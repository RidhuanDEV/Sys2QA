import { checkDefectTransition, validateDocument, type DefectState } from "@sys2qa/contract";
import { appendAudit, type AuditAction } from "@sys2qa/platform";
import type { Scenario } from "@sys2qa/qaa-core";
import { serviceError, ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const DEFECT_ID = { type: "string", pattern: "^defect:[0-9A-HJKMNP-TV-Z]{26}$" } as const;
const RUN_ID = { type: "string", pattern: "^mrun:[0-9A-HJKMNP-TV-Z]{26}$" } as const;
const TEXT = { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } as const;
const SEVERITY = { enum: ["critical", "major", "minor", "trivial"] } as const;
const PRIORITY = { enum: ["high", "medium", "low"] } as const;
const SUSPECTED = { enum: ["product_defect", "test_defect", "unknown"] } as const;
const STATES = [
  "new",
  "triaged",
  "confirmed",
  "rejected",
  "duplicate",
  "needs_info",
  "fixed",
  "ready_for_retest",
  "closed",
  "reopened",
] as const;

interface DefectDoc {
  schema_version: string;
  defect_id: string;
  title: { language: string; value: string };
  description?: { language: string; value: string };
  severity: string;
  priority: string;
  state: DefectState;
  suspected_type: string;
  links: { scenario_id: string; scenario_version: number; run_id: string; step_id: string; evidence_refs: string[] };
  baseline: unknown;
  environment: unknown;
  duplicate_of?: string;
  created_at: string;
}

function defectRow(host: Host, defectId: string): { project_id: string; doc: DefectDoc } {
  const row = host.state.db.prepare("SELECT project_id, doc_json FROM defects WHERE id = ?").get(defectId) as
    { project_id: string; doc_json: string } | undefined;
  if (!row) throw serviceError("NOT_FOUND", `no defect ${defectId}`);
  return { project_id: row.project_id, doc: JSON.parse(row.doc_json) as DefectDoc };
}

function transitionsOf(host: Host, defectId: string) {
  return host.state.db
    .prepare(
      "SELECT seq, from_state, to_state, by, at, reason FROM defect_transitions WHERE defect_id = ? ORDER BY seq",
    )
    .all(defectId) as Array<{
    seq: number;
    from_state: string;
    to_state: string;
    by: string;
    at: string;
    reason: string | null;
  }>;
}

function checked(doc: DefectDoc): DefectDoc {
  const check = validateDocument("defect", doc);
  if (!check.ok)
    throw new ServiceError(
      "INTERNAL_ERROR",
      "internal",
      "the defect does not match its contract schema",
      "Report it with the listed issues.",
      { issues: check.issues.slice(0, 10).map((i) => i.message) },
    );
  return doc;
}

/** The stored links plus the hashes of the evidence blobs they name, so retention keeps those blobs. */
function linksJson(host: Host, doc: DefectDoc): string {
  const hashes = doc.links.evidence_refs.length
    ? (
        host.state.db
          .prepare(
            `SELECT sha256 FROM run_attachments WHERE id IN (${doc.links.evidence_refs.map(() => "?").join(", ")})`,
          )
          .all(...doc.links.evidence_refs) as Array<{ sha256: string }>
      ).map((r) => r.sha256.replace(/^sha256:/, ""))
    : [];
  return JSON.stringify({ ...doc.links, evidence_sha256: hashes });
}

function audit(host: Host, projectId: string, actor: string, action: AuditAction, target: string, details: object) {
  appendAudit(
    host.state.db,
    { projectId, actor, action, target, details: details as Record<string, unknown> },
    { redactor: host.redactor, now: host.now },
  );
}

const show = (host: Host, defectId: string) => {
  const { doc } = defectRow(host, defectId);
  return { defect: doc, transitions: transitionsOf(host, defectId) };
};

const defectsCreate = defineOperation<
  {
    run_id: string;
    scenario_id: string;
    step_id: string;
    title: string;
    description?: string;
    severity: string;
    priority: string;
    suspected_type?: string;
  },
  unknown
>({
  name: "defects.create",
  title: "Create a defect from a failed step",
  description:
    "Creates a defect from a failed step of a manual run (QAA-FR-084), pre-linked to the scenario version, the run, the step and its evidence, with the run's baseline and environment. Severity (impact) and priority (urgency) are both required and separate (QAA-FR-088); the suspected type (product or test defect) stays reviewable. The defect starts `new`.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id", "scenario_id", "step_id", "title", "severity", "priority"],
    properties: {
      run_id: RUN_ID,
      scenario_id: ID,
      step_id: { type: "string", pattern: "^S[0-9]+$" },
      title: { type: "string", minLength: 1, maxLength: 300, pattern: "\\S" },
      description: TEXT,
      severity: SEVERITY,
      priority: PRIORITY,
      suspected_type: SUSPECTED,
    },
  },
  run: ({ host, caller }, input) => {
    const run = host.state.db
      .prepare(
        "SELECT project_id, environment_json, baseline_json, language FROM runs WHERE id = ? AND kind = 'manual'",
      )
      .get(input.run_id) as
      { project_id: string; environment_json: string; baseline_json: string; language: string } | undefined;
    if (!run) throw serviceError("NOT_FOUND", `no manual run ${input.run_id}`);
    const kase = host.state.db
      .prepare(
        `SELECT c.version, v.doc_json FROM run_cases c JOIN scenario_versions v ON v.scenario_id = c.scenario_id AND v.version = c.version
         WHERE c.run_id = ? AND c.scenario_id = ?`,
      )
      .get(input.run_id, input.scenario_id) as { version: number; doc_json: string } | undefined;
    if (!kase) throw serviceError("NOT_FOUND", `${input.scenario_id} is not part of run ${input.run_id}`);
    const scenario = JSON.parse(kase.doc_json) as Scenario;
    if (!scenario.steps.some((s) => s.step_id === input.step_id))
      throw serviceError("NOT_FOUND", `${input.scenario_id} has no step ${input.step_id}`);
    const latest = host.state.db
      .prepare(
        `SELECT r.doc_json FROM step_results r WHERE r.run_id = ? AND r.scenario_id = ? AND r.step_id = ?
         AND NOT EXISTS (SELECT 1 FROM step_results n WHERE n.supersedes = r.id)`,
      )
      .get(input.run_id, input.scenario_id, input.step_id) as { doc_json: string } | undefined;
    const step = latest ? (JSON.parse(latest.doc_json) as { status: string; evidence_refs?: string[] }) : undefined;
    if (step?.status !== "fail")
      throw new ServiceError(
        "DEFECT_STEP_NOT_FAILED",
        "conflict",
        `step ${input.step_id} of ${input.scenario_id} is ${step?.status ?? "not recorded"} in run ${input.run_id}; a defect is created from a failed step`,
        "Record the step as failed with its actual result first.",
        { status: step?.status ?? null },
      );
    const redact = (text: string) => host.redactor.redactText(text).text;
    const defectId = host.newId("defect");
    const at = host.now().toISOString();
    const doc = checked({
      schema_version: "1.0.0",
      defect_id: defectId,
      title: { language: run.language, value: redact(input.title) },
      ...(input.description ? { description: { language: run.language, value: redact(input.description) } } : {}),
      severity: input.severity,
      priority: input.priority,
      state: "new",
      suspected_type: input.suspected_type ?? "unknown",
      links: {
        scenario_id: input.scenario_id,
        scenario_version: kase.version,
        run_id: input.run_id,
        step_id: input.step_id,
        evidence_refs: step.evidence_refs ?? [],
      },
      baseline: JSON.parse(run.baseline_json) as unknown,
      environment: JSON.parse(run.environment_json) as unknown,
      created_at: at.replace(/\.\d{3}Z$/, "Z"),
    });
    host.state.transaction(() => {
      host.state.db
        .prepare(
          "INSERT INTO defects (id, project_id, state, severity, priority, links_json, doc_json, created_at, updated_at) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?)",
        )
        .run(defectId, run.project_id, doc.severity, doc.priority, linksJson(host, doc), JSON.stringify(doc), at, at);
      audit(host, run.project_id, caller.actor, "defect.created", defectId, {
        links: doc.links,
        severity: doc.severity,
        priority: doc.priority,
        suspected_type: doc.suspected_type,
      });
    });
    return show(host, defectId);
  },
});

const defectsTransition = defineOperation<
  { defect_id: string; to: DefectState; reason?: string; duplicate_of?: string; retest_run_id?: string },
  unknown
>({
  name: "defects.transition",
  title: "Move a defect through its lifecycle",
  description:
    "Moves a defect to its next state (PRD §15.12, CR-070): new → triaged → confirmed | rejected (with a reason) | duplicate (of another defect) | needs_info → fixed → ready_for_retest → closed | reopened. Closing needs a passing retest (a completed manual run in which the defect's scenario passed, on its recorded baseline) or a reason. Every transition is recorded with who, when and why.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["defect_id", "to"],
    properties: {
      defect_id: DEFECT_ID,
      to: { enum: STATES },
      reason: TEXT,
      duplicate_of: DEFECT_ID,
      retest_run_id: RUN_ID,
    },
  },
  run: ({ host, caller }, input) => {
    const { project_id, doc } = defectRow(host, input.defect_id);
    if (input.duplicate_of) {
      const other = host.state.db.prepare("SELECT project_id FROM defects WHERE id = ?").get(input.duplicate_of) as
        { project_id: string } | undefined;
      if (!other || other.project_id !== project_id || input.duplicate_of === input.defect_id)
        throw serviceError("NOT_FOUND", `no other defect ${input.duplicate_of} in this project`, {
          field: "duplicate_of",
        });
    }
    let retestPassed = false;
    if (input.retest_run_id) {
      const run = host.state.db
        .prepare("SELECT project_id, state FROM runs WHERE id = ? AND kind = 'manual'")
        .get(input.retest_run_id) as { project_id: string; state: string } | undefined;
      if (!run || run.project_id !== project_id)
        throw serviceError("NOT_FOUND", `no manual run ${input.retest_run_id} in this project`, {
          field: "retest_run_id",
        });
      const outcome = host.state.db
        .prepare(
          "SELECT doc_json FROM case_results WHERE run_id = ? AND scenario_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(input.retest_run_id, doc.links.scenario_id) as { doc_json: string } | undefined;
      retestPassed =
        run.state === "completed" &&
        outcome !== undefined &&
        (JSON.parse(outcome.doc_json) as { outcome: string }).outcome === "passed";
    }
    const issues = checkDefectTransition(doc.state, input.to, {
      retest_passed: retestPassed,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.duplicate_of ? { duplicate_of: input.duplicate_of } : {}),
    });
    if (issues.length > 0)
      throw new ServiceError(
        "DEFECT_TRANSITION_INVALID",
        "conflict",
        issues[0]!.message,
        "Follow the defect lifecycle (PRD §15.12) and give what the transition needs: a reason, the duplicate, or a passing retest.",
        { from: doc.state, to: input.to, allowed: (issues[0]!.details ?? {}) as object },
      );
    const at = host.now().toISOString();
    const reason = input.reason ? host.redactor.redactText(input.reason).text : null;
    const updated = checked({
      ...doc,
      state: input.to,
      ...(input.to === "duplicate" ? { duplicate_of: input.duplicate_of } : {}),
    });
    host.state.transaction(() => {
      const seq = (
        host.state.db
          .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM defect_transitions WHERE defect_id = ?")
          .get(input.defect_id) as {
          n: number;
        }
      ).n;
      host.state.db
        .prepare(
          "INSERT INTO defect_transitions (defect_id, seq, project_id, from_state, to_state, by, at, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.defect_id,
          seq + 1,
          project_id,
          doc.state,
          input.to,
          caller.actor,
          at,
          reason ?? (input.retest_run_id && retestPassed ? `retest passed in ${input.retest_run_id}` : null),
          at,
          at,
        );
      host.state.db
        .prepare("UPDATE defects SET state = ?, doc_json = ?, updated_at = ? WHERE id = ?")
        .run(input.to, JSON.stringify(updated), at, input.defect_id);
      audit(host, project_id, caller.actor, "defect.transitioned", input.defect_id, {
        from: doc.state,
        to: input.to,
        ...(reason ? { reason } : {}),
        ...(input.duplicate_of ? { duplicate_of: input.duplicate_of } : {}),
        ...(input.retest_run_id ? { retest_run_id: input.retest_run_id, retest_passed: retestPassed } : {}),
      });
    });
    return show(host, input.defect_id);
  },
});

const defectsUpdate = defineOperation<
  { defect_id: string; severity?: string; priority?: string; suspected_type?: string; reason: string },
  unknown
>({
  name: "defects.update",
  title: "Reclassify a defect",
  description:
    "Changes a defect's severity, priority or suspected type (product or test defect) with the reason; the change is audited (QAA-FR-088). Its state changes only through `defects.transition`.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["defect_id", "reason"],
    minProperties: 3,
    properties: {
      defect_id: DEFECT_ID,
      severity: SEVERITY,
      priority: PRIORITY,
      suspected_type: SUSPECTED,
      reason: TEXT,
    },
  },
  run: ({ host, caller }, input) => {
    const { project_id, doc } = defectRow(host, input.defect_id);
    const updated = checked({
      ...doc,
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.suspected_type ? { suspected_type: input.suspected_type } : {}),
    });
    const at = host.now().toISOString();
    host.state.transaction(() => {
      host.state.db
        .prepare("UPDATE defects SET severity = ?, priority = ?, doc_json = ?, updated_at = ? WHERE id = ?")
        .run(updated.severity, updated.priority, JSON.stringify(updated), at, input.defect_id);
      audit(host, project_id, caller.actor, "defect.updated", input.defect_id, {
        before: { severity: doc.severity, priority: doc.priority, suspected_type: doc.suspected_type },
        after: { severity: updated.severity, priority: updated.priority, suspected_type: updated.suspected_type },
        reason: host.redactor.redactText(input.reason).text,
      });
    });
    return show(host, input.defect_id);
  },
});

const defectsShow = defineOperation<{ defect_id: string }, unknown>({
  name: "defects.show",
  title: "Show a defect",
  description: "A defect as the contract states it, with every transition: from, to, who, when and why.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["defect_id"], properties: { defect_id: DEFECT_ID } },
  run: ({ host }, input) => show(host, input.defect_id),
});

const defectsList = defineOperation<{ project_id: string; state?: string; run_id?: string }, unknown>({
  name: "defects.list",
  title: "List defects",
  description: "The project's defects, optionally of one state or one run, most severe first.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id"],
    properties: { project_id: ID, state: { enum: STATES }, run_id: RUN_ID },
  },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const order = ["critical", "major", "minor", "trivial"];
    const docs = (
      host.state.db
        .prepare("SELECT doc_json FROM defects WHERE project_id = ? ORDER BY created_at, id")
        .all(project.id) as Array<{
        doc_json: string;
      }>
    )
      .map((r) => JSON.parse(r.doc_json) as DefectDoc)
      .filter((d) => (!input.state || d.state === input.state) && (!input.run_id || d.links.run_id === input.run_id))
      .sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
    return {
      project_id: project.id,
      defects: docs.map((d) => ({
        defect_id: d.defect_id,
        title: d.title.value,
        state: d.state,
        severity: d.severity,
        priority: d.priority,
        suspected_type: d.suspected_type,
        links: d.links,
      })),
    };
  },
});

/** Defect IDs per scenario of a run, for its case results (Contract Specification §6.3). */
export function defectIdsOf(host: Host, runId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of host.state.db
    .prepare(
      "SELECT id, links_json FROM defects WHERE json_extract(links_json, '$.run_id') = ? ORDER BY created_at, id",
    )
    .all(runId) as Array<{ id: string; links_json: string }>) {
    const scenario = (JSON.parse(r.links_json) as { scenario_id: string }).scenario_id;
    out.set(scenario, [...(out.get(scenario) ?? []), r.id]);
  }
  return out;
}

export const DEFECT_OPERATIONS = [defectsCreate, defectsTransition, defectsUpdate, defectsShow, defectsList];
