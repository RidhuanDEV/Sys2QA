import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const F1 = repo("fixtures/benchmarks/F1-repository-only/repo");
const F4 = repo("fixtures/benchmarks/F4-incomplete-evidence/repo");
const MODE_B_QAA = repo("fixtures/contract/packages/valid/mode-b-qaa");

interface Risk {
  id: string;
  impact: number;
  likelihood: number;
  exposure: string[];
  rationale: string;
  score: number;
}
interface PlanResult {
  plan: Record<string, unknown> & {
    plan_id: string;
    qa_objectives: string[];
    scope: { in_scope: string[]; out_of_scope: string[]; exclusions_reason?: string };
    risks: Array<Omit<Risk, "score">>;
    baseline: { revision: { kind: string } };
    assumptions: Array<{ value: string }>;
  };
  risks: Risk[];
  suggested_coverage: Array<{ workflow_id: string; techniques: string[]; state_machines: string[]; roles: string[] }>;
}
interface Ref {
  project: string;
  package_id: string;
  version: number;
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-plan-"));
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
}
async function modeA(name: string, root: string): Promise<Ref> {
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", { name, root });
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  return { project: started.project.id, package_id: exported.package_id, version: exported.version };
}
const create = (ref: Ref, extra: Record<string, unknown> = {}) =>
  raw("plan.create", { project_id: ref.project, package_id: ref.package_id, version: ref.version, ...extra });

let f1: Ref;
let f4: Ref;
let f1Plan: PlanResult;

beforeAll(async () => {
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);
  f1 = await modeA("Acme portal", F1);
  f1Plan = (await create(f1, { objective: "Check registration and ordering before the release." }).then((r) => {
    if (!r.ok) throw new Error(r.error.code);
    return r.data;
  })) as PlanResult;
  f4 = await modeA("Shop front", F4);
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("test plan [@req QAA-FR-030]", () => {
  it("validates against the contract and has every field", () => {
    expect(validateDocument("test-plan", f1Plan.plan).issues).toEqual([]);
    for (const field of [
      "objectives",
      "qa_objectives",
      "scope",
      "risks",
      "test_basis",
      "assumptions",
      "exit_criteria",
      "baseline",
      "evidence_profile_summary",
    ])
      expect(f1Plan.plan, field).toHaveProperty(field);
    expect((f1Plan.plan.objectives as Array<{ value: string }>)[0]!.value).toBe(
      "Check registration and ordering before the release.",
    );
    expect(f1Plan.suggested_coverage.length).toBe(f1Plan.plan.scope.in_scope.length);
  });

  it("keeps QA objectives within the evidence: no requirement conformance without supplied requirements", () => {
    expect(f1Plan.plan.qa_objectives).toEqual(["implementation_conformance", "exploratory"]);
  });

  it("scopes from the catalog and states why boundaries and blocked flows are excluded", async () => {
    expect(f1Plan.plan.scope.out_of_scope).toEqual(["integration:email.provider"]);
    expect(f1Plan.plan.scope.exclusions_reason).toMatch(/email\.provider: outside the analyzed scope/);
    await call("readiness.confirm_baseline", {
      project_id: f4.project,
      package_id: f4.package_id,
      version: f4.version,
      statement: "The test environment runs this working tree.",
    });
    const r = await create(f4);
    const plan = (r as { ok: true; data: PlanResult }).data.plan;
    expect(plan.scope.out_of_scope).toContain("workflow:page:app:/loyalty");
    expect(plan.scope.in_scope).not.toContain("workflow:page:app:/loyalty");
    expect(plan.scope.exclusions_reason).toMatch(/material gap blocks scenario design/);
  });

  it("is refused while scenario design is blocked for the chosen scope", async () => {
    const r = await create(f4, { workflow_ids: ["workflow:page:app:/loyalty"] });
    expect(r.ok ? "ok" : r.error.code).toBe("READINESS_BLOCKED");
  });

  it("suggests coverage from the package: boundaries, states and roles where the evidence has them", () => {
    const of = (id: string) => f1Plan.suggested_coverage.find((c) => c.workflow_id === id)!;
    expect(of("workflow:page:web:/register").techniques).toEqual(
      expect.arrayContaining(["equivalence_partitioning", "boundary_value_analysis", "negative"]),
    );
    expect(of("workflow:page:web:/orders/{id}")).toMatchObject({ state_machines: ["state_machine:order.status"] });
    expect(of("workflow:page:web:/orders/{id}").techniques).toContain("state_transition");
    expect(of("workflow:page:web:/admin/users").techniques).toContain("role_matrix");
    expect(of("workflow:job:cleanup.nightly").techniques).toEqual(["user_journey"]);
  });

  it("characterizes a runtime-only package and baselines it on the observation window [@req QAA-FR-110]", async () => {
    const b = await call<{ id: string }>("project.create", { name: "Observed portal" });
    const imported = await call<{ package: { package_id: string; version: number } }>("package.import", {
      project_id: b.id,
      path: MODE_B_QAA,
    });
    const r = await create({
      project: b.id,
      package_id: imported.package.package_id,
      version: imported.package.version,
    });
    const plan = (r as { ok: true; data: PlanResult }).data.plan;
    expect(validateDocument("test-plan", plan).issues).toEqual([]);
    expect(plan.qa_objectives[0]).toBe("characterization");
    expect(plan.baseline.revision.kind).toBe("observation_window");
    expect(plan.assumptions.map((a) => a.value)).toContain(
      "Expected results come from observed behavior; internal effects are not asserted.",
    );
  });
});

describe("transparent risk priority [@req QAA-FR-038]", () => {
  it("shows impact, likelihood, exposure and a rationale naming every factor, ordered by score", () => {
    for (const risk of f1Plan.risks) {
      expect(risk.score).toBe(risk.impact * risk.likelihood);
      expect(risk.rationale).toMatch(/^Default from package evidence\. Impact \d: .+ Likelihood \d: .+/);
    }
    const scores = f1Plan.risks.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const register = f1Plan.risks.find((r) => r.id === "risk:page-web-register")!;
    expect(register.exposure).toContain("data_critical");
    expect(register.rationale).toMatch(/3 business rule\(s\) constrain its input/);
    expect(f1Plan.risks.find((r) => r.id === "risk:page-web-admin-users")!.exposure).toContain("permission_sensitive");
  });

  it("lets a person edit the inputs, revalidates the plan and audits the values before and after", async () => {
    const planId = f1Plan.plan.plan_id;
    const before = f1Plan.risks.find((r) => r.id === "risk:job-cleanup-nightly")!;
    const edited = await call<{ risk: Risk; risks: Risk[] }>("plan.update_risk", {
      plan_id: planId,
      risk_id: "risk:job-cleanup-nightly",
      likelihood: 4,
      exposure: ["data_critical"],
      rationale: "The cleanup job deleted live drafts in the last incident.",
    });
    expect(edited.risk).toMatchObject({ impact: before.impact, likelihood: 4, exposure: ["data_critical"] });
    const shown = await call<{ plan: Record<string, unknown>; risk_history: Array<Record<string, unknown>> }>(
      "plan.show",
      { plan_id: planId },
    );
    expect(validateDocument("test-plan", shown.plan).issues).toEqual([]);
    expect(shown.risk_history).toEqual([
      expect.objectContaining({
        actor: caller.actor,
        risk_id: "risk:job-cleanup-nightly",
        before: expect.objectContaining({ likelihood: before.likelihood }),
        after: expect.objectContaining({
          likelihood: 4,
          rationale: "The cleanup job deleted live drafts in the last incident.",
        }),
      }),
    ]);
  });

  it("refuses values outside the scale, unknown exposure flags and unknown risks", async () => {
    const planId = f1Plan.plan.plan_id;
    const code = async (input: Record<string, unknown>) => {
      const r = await raw("plan.update_risk", { plan_id: planId, rationale: "x", ...input });
      return r.ok ? "ok" : r.error.code;
    };
    expect(await code({ risk_id: "risk:page-web-register", impact: 6 })).toBe("INPUT_INVALID");
    expect(await code({ risk_id: "risk:page-web-register", exposure: ["payments"] })).toBe("INPUT_INVALID");
    expect(await code({ risk_id: "risk:nothing" })).toBe("NOT_FOUND");
    expect(await code({ risk_id: "risk:page-web-register" })).toBe("ok");
  });

  it("lists the project's plans", async () => {
    const list = await call<{ plans: Array<{ plan_id: string; risks: number }> }>("plan.list", {
      project_id: f1.project,
    });
    expect(list.plans.map((p) => p.plan_id)).toEqual([f1Plan.plan.plan_id]);
  });
});
