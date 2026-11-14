import { createHash } from "node:crypto";
import { canonicalJson, appendAudit, type AuditAction } from "@sys2qa/platform";
import { checkExecutionAllowed, validateDocument, validateScenario, type ExecutionRequest } from "@sys2qa/contract";
import type { Scenario } from "@sys2qa/qaa-core";
import { serviceError, ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const TEXT = { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" } as const;
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
/** Declared (not configured) environments have no scope policy; their approvals bind to policy version 1. */
const DECLARED_SCOPE_POLICY_VERSION = 1;

interface VersionRow {
  scenario_id: string;
  version: number;
  status: string;
  freshness: string;
  doc_json: string;
  project_id: string;
  latest_version: number;
}

function load(host: Host, scenarioId: string, version?: number): VersionRow & { doc: Scenario } {
  const row = host.state.db
    .prepare(
      `SELECT v.scenario_id, v.version, v.status, v.freshness, v.doc_json, s.project_id, s.latest_version FROM scenario_versions v
       JOIN scenarios s ON s.scenario_id = v.scenario_id WHERE v.scenario_id = ? AND v.version = COALESCE(?, s.latest_version)`,
    )
    .get(scenarioId, version ?? null) as VersionRow | undefined;
  if (!row) throw serviceError("NOT_FOUND", `no scenario ${scenarioId}${version ? ` version ${version}` : ""}`);
  return { ...row, doc: JSON.parse(row.doc_json) as Scenario };
}

function audit(
  host: Host,
  projectId: string,
  actor: string,
  action: AuditAction,
  target: string,
  details: Record<string, unknown>,
) {
  appendAudit(host.state.db, { projectId, actor, action, target, details }, { redactor: host.redactor, now: host.now });
}

function contractError(issues: Array<{ code: string; message: string }>, fallback: string): ServiceError {
  const first = issues[0];
  return new ServiceError(
    first?.code ?? "INPUT_INVALID",
    "invalid_input",
    first?.message ?? fallback,
    "Fix the listed issues; the scenario contract (PRD §15.9) decides what a scenario may state.",
    { issues: issues.slice(0, 10) },
  );
}

/**
 * Stores a changed scenario as a new version (QAA-FR-053): an approval never transfers. A previously approved latest
 * version becomes `superseded` with its active approvals.
 */
function newVersion(host: Host, row: VersionRow & { doc: Scenario }, doc: Scenario): Scenario {
  const next: Scenario = { ...doc, version: row.latest_version + 1 };
  const check = validateScenario(next);
  if (!check.ok) throw contractError(check.issues, "the edited scenario is not valid");
  const json = JSON.stringify(next);
  const at = host.now().toISOString();
  host.state.db
    .prepare(
      "INSERT INTO scenario_versions (scenario_id, version, doc_json, status, freshness, content_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(next.scenario_id, next.version, json, next.status, next.freshness, sha256(json), at, at);
  host.state.db
    .prepare("UPDATE scenarios SET latest_version = ?, updated_at = ? WHERE scenario_id = ?")
    .run(next.version, at, next.scenario_id);
  const prior = load(host, row.scenario_id, row.latest_version);
  if (prior.status === "approved") {
    host.state.db
      .prepare(
        "UPDATE scenario_versions SET status = 'superseded', updated_at = ? WHERE scenario_id = ? AND version = ?",
      )
      .run(at, prior.scenario_id, prior.version);
    host.state.db
      .prepare(
        "UPDATE approvals SET state = 'superseded', updated_at = ? WHERE scenario_id = ? AND version = ? AND state = 'active'",
      )
      .run(at, prior.scenario_id, prior.version);
  }
  return next;
}

/** Replaces a not-yet-approved version's document in place (status and classification changes before approval). */
function rewrite(host: Host, row: VersionRow, doc: Scenario): Scenario {
  const check = validateScenario(doc);
  if (!check.ok) throw contractError(check.issues, "the scenario is not valid");
  const json = JSON.stringify(doc);
  host.state.db
    .prepare(
      "UPDATE scenario_versions SET doc_json = ?, status = ?, content_sha256 = ?, updated_at = ? WHERE scenario_id = ? AND version = ?",
    )
    .run(json, doc.status, sha256(json), host.now().toISOString(), row.scenario_id, row.version);
  return doc;
}

const scenariosEdit = defineOperation<
  {
    scenario_id: string;
    title?: string;
    steps?: Array<{ step_id: string; instruction: string }>;
    preconditions?: string[];
    cleanup?: string[];
    irreversible_ack?: boolean;
    priority?: "high" | "medium" | "low";
  },
  unknown
>({
  name: "scenarios.edit",
  title: "Edit a scenario",
  description:
    "Edits a scenario's wording, preconditions, cleanup, priority or irreversibility acknowledgment. The edit is a new version waiting for review again; an approval of the old version does not transfer (QAA-FR-053). Expected results, bases and links are never edited by hand.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["scenario_id"],
    properties: {
      scenario_id: ID,
      title: TEXT,
      steps: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["step_id", "instruction"],
          properties: { step_id: { type: "string", pattern: "^S[0-9]+$" }, instruction: TEXT },
        },
      },
      preconditions: { type: "array", maxItems: 20, items: TEXT },
      cleanup: { type: "array", maxItems: 20, items: TEXT },
      irreversible_ack: { type: "boolean" },
      priority: { enum: ["high", "medium", "low"] },
    },
  },
  run: ({ host, caller }, input) => {
    const row = load(host, input.scenario_id);
    const doc: Scenario = JSON.parse(row.doc_json) as Scenario;
    const lang = doc.content_language;
    if (input.title) doc.title = { language: lang, value: input.title };
    for (const edit of input.steps ?? []) {
      const step = doc.steps.find((s) => s.step_id === edit.step_id);
      if (!step) throw serviceError("INPUT_INVALID", `no step ${edit.step_id}`, { field: "steps" });
      step.instruction = { language: lang, value: edit.instruction };
    }
    if (input.preconditions) {
      const kept = doc.preconditions.filter((p) => p.credential_profile_ref);
      doc.preconditions = [
        ...kept,
        ...input.preconditions.map((t, i) => ({
          id: `pre-${kept.length + i + 1}`,
          text: { language: lang, value: t },
        })),
      ];
    }
    if (input.cleanup) doc.cleanup = input.cleanup.map((t) => ({ language: lang, value: t }));
    if (input.irreversible_ack !== undefined)
      (doc as Scenario & { irreversible_ack?: boolean }).irreversible_ack = input.irreversible_ack;
    if (input.priority) doc.priority = input.priority;
    // An edited scenario is reviewed again (the critic or a person sets it ready).
    doc.status = "draft";
    delete (doc as { status_reason?: string }).status_reason;
    let next!: Scenario;
    host.state.transaction(() => {
      next = newVersion(host, row, doc);
      audit(host, row.project_id, caller.actor, "scenario.edited", input.scenario_id, {
        from_version: row.version,
        to_version: next.version,
      });
    });
    return {
      scenario_id: next.scenario_id,
      version: next.version,
      status: next.status,
      previous_version: row.version,
      previous_status: row.status,
    };
  },
});

const scenariosDecide = defineOperation<
  {
    scenario_id: string;
    version: number;
    decision: "ready_for_review" | "reject" | "defer" | "request_regeneration";
    reason: string;
  },
  unknown
>({
  name: "scenarios.decide",
  title: "Decide on a scenario",
  description:
    "Marks a scenario version ready for review, rejects or defers it, or requests its regeneration (back to clarification with the reason). Every decision is audited (QAA-FR-050).",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["scenario_id", "version", "decision", "reason"],
    properties: {
      scenario_id: ID,
      version: { type: "integer", minimum: 1 },
      decision: { enum: ["ready_for_review", "reject", "defer", "request_regeneration"] },
      reason: TEXT,
    },
  },
  run: ({ host, caller }, input) => {
    const row = load(host, input.scenario_id, input.version);
    if (row.version !== row.latest_version)
      throw serviceError(
        "CONFLICT",
        `version ${row.version} is not the latest; decide on version ${row.latest_version}`,
      );
    if (row.status === "approved" || row.status === "superseded")
      throw serviceError("CONFLICT", `version ${row.version} is ${row.status}; edit it to create a new version`);
    const status = {
      ready_for_review: "pending_review",
      reject: "rejected",
      defer: "deferred",
      request_regeneration: "needs_clarification",
    }[input.decision] as Scenario["status"];
    const doc: Scenario = { ...row.doc, status };
    // Every status but review-ready carries why (the contract requires it for rejected, deferred and clarification).
    if (status === "pending_review") delete (doc as { status_reason?: string }).status_reason;
    else doc.status_reason = `${status === "needs_clarification" ? "regeneration requested" : status}: ${input.reason}`;
    host.state.transaction(() => {
      rewrite(host, row, doc);
      audit(host, row.project_id, caller.actor, "scenario.decided", input.scenario_id, {
        version: row.version,
        decision: input.decision,
        reason: input.reason,
      });
    });
    return { scenario_id: input.scenario_id, version: row.version, status };
  },
});

const MODES_OF: Record<Scenario["execution_classification"], Scenario["execution_modes"]> = {
  manual_only: ["manual"],
  automation_candidate: ["manual"],
  automation_ready: ["automated"],
  both: ["manual", "automated"],
};

const scenariosClassify = defineOperation<
  { scenario_id: string; classification: Scenario["execution_classification"]; reason: string },
  unknown
>({
  name: "scenarios.classify",
  title: "Override a scenario's execution classification",
  description:
    "Sets `manual_only`, `automation_candidate`, `automation_ready` or `both` with a reason (QAA-FR-055); audited. `automation_ready` needs an automation action on every step and no result without an oracle (CR-051). On an approved scenario this is a new version.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["scenario_id", "classification", "reason"],
    properties: {
      scenario_id: ID,
      classification: { enum: ["manual_only", "automation_candidate", "automation_ready", "both"] },
      reason: TEXT,
    },
  },
  run: ({ host, caller }, input) => {
    const row = load(host, input.scenario_id);
    const before = row.doc.execution_classification;
    const doc: Scenario = {
      ...row.doc,
      execution_classification: input.classification,
      execution_modes: MODES_OF[input.classification],
    };
    let result!: Scenario;
    host.state.transaction(() => {
      result = row.status === "approved" ? newVersion(host, row, { ...doc, status: "draft" }) : rewrite(host, row, doc);
      audit(host, row.project_id, caller.actor, "scenario.classified", input.scenario_id, {
        version: result.version,
        from: before,
        to: input.classification,
        reason: input.reason,
      });
    });
    return {
      scenario_id: result.scenario_id,
      version: result.version,
      status: result.status,
      classification: input.classification,
    };
  },
});

export interface Binding {
  mode: "manual" | "automated";
  environment_id?: string;
  declared_environment_id?: string;
  scope_policy_version: number;
  test_data_profile: string;
}

export const BINDING_INPUT = {
  mode: { enum: ["manual", "automated"] },
  environment_id: ID,
  declared_environment: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]*$" },
  test_data_profile: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._-]+$" },
} as const;

/** The environment part of a binding: a configured environment with its current scope policy, or a declared one. */
function bindingOf(
  host: Host,
  projectId: string,
  input: {
    mode: "manual" | "automated";
    environment_id?: string;
    declared_environment?: string;
    test_data_profile?: string;
  },
): Binding {
  const test_data_profile = input.test_data_profile ?? "default";
  if (input.environment_id) {
    const env = host.state.db
      .prepare("SELECT id, classification FROM environments WHERE id = ? AND project_id = ?")
      .get(input.environment_id, projectId) as { id: string; classification: string } | undefined;
    if (!env)
      throw serviceError("NOT_FOUND", `no environment ${input.environment_id} in this project`, {
        field: "environment_id",
      });
    if (env.classification === "production")
      throw new ServiceError(
        "PRODUCTION_REFUSED",
        "denied",
        "a production environment cannot be a test baseline",
        "Use a development or staging environment.",
      );
    const policy = host.projects.currentScopePolicy(env.id);
    if (!policy) throw serviceError("CONFLICT", `environment ${env.id} has no scope policy yet; configure it first`);
    return { mode: input.mode, environment_id: env.id, scope_policy_version: policy.version, test_data_profile };
  }
  if (input.mode === "automated")
    throw serviceError("INPUT_INVALID", "automated execution needs a configured environment", {
      field: "environment_id",
    });
  if (!input.declared_environment)
    throw serviceError("INPUT_INVALID", "name the environment: a configured one or a declared one", {
      field: "declared_environment",
    });
  const slug = input.declared_environment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return {
    mode: input.mode,
    declared_environment_id: `denv:${slug}`,
    scope_policy_version: DECLARED_SCOPE_POLICY_VERSION,
    test_data_profile,
  };
}

interface PreviewItem {
  scenario_id: string;
  version: number;
  display_key: string;
  title: string;
  state_changing: boolean;
  execution_classification: string;
}

function previewToken(items: PreviewItem[], binding: Binding): string {
  return sha256(canonicalJson({ items: items.map((i) => [i.scenario_id, i.version]), binding }));
}

function approvable(host: Host, projectId: string, scenarioIds: string[]): Array<VersionRow & { doc: Scenario }> {
  return scenarioIds.map((id) => {
    const row = load(host, id);
    if (row.project_id !== projectId) throw serviceError("NOT_FOUND", `no scenario ${id} in this project`);
    if (row.status !== "pending_review")
      throw serviceError(
        "SCENARIO_NOT_READY",
        `${row.doc.display_key} (${id}) version ${row.version} is ${row.status}`,
        {
          scenario_id: id,
          status: row.status,
        },
      );
    return row;
  });
}

const PREVIEW_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["project_id", "scenario_ids", "mode"],
  properties: {
    project_id: ID,
    scenario_ids: { type: "array", minItems: 1, maxItems: 1000, uniqueItems: true, items: ID },
    ...BINDING_INPUT,
  },
} as const;

type PreviewInput = {
  project_id: string;
  scenario_ids: string[];
  mode: "manual" | "automated";
  environment_id?: string;
  declared_environment?: string;
  test_data_profile?: string;
};

const approvalsPreview = defineOperation<PreviewInput, unknown>({
  name: "approvals.preview",
  title: "Preview an approval",
  description:
    "Lists the exact scenario versions an approval would cover, with the binding (baseline, environment, scope policy version, test-data profile) and the state-changing ones, and returns the token `approvals.approve` requires, so nothing is approved that was not shown (QAA-FR-051).",
  level: "none",
  effect: "read",
  input: PREVIEW_INPUT,
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const binding = bindingOf(host, project.id, input);
    const items = approvable(host, project.id, input.scenario_ids).map((r) => ({
      scenario_id: r.scenario_id,
      version: r.version,
      display_key: r.doc.display_key,
      title: r.doc.title.value,
      state_changing: r.doc.state_changing,
      execution_classification: r.doc.execution_classification,
    }));
    return {
      items,
      binding,
      baselines: [...new Set(input.scenario_ids.map((id) => canonicalJson(load(host, id).doc.baseline)))].map(
        (b) => JSON.parse(b) as unknown,
      ),
      state_changing: items.filter((i) => i.state_changing).map((i) => i.scenario_id),
      preview_token: previewToken(items, binding),
    };
  },
});

const approvalsApprove = defineOperation<
  PreviewInput & { preview_token: string; state_changing_ack?: boolean },
  unknown
>({
  name: "approvals.approve",
  title: "Approve scenarios",
  description:
    "Approves exactly the previewed scenario versions (QAA-FR-051). Each approval is bound to the scenario version, the package baseline and revision, the environment, its scope policy version and the test-data profile (QAA-FR-052) and audited. A state-changing scenario needs an explicit acknowledgment and a cleanup plan or an acknowledged irreversibility (QAA-FR-057).",
  level: "none",
  effect: "write",
  input: {
    ...PREVIEW_INPUT,
    required: [...PREVIEW_INPUT.required, "preview_token"],
    properties: {
      ...PREVIEW_INPUT.properties,
      preview_token: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      state_changing_ack: { type: "boolean" },
    },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    const binding = bindingOf(host, project.id, input);
    const rows = approvable(host, project.id, input.scenario_ids);
    const items = rows.map((r) => ({
      scenario_id: r.scenario_id,
      version: r.version,
      display_key: r.doc.display_key,
      title: r.doc.title.value,
      state_changing: r.doc.state_changing,
      execution_classification: r.doc.execution_classification,
    }));
    if (previewToken(items, binding) !== input.preview_token)
      throw serviceError(
        "CONFLICT",
        "the selection or a scenario changed since the preview; preview again and approve what is shown",
      );
    const stateChanging = rows.filter((r) => r.doc.state_changing);
    if (stateChanging.length > 0 && input.state_changing_ack !== true)
      throw new ServiceError(
        "APPROVAL_REQUIRED",
        "denied",
        `${stateChanging.length} scenario(s) change data and need an explicit state-changing acknowledgment`,
        "Approve them with state_changing_ack after checking their cleanup, or approve the others alone.",
        { scenario_ids: stateChanging.map((r) => r.scenario_id) },
      );
    const noCleanup = stateChanging.filter(
      (r) =>
        r.doc.cleanup.length === 0 && (r.doc as Scenario & { irreversible_ack?: boolean }).irreversible_ack !== true,
    );
    if (noCleanup.length > 0)
      throw new ServiceError(
        "APPROVAL_REQUIRED",
        "denied",
        `${noCleanup.length} state-changing scenario(s) have neither a cleanup plan nor an acknowledged irreversibility`,
        "Add a cleanup plan or acknowledge irreversibility (scenarios.edit), then preview again.",
        { scenario_ids: noCleanup.map((r) => r.scenario_id) },
      );
    if (binding.mode === "automated") {
      const manualOnly = rows.filter((r) => !["automation_ready", "both"].includes(r.doc.execution_classification));
      if (manualOnly.length > 0)
        throw new ServiceError(
          "SCN_NOT_AUTOMATABLE",
          "invalid_input",
          `${manualOnly.length} scenario(s) are not automation-ready`,
          "Approve them for manual execution, or classify them after adding automation.",
          {
            scenario_ids: manualOnly.map((r) => r.scenario_id),
          },
        );
    }
    const approvals: Array<Record<string, unknown>> = [];
    host.state.transaction(() => {
      const at = host.now().toISOString();
      for (const r of rows) {
        const approval = {
          schema_version: "1.0.0",
          approval_id: host.newId("approval"),
          scenario_id: r.scenario_id,
          scenario_version: r.version,
          baseline: r.doc.baseline,
          ...(binding.environment_id ? { environment_id: binding.environment_id } : {}),
          ...(binding.declared_environment_id ? { declared_environment_id: binding.declared_environment_id } : {}),
          scope_policy_version: binding.scope_policy_version,
          test_data_profile: binding.test_data_profile,
          mode: binding.mode,
          ...(r.doc.state_changing ? { state_changing_ack: true } : {}),
          approver: caller.actor,
          approved_at: at.replace(/\.\d{3}Z$/, "Z"),
          state: "active",
        };
        const check = validateDocument("approval", approval);
        if (!check.ok) throw contractError(check.issues, "the approval is not valid");
        host.state.db
          .prepare(
            "INSERT INTO approvals (id, scenario_id, version, binding_json, mode, state, approver, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
          )
          .run(
            approval.approval_id,
            r.scenario_id,
            r.version,
            JSON.stringify(approval),
            binding.mode,
            caller.actor,
            approval.approved_at,
            at,
            at,
          );
        rewrite(host, r, { ...r.doc, status: "approved" });
        audit(host, project.id, caller.actor, "approval.granted", approval.approval_id, {
          scenario_id: r.scenario_id,
          version: r.version,
          mode: binding.mode,
          environment: binding.environment_id ?? binding.declared_environment_id,
          scope_policy_version: binding.scope_policy_version,
          test_data_profile: binding.test_data_profile,
          state_changing_ack: r.doc.state_changing,
        });
        approvals.push(approval);
      }
    });
    return { approved: approvals.length, approvals };
  },
});

const approvalsRevoke = defineOperation<{ approval_id: string; reason: string }, unknown>({
  name: "approvals.revoke",
  title: "Revoke an approval",
  description: "Revokes an active approval with a reason; the scenario version can no longer run under it. Audited.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["approval_id", "reason"],
    properties: { approval_id: ID, reason: TEXT },
  },
  run: ({ host, caller }, input) => {
    const row = host.state.db
      .prepare("SELECT scenario_id, version, state FROM approvals WHERE id = ?")
      .get(input.approval_id) as { scenario_id: string; version: number; state: string } | undefined;
    if (!row) throw serviceError("NOT_FOUND", `no approval ${input.approval_id}`);
    if (row.state !== "active") throw serviceError("CONFLICT", `approval ${input.approval_id} is ${row.state}`);
    const scenario = load(host, row.scenario_id, row.version);
    host.state.transaction(() => {
      host.state.db
        .prepare("UPDATE approvals SET state = 'revoked', updated_at = ? WHERE id = ?")
        .run(host.now().toISOString(), input.approval_id);
      audit(host, scenario.project_id, caller.actor, "approval.revoked", input.approval_id, { reason: input.reason });
    });
    return { approval_id: input.approval_id, state: "revoked" };
  },
});

const approvalsList = defineOperation<{ scenario_id: string }, unknown>({
  name: "approvals.list",
  title: "List a scenario's approvals",
  description: "Every approval of a scenario's versions with its binding and state.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["scenario_id"], properties: { scenario_id: ID } },
  run: ({ host }, input) => {
    load(host, input.scenario_id);
    const rows = host.state.db
      .prepare("SELECT binding_json, state FROM approvals WHERE scenario_id = ? ORDER BY version, approved_at")
      .all(input.scenario_id) as Array<{ binding_json: string; state: string }>;
    return {
      scenario_id: input.scenario_id,
      approvals: rows.map((r) => ({ ...(JSON.parse(r.binding_json) as object), state: r.state })),
    };
  },
});

/** The project's current baseline for a package: its latest stored version and that version's revision. */
function currentBaseline(host: Host, projectId: string, scenario: Scenario): ExecutionRequest["baseline"] {
  const ref = scenario.baseline.packages[0]!;
  const latest = host.state.db
    .prepare("SELECT version, path FROM packages WHERE project_id = ? AND package_id = ? ORDER BY version DESC LIMIT 1")
    .get(projectId, ref.package_id) as { version: number } | undefined;
  if (!latest || latest.version === ref.package_version)
    return scenario.baseline as unknown as ExecutionRequest["baseline"];
  return {
    ...scenario.baseline,
    packages: [{ package_id: ref.package_id, package_version: latest.version }],
  } as unknown as ExecutionRequest["baseline"];
}

export interface ExecutionDecision {
  allowed: boolean;
  scenario_id: string;
  version: number;
  project_id: string;
  issues: Array<{ code: string; message: string; details?: unknown }>;
  /** The active approval the run rests on, when it is allowed. */
  approval_id: string | null;
  binding: Binding;
  baseline: ExecutionRequest["baseline"];
  scenario: Scenario;
}

/**
 * The execution gate every run passes, manual or automated (QAA-FR-054, CR-055, CR-056): the scenario version must be
 * approved and current, and its active approval must match the run on every binding field.
 */
export function checkExecution(
  host: Host,
  input: {
    scenario_id: string;
    version?: number;
    mode: "manual" | "automated";
    environment_id?: string;
    declared_environment?: string;
    test_data_profile?: string;
  },
): ExecutionDecision {
  const row = load(host, input.scenario_id, input.version);
  const binding = bindingOf(host, row.project_id, input);
  const approvalRow = host.state.db
    .prepare(
      "SELECT id, binding_json, state FROM approvals WHERE scenario_id = ? AND version = ? AND mode = ? ORDER BY approved_at DESC, rowid DESC LIMIT 1",
    )
    .get(row.scenario_id, row.version, binding.mode) as { id: string; binding_json: string; state: string } | undefined;
  const approval = approvalRow
    ? { ...(JSON.parse(approvalRow.binding_json) as object), state: approvalRow.state }
    : undefined;
  // The stored status and freshness are authoritative: staleness changes them without touching an approved document.
  const scenario = {
    ...row.doc,
    status: row.status,
    freshness: row.freshness,
  } as unknown as ExecutionRequest["scenario"];
  const latestNote =
    row.version !== row.latest_version
      ? [{ code: "APPROVAL_REQUIRED", message: `version ${row.version} is not the latest (${row.latest_version})` }]
      : [];
  const baseline = currentBaseline(host, row.project_id, row.doc);
  const issues = [
    ...latestNote,
    ...checkExecutionAllowed({
      scenario,
      ...(approval ? { approval: approval as unknown as NonNullable<ExecutionRequest["approval"]> } : {}),
      mode: binding.mode,
      baseline,
      ...(binding.environment_id ? { environment_id: binding.environment_id } : {}),
      ...(binding.declared_environment_id ? { declared_environment_id: binding.declared_environment_id } : {}),
      scope_policy_version: binding.scope_policy_version,
      test_data_profile: binding.test_data_profile,
    }).map((i) => ({ code: i.code, message: i.message, ...(i.details ? { details: i.details } : {}) })),
  ];
  const allowed = issues.length === 0;
  return {
    allowed,
    scenario_id: row.scenario_id,
    version: row.version,
    project_id: row.project_id,
    issues,
    approval_id: allowed && approvalRow ? approvalRow.id : null,
    binding,
    baseline,
    scenario: row.doc,
  };
}

const executionCheck = defineOperation<
  {
    scenario_id: string;
    version?: number;
    mode: "manual" | "automated";
    environment_id?: string;
    declared_environment?: string;
    test_data_profile?: string;
  },
  unknown
>({
  name: "execution.check",
  title: "Check that a scenario may run",
  description:
    "The execution gate every run passes (QAA-FR-054, CR-055, CR-056): the scenario version must be approved and current, and its active approval must match the run on every binding field: version, mode, the project's current package baseline, environment, its current scope policy version and the test-data profile. Returns the refusals; nothing runs here.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["scenario_id", "mode"],
    properties: { scenario_id: ID, version: { type: "integer", minimum: 1 }, ...BINDING_INPUT },
  },
  run: ({ host }, input) => {
    const { allowed, scenario_id, version, issues } = checkExecution(host, input);
    return { allowed, scenario_id, version, issues };
  },
});

export const REVIEW_OPERATIONS = [
  scenariosEdit,
  scenariosDecide,
  scenariosClassify,
  approvalsPreview,
  approvalsApprove,
  approvalsRevoke,
  approvalsList,
  executionCheck,
];
