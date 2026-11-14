import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

/**
 * Gate 3 acceptance (IMP-305, PRD §29.1, Test Strategy §8): one block per checklist item, on F1 as a repository (Mode A)
 * and as an imported package (Mode D), with no environment configured anywhere. `scripts/gate-report.mjs --gate 3`
 * maps these blocks to the checklist.
 */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const F1 = join(REPO, "fixtures", "benchmarks", "F1-repository-only", "repo");
const TIMEOUT = 240_000;
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let work: string;
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "tester@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok)
    throw new Error(`${operation}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data as T;
}

interface Project {
  projectId: string;
  planId: string;
  approved: string[];
}

/** Plans, generates, critiques and approves the admin user list's access cases for manual execution. */
async function prepare(projectId: string, packageId: string, version: number): Promise<Project> {
  const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: projectId,
    package_id: packageId,
    version,
  });
  await call("scenarios.generate", { plan_id: plan.plan.plan_id });
  await call("scenarios.critique", { plan_id: plan.plan.plan_id });
  const pending = (
    await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
      project_id: projectId,
      status: "pending_review",
    })
  ).scenarios.map((s) => s.scenario_id);
  const approved = ["allowed-admin", "denied-customer"].map((item) =>
    pending.find((id) => id.endsWith(`admin.users_access.${item}`))!,
  );
  const preview = await call<{ preview_token: string }>("approvals.preview", {
    project_id: projectId,
    scenario_ids: approved,
    ...DECLARED,
  });
  await call("approvals.approve", {
    project_id: projectId,
    scenario_ids: approved,
    ...DECLARED,
    preview_token: preview.preview_token,
  });
  return { projectId, planId: plan.plan.plan_id, approved };
}

const environments = (projectId: string) =>
  (
    host.state.db
      .prepare("SELECT COUNT(*) AS n FROM evidence_sources WHERE project_id = ? AND kind = 'environment'")
      .get(projectId) as { n: number }
  ).n;

let modeA: Project;
let modeD: Project;
let packagePath: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "sys2qa-gate3-"));
  const repo = join(work, "acme-portal");
  cpSync(F1, repo, { recursive: true });
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
    name: "Acme portal",
    root: repo,
  });
  await call("project.declare", {
    source_id: started.source.id,
    declared_by: "owner@example.com",
    operation_level: "L1",
  });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number; path: string }>("saa.export", {
    run_id: run.run_id,
  });
  packagePath = exported.path;
  modeA = await prepare(started.project.id, exported.package_id, exported.version);
  const imported = await call<{ id: string }>("project.create", { name: "Acme portal (package)" });
  const pkg = await call<{ package: { package_id: string; version: number } }>("package.import", {
    project_id: imported.id,
    path: packagePath,
  });
  modeD = await prepare(imported.id, pkg.package.package_id, pkg.package.version);
}, TIMEOUT);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let runId: string;
let defectId: string;

describe("Gate 3 item 1: a tester completes a manual run with actual results, evidence, pause/resume and a linked defect; results are labeled tester-reported [@req QAA-FR-080] [@req QAA-FR-081] [@req QAA-FR-082] [@req QAA-FR-083] [@req QAA-FR-084] [@req QAA-FR-085] [@req QAA-FR-086] [@req QAA-FR-088]", () => {
  it(
    "runs the approved F1 scenarios step by step, pauses and resumes with progress kept, records a failure with evidence and a defect, and submits",
    async () => {
      const [failing, passing] = modeA.approved;
      expect(
        (
          await raw("runs.start_manual", {
            project_id: modeA.projectId,
            scenario_ids: [failing!],
            declared_environment: "elsewhere",
          })
        ).ok,
      ).toBe(false);
      const started = await call<{
        run: { run_id: string; label: string };
        cases: Array<{ scenario_id: string; steps: Array<{ step_id: string; expected_result: unknown }> }>;
      }>("runs.start_manual", {
        project_id: modeA.projectId,
        scenario_ids: modeA.approved,
        declared_environment: "tester laptop",
        declared_environment_url: "https://staging.acme.example",
      });
      runId = started.run.run_id;
      expect(started.run.label).toBe("tester-reported");
      const record = (scenario: string, step: string, status: string, extra: object = {}) =>
        call("runs.record_step", { run_id: runId, scenario_id: scenario, step_id: step, status, ...extra });

      await record(failing!, "S1", "pass");
      await record(failing!, "S2", "pass");
      await call("runs.pause", { run_id: runId });
      const paused = await call<{ run: { state: string }; progress: { steps_recorded: number } }>("runs.show", {
        run_id: runId,
      });
      expect(paused).toMatchObject({ run: { state: "paused" }, progress: { steps_recorded: 2 } });
      await call("runs.resume", { run_id: runId });
      const evidence = await call<{ evidence_ref: string }>("runs.attach", {
        run_id: runId,
        scenario_id: failing,
        step_id: "S3",
        name: "admin-users.png",
        content_base64: PNG.toString("base64"),
      });
      await record(failing!, "S3", "fail", {
        actual: "The user list returned an error page for the admin.",
        evidence_refs: [evidence.evidence_ref],
      });
      for (const step of ["S1", "S2", "S3"]) await record(passing!, step, "pass");
      const defect = await call<{ defect: { defect_id: string; links: Record<string, unknown>; state: string } }>(
        "defects.create",
        {
          run_id: runId,
          scenario_id: failing,
          step_id: "S3",
          title: "Admin user list fails",
          severity: "major",
          priority: "high",
          suspected_type: "product_defect",
        },
      );
      defectId = defect.defect.defect_id;
      expect(defect.defect).toMatchObject({
        state: "new",
        links: {
          scenario_id: failing,
          scenario_version: 1,
          run_id: runId,
          step_id: "S3",
          evidence_refs: [evidence.evidence_ref],
        },
      });
      const submitted = await call<{ result: Record<string, unknown> }>("runs.submit", { run_id: runId });
      expect(validateDocument("run-result", submitted.result).issues).toEqual([]);
      const cases = submitted.result.cases as Array<{
        scenario_id: string;
        outcome: string;
        reported_by: string;
        defect_ids?: string[];
        steps: Array<{ step_id: string; actual?: string; evidence_refs?: string[] }>;
      }>;
      expect(cases.map((c) => [c.outcome, c.reported_by])).toEqual([
        ["failed", "tester"],
        ["passed", "tester"],
      ]);
      expect(cases[0]!.defect_ids).toEqual([defectId]);
      expect(cases[0]!.steps[2]).toMatchObject({
        actual: expect.stringMatching(/error page/),
        evidence_refs: [evidence.evidence_ref],
      });
      // The defect lifecycle is enforced (CR-070).
      expect((await raw("defects.transition", { defect_id: defectId, to: "closed" })).ok).toBe(false);
      await call("defects.transition", { defect_id: defectId, to: "triaged" });
    },
    TIMEOUT,
  );
});

describe("Gate 3 item 2: Modes A and D export a manual test pack with no environment; results import back with a declared environment [@req QAA-FR-112] [@req SYS-003]", () => {
  for (const [mode, get] of [
    ["A (repository)", () => modeA],
    ["D (imported package)", () => modeD],
  ] as const)
    it(
      `Mode ${mode}: exports a pack, and its filled-in results come back as a tester-reported run in the declared environment`,
      async () => {
        const p = get();
        expect(environments(p.projectId)).toBe(0);
        const pack = await call<{ run_id: string; path: string; environment_needed: boolean }>("packs.export", {
          project_id: p.projectId,
          scenario_ids: p.approved,
        });
        expect(pack.environment_needed).toBe(false);
        expect(
          validateDocument("manual-test-pack", JSON.parse(readFileSync(join(pack.path, "pack.json"), "utf8"))).issues,
        ).toEqual([]);
        const template = JSON.parse(readFileSync(join(pack.path, "result-template.json"), "utf8")) as {
          environment: unknown;
          finished_at?: string;
          cases: Array<{ outcome: string; steps: Array<{ status: string }> }>;
        };
        template.environment = { declared: { name: "Rina laptop against staging", version: "2.4.1" } };
        template.finished_at = "2026-11-14T11:00:00Z";
        for (const c of template.cases) {
          for (const s of c.steps) s.status = "pass";
          c.outcome = "passed";
        }
        const file = join(work, `filled-${p.projectId.slice(-6)}.json`);
        writeFileSync(file, JSON.stringify(template));
        const imported = await call<{ run_id: string; label: string }>("packs.import_results", {
          project_id: p.projectId,
          path: file,
          tester: "Rina",
        });
        expect(imported).toMatchObject({ run_id: pack.run_id, label: "tester-reported" });
        const report = await call<{ path: string }>("reports.generate", { project_id: p.projectId });
        const json = JSON.parse(readFileSync(join(report.path, "report.json"), "utf8")) as {
          results: Array<{
            run_id: string;
            label: string;
            environment: { declared?: { name: string; version?: string } };
          }>;
        };
        const fromPack = json.results.filter((r) => r.run_id === pack.run_id);
        expect(fromPack).toHaveLength(2);
        for (const r of fromPack)
          expect(r).toMatchObject({
            label: "tester-reported",
            environment: { declared: { name: "Rina laptop against staging", version: "2.4.1" } },
          });
        expect(environments(p.projectId)).toBe(0);
      },
      TIMEOUT,
    );
});

describe("Gate 3 item 3: reports state the evidence profile, QA objectives, limitations and coverage relative to the model; en/id artefacts preserve identifiers, numbers and status terms [@req QAA-FR-090] [@req QAA-FR-091] [@req QAA-FR-092] [@req QAA-FR-093] [@req SYS-004] [@req LOC-006]", () => {
  interface Report {
    language: string;
    glossary: string;
    summary: Record<string, number>;
    evidence_profiles: Array<{ profile: { cannot_establish: string[] } }>;
    qa_objectives: Record<string, number>;
    coverage: Array<{ report: { scope_statement: string } }>;
    limitations: Record<string, string[]>;
    results: Array<{ outcome: string; run_id: string }>;
    documents: { runs: unknown[] };
    defects: unknown[];
  }
  const generate = async (language: string) => {
    const r = await call<{ path: string }>("reports.generate", {
      project_id: modeA.projectId,
      plan_id: modeA.planId,
      language,
    });
    return {
      json: JSON.parse(readFileSync(join(r.path, "report.json"), "utf8")) as Report,
      md: readFileSync(join(r.path, "report.md"), "utf8"),
    };
  };

  it(
    "states the evidence profile and its limits, QA objectives, every limitation section and coverage relative to the model",
    async () => {
      const { json, md } = await generate("en");
      expect(json.evidence_profiles[0]!.profile.cannot_establish.length).toBeGreaterThan(0);
      expect(Object.keys(json.qa_objectives)).toContain("implementation_conformance");
      expect(json.coverage[0]!.report.scope_statement).toMatch(/does not measure the completeness of the system/);
      expect(Object.keys(json.limitations).sort()).toEqual([
        "analysis",
        "cannot_establish",
        "coverage_gaps",
        "unresolved_assumptions",
        "unsupported_operations",
      ]);
      for (const section of [
        "## Evidence profile",
        "## QA objectives",
        "## Coverage relative to the model",
        "## Limitations",
      ])
        expect(md).toContain(section);
      expect(json.summary).toMatchObject({ approved: 2, executed: 2 });
      for (const run of json.documents.runs) expect(validateDocument("run-result", run).issues).toEqual([]);
      for (const d of json.defects) expect(validateDocument("defect", d).issues).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "renders the same report and pack in Indonesian with identical identifiers and numbers, and status terms from the glossary",
    async () => {
      const en = await generate("en");
      const id = await generate("id");
      const identifiers = (text: string) =>
        [...text.matchAll(/`([a-z_]+:[^`]+)`/g)]
          .map((m) => m[1])
          .filter((x) => !x!.startsWith("report:"))
          .sort();
      const numbers = (text: string) => [...text.matchAll(/\| (\d+) \|/g)].map((m) => m[1]);
      expect(identifiers(id.md)).toEqual(identifiers(en.md));
      expect(numbers(id.md)).toEqual(numbers(en.md));
      expect(id.json.summary).toEqual(en.json.summary);
      // Status terms: the glossary's Indonesian term, with the code it stands for unchanged.
      expect(en.md).toMatch(/failed \(`failed`\)/i);
      expect(id.md).toContain("Gagal (`failed`)");
      expect(id.json.glossary).toMatch(/^id@\d+\.\d+\.\d+$/);
      const packs = await Promise.all(
        ["en", "id"].map((language) =>
          call<{ path: string }>("packs.export", {
            project_id: modeA.projectId,
            scenario_ids: modeA.approved,
            language,
          }),
        ),
      );
      const [packEn, packId] = packs.map((p) => readFileSync(join(p.path, "pack.md"), "utf8"));
      const packIds = (text: string) =>
        [...text.matchAll(/`((?:scenario|approval|api|actor_role):[^`]+)`/g)].map((m) => m[1]);
      expect(packIds(packId!)).toEqual(packIds(packEn!));
      expect(packId).toContain("Didokumentasikan SAA");
    },
    TIMEOUT,
  );

  it(
    "records the language and the version on every QA artefact it writes [@req LOC-004]",
    async () => {
      const { json } = await generate("id");
      expect(json.language).toBe("id");
      const pack = await call<{ path: string }>("packs.export", {
        project_id: modeA.projectId,
        scenario_ids: modeA.approved,
        language: "id",
      });
      const packDoc = JSON.parse(readFileSync(join(pack.path, "pack.json"), "utf8")) as {
        content_language: string;
        glossary_version: string;
        schema_version: string;
        scenarios: Array<{ content_language: string; schema_version: string }>;
      };
      expect(packDoc).toMatchObject({
        content_language: "id",
        glossary_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      });
      for (const s of packDoc.scenarios) expect(s).toMatchObject({ content_language: "en", schema_version: "1.0.0" });
      const result = await call<{ locale: string; schema_version: string }>("runs.result", { run_id: runId });
      expect(result).toMatchObject({ locale: "en", schema_version: "1.0.0" });
      const defect = await call<{ defect: { title: { language: string }; schema_version: string } }>("defects.show", {
        defect_id: defectId,
      });
      expect(defect.defect).toMatchObject({ title: { language: "en" }, schema_version: "1.0.0" });
      const manifest = JSON.parse(readFileSync(join(packagePath, "manifest.json"), "utf8")) as {
        languages: { default: string; documentation: string[] };
        producer: { version: string };
      };
      expect(manifest.languages.default).toBe("en");
      expect(manifest.producer.version).toMatch(/^\d+\.\d+\.\d+/);
    },
    TIMEOUT,
  );
});
