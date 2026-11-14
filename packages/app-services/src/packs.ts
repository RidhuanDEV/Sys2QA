import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validateDocument } from "@sys2qa/contract";
import { appendAudit, localIdPart, projectDirectory } from "@sys2qa/platform";
import {
  DECLARED_ENVIRONMENT_PLACEHOLDER,
  renderManualPack,
  resultInstructions,
  resultTemplate,
  type ManualPack,
  type Scenario,
} from "@sys2qa/qaa-core";
import { serviceError, ServiceError, SERVICE_ERRORS } from "./errors.js";
import { caseOutcome } from "./manual-runs.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const PATH = { type: "string", minLength: 1, maxLength: 4096 } as const;
const LANGUAGE = { type: "string", pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" } as const;
const RESULT_MAX_BYTES = 4 * 1024 * 1024;

interface PackRow {
  id: string;
  project_id: string;
  run_id: string;
  language: string;
  doc_json: string;
  path: string;
  imported_at: string | null;
  created_at: string;
}

/** A path inside (or equal to) any of the roots. */
const insideAny = (path: string, roots: string[]) =>
  roots.some((root) => {
    const r = relative(resolve(root), resolve(path));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  });

const packsExport = defineOperation<
  { project_id: string; scenario_ids: string[]; language?: string; output_dir?: string },
  unknown
>({
  name: "packs.export",
  title: "Export a manual test pack",
  description:
    "Exports approved scenarios as a manual test pack (QAA-FR-112, SYS-003) that a tester runs in any environment they can use, with nothing configured in Sys2QA: `pack.json` (the `manual-test-pack` contract document), `pack.md` (the same scenarios to follow by hand, in the pack's language) and `result-template.json` (a `run-result` to fill in and import back). Every scenario's latest version must be approved for manual execution. The pack is written under the project's home directory, or to an absolute output directory outside the analyzed repositories.",
  level: "none",
  effect: "write",
  paths: (input) => (input.output_dir ? [input.output_dir] : []),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "scenario_ids"],
    properties: {
      project_id: ID,
      scenario_ids: { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: ID },
      language: LANGUAGE,
      output_dir: PATH,
    },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    if (input.output_dir !== undefined && !isAbsolute(input.output_dir))
      throw serviceError("INPUT_INVALID", "the output directory must be absolute", { field: "output_dir" });
    const roots = host.projects
      .listEvidenceSources(project.id)
      .filter((s) => s.kind === "source_root")
      .map((s) => s.ref);
    if (input.output_dir && insideAny(input.output_dir, roots))
      throw new ServiceError(
        "EXPORT_REFUSED",
        "conflict",
        "a manual test pack is never written into an analyzed repository",
        SERVICE_ERRORS.EXPORT_REFUSED!.remediation,
        { reason: "inside_analyzed_repository" },
      );
    const cases = input.scenario_ids.map((id) => {
      const row = host.state.db
        .prepare(
          `SELECT s.project_id, v.version, v.status, v.doc_json FROM scenarios s
           JOIN scenario_versions v ON v.scenario_id = s.scenario_id AND v.version = s.latest_version WHERE s.scenario_id = ?`,
        )
        .get(id) as { project_id: string; version: number; status: string; doc_json: string } | undefined;
      if (!row || row.project_id !== project.id) throw serviceError("NOT_FOUND", `no scenario ${id} in this project`);
      const approval = host.state.db
        .prepare(
          "SELECT id FROM approvals WHERE scenario_id = ? AND version = ? AND mode = 'manual' AND state = 'active' ORDER BY approved_at DESC LIMIT 1",
        )
        .get(id, row.version) as { id: string } | undefined;
      if (row.status !== "approved" || !approval)
        throw new ServiceError(
          "APPROVAL_REQUIRED",
          "denied",
          `${id} version ${row.version} has no active approval for manual execution`,
          "Approve the latest version of each scenario for manual execution, then export the pack.",
          { scenario_id: id, version: row.version, status: row.status },
        );
      return { scenario: JSON.parse(row.doc_json) as Scenario, approval_id: approval.id };
    });
    const baselines = new Set(cases.map((c) => JSON.stringify(c.scenario.baseline.packages)));
    if (baselines.size > 1)
      throw serviceError("CONFLICT", "the scenarios rest on different package baselines; export one pack per baseline");
    const language = input.language ?? cases[0]!.scenario.content_language;
    const glossary = host.glossary.get(language) ?? host.glossary.get("en")!;
    const packId = host.newId("mpack");
    const runId = host.newId("mrun");
    const createdAt = host
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const pack: ManualPack = {
      contract: "sys2qa.manual-test-pack",
      schema_version: "1.0.0",
      pack_id: packId,
      created_at: createdAt,
      content_language: language,
      glossary_version: glossary.version,
      scenarios: cases.map((c) => c.scenario),
      approval_ids: cases.map((c) => c.approval_id),
      result_template: {
        schema: "https://sys2qa.dev/schemas/run-result/1.0.json",
        instructions: resultInstructions(language),
      },
    };
    const template = resultTemplate({ runId, createdAt, language, cases });
    for (const [name, doc] of [
      ["manual-test-pack", pack],
      ["run-result", template],
    ] as const) {
      const check = validateDocument(name, doc);
      if (!check.ok)
        throw new ServiceError(
          "INTERNAL_ERROR",
          "internal",
          `the ${name} document does not match its contract schema`,
          "Report it with the listed issues.",
          { issues: check.issues.slice(0, 10).map((i) => i.message) },
        );
    }
    const dir = join(input.output_dir ?? join(projectDirectory(host.home, project.id), "packs"), localIdPart(packId));
    if (existsSync(dir)) throw serviceError("CONFLICT", `${dir} already exists`);
    mkdirSync(dir, { recursive: true });
    const approvals = new Map(cases.map((c) => [c.scenario.scenario_id, c.approval_id]));
    const terms = (glossary as { terms?: Record<string, Record<string, string>> }).terms ?? {};
    writeFileSync(join(dir, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
    writeFileSync(join(dir, "pack.md"), renderManualPack(pack, approvals, terms));
    writeFileSync(join(dir, "result-template.json"), `${JSON.stringify(template, null, 2)}\n`);
    const at = host.now().toISOString();
    host.state.transaction(() => {
      host.state.db
        .prepare(
          "INSERT INTO manual_test_packs (id, project_id, run_id, language, doc_json, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(packId, project.id, runId, language, JSON.stringify(pack), dir, at, at);
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "pack.exported",
          target: packId,
          details: {
            run_id: runId,
            scenarios: cases.map((c) => [c.scenario.scenario_id, c.scenario.version]),
            language,
          },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return {
      pack_id: packId,
      run_id: runId,
      path: dir,
      files: ["pack.json", "pack.md", "result-template.json"],
      language,
      glossary: `${language}@${glossary.version}`,
      scenarios: cases.length,
      environment_needed: false,
    };
  },
});

interface ImportedStep {
  step_id: string;
  status: "pass" | "fail" | "blocked" | "not_applicable" | "not_run";
  expected?: string;
  actual?: string;
  notes?: string;
  evidence_refs?: string[];
}
interface ImportedCase {
  scenario_id: string;
  version: number;
  approval_id: string;
  outcome: string;
  reported_by: string;
  reason?: string;
  steps: ImportedStep[];
}

const packsImport = defineOperation<
  { project_id: string; path?: string; result?: Record<string, unknown>; tester?: string },
  unknown
>({
  name: "packs.import_results",
  title: "Import manual test pack results",
  description:
    "Imports a filled-in result template of a manual test pack (QAA-FR-112): a `run-result` document of the pack's run, reported by the tester, with the environment the tester declares (the placeholder is refused). Every case must be one of the pack's scenario versions with its approval, every step accounted for, each outcome consistent with its steps, and every failed step must state its actual result. The results become that manual run, labeled tester-reported and linked to the declared environment; a pack imports once.",
  level: "none",
  effect: "write",
  paths: (input) => (input.path ? [input.path] : []),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id"],
    properties: {
      project_id: ID,
      path: PATH,
      result: { type: "object" },
      tester: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    if ((input.path === undefined) === (input.result === undefined))
      throw serviceError("INPUT_INVALID", "give either the path of the filled-in result file or the result itself", {
        field: "path",
      });
    let doc: Record<string, unknown>;
    if (input.path !== undefined) {
      if (!isAbsolute(input.path))
        throw serviceError("INPUT_INVALID", "the result file path must be absolute", { field: "path" });
      if (!existsSync(input.path) || !statSync(input.path).isFile())
        throw serviceError("NOT_FOUND", `no result file at ${input.path}`, { field: "path" });
      if (statSync(input.path).size > RESULT_MAX_BYTES)
        throw serviceError("INPUT_INVALID", "the result file is larger than 4 MB", { field: "path" });
      try {
        doc = JSON.parse(readFileSync(input.path, "utf8")) as Record<string, unknown>;
      } catch {
        throw serviceError("INPUT_INVALID", "the result file is not JSON", { field: "path" });
      }
    } else doc = input.result!;
    const invalid = (message: string, details: Record<string, unknown> = {}) =>
      new ServiceError(
        "RESULT_INCOMPLETE",
        "invalid_input",
        message,
        "Correct the result file as its instructions say, then import it again.",
        details,
      );
    const check = validateDocument("run-result", doc);
    if (!check.ok)
      throw invalid("the result does not match the run-result contract", {
        issues: check.issues.slice(0, 20).map((i) => `${i.json_pointer ?? ""} ${i.message}`.trim()),
      });
    const pack = host.state.db.prepare("SELECT * FROM manual_test_packs WHERE run_id = ?").get(doc.run_id) as
      PackRow | undefined;
    if (!pack || pack.project_id !== project.id)
      throw serviceError("NOT_FOUND", `no manual test pack of this project issued run ${String(doc.run_id)}`);
    if (pack.imported_at || host.state.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(pack.run_id))
      throw serviceError("CONFLICT", `the results of pack ${pack.id} were already imported`);
    if (doc.kind !== "manual") throw invalid("a manual test pack's results are a manual run");
    if (!["completed", "abandoned"].includes(String(doc.state)))
      throw invalid("the result state must be completed or abandoned", { field: "state" });
    const environment = doc.environment as { declared?: { name: string; url?: string; version?: string } };
    if (!environment.declared)
      throw invalid("a manual test pack is run in a declared environment", { field: "environment" });
    if (environment.declared.name.trim() === "" || environment.declared.name === DECLARED_ENVIRONMENT_PLACEHOLDER)
      throw invalid("declare the environment you tested in (replace the placeholder name)", {
        field: "environment.declared.name",
      });

    const packDoc = JSON.parse(pack.doc_json) as ManualPack;
    const expected = new Map(
      packDoc.scenarios.map((s, i) => [s.scenario_id, { scenario: s, approval_id: packDoc.approval_ids[i]! }]),
    );
    const cases = doc.cases as ImportedCase[];
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const c of cases) {
      const want = expected.get(c.scenario_id);
      if (!want) {
        problems.push(`${c.scenario_id} is not in the pack`);
        continue;
      }
      seen.add(c.scenario_id);
      if (c.version !== want.scenario.version)
        problems.push(`${c.scenario_id}: version ${c.version} is not the pack's`);
      if (c.approval_id !== want.approval_id)
        problems.push(`${c.scenario_id}: approval ${c.approval_id} is not the pack's`);
      const stepIds = want.scenario.steps.map((s) => s.step_id);
      if (JSON.stringify(c.steps.map((s) => s.step_id)) !== JSON.stringify(stepIds))
        problems.push(`${c.scenario_id}: the steps must be ${stepIds.join(", ")} in that order`);
      for (const [i, s] of c.steps.entries()) {
        const step = want.scenario.steps[i];
        if (s.status === "fail" && !s.actual?.trim())
          problems.push(`${c.scenario_id} ${s.step_id}: a failed step needs actual`);
        if (s.status === "blocked" && !s.notes?.trim())
          problems.push(`${c.scenario_id} ${s.step_id}: a blocked step needs notes`);
        if (s.status === "not_applicable" && step?.expected_result)
          problems.push(`${c.scenario_id} ${s.step_id}: a step with an expected result cannot be not_applicable`);
      }
      const derived = caseOutcome(c.steps.map((s) => s.status));
      if (c.outcome !== derived)
        problems.push(`${c.scenario_id}: outcome ${c.outcome} contradicts its steps (${derived})`);
      if (doc.state === "completed" && c.steps.some((s) => s.status === "not_run"))
        problems.push(`${c.scenario_id}: a completed run has no not_run step; mark the run abandoned with a reason`);
      if (doc.state === "abandoned" && !c.reason?.trim())
        problems.push(`${c.scenario_id}: an abandoned run needs a reason`);
    }
    for (const id of expected.keys()) if (!seen.has(id)) problems.push(`${id} is missing`);
    if (problems.length > 0)
      throw invalid(`${problems.length} problem(s) in the result`, { problems: problems.slice(0, 50) });

    const tester = input.tester ?? caller.actor;
    const at = host.now().toISOString();
    const redact = (text?: string) => (text === undefined ? undefined : host.redactor.redactText(text).text);
    const startedAt = String(doc.started_at);
    const finishedAt = typeof doc.finished_at === "string" ? doc.finished_at : at;
    const reason = cases.find((c) => c.reason)?.reason;
    host.state.transaction(() => {
      host.state.db
        .prepare(
          `INSERT INTO runs (id, project_id, kind, state, environment_json, baseline_json, binding_json, language, tester, abandon_reason, started_at, finished_at, created_at, updated_at)
           VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pack.run_id,
          project.id,
          doc.state,
          JSON.stringify({ declared: environment.declared }),
          JSON.stringify(doc.baseline),
          JSON.stringify({ mode: "manual", source: "manual_test_pack", pack_id: pack.id }),
          pack.language,
          tester,
          doc.state === "abandoned" ? (redact(reason) ?? "abandoned") : null,
          startedAt,
          finishedAt,
          at,
          at,
        );
      const insertCase = host.state.db.prepare(
        "INSERT INTO run_cases (run_id, project_id, position, scenario_id, version, approval_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertStep = host.state.db.prepare(
        `INSERT INTO step_results (id, run_id, project_id, scenario_id, version, step_id, doc_json, recorded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertResult = host.state.db.prepare(
        "INSERT INTO case_results (id, run_id, project_id, scenario_id, version, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      cases.forEach((c, i) => {
        insertCase.run(pack.run_id, project.id, i + 1, c.scenario_id, c.version, c.approval_id);
        const steps = c.steps.map((s) => ({
          ...s,
          ...(s.actual !== undefined ? { actual: redact(s.actual) } : {}),
          ...(s.notes !== undefined ? { notes: redact(s.notes) } : {}),
        }));
        for (const s of steps)
          if (s.status !== "not_run")
            insertStep.run(
              host.newId("stepres"),
              pack.run_id,
              project.id,
              c.scenario_id,
              c.version,
              s.step_id,
              JSON.stringify({
                step_id: s.step_id,
                status: s.status,
                ...(s.actual ? { actual: s.actual } : {}),
                ...(s.notes ? { notes: s.notes } : {}),
                ...(s.evidence_refs?.length ? { evidence_refs: s.evidence_refs } : {}),
                recorded_by: tester,
                recorded_at: finishedAt,
              }),
              tester,
              at,
              at,
            );
        insertResult.run(
          host.newId("caseres"),
          pack.run_id,
          project.id,
          c.scenario_id,
          c.version,
          JSON.stringify({ ...c, steps, reported_by: "tester", ...(c.reason ? { reason: redact(c.reason) } : {}) }),
          at,
          at,
        );
      });
      host.state.db
        .prepare("UPDATE manual_test_packs SET imported_at = ?, updated_at = ? WHERE id = ?")
        .run(at, at, pack.id);
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "run.imported",
          target: pack.run_id,
          details: {
            pack_id: pack.id,
            tester,
            environment: environment.declared,
            outcomes: cases.map((c) => [c.scenario_id, c.outcome]),
          },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return {
      run_id: pack.run_id,
      pack_id: pack.id,
      state: doc.state,
      label: "tester-reported",
      environment: { declared: environment.declared },
      outcomes: cases.map((c) => ({ scenario_id: c.scenario_id, outcome: c.outcome })),
    };
  },
});

const packsList = defineOperation<{ project_id: string }, unknown>({
  name: "packs.list",
  title: "List manual test packs",
  description:
    "The project's exported manual test packs, newest first, with where they were written and whether their results were imported.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["project_id"], properties: { project_id: ID } },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const rows = host.state.db
      .prepare("SELECT * FROM manual_test_packs WHERE project_id = ? ORDER BY created_at DESC, id DESC")
      .all(project.id) as PackRow[];
    return {
      project_id: project.id,
      packs: rows.map((r) => ({
        pack_id: r.id,
        run_id: r.run_id,
        language: r.language,
        path: r.path,
        scenarios: (JSON.parse(r.doc_json) as ManualPack).scenarios.length,
        created_at: r.created_at,
        imported_at: r.imported_at,
      })),
    };
  },
});

export const PACK_OPERATIONS = [packsExport, packsImport, packsList];
