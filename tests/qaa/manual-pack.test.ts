import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;

interface Exported {
  pack_id: string;
  run_id: string;
  path: string;
  files: string[];
  environment_needed: boolean;
}
interface Template {
  run_id: string;
  state: string;
  finished_at?: string;
  environment: { declared: { name: string; url?: string } };
  cases: Array<{
    scenario_id: string;
    outcome: string;
    reason?: string;
    steps: Array<{ step_id: string; status: string; expected?: string; actual?: string; notes?: string }>;
  }>;
}

// Each test runs whole flows (import, plan, generation, approval, runs); slow CI machines need more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const work = mkdtempSync(join(tmpdir(), "sys2qa-pack-"));
const repo = join(work, "acme-portal");
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok)
    throw new Error(`${operation}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data as T;
}
const code = (r: ServiceResult) => (r.ok ? "ok" : r.error.code);

/** Plans, generates and approves the admin user list's access cases for manual execution in a declared environment. */
async function approveAdminCases(projectId: string, packageId: string, version: number) {
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
  const ids = pending.filter((id) => /admin\.users_access\.(allowed-admin|denied-customer)$/.test(id));
  const preview = await call<{ preview_token: string }>("approvals.preview", {
    project_id: projectId,
    scenario_ids: ids,
    ...DECLARED,
  });
  await call("approvals.approve", {
    project_id: projectId,
    scenario_ids: ids,
    ...DECLARED,
    preview_token: preview.preview_token,
  });
  return { ids, unapproved: pending.find((id) => id.endsWith("admin.users_access.denied-anonymous"))! };
}

const environments = (projectId: string) =>
  host.state.db
    .prepare("SELECT COUNT(*) AS n FROM evidence_sources WHERE project_id = ? AND kind = 'environment'")
    .get(projectId) as {
    n: number;
  };

let modeA: { projectId: string; ids: string[]; unapproved: string; packagePath: string };

beforeAll(async () => {
  cpSync(F1, repo, { recursive: true });
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
    name: "Acme",
    root: repo,
  });
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number; path: string }>("saa.export", {
    run_id: run.run_id,
  });
  const approved = await approveAdminCases(started.project.id, exported.package_id, exported.version);
  modeA = { projectId: started.project.id, ...approved, packagePath: exported.path };
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("manual test pack export with no environment [@req QAA-FR-112] [@req SYS-003]", () => {
  it("exports a Mode A pack: the contract document, a Markdown pack and a valid result template", async () => {
    expect(environments(modeA.projectId).n).toBe(0);
    const pack = await call<Exported>("packs.export", { project_id: modeA.projectId, scenario_ids: modeA.ids });
    expect(pack).toMatchObject({ environment_needed: false, files: ["pack.json", "pack.md", "result-template.json"] });
    const doc = JSON.parse(readFileSync(join(pack.path, "pack.json"), "utf8")) as {
      pack_id: string;
      approval_ids: string[];
    };
    expect(validateDocument("manual-test-pack", doc).issues).toEqual([]);
    expect(doc.pack_id).toBe(pack.pack_id);
    const template = JSON.parse(readFileSync(join(pack.path, "result-template.json"), "utf8")) as Template;
    expect(validateDocument("run-result", template).issues).toEqual([]);
    expect(template.run_id).toBe(pack.run_id);
    const md = readFileSync(join(pack.path, "pack.md"), "utf8");
    for (const id of modeA.ids) expect(md).toContain(`\`${id}\``);
    expect(md).toMatch(/#### Step S3[\s\S]*- Expected: /);
    expect(md).toContain("tester-reported");
  });

  it("writes the pack in Indonesian with every identifier and number unchanged [@req LOC-006]", async () => {
    const pack = await call<Exported & { glossary: string }>("packs.export", {
      project_id: modeA.projectId,
      scenario_ids: modeA.ids,
      language: "id",
    });
    const md = readFileSync(join(pack.path, "pack.md"), "utf8");
    expect(md.startsWith("# Paket uji manual")).toBe(true);
    expect(md).toContain("Didokumentasikan SAA");
    for (const id of modeA.ids) expect(md).toContain(`\`${id}\``);
    expect(pack.glossary).toMatch(/^id@\d+\.\d+\.\d+$/);
  });

  it("exports a Mode D pack from an imported package with no source and no environment", async () => {
    const project = await call<{ id: string }>("project.create", { name: "Imported Acme" });
    const imported = await call<{ package: { package_id: string; version: number } }>("package.import", {
      project_id: project.id,
      path: modeA.packagePath,
    });
    const approved = await approveAdminCases(project.id, imported.package.package_id, imported.package.version);
    const sources = await call<{ evidence_mode: string; sources: Array<{ kind: string }> }>("project.get", {
      project_id: project.id,
    });
    expect(sources.evidence_mode).toBe("D");
    expect(sources.sources.map((s) => s.kind)).not.toContain("environment");
    const pack = await call<Exported>("packs.export", { project_id: project.id, scenario_ids: approved.ids });
    expect(existsSync(join(pack.path, "pack.md"))).toBe(true);
  });

  it("refuses unapproved scenarios, relative paths and an output inside the analyzed repository", async () => {
    expect(code(await raw("packs.export", { project_id: modeA.projectId, scenario_ids: [modeA.unapproved] }))).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(
      code(await raw("packs.export", { project_id: modeA.projectId, scenario_ids: modeA.ids, output_dir: "packs" })),
    ).toBe("INPUT_INVALID");
    expect(
      code(
        await raw("packs.export", {
          project_id: modeA.projectId,
          scenario_ids: modeA.ids,
          output_dir: join(repo, "qa-packs"),
        }),
      ),
    ).toBe("EXPORT_REFUSED");
    expect(existsSync(join(repo, "qa-packs"))).toBe(false);
  });
});

describe("importing pack results [@req QAA-FR-112] [@req QAA-FR-086]", () => {
  it("imports filled-in results as a tester-reported run linked to the declared environment, once", async () => {
    const out = mkdtempSync(join(work, "out-"));
    const pack = await call<Exported>("packs.export", {
      project_id: modeA.projectId,
      scenario_ids: modeA.ids,
      output_dir: out,
    });
    const template = JSON.parse(readFileSync(join(pack.path, "result-template.json"), "utf8")) as Template;
    const file = join(work, "filled.json");
    const importFile = (doc: unknown) => {
      writeFileSync(file, JSON.stringify(doc));
      return raw("packs.import_results", { project_id: modeA.projectId, path: file, tester: "Rina (tester)" });
    };
    const filled = structuredClone(template);
    filled.finished_at = "2026-11-14T10:00:00Z";
    filled.environment = { declared: { name: "Rina laptop against staging", url: "https://staging.acme.example" } };
    for (const c of filled.cases) for (const s of c.steps) s.status = "pass";
    filled.cases[0]!.steps[2]!.status = "fail";
    filled.cases[0]!.steps[2]!.actual = "The admin user list returned an error page.";
    filled.cases[0]!.outcome = "failed";
    filled.cases[1]!.outcome = "passed";

    // The placeholder environment, a contradicting outcome and an unknown run are refused.
    expect(code(await importFile({ ...filled, environment: template.environment }))).toBe("RESULT_INCOMPLETE");
    const contradicting = structuredClone(filled);
    contradicting.cases[0]!.outcome = "passed";
    expect(code(await importFile(contradicting))).toBe("RESULT_INCOMPLETE");
    expect(code(await importFile({ ...filled, run_id: "mrun:01JBQG00000000000000000000" }))).toBe("NOT_FOUND");

    const imported = await importFile(filled);
    expect(code(imported)).toBe("ok");
    expect((imported as { ok: true; data: Record<string, unknown> }).data).toMatchObject({
      run_id: pack.run_id,
      label: "tester-reported",
      environment: { declared: { name: "Rina laptop against staging" } },
    });
    const shown = await call<{ run: { state: string; tester: string; label: string; environment: unknown } }>(
      "runs.show",
      { run_id: pack.run_id },
    );
    expect(shown.run).toMatchObject({ state: "completed", tester: "Rina (tester)", label: "tester-reported" });
    const result = await call<Record<string, unknown>>("runs.result", { run_id: pack.run_id });
    expect(validateDocument("run-result", result).issues).toEqual([]);
    expect(
      (result.cases as Array<{ outcome: string; reported_by: string }>).map((c) => [c.outcome, c.reported_by]),
    ).toEqual([
      ["failed", "tester"],
      ["passed", "tester"],
    ]);
    expect(code(await importFile(filled))).toBe("CONFLICT");
    const packs = await call<{ packs: Array<{ pack_id: string; imported_at: string | null }> }>("packs.list", {
      project_id: modeA.projectId,
    });
    expect(packs.packs.find((p) => p.pack_id === pack.pack_id)?.imported_at).toBeTruthy();
  });

  it("imports an abandoned pack run with its reason and not_run steps", async () => {
    const pack = await call<Exported>("packs.export", { project_id: modeA.projectId, scenario_ids: modeA.ids });
    const doc = JSON.parse(readFileSync(join(pack.path, "result-template.json"), "utf8")) as Template;
    doc.state = "abandoned";
    doc.environment = { declared: { name: "Office desktop" } };
    doc.cases[0]!.steps[0]!.status = "pass";
    doc.cases[0]!.outcome = "inconclusive";
    for (const c of doc.cases) c.reason = "The environment went down.";
    const r = await raw("packs.import_results", { project_id: modeA.projectId, result: doc });
    expect(code(r)).toBe("ok");
    const shown = await call<{ run: { state: string; abandon_reason: string } }>("runs.show", { run_id: pack.run_id });
    expect(shown.run).toMatchObject({ state: "abandoned", abandon_reason: "The environment went down." });
  });
});
