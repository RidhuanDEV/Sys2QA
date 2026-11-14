import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));

interface Catalog {
  evidence_profile: { source_analysis: string; cannot_establish: string[] };
  workflows: Array<{
    id: string;
    steps: Array<{ id: string; kind: string | null; action: string }>;
    branches: unknown[];
    stops: Array<{ reason_code: string }>;
  }>;
  entities: Array<{ kind: string; count: number }>;
  gaps: Array<{ id: string; type: string }>;
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-catalog-"));
const repo = join(work, "acme-portal");
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
}
let ref: { project_id: string; package_id: string; version: number };

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
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  ref = { project_id: started.project.id, package_id: exported.package_id, version: exported.version };
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("system map and catalog of a package [@req SYS-004]", () => {
  it("lists every workflow with ordered steps, branches and stops, the entities by kind, the gaps and the evidence profile", async () => {
    const c = await call<Catalog>("package.catalog", ref);
    expect(c.evidence_profile.source_analysis).toBe("available");
    expect(c.evidence_profile.cannot_establish).toContain("Behavior of any running environment");
    expect(c.workflows).toHaveLength(8);
    const login = c.workflows.find((w) => w.id === "workflow:page:web:/login")!;
    expect(login.steps.map((s) => s.id)).toEqual([
      "page:web:/login",
      "form:web:/login#login",
      "api:POST:/api/auth/login",
    ]);
    expect(login.steps.map((s) => s.kind)).toEqual(["page", "form", "api"]);
    expect(login.branches.length).toBe(3);
    const registration = c.workflows.find((w) => w.id === "workflow:page:web:/register")!;
    expect(registration.stops.map((s) => s.reason_code)).toContain("external_service");
    expect(c.entities.find((e) => e.kind === "business_rule")?.count).toBeGreaterThanOrEqual(3);
    expect(c.gaps.map((g) => g.type)).toContain("contradiction");
  });

  it("is refused for a package the project does not hold", async () => {
    const r = await raw("package.catalog", { ...ref, version: 99 });
    expect(r.ok ? "ok" : r.error.code).toBe("NOT_FOUND");
  });
});

describe("scenarios of one plan [@req QAA-FR-050]", () => {
  it("lists only the scenarios that test the plan's conditions, and refuses a plan of another project", async () => {
    const plan = await call<{ plan: { plan_id: string } }>("plan.create", ref);
    await call("scenarios.generate", { plan_id: plan.plan.plan_id });
    const login = await call<{ plan: { plan_id: string } }>("plan.create", {
      ...ref,
      workflow_ids: ["workflow:page:web:/login"],
    });
    await call("scenarios.generate", { plan_id: login.plan.plan_id });
    const all = await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
      project_id: ref.project_id,
    });
    const ofLogin = await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
      project_id: ref.project_id,
      plan_id: login.plan.plan_id,
    });
    expect(ofLogin.scenarios.length).toBeGreaterThan(0);
    expect(ofLogin.scenarios.length).toBeLessThan(all.scenarios.length);
    expect(
      ofLogin.scenarios.map((s) => s.scenario_id).filter((id) => /\.(order|registration|admin)\./.test(id)),
    ).toEqual([]);
    const shown = await call<{ project_id: string }>("plan.show", { plan_id: plan.plan.plan_id });
    expect(shown.project_id).toBe(ref.project_id);
    const other = await call<{ id: string }>("project.create", { name: "Other" });
    const refused = await raw("scenarios.list", { project_id: other.id, plan_id: plan.plan.plan_id });
    expect(refused.ok ? "ok" : refused.error.code).toBe("NOT_FOUND");
  });
});
