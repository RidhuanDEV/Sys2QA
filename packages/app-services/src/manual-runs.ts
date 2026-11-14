import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDocument } from "@sys2qa/contract";
import { appendAudit, canonicalJson, projectDirectory, type AuditAction } from "@sys2qa/platform";
import type { Scenario } from "@sys2qa/qaa-core";
import { serviceError, ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";
import { BINDING_INPUT, checkExecution, type Binding } from "./review.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const RUN_ID = { type: "string", pattern: "^mrun:[0-9A-HJKMNP-TV-Z]{26}$" } as const;
const STEP_ID = { type: "string", pattern: "^S[0-9]+$" } as const;
const TEXT = { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } as const;
const LANGUAGE = { type: "string", pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" } as const;
/** Manual evidence uploads are type- and size-limited (SEC-019). */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

type StepStatus = "pass" | "fail" | "blocked" | "not_applicable" | "not_run";
type CaseOutcome = "passed" | "failed" | "blocked" | "inconclusive" | "not_run";

interface RunRow {
  id: string;
  project_id: string;
  kind: string;
  state: string;
  environment_json: string;
  baseline_json: string;
  binding_json: string;
  language: string;
  tester: string;
  baseline_changed: number;
  abandon_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
}
interface CaseRow {
  position: number;
  scenario_id: string;
  version: number;
  approval_id: string;
}
interface StepRecord {
  step_id: string;
  status: Exclude<StepStatus, "not_run">;
  actual?: string;
  notes?: string;
  evidence_refs?: string[];
  recorded_by: string;
  recorded_at: string;
}

function runRow(host: Host, runId: string): RunRow {
  const row = host.state.db.prepare("SELECT * FROM runs WHERE id = ? AND kind = 'manual'").get(runId) as
    RunRow | undefined;
  if (!row) throw serviceError("NOT_FOUND", `no manual run ${runId}`);
  return row;
}

function casesOf(host: Host, runId: string): Array<CaseRow & { doc: Scenario }> {
  return (
    host.state.db
      .prepare(
        `SELECT c.position, c.scenario_id, c.version, c.approval_id, v.doc_json FROM run_cases c
         JOIN scenario_versions v ON v.scenario_id = c.scenario_id AND v.version = c.version
         WHERE c.run_id = ? ORDER BY c.position`,
      )
      .all(runId) as Array<CaseRow & { doc_json: string }>
  ).map(({ doc_json, ...c }) => ({ ...c, doc: JSON.parse(doc_json) as Scenario }));
}

/** The latest record of each step of a run (earlier records are superseded, never changed). */
function latestSteps(host: Host, runId: string): Map<string, StepRecord & { id: string }> {
  const rows = host.state.db
    .prepare(
      `SELECT r.id, r.scenario_id, r.step_id, r.doc_json FROM step_results r
       WHERE r.run_id = ? AND NOT EXISTS (SELECT 1 FROM step_results n WHERE n.supersedes = r.id)`,
    )
    .all(runId) as Array<{ id: string; scenario_id: string; step_id: string; doc_json: string }>;
  return new Map(
    rows.map((r) => [`${r.scenario_id}\0${r.step_id}`, { id: r.id, ...(JSON.parse(r.doc_json) as StepRecord) }]),
  );
}

function attachmentsOf(host: Host, runId: string) {
  return host.state.db
    .prepare(
      "SELECT id, scenario_id, step_id, sha256, name, media_type, size_bytes, redacted, created_at FROM run_attachments WHERE run_id = ? ORDER BY created_at, id",
    )
    .all(runId) as Array<{
    id: string;
    scenario_id: string;
    step_id: string;
    sha256: string;
    name: string;
    media_type: string;
    size_bytes: number;
    redacted: number;
    created_at: string;
  }>;
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

function stateError(run: RunRow, wanted: string): ServiceError {
  return new ServiceError(
    "RUN_STATE_INVALID",
    "conflict",
    `manual run ${run.id} is ${run.state}; this needs it ${wanted}`,
    run.state === "paused" ? "Resume the run first." : "Start a new manual run for further testing.",
    { state: run.state },
  );
}

/** Whether the project's baseline moved on since the run started (PRD §16: the run continues, flagged). */
function baselineMoved(host: Host, run: RunRow): boolean {
  if (run.baseline_changed) return true;
  const baseline = JSON.parse(run.baseline_json) as {
    packages: Array<{ package_id: string; package_version: number }>;
  };
  return baseline.packages.some((p) => {
    const latest = host.state.db
      .prepare("SELECT MAX(version) AS v FROM packages WHERE project_id = ? AND package_id = ?")
      .get(run.project_id, p.package_id) as { v: number | null };
    return latest.v !== null && latest.v !== p.package_version;
  });
}

/** A step without an expected result (setup, navigation) may be not applicable; an expected result never is. */
const mayBeNotApplicable = (step: Scenario["steps"][number]) => step.expected_result === null;

function caseOutcome(statuses: StepStatus[]): CaseOutcome {
  if (statuses.includes("fail")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.every((s) => s === "not_run")) return "not_run";
  if (statuses.includes("not_run")) return "inconclusive";
  return "passed";
}

/** The run as the contract states it (`run-result`, Contract Specification §6.3); manual results are tester-reported. */
function runResult(host: Host, run: RunRow): Record<string, unknown> {
  const steps = latestSteps(host, run.id);
  const finished = ["completed", "abandoned"].includes(run.state);
  return {
    schema_version: "1.0.0",
    run_id: run.id,
    kind: "manual",
    state: run.state,
    environment: JSON.parse(run.environment_json) as unknown,
    baseline: JSON.parse(run.baseline_json) as unknown,
    started_at: run.started_at,
    ...(run.finished_at ? { finished_at: run.finished_at } : {}),
    locale: run.language,
    cases: casesOf(host, run.id).map((c) => {
      const results = c.doc.steps.map((step) => {
        const r = steps.get(`${c.scenario_id}\0${step.step_id}`);
        const status: StepStatus = r?.status ?? "not_run";
        return {
          step_id: step.step_id,
          status,
          ...(step.expected_result ? { expected: step.expected_result.description.value } : {}),
          ...(r?.actual ? { actual: r.actual } : {}),
          ...(r?.evidence_refs?.length ? { evidence_refs: r.evidence_refs } : {}),
          ...(r?.notes ? { notes: r.notes } : {}),
        };
      });
      const outcome = caseOutcome(results.map((s) => s.status));
      return {
        scenario_id: c.scenario_id,
        version: c.version,
        approval_id: c.approval_id,
        outcome,
        reported_by: "tester",
        steps: results,
        ...(run.state === "abandoned" && run.abandon_reason && finished ? { reason: run.abandon_reason } : {}),
      };
    }),
  };
}

/** The run with each case's scenario text, step results and attachments, as the manual runner shows it. */
function showRun(host: Host, run: RunRow, language?: string) {
  const steps = latestSteps(host, run.id);
  const attachments = attachmentsOf(host, run.id);
  const cases = casesOf(host, run.id);
  let total = 0;
  let recorded = 0;
  const shownLanguages = new Set<string>();
  const view = cases.map((c) => {
    shownLanguages.add(c.doc.content_language);
    const statuses = c.doc.steps.map((step) => steps.get(`${c.scenario_id}\0${step.step_id}`)?.status ?? "not_run");
    return {
      // So far: from the steps recorded; final once the run is completed or abandoned.
      outcome: caseOutcome(statuses),
      position: c.position,
      scenario_id: c.scenario_id,
      version: c.version,
      approval_id: c.approval_id,
      display_key: c.doc.display_key,
      title: c.doc.title.value,
      content_language: c.doc.content_language,
      qa_objective: c.doc.qa_objective,
      priority: c.doc.priority,
      risk: c.doc.risk,
      state_changing: c.doc.state_changing,
      preconditions: c.doc.preconditions.map((p) => p.text.value),
      // Test data is shown as written in the scenario: descriptions and secret references, never secret values.
      test_data: c.doc.test_data,
      cleanup: c.doc.cleanup,
      steps: c.doc.steps.map((step) => {
        total++;
        const r = steps.get(`${c.scenario_id}\0${step.step_id}`);
        if (r) recorded++;
        return {
          step_id: step.step_id,
          instruction: step.instruction.value,
          expected_result: step.expected_result
            ? {
                description: step.expected_result.description.value,
                basis: step.expected_result.basis,
                oracle_class: step.expected_result.oracle_class,
              }
            : null,
          not_applicable_allowed: mayBeNotApplicable(step),
          result: r
            ? {
                status: r.status,
                actual: r.actual ?? null,
                notes: r.notes ?? null,
                evidence_refs: r.evidence_refs ?? [],
                recorded_by: r.recorded_by,
                recorded_at: r.recorded_at,
              }
            : null,
          attachments: attachments
            .filter((a) => a.scenario_id === c.scenario_id && a.step_id === step.step_id)
            .map((a) => ({
              evidence_ref: a.id,
              name: a.name,
              media_type: a.media_type,
              size_bytes: a.size_bytes,
              sha256: a.sha256,
              redacted: a.redacted === 1,
            })),
        };
      }),
    };
  });
  const requested = language ?? run.language;
  const unavailable = [...shownLanguages].filter((l) => l !== requested);
  return {
    run: {
      run_id: run.id,
      kind: "manual",
      state: run.state,
      tester: run.tester,
      reported_by: "tester",
      label: "tester-reported",
      environment: JSON.parse(run.environment_json) as unknown,
      baseline: JSON.parse(run.baseline_json) as unknown,
      baseline_changed: baselineMoved(host, run),
      started_at: run.started_at,
      finished_at: run.finished_at,
      abandon_reason: run.abandon_reason,
    },
    language: {
      requested,
      shown: [...shownLanguages],
      // Step identity never depends on the language; a version written in another language is shown as written.
      fallback: unavailable.length > 0,
    },
    progress: { steps_total: total, steps_recorded: recorded },
    cases: view,
  };
}

function touch(host: Host, runId: string, fields: Record<string, unknown>) {
  const sets = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(", ");
  host.state.db
    .prepare(`UPDATE runs SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(fields), host.now().toISOString(), runId);
}

const runsStart = defineOperation<
  {
    project_id: string;
    scenario_ids: string[];
    environment_id?: string;
    declared_environment?: string;
    declared_environment_url?: string;
    declared_environment_version?: string;
    test_data_profile?: string;
    language?: string;
    tester?: string;
  },
  unknown
>({
  name: "runs.start_manual",
  title: "Start a manual run",
  description:
    "Starts a manual run of approved scenarios (QAA-FR-080, PRD §16): every scenario must pass the same execution gate as automation (approval active and matching the current baseline, the environment and the test-data profile; QAA-FR-054). The run is bound to the scenario versions, their approvals, the baseline and the environment, configured or declared (name, URL and version if known). Results are tester-reported.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "scenario_ids"],
    properties: {
      project_id: ID,
      scenario_ids: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: ID },
      environment_id: BINDING_INPUT.environment_id,
      declared_environment: BINDING_INPUT.declared_environment,
      declared_environment_url: { type: "string", format: "uri", maxLength: 2048, pattern: "^https?://" },
      declared_environment_version: { type: "string", minLength: 1, maxLength: 200 },
      test_data_profile: BINDING_INPUT.test_data_profile,
      language: LANGUAGE,
      tester: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    if (!input.environment_id && !input.declared_environment)
      throw serviceError(
        "INPUT_INVALID",
        "name the environment: a configured environment_id or a declared_environment",
        {
          field: "declared_environment",
        },
      );
    const decisions = input.scenario_ids.map((id) =>
      checkExecution(host, {
        scenario_id: id,
        mode: "manual",
        ...(input.environment_id ? { environment_id: input.environment_id } : {}),
        ...(input.declared_environment ? { declared_environment: input.declared_environment } : {}),
        ...(input.test_data_profile ? { test_data_profile: input.test_data_profile } : {}),
      }),
    );
    const foreign = decisions.filter((d) => d.project_id !== project.id).map((d) => d.scenario_id);
    if (foreign.length > 0) throw serviceError("NOT_FOUND", `not in this project: ${foreign.join(", ")}`);
    const refused = decisions.filter((d) => !d.allowed);
    if (refused.length > 0) {
      const first = refused[0]!.issues[0]!;
      throw new ServiceError(
        first.code,
        "denied",
        `${refused.length} scenario(s) may not run manually here: ${refused.map((d) => `${d.scenario_id} (${d.issues.map((i) => i.code).join(", ")})`).join("; ")}`,
        "Approve the exact scenario versions for this baseline, environment and test-data profile, then start the run.",
        { refusals: refused.map((d) => ({ scenario_id: d.scenario_id, version: d.version, issues: d.issues })) },
      );
    }
    const baselines = new Set(decisions.map((d) => canonicalJson(d.baseline)));
    if (baselines.size > 1)
      throw serviceError("CONFLICT", "the scenarios rest on different baselines; start one run per baseline");
    const binding: Binding = decisions[0]!.binding;
    const environment = binding.environment_id
      ? { environment_id: binding.environment_id }
      : {
          declared: {
            name: input.declared_environment!,
            ...(input.declared_environment_url ? { url: input.declared_environment_url } : {}),
            ...(input.declared_environment_version ? { version: input.declared_environment_version } : {}),
          },
        };
    const runId = host.newId("mrun");
    const at = host.now().toISOString();
    const tester = input.tester ?? caller.actor;
    host.state.transaction(() => {
      host.state.db
        .prepare(
          `INSERT INTO runs (id, project_id, kind, state, environment_json, baseline_json, binding_json, language, tester, started_at, created_at, updated_at)
           VALUES (?, ?, 'manual', 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          project.id,
          JSON.stringify(environment),
          JSON.stringify(decisions[0]!.baseline),
          JSON.stringify(binding),
          input.language ?? decisions[0]!.scenario.content_language,
          tester,
          at,
          at,
          at,
        );
      const insert = host.state.db.prepare(
        "INSERT INTO run_cases (run_id, project_id, position, scenario_id, version, approval_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      decisions.forEach((d, i) => insert.run(runId, project.id, i + 1, d.scenario_id, d.version, d.approval_id));
      audit(host, project.id, caller.actor, "run.started", runId, {
        kind: "manual",
        tester,
        scenarios: decisions.map((d) => ({
          scenario_id: d.scenario_id,
          version: d.version,
          approval_id: d.approval_id,
        })),
        environment,
      });
    });
    return showRun(host, runRow(host, runId));
  },
});

const runsShow = defineOperation<{ run_id: string; language?: string }, unknown>({
  name: "runs.show",
  title: "Show a manual run",
  description:
    "A manual run as the runner presents it (QAA-FR-081): each scenario's purpose, risk, preconditions, test data (references, never secret values), steps with their expected results and evidence basis, the recorded results and attachments, progress, the environment and whether the baseline moved on since the run started. Step identity does not depend on the language; a version written in another language is shown as written and flagged.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: { run_id: RUN_ID, language: LANGUAGE },
  },
  run: ({ host }, input) => showRun(host, runRow(host, input.run_id), input.language),
});

const runsList = defineOperation<{ project_id: string; state?: string }, unknown>({
  name: "runs.list",
  title: "List manual runs",
  description: "The project's manual runs, newest first, optionally of one state, with their progress.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id"],
    properties: { project_id: ID, state: { enum: ["running", "paused", "completed", "abandoned"] } },
  },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const rows = host.state.db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND kind = 'manual' ORDER BY created_at DESC, id DESC")
      .all(project.id) as RunRow[];
    return {
      project_id: project.id,
      runs: rows
        .filter((r) => !input.state || r.state === input.state)
        .map((r) => {
          const shown = showRun(host, r);
          return {
            run_id: r.id,
            state: r.state,
            tester: r.tester,
            label: "tester-reported",
            environment: shown.run.environment,
            scenarios: shown.cases.length,
            progress: shown.progress,
            started_at: r.started_at,
            finished_at: r.finished_at,
          };
        }),
    };
  },
});

const runsRecordStep = defineOperation<
  {
    run_id: string;
    scenario_id: string;
    step_id: string;
    status: "pass" | "fail" | "blocked" | "not_applicable";
    actual?: string;
    notes?: string;
    evidence_refs?: string[];
  },
  unknown
>({
  name: "runs.record_step",
  title: "Record a step result",
  description:
    "Records one step of a running manual run (QAA-FR-082, QAA-FR-083): `pass`, `fail`, `blocked` or `not_applicable` (only for a step without an expected result), with the actual result (required for `fail`), notes (the reason, required for `blocked`) and the step's attachments as evidence. Recording a step again supersedes the earlier record; nothing is overwritten. Text passes through secret redaction.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id", "scenario_id", "step_id", "status"],
    properties: {
      run_id: RUN_ID,
      scenario_id: ID,
      step_id: STEP_ID,
      status: { enum: ["pass", "fail", "blocked", "not_applicable"] },
      actual: TEXT,
      notes: TEXT,
      evidence_refs: {
        type: "array",
        maxItems: 50,
        uniqueItems: true,
        items: { type: "string", pattern: "^qevid:[0-9A-HJKMNP-TV-Z]{26}$" },
      },
    },
  },
  run: ({ host, caller }, input) => {
    const run = runRow(host, input.run_id);
    if (run.state !== "running") throw stateError(run, "running");
    const kase = casesOf(host, run.id).find((c) => c.scenario_id === input.scenario_id);
    if (!kase) throw serviceError("NOT_FOUND", `${input.scenario_id} is not part of run ${run.id}`);
    const step = kase.doc.steps.find((s) => s.step_id === input.step_id);
    if (!step) throw serviceError("NOT_FOUND", `${input.scenario_id} has no step ${input.step_id}`);
    const missing = (field: string, why: string) =>
      new ServiceError(
        "RESULT_INCOMPLETE",
        "invalid_input",
        why,
        "Fill in the listed field and record the step again.",
        {
          field,
        },
      );
    if (input.status === "not_applicable" && !mayBeNotApplicable(step))
      throw missing("status", `step ${input.step_id} has an expected result, so it cannot be not applicable`);
    if (input.status === "fail" && !input.actual) throw missing("actual", "a failed step needs the actual result");
    if (input.status === "blocked" && !input.notes) throw missing("notes", "a blocked step needs the reason in notes");
    const known = new Set(
      attachmentsOf(host, run.id)
        .filter((a) => a.scenario_id === input.scenario_id && a.step_id === input.step_id)
        .map((a) => a.id),
    );
    const unknown = (input.evidence_refs ?? []).filter((r) => !known.has(r));
    if (unknown.length > 0)
      throw serviceError("NOT_FOUND", `not attachments of this step: ${unknown.join(", ")}`, {
        field: "evidence_refs",
      });
    const redact = (text?: string) => (text === undefined ? undefined : host.redactor.redactText(text));
    const actual = redact(input.actual);
    const notes = redact(input.notes);
    const at = host.now().toISOString();
    const record: StepRecord = {
      step_id: input.step_id,
      status: input.status,
      ...(actual ? { actual: actual.text } : {}),
      ...(notes ? { notes: notes.text } : {}),
      ...(input.evidence_refs?.length ? { evidence_refs: input.evidence_refs } : {}),
      recorded_by: caller.actor,
      recorded_at: at,
    };
    const previous = latestSteps(host, run.id).get(`${input.scenario_id}\0${input.step_id}`);
    const id = host.newId("stepres");
    host.state.transaction(() => {
      host.state.db
        .prepare(
          `INSERT INTO step_results (id, run_id, project_id, scenario_id, version, step_id, doc_json, supersedes, recorded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          run.id,
          run.project_id,
          kase.scenario_id,
          kase.version,
          input.step_id,
          JSON.stringify(record),
          previous?.id ?? null,
          caller.actor,
          at,
          at,
        );
      if (baselineMoved(host, run) && !run.baseline_changed) touch(host, run.id, { baseline_changed: 1 });
      audit(host, run.project_id, caller.actor, "run.step_recorded", run.id, {
        scenario_id: kase.scenario_id,
        step_id: input.step_id,
        status: input.status,
        supersedes: previous?.id ?? null,
      });
    });
    return {
      run_id: run.id,
      scenario_id: kase.scenario_id,
      step_id: input.step_id,
      status: input.status,
      redacted: Boolean(actual?.redacted || notes?.redacted),
      supersedes: previous?.id ?? null,
    };
  },
});

/** The media type a file's bytes show it to be; the client's claim is not trusted (SEC-019). */
function sniff(bytes: Buffer, name: string): string | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (/\.(txt|log|json|csv|md)$/i.test(name) && !bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return "text/plain";
    } catch {
      return null;
    }
  }
  return null;
}

const runsAttach = defineOperation<
  { run_id: string; scenario_id: string; step_id: string; name: string; content_base64: string },
  unknown
>({
  name: "runs.attach",
  title: "Attach evidence to a step",
  description: `Stores a screenshot or file a tester attaches to a step of a running manual run (QAA-FR-083), as QAA evidence (\`qevid:\`) in the project's content-addressed blob store. Only PNG, JPEG, GIF, WebP, PDF and UTF-8 text (.txt, .log, .json, .csv, .md) up to ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB are accepted, recognized from the bytes, never from the name or a claimed type (SEC-019); text passes through secret redaction. Refer to the returned evidence_ref when recording the step.`,
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id", "scenario_id", "step_id", "name", "content_base64"],
    properties: {
      run_id: RUN_ID,
      scenario_id: ID,
      step_id: STEP_ID,
      name: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^/\\\\\\u0000-\\u001f]+$" },
      content_base64: {
        type: "string",
        minLength: 4,
        maxLength: Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 4,
        pattern: "^[A-Za-z0-9+/]+={0,2}$",
      },
    },
  },
  run: ({ host, caller }, input) => {
    const run = runRow(host, input.run_id);
    if (run.state !== "running") throw stateError(run, "running");
    const kase = casesOf(host, run.id).find((c) => c.scenario_id === input.scenario_id);
    if (!kase?.doc.steps.some((s) => s.step_id === input.step_id))
      throw serviceError("NOT_FOUND", `${input.scenario_id} ${input.step_id} is not a step of run ${run.id}`);
    let bytes = Buffer.from(input.content_base64, "base64");
    const refuse = (why: string) =>
      new ServiceError(
        "ATTACHMENT_REFUSED",
        "invalid_input",
        why,
        "Attach a PNG, JPEG, GIF, WebP or PDF file, or UTF-8 text (.txt, .log, .json, .csv, .md), of at most 5 MB.",
        { name: input.name },
      );
    if (bytes.length === 0) throw refuse("the file is empty");
    if (bytes.length > ATTACHMENT_MAX_BYTES) throw refuse(`the file is larger than ${ATTACHMENT_MAX_BYTES} bytes`);
    const mediaType = sniff(bytes, input.name);
    if (!mediaType) throw refuse("this kind of file is not accepted as manual evidence");
    let redacted = false;
    if (mediaType === "text/plain") {
      const r = host.redactor.redactText(bytes.toString("utf8"));
      redacted = r.redacted;
      bytes = Buffer.from(r.text, "utf8");
    }
    const hex = createHash("sha256").update(bytes).digest("hex");
    const dir = join(projectDirectory(host.home, run.project_id), "blobs", hex.slice(0, 2));
    const file = join(dir, hex);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, file);
    }
    const id = host.newId("qevid");
    const at = host.now().toISOString();
    host.state.transaction(() => {
      host.state.db
        .prepare(
          `INSERT INTO run_attachments (id, run_id, project_id, scenario_id, step_id, sha256, name, media_type, size_bytes, redacted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          run.id,
          run.project_id,
          input.scenario_id,
          input.step_id,
          `sha256:${hex}`,
          input.name,
          mediaType,
          bytes.length,
          redacted ? 1 : 0,
          at,
          at,
        );
      audit(host, run.project_id, caller.actor, "run.attachment_added", run.id, {
        evidence_ref: id,
        scenario_id: input.scenario_id,
        step_id: input.step_id,
        media_type: mediaType,
        size_bytes: bytes.length,
        sha256: `sha256:${hex}`,
      });
    });
    return {
      evidence_ref: id,
      sha256: `sha256:${hex}`,
      media_type: mediaType,
      size_bytes: bytes.length,
      redacted,
    };
  },
});

function transition(
  name: "runs.pause" | "runs.resume",
  from: string,
  to: string,
  action: AuditAction,
  description: string,
) {
  return defineOperation<{ run_id: string }, unknown>({
    name,
    title: name === "runs.pause" ? "Pause a manual run" : "Resume a manual run",
    description,
    level: "none",
    effect: "write",
    input: { type: "object", additionalProperties: false, required: ["run_id"], properties: { run_id: RUN_ID } },
    run: ({ host, caller }, input) => {
      const run = runRow(host, input.run_id);
      if (run.state !== from) throw stateError(run, from);
      host.state.transaction(() => {
        touch(host, run.id, { state: to, ...(baselineMoved(host, run) ? { baseline_changed: 1 } : {}) });
        audit(host, run.project_id, caller.actor, action, run.id, {});
      });
      return showRun(host, runRow(host, run.id));
    },
  });
}

const runsPause = transition(
  "runs.pause",
  "running",
  "paused",
  "run.paused",
  "Pauses a running manual run; every recorded step and attachment is kept (QAA-FR-085).",
);
const runsResume = transition(
  "runs.resume",
  "paused",
  "running",
  "run.resumed",
  "Resumes a paused manual run with its progress restored (QAA-FR-085). If the project's baseline moved on meanwhile, the run continues and is flagged.",
);

/** Ends a run: writes one case result per scenario, the run's final state, and returns the contract document. */
function finish(host: Host, run: RunRow, state: "completed" | "abandoned", actor: string, reason?: string) {
  const at = host.now().toISOString();
  host.state.transaction(() => {
    touch(host, run.id, {
      state,
      finished_at: at,
      ...(reason ? { abandon_reason: reason } : {}),
      ...(baselineMoved(host, run) ? { baseline_changed: 1 } : {}),
    });
    const ended = runRow(host, run.id);
    const doc = runResult(host, ended);
    const check = validateDocument("run-result", doc);
    if (!check.ok)
      throw new ServiceError(
        "INTERNAL_ERROR",
        "internal",
        "the run result does not match its contract schema",
        "Report it with the listed issues.",
        { issues: check.issues.slice(0, 10).map((i) => i.message) },
      );
    const insert = host.state.db.prepare(
      "INSERT INTO case_results (id, run_id, project_id, scenario_id, version, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of doc.cases as Array<{ scenario_id: string; version: number }>)
      insert.run(host.newId("caseres"), run.id, run.project_id, c.scenario_id, c.version, JSON.stringify(c), at, at);
    audit(host, run.project_id, actor, state === "completed" ? "run.submitted" : "run.abandoned", run.id, {
      outcomes: (doc.cases as Array<{ scenario_id: string; outcome: string }>).map((c) => [c.scenario_id, c.outcome]),
      ...(reason ? { reason } : {}),
    });
  });
  const ended = runRow(host, run.id);
  return { result: runResult(host, ended), baseline_changed: ended.baseline_changed === 1 };
}

const runsAbandon = defineOperation<{ run_id: string; reason: string }, unknown>({
  name: "runs.abandon",
  title: "Abandon a manual run",
  description:
    "Abandons a running or paused manual run with the reason (QAA-FR-089): steps not recorded become `not_run`, each case gets its outcome from what was recorded, and the run is reported as abandoned.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id", "reason"],
    properties: { run_id: RUN_ID, reason: TEXT },
  },
  run: ({ host, caller }, input) => {
    const run = runRow(host, input.run_id);
    if (run.state !== "running" && run.state !== "paused") throw stateError(run, "running or paused");
    return finish(host, run, "abandoned", caller.actor, host.redactor.redactText(input.reason).text);
  },
});

const runsSubmit = defineOperation<{ run_id: string }, unknown>({
  name: "runs.submit",
  title: "Submit a manual run",
  description:
    "Completes a running manual run once every step of every scenario is recorded (PRD §16 step 6): each case's outcome follows its steps (any `fail` → failed, any `blocked` → blocked, else passed), results are labeled tester-reported (QAA-FR-086), and the run is returned as a `run-result` contract document.",
  level: "none",
  effect: "write",
  input: { type: "object", additionalProperties: false, required: ["run_id"], properties: { run_id: RUN_ID } },
  run: ({ host, caller }, input) => {
    const run = runRow(host, input.run_id);
    if (run.state !== "running") throw stateError(run, "running");
    const steps = latestSteps(host, run.id);
    const missing = casesOf(host, run.id).flatMap((c) =>
      c.doc.steps
        .filter((s) => !steps.has(`${c.scenario_id}\0${s.step_id}`))
        .map((s) => ({ scenario_id: c.scenario_id, step_id: s.step_id })),
    );
    if (missing.length > 0)
      throw new ServiceError(
        "RESULT_INCOMPLETE",
        "invalid_input",
        `${missing.length} step(s) have no result yet`,
        "Record every listed step, or abandon the run with a reason.",
        { missing: missing.slice(0, 100) },
      );
    return finish(host, run, "completed", caller.actor);
  },
});

const runsResult = defineOperation<{ run_id: string }, unknown>({
  name: "runs.result",
  title: "Result of a manual run",
  description:
    "The `run-result` contract document of a manual run (Contract Specification §6.3): environment, baseline, and per scenario version its approval, outcome and step results, always reported by the tester. While the run is open, unrecorded steps read `not_run`.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["run_id"], properties: { run_id: RUN_ID } },
  run: ({ host }, input) => runResult(host, runRow(host, input.run_id)),
});

export const MANUAL_RUN_OPERATIONS = [
  runsStart,
  runsShow,
  runsList,
  runsRecordStep,
  runsAttach,
  runsPause,
  runsResume,
  runsAbandon,
  runsSubmit,
  runsResult,
];
