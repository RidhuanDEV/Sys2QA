import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

// Tests here run whole service flows (projects, imports, plans, generation); slow CI machines need more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));

interface Listed {
  scenario_id: string;
  status: string;
  freshness: string;
}
interface Doc {
  scenario_id: string;
  version: number;
  test_condition_ids: string[];
  state_changing: boolean;
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-staleness-"));
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
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;
const show = async (id: string) => (await call<{ scenario: Doc }>("scenarios.show", { scenario_id: id })).scenario;
const state = (scenarioId: string) =>
  (
    host.state.db
      .prepare("SELECT state FROM approvals WHERE scenario_id = ? ORDER BY approved_at DESC, rowid DESC LIMIT 1")
      .get(scenarioId) as { state: string }
  ).state;
const freshness = (scenarioId: string) =>
  (
    host.state.db
      .prepare(
        "SELECT v.freshness FROM scenario_versions v JOIN scenarios s ON s.scenario_id = v.scenario_id AND v.version = s.latest_version WHERE s.scenario_id = ?",
      )
      .get(scenarioId) as { freshness: string }
  ).freshness;

let projectId: string;
let runId: string;
let packageId: string;
const picked: Record<"changed" | "removed" | "unchanged", string> = {} as never;
let stalenessResult: { diff: string; scenarios: Array<{ scenario_id: string; freshness: string; approval: string }> };

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
  projectId = started.project.id;
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  runId = (await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id })).run_id;
  const v1 = await call<{ package_id: string; version: number }>("saa.export", { run_id: runId });
  packageId = v1.package_id;
  const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: projectId,
    package_id: packageId,
    version: v1.version,
  });
  await call("scenarios.generate", { plan_id: plan.plan.plan_id });
  await call("scenarios.critique", { plan_id: plan.plan.plan_id });
  const pending = (
    await call<{ scenarios: Listed[] }>("scenarios.list", { project_id: projectId, status: "pending_review" })
  ).scenarios;
  const docs = await Promise.all(pending.map((s) => show(s.scenario_id)));
  const pick = (condition: string) =>
    docs.find((d) => d.test_condition_ids[0] === condition && !d.state_changing)!.scenario_id;
  picked.changed = pick("tc:auth.login.invalid_credentials");
  picked.removed = pick("tc:admin.users_access");
  picked.unchanged = pick("tc:order.amount_1_to_10000");
  for (const id of Object.values(picked)) {
    const preview = await call<{ preview_token: string }>("approvals.preview", {
      project_id: projectId,
      scenario_ids: [id],
      ...DECLARED,
    });
    await call("approvals.approve", {
      project_id: projectId,
      scenario_ids: [id],
      ...DECLARED,
      preview_token: preview.preview_token,
    });
  }

  // The repository changes: the login error message is reworded, the admin endpoint moves, nothing else.
  const auth = join(repo, "src", "server", "routes", "auth.ts");
  writeFileSync(auth, readFileSync(auth, "utf8").replace('"invalid credentials"', '"wrong email or password"'));
  const admin = join(repo, "src", "server", "routes", "admin.ts");
  writeFileSync(admin, readFileSync(admin, "utf8").replace('"/api/admin/users"', '"/api/admin/accounts"'));
  const run2 = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const v2 = await call<{ staleness: typeof stalenessResult }>("saa.export", { run_id: run2.run_id });
  stalenessResult = v2.staleness;
}, 300_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("staleness propagation on the change fixture [@req QAA-FR-046] [@req CON-014]", () => {
  it("evaluates every scenario of the older package as soon as the new version is stored", () => {
    expect(stalenessResult.diff).toBe("available");
    expect(stalenessResult.scenarios.length).toBeGreaterThan(50);
  });

  it("follows PRD §13.11: unchanged → current and suspended, changed → potentially stale and suspended, removed → stale and invalidated", () => {
    expect([freshness(picked.unchanged), state(picked.unchanged)]).toEqual(["current", "suspended"]);
    expect([freshness(picked.changed), state(picked.changed)]).toEqual(["potentially_stale", "suspended"]);
    expect([freshness(picked.removed), state(picked.removed)]).toEqual(["stale", "invalidated"]);
  });

  it("names the records that decided each scenario's state", () => {
    const of = (id: string) =>
      stalenessResult.scenarios.find((s) => s.scenario_id === id) as unknown as { reason: string; records: string[] };
    expect(of(picked.changed).records).toContain("api:POST:/api/auth/login");
    expect(of(picked.removed).records).toContain("api:GET:/api/admin/users");
    expect(of(picked.unchanged).records).toEqual([]);
  });
});

describe("suspension and revalidation [@req QAA-FR-047] [@req QAA-FR-054]", () => {
  it("lets no suspended or invalidated approval run", async () => {
    for (const id of Object.values(picked))
      expect((await call<{ allowed: boolean }>("execution.check", { scenario_id: id, ...DECLARED })).allowed, id).toBe(
        false,
      );
  });

  it("rebinds only the unaffected approvals to the new baseline in one audited action", async () => {
    const result = await call<{
      rebound: Array<{ scenario_id: string; version: number }>;
      left_for_review: Array<{ scenario_id: string }>;
    }>("approvals.revalidate", { project_id: projectId, package_id: packageId, version: 2 });
    expect(result.rebound.map((r) => r.scenario_id)).toEqual([picked.unchanged]);
    expect(result.left_for_review.map((r) => r.scenario_id)).toEqual([picked.changed]);
    expect(
      (await call<{ allowed: boolean }>("execution.check", { scenario_id: picked.unchanged, ...DECLARED })).allowed,
    ).toBe(true);
    const approvals = await call<{
      approvals: Array<{
        scenario_version: number;
        state: string;
        baseline: { packages: Array<{ package_version: number }> };
      }>;
    }>("approvals.list", { scenario_id: picked.unchanged });
    expect(
      approvals.approvals.map((a) => [a.scenario_version, a.state, a.baseline.packages[0]!.package_version]),
    ).toEqual([
      [1, "superseded", 1],
      [2, "active", 2],
    ]);
    const audited = host.state.db
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'approval.revalidated'")
      .get() as { n: number };
    expect(audited.n).toBe(1);
    expect(
      (await call<{ allowed: boolean }>("execution.check", { scenario_id: picked.changed, ...DECLARED })).allowed,
    ).toBe(false);
    expect(
      (await call<{ allowed: boolean }>("execution.check", { scenario_id: picked.removed, ...DECLARED })).allowed,
    ).toBe(false);
  });

  it("suspends approvals bound to an older scope policy version when the environment changes", async () => {
    const env = await call<{ id: string }>("project.add_source", {
      project_id: projectId,
      kind: "environment",
      ref: "https://staging.acme.example/",
    });
    await call("project.declare", { source_id: env.id, declared_by: caller.actor, operation_level: "L2" });
    const configure = (hosts: string[]) =>
      call("project.configure_environment", {
        source_id: env.id,
        base_url: "https://staging.acme.example/",
        classification: "staging",
        allowed_hosts: hosts,
      });
    await configure(["staging.acme.example"]);
    const id = (
      await call<{ scenarios: Listed[] }>("scenarios.list", { project_id: projectId, status: "pending_review" })
    ).scenarios.find((s) => s.freshness === "current")!.scenario_id;
    const binding = { mode: "manual", environment_id: env.id };
    const preview = await call<{ preview_token: string }>("approvals.preview", {
      project_id: projectId,
      scenario_ids: [id],
      ...binding,
    });
    const approved = await raw("approvals.approve", {
      project_id: projectId,
      scenario_ids: [id],
      ...binding,
      preview_token: preview.preview_token,
      state_changing_ack: true,
    });
    expect(approved.ok).toBe(true);
    await configure(["staging.acme.example", "cdn.staging.acme.example"]);
    expect(state(id)).toBe("suspended");
  });
});
