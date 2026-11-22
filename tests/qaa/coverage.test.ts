import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

// Tests here run whole service flows (projects, imports, plans, generation); slow CI machines need more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));

interface Ratio {
  covered: number;
  of: number;
  ratio: number | null;
}
interface Coverage {
  scope_statement: string;
  workflows: {
    designed: Ratio;
    approved: Ratio;
    uncovered: string[];
    branches: { designed: Ratio; approved: Ratio; uncovered: Array<{ workflow_id: string; branch: number }> };
    outside_scope: string[];
  };
  rules: {
    designed: Ratio;
    approved: Ratio;
    per_rule: Array<{ rule_id: string; techniques: Record<string, { designed: boolean; approved: boolean }> }>;
    uncovered: string[];
  };
  role_permissions: { designed: Ratio; approved: Ratio; uncovered: Array<{ role: string; step: string }> };
  pages: { designed: Ratio; approved: Ratio; uncovered: string[] };
  execution: { executed: number; of: number; ratio: number | null };
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-coverage-"));
const repo = join(work, "acme-portal");
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r: ServiceResult = await services.execute(operation, input, caller);
  if (!r.ok)
    throw new Error(`${operation}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data as T;
}
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;
let projectId: string;
let planId: string;
let projectKey: string;
const report = async () => (await call<{ coverage: Coverage }>("coverage.report", { plan_id: planId })).coverage;

// The scenarios a reviewer approves: the whole login workflow (journey and its three branches, both login rules with
// every technique) and the allowed and one denied case of the admin user list. Nothing else.
const APPROVE = [
  "page.login_journey.main",
  "page.login_journey.branch-1",
  "page.login_journey.branch-2",
  "page.login_journey.branch-3",
  "login.email_email_format.valid",
  "login.email_email_format.format-invalid",
  "login.password_required.valid",
  "login.password_required.empty",
  "login.password_required.length-0",
  "login.password_required.length-1",
  "login.password_required.length-2",
  "admin.users_access.allowed-admin",
  "admin.users_access.denied-customer",
];

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
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: projectId,
    package_id: exported.package_id,
    version: exported.version,
  });
  planId = plan.plan.plan_id;
  await call("scenarios.generate", { plan_id: planId });
  await call("scenarios.critique", { plan_id: planId });
  const listed = await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", { project_id: projectId });
  projectKey = listed.scenarios[0]!.scenario_id.split(".")[0]!;
}, 300_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("coverage relative to the system model [@req QAA-FR-044]", () => {
  // Hand-computed from the F1 package: the plan's scope holds 8 workflows (the 7 of the ground truth plus the
  // order-detail API flow SAA catalogs on its own); their documented branches number 18; 6 business rules lie on
  // their paths (login e-mail format and password required; registration e-mail format, NIB and password length;
  // the order amount); 2 steps are
  // guarded by a role (admin on the user list and on the order decision); 6 documented pages are on the paths (the
  // home page is on none). Every one of them has a designed scenario after generation; none is approved yet.
  it("reports designed coverage of every dimension before any approval, with everything uncovered", async () => {
    const c = await report();
    expect([c.workflows.designed, c.workflows.approved]).toEqual([
      { covered: 8, of: 8, ratio: 1 },
      { covered: 0, of: 8, ratio: 0 },
    ]);
    expect([
      c.workflows.branches.designed.of,
      c.rules.designed.of,
      c.role_permissions.designed.of,
      c.pages.designed.of,
    ]).toEqual([18, 6, 2, 6]);
    expect(c.workflows.uncovered).toHaveLength(8);
    expect(c.pages.uncovered).toHaveLength(6);
    expect(c.execution).toEqual({ executed: 0, of: 0, ratio: null, note: expect.any(String) as unknown });
    expect(c.workflows.outside_scope).toEqual(["integration:email.provider"]);
    expect(c.scope_statement).toMatch(/does not measure the completeness of the system/);
  });

  it("matches the hand-computed values after a partial approval", async () => {
    const ids = APPROVE.map((local) => `${projectKey}.${local}`);
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
      state_changing_ack: true,
    });
    const c = await report();
    // Login and the admin user list each have an approved scenario: 2 of 8.
    expect(c.workflows.approved).toEqual({ covered: 2, of: 8, ratio: 2 / 8 });
    // The three login branches; the admin user list's branch has no approved scenario: 3 of 18.
    expect(c.workflows.branches.approved).toEqual({ covered: 3, of: 18, ratio: 3 / 18 });
    expect(c.workflows.branches.uncovered).toContainEqual(
      expect.objectContaining({ workflow_id: "workflow:page:web:/admin/users", branch: 1 }),
    );
    // Both login rules with every applicable technique: 2 of 6.
    expect(c.rules.approved).toEqual({ covered: 2, of: 6, ratio: 2 / 6 });
    expect(c.rules.uncovered).not.toContain("business_rule:login.password_required");
    expect(c.rules.uncovered).toContain("business_rule:registration.nib_13_digits");
    // Admin on the user list has an allowed and a denied case; the order decision has neither approved: 1 of 2.
    expect(c.role_permissions.approved).toEqual({ covered: 1, of: 2, ratio: 1 / 2 });
    expect(c.role_permissions.uncovered).toEqual([
      { role: "actor_role:admin", step: "api:POST:/api/orders/{id}/decision" },
    ]);
    // The login page and the admin user list page: 2 of 6.
    expect(c.pages.approved).toEqual({ covered: 2, of: 6, ratio: 2 / 6 });
    expect(c.pages.uncovered).not.toContain("page:web:/login");
    // 13 approved scenarios, none run yet.
    expect(c.execution).toMatchObject({ executed: 0, of: APPROVE.length, ratio: 0 });
  });

  it("stops counting an approval once it is no longer active", async () => {
    const id = `${projectKey}.admin.users_access.denied-customer`;
    const approvals = await call<{ approvals: Array<{ approval_id: string; state: string }> }>("approvals.list", {
      scenario_id: id,
    });
    await call("approvals.revoke", { approval_id: approvals.approvals[0]!.approval_id, reason: "re-review" });
    const c = await report();
    expect(c.role_permissions.approved).toEqual({ covered: 0, of: 2, ratio: 0 });
    expect(c.workflows.approved.covered).toBe(2);
  });
});
