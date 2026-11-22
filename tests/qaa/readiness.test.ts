import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

// Tests here run whole service flows (projects, imports, plans, generation); slow CI machines need more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const F1 = repo("fixtures/benchmarks/F1-repository-only/repo");
const F4 = repo("fixtures/benchmarks/F4-incomplete-evidence/repo");
const MODE_A_SAA = repo("fixtures/contract/packages/valid/mode-a-saa");
const MODE_B_QAA = repo("fixtures/contract/packages/valid/mode-b-qaa");
const EXPECTED = JSON.parse(readFileSync(repo("fixtures/qaa/readiness/expected.json"), "utf8")) as Record<
  string,
  { activities: Record<string, string>; freshness: string; flows?: Record<string, string> }
>;

interface Assessment {
  assessment: {
    activities: Record<string, { readiness: string; reasons: string[] }>;
    freshness: string;
    [key: string]: unknown;
  };
  flows: Array<{ workflow_id: string; readiness: string; gaps: Array<{ gap_id: string; effect: string }> }>;
  findings: Array<{ id: string }>;
  categories: Array<{ category: string; value: string }>;
  freshness: { value: string; code?: string };
}

/** The fields of operation results this test reads. */
interface Data {
  id: string;
  source: { id: string };
  project: { id: string };
  run_id: string;
  package_id: string;
  version: number;
  package: { package_id: string; version: number; path: string };
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-readiness-"));
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const call = async (operation: string, input: unknown) => {
  const r: ServiceResult = await services.execute(operation, input, caller);
  if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
  return r.data as Data;
};
const results: Record<string, Assessment> = {};

async function modeA(name: string, root: string) {
  const started = await call("saa.start", { name, root });
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call("saa.analyze", { source_id: started.source.id });
  const exported = await call("saa.export", { run_id: run.run_id });
  return {
    project: started.project.id as string,
    package_id: exported.package_id as string,
    version: exported.version as number,
  };
}
const assess = async (ref: { project: string; package_id: string; version: number }, scope?: string[]) =>
  (await call("readiness.assess", {
    project_id: ref.project,
    package_id: ref.package_id,
    version: ref.version,
    ...(scope ? { workflow_ids: scope } : {}),
  })) as unknown as Assessment;
const confirm = (ref: { project: string; package_id: string; version: number }) =>
  call("readiness.confirm_baseline", {
    project_id: ref.project,
    package_id: ref.package_id,
    version: ref.version,
    statement: "The test environment runs exactly this working tree.",
  });

beforeAll(async () => {
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);

  const f1 = await modeA("Acme portal", F1);
  results["mode-a-f1"] = await assess(f1);
  await confirm(f1);
  results["mode-a-f1-confirmed-login-admin"] = await assess(f1, [
    "workflow:page:web:/login",
    "workflow:page:web:/admin/users",
  ]);

  const f1copy = join(work, "acme-checkout");
  cpSync(F1, f1copy, { recursive: true });
  const changed = await modeA("Acme checkout", f1copy);
  await confirm(changed);
  appendFileSync(join(f1copy, "README.md"), "\nEdited after the analysis.\n");
  results["mode-a-f1-checkout-changed"] = await assess(changed);

  const f4 = await modeA("Shop front", F4);
  await confirm(f4);
  results["mode-a-f4-confirmed"] = await assess(f4);
  results["mode-a-f4-loyalty-only"] = await assess(f4, ["workflow:page:app:/loyalty"]);
  await call("readiness.override_materiality", {
    project_id: f4.project,
    gap_id: "gap:route-condition:app:/loyalty",
    material: false,
    reason: "The loyalty programme is switched on in every test environment.",
  });
  results["mode-a-f4-loyalty-override"] = await assess(f4, ["workflow:page:app:/loyalty"]);

  const b = await call("project.create", { name: "Observed portal" });
  const env = await call("project.add_source", {
    project_id: b.id,
    kind: "environment",
    ref: "https://staging.acme.example/",
  });
  await call("project.declare", { source_id: env.id, declared_by: caller.actor, operation_level: "L2" });
  await call("project.configure_environment", {
    source_id: env.id,
    base_url: "https://staging.acme.example/",
    classification: "staging",
    allowed_hosts: ["staging.acme.example"],
  });
  const bImport = await call("package.import", { project_id: b.id, path: MODE_B_QAA });
  results["mode-b"] = await assess({
    project: b.id,
    package_id: bImport.package.package_id,
    version: bImport.package.version,
  });

  const d = await call("project.create", { name: "Imported portal" });
  const dImport = await call("package.import", { project_id: d.id, path: MODE_A_SAA });
  const dRef = {
    project: d.id as string,
    package_id: dImport.package.package_id as string,
    version: dImport.package.version as number,
  };
  results["mode-d"] = await assess(dRef);
  const next = join(work, "mode-a-saa-next");
  cpSync(MODE_A_SAA, next, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(next, "manifest.json"), "utf8")) as {
    package_version: number;
    previous_package: unknown;
    repository: { revision: { value: string } };
    artifacts: Array<{ role: string }>;
  };
  manifest.previous_package = {
    package_version: manifest.package_version,
    revision: manifest.repository.revision.value,
  };
  manifest.package_version += 1;
  // The diff report names its target version; a next version without one is still a valid package.
  manifest.artifacts = manifest.artifacts.filter((x) => x.role !== "diff_report");
  writeFileSync(join(next, "manifest.json"), JSON.stringify(manifest, null, 2));
  await call("package.import", { project_id: d.id, path: next });
  results["mode-d-stale"] = await assess(dRef);
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("readiness per QA activity [@req CON-022] [@req QAA-FR-014] [@req QAA-FR-018] [@req QAA-FR-013]", () => {
  it.each(Object.keys(EXPECTED))("%s gives the expected per-activity results", (name) => {
    const expected = EXPECTED[name]!;
    const got = results[name]!;
    expect(
      Object.fromEntries(Object.entries(got.assessment.activities).map(([k, v]) => [k, v.readiness])),
      JSON.stringify(got.assessment.activities, null, 1),
    ).toEqual(expected.activities);
    expect(got.assessment.freshness).toBe(expected.freshness);
    for (const [flow, readiness] of Object.entries(expected.flows ?? {}))
      expect(got.flows.find((f) => f.workflow_id === flow)?.readiness, flow).toBe(readiness);
  });

  it("never lowers readiness for evidence a package does not claim", () => {
    // A runtime package is not penalized for lacking source, a source package not for lacking an environment.
    expect(results["mode-b"]!.assessment.activities.scenario_design!.readiness).not.toMatch(/review_only|blocked/);
    const design = results["mode-d"]!.assessment.activities.scenario_design!;
    expect(design.reasons.join(" ")).not.toMatch(/environment/i);
    expect(results["mode-d"]!.assessment.activities.automated_execution!.reasons).toContain(
      "No environment configured.",
    );
  });

  it("blocks only the flows with a material gap", () => {
    const flows = results["mode-a-f4-confirmed"]!.flows;
    expect(flows.filter((f) => f.readiness === "blocked").length).toBeLessThan(flows.length);
    expect(flows.find((f) => f.workflow_id === "workflow:page:app:/loyalty")!.gaps).toContainEqual(
      expect.objectContaining({ gap_id: "gap:route-condition:app:/loyalty", effect: "material" }),
    );
  });

  it("states freshness codes for a mismatched checkout and an unknown deployed revision", () => {
    expect(results["mode-a-f1-checkout-changed"]!.freshness.code).toBe("PKG_REVISION_MISMATCH");
    expect(results["mode-b"]!.freshness.code).toBe("PKG_REVISION_UNVERIFIABLE");
    expect(results["mode-b"]!.assessment.activities.automated_execution!.reasons.join(" ")).toMatch(
      /baseline confirmation/,
    );
  });

  it("lists every coverage category with its status", () => {
    for (const r of Object.values(results)) expect(r.categories.map((c) => c.category)).toHaveLength(10);
    expect(results["mode-b"]!.categories).toContainEqual({ category: "modules", value: "not_reported" });
  });
});

describe("assessment records [@req CON-028] [@req CON-013] [@req QAA-FR-003]", () => {
  it("are valid contract documents with three separate dimensions and no aggregate score", () => {
    for (const [name, r] of Object.entries(results)) {
      expect(validateDocument("readiness-assessment", r.assessment).issues, name).toEqual([]);
      expect(Object.keys(r.assessment)).not.toContain("score");
    }
    const rows = host.state.db.prepare("SELECT COUNT(*) AS n FROM readiness_assessments").get() as { n: number };
    expect(rows.n).toBe(Object.keys(results).length * 3);
  });

  it("give QAA's own findings qgap: IDs and change nothing in the package", async () => {
    const findings = Object.values(results).flatMap((r) => r.findings.map((f) => f.id));
    expect(findings.length).toBeGreaterThan(0);
    for (const id of findings) expect(id).toMatch(/^qgap:/);
    const d = await call("project.create", { name: "Untouched" });
    const imported = await call("package.import", { project_id: d.id, path: MODE_A_SAA });
    const digest = (dir: string): string => {
      const h = createHash("sha256");
      const walk = (p: string) => {
        for (const n of readdirSync(p).sort()) {
          const f = join(p, n);
          if (statSync(f).isDirectory()) walk(f);
          else h.update(n).update(readFileSync(f));
        }
      };
      walk(dir);
      return h.digest("hex");
    };
    const before = digest(imported.package.path);
    await assess({ project: d.id, package_id: imported.package.package_id, version: imported.package.version });
    expect(digest(imported.package.path)).toBe(before);
  });

  it("audits baseline confirmations and materiality overrides", () => {
    const actions = (
      host.state.db
        .prepare("SELECT action FROM audit_events WHERE action IN ('baseline.confirmed', 'materiality.overridden')")
        .all() as Array<{
        action: string;
      }>
    ).map((r) => r.action);
    expect(actions.filter((a) => a === "baseline.confirmed")).toHaveLength(3);
    expect(actions).toContain("materiality.overridden");
  });
});
