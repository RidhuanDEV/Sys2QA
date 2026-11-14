import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateScenario } from "../../packages/contract/src/index.js";
import type { BackendRequest, LlmBackend } from "../../packages/platform/src/index.js";
import { buildF2Package, bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));

interface Expected {
  description: { language: string; value: string };
  basis: string;
  saa_status?: string;
  oracle_class: string;
  trace: { saa_ids: string[]; evidence_ids: string[] };
}
interface ScenarioDoc {
  scenario_id: string;
  display_key: string;
  version: number;
  content_language: string;
  title: { language: string; value: string };
  test_condition_ids: string[];
  qa_objective: string;
  test_techniques: Array<{ id: string; rationale: string }>;
  status: string;
  preconditions: Array<{ credential_profile_ref?: string }>;
  steps: Array<{ step_id: string; instruction: { value: string }; expected_result: Expected | null }>;
  assumptions: Array<{ value: string }>;
  open_gaps: string[];
  baseline: { packages: Array<{ package_id: string; package_version: number }> };
  [key: string]: unknown;
}
const expectedOf = (s: ScenarioDoc) => s.steps.find((st) => st.expected_result)!.expected_result!;

/** A model stub: answers with the given step IDs, so a well-formed and an ill-formed answer can both be tried. */
class StubBackend implements LlmBackend {
  readonly provider = "stub";
  readonly model = "stub";
  readonly locality = "local" as const;
  calls = 0;
  constructor(private readonly stepIds: string[]) {}
  generate(_request: BackendRequest) {
    this.calls++;
    return Promise.resolve({
      text: JSON.stringify({
        title: "Reworded title",
        steps: this.stepIds.map((id) => ({ step_id: id, instruction: `Reworded ${id}` })),
      }),
      tokensIn: 10,
      tokensOut: 10,
    });
  }
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-scenarios-"));
const hosts: Host[] = [];
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
let adapters: Array<{ id: string; entry: string }>;

function servicesFor(backend?: LlmBackend) {
  const host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters,
    ...(backend ? { llmBackend: backend } : {}),
  });
  hosts.push(host);
  const services = new AppServices(host);
  const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
  const call = async <T>(operation: string, input: unknown): Promise<T> => {
    const r = await raw(operation, input);
    if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  };
  return { host, raw, call };
}

async function f1Plan(call: ReturnType<typeof servicesFor>["call"]) {
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
    name: "Acme",
    root: F1,
  });
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: started.project.id,
    package_id: exported.package_id,
    version: exported.version,
  });
  return { planId: plan.plan.plan_id, runId: run.run_id, project: started.project.id, exported };
}

async function docs(call: ReturnType<typeof servicesFor>["call"], ids: string[]): Promise<ScenarioDoc[]> {
  const out: ScenarioDoc[] = [];
  for (const id of ids)
    out.push((await call<{ scenario: ScenarioDoc }>("scenarios.show", { scenario_id: id })).scenario);
  return out;
}

let main: ReturnType<typeof servicesFor>;
let f1: { planId: string; runId: string; project: string; exported: { package_id: string; version: number } };
let f1Docs: ScenarioDoc[];
let f2Docs: ScenarioDoc[];

beforeAll(async () => {
  adapters = await bundleSaaAdapters(join(work, "adapters"));
  main = servicesFor();
  f1 = await f1Plan(main.call);
  const generated = await main.call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.generate", {
    plan_id: f1.planId,
  });
  f1Docs = await docs(
    main.call,
    generated.scenarios.map((s) => s.scenario_id),
  );

  const d = await main.call<{ id: string }>("project.create", { name: "F2 site" });
  const imported = await main.call<{ package: { package_id: string; version: number } }>("package.import", {
    project_id: d.id,
    path: buildF2Package(join(work, "f2")),
  });
  const plan = await main.call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: d.id,
    ...{ package_id: imported.package.package_id, version: imported.package.version },
  });
  const f2 = await main.call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.generate", {
    plan_id: plan.plan.plan_id,
  });
  f2Docs = await docs(
    main.call,
    f2.scenarios.map((s) => s.scenario_id),
  );
}, 300_000);

afterAll(() => {
  for (const h of hosts) h.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("generated scenarios [@req QAA-FR-032] [@req QAA-FR-031] [@req QAA-FR-048] [@req QAA-FR-041]", () => {
  it("are valid scenario documents with every field, a technique with a rationale and a condition", () => {
    expect(f1Docs.length).toBeGreaterThan(50);
    for (const s of [...f1Docs, ...f2Docs]) {
      expect(validateScenario(s).issues, s.scenario_id).toEqual([]);
      expect(s.test_techniques.length).toBeGreaterThan(0);
      for (const t of s.test_techniques) expect(t.rationale).toMatch(/\S{3}/);
      expect(s.test_condition_ids.length).toBe(1);
      for (const f of [
        "preconditions",
        "test_data",
        "steps",
        "cleanup",
        "priority",
        "risk",
        "execution_classification",
      ])
        expect(s, f).toHaveProperty(f);
    }
  });

  it("pass CR-050 to CR-054 once in review, and derive the oracle from the basis [@req QAA-FR-111]", () => {
    for (const s of [...f1Docs, ...f2Docs]) {
      const inReview = { ...s, status: "pending_review" };
      expect(validateScenario(inReview).issues, s.scenario_id).toEqual([]);
      const e = expectedOf(s);
      const oracle = {
        saa_documented: "implemented",
        source_supported: "implemented",
        observed: "observed",
        inferred: "none",
      }[e.basis];
      expect(e.oracle_class).toBe(oracle);
    }
  });
});

describe("links to the package [@req QAA-FR-015] [@req QAA-FR-033a]", () => {
  it("resolve every SAA ID in the stored package and record the package version used", async () => {
    const ids = new Set(f1Docs.flatMap((s) => expectedOf(s).trace.saa_ids));
    for (const id of ids) {
      const op = id.startsWith("workflow:") ? "saa.workflows.show" : "saa.entity";
      const input = id.startsWith("workflow:")
        ? { run_id: f1.runId, workflow_id: id }
        : { run_id: f1.runId, entity_id: id };
      expect((await main.raw(op, input)).ok, id).toBe(true);
    }
    for (const s of f1Docs) {
      expect(s.baseline.packages).toEqual([
        { package_id: f1.exported.package_id, package_version: f1.exported.version },
      ]);
      expect(expectedOf(s).trace.evidence_ids.length, s.scenario_id).toBeGreaterThan(0);
    }
  });
});

describe("expectations stay within the evidence [@req QAA-FR-033] [@req QAA-FR-036] [@req QAA-FR-110] [@req QAA-FR-111]", () => {
  it("F1: implementation conformance from source, never requirement conformance or an observed basis", () => {
    for (const s of f1Docs) {
      expect(s.qa_objective).not.toBe("requirement_conformance");
      expect(expectedOf(s).basis).not.toBe("observed");
    }
    expect(f1Docs.filter((s) => s.qa_objective === "implementation_conformance").length).toBeGreaterThan(50);
  });

  it("F2: characterization or exploration only, never a source basis or an internal effect", () => {
    for (const s of f2Docs) {
      expect(["characterization", "exploratory"]).toContain(s.qa_objective);
      expect(["observed", "inferred"]).toContain(expectedOf(s).basis);
      const said = JSON.stringify(s.steps.map((st) => st.expected_result?.description.value ?? ""));
      expect(said, s.scenario_id).not.toMatch(
        /stored|saved|persist|database|record (is )?created|email|delivered|account (is )?created/i,
      );
    }
    // A submission discovery did not make is not an observation: acceptance is inferred and needs clarification.
    const accepted = f2Docs.filter(
      (s) =>
        s.test_condition_ids[0] === "tc:register.nib_16_digits" &&
        expectedOf(s).description.value === "The input is accepted",
    );
    expect(accepted.length).toBeGreaterThan(0);
    for (const s of accepted) expect([expectedOf(s).basis, s.status]).toEqual(["inferred", "needs_clarification"]);
  });

  it("labels every inferred expectation as an inference, not a requirement", () => {
    for (const s of [...f1Docs, ...f2Docs].filter((x) => expectedOf(x).basis === "inferred"))
      expect(s.assumptions.map((a) => a.value).join(" "), s.scenario_id).toMatch(
        /QAA inference, not a documented requirement/,
      );
  });

  it("turns a documentation/code contradiction into a clarification instead of choosing a side", () => {
    const password = f1Docs.filter((s) => s.test_condition_ids[0] === "tc:registration.password_min_12_characters");
    expect(password.length).toBeGreaterThan(0);
    for (const s of password) {
      expect(s.status).toBe("needs_clarification");
      expect(s.open_gaps).toContain("gap:contradiction:registration.password_min_12_characters");
    }
  });

  it("names the credential profile a role case needs", () => {
    const allowed = f1Docs.find((s) => s.scenario_id.endsWith("admin.users_access.allowed-admin"))!;
    expect(allowed.preconditions.map((p) => p.credential_profile_ref)).toContain("secretref:role-admin");
  });
});

describe("language and versions [@req QAA-FR-037]", () => {
  it("writes the chosen language, keeps machine fields, and versions only what changed", async () => {
    const again = await main.call<{ unchanged: number; versioned: number; created: number }>("scenarios.generate", {
      plan_id: f1.planId,
    });
    expect(again).toMatchObject({ unchanged: f1Docs.length, versioned: 0, created: 0 });
    const id = await main.call<{ versioned: number; scenarios: Array<{ scenario_id: string }> }>("scenarios.generate", {
      plan_id: f1.planId,
      language: "id",
    });
    expect(id.versioned).toBe(f1Docs.length);
    const [before] = f1Docs;
    const after = (await main.call<{ scenario: ScenarioDoc }>("scenarios.show", { scenario_id: before!.scenario_id }))
      .scenario;
    expect(after).toMatchObject({ content_language: "id", version: 2, display_key: before!.display_key });
    expect(after.title.language).toBe("id");
    expect(after.title.value).not.toBe(before!.title.value);
    expect(expectedOf(after).basis).toBe(expectedOf(before!).basis);
    expect(after.test_condition_ids).toEqual(before!.test_condition_ids);
  });
});

describe("model-assisted wording (ADR-008)", () => {
  it("rewords titles and steps only, and keeps the templates when the model's answer does not fit", async () => {
    const good = new StubBackend(["S1", "S2", "S3"]);
    const a = servicesFor(good);
    const planA = await f1Plan(a.call);
    const ra = await a.call<{ wording: { reworded: number }; scenarios: Array<{ scenario_id: string }> }>(
      "scenarios.generate",
      {
        plan_id: planA.planId,
        wording: "model",
      },
    );
    expect(ra.wording.reworded).toBe(ra.scenarios.length);
    const reworded = (await docs(a.call, [ra.scenarios[0]!.scenario_id]))[0]!;
    expect(reworded.title.value).toBe("Reworded title");
    expect(reworded.steps.map((s) => s.instruction.value)).toEqual(["Reworded S1", "Reworded S2", "Reworded S3"]);
    expect(validateScenario(reworded).issues).toEqual([]);

    const bad = new StubBackend(["S1", "S2"]);
    const b = servicesFor(bad);
    const planB = await f1Plan(b.call);
    const rb = await b.call<{ wording: { reworded: number } }>("scenarios.generate", {
      plan_id: planB.planId,
      wording: "model",
    });
    expect(bad.calls).toBeGreaterThan(0);
    expect(rb.wording.reworded).toBe(0);
  }, 240_000);

  it("falls back to templates without a model (deterministic-only mode)", async () => {
    const r = await main.call<{ wording: { reworded: number; templates: number } }>("scenarios.generate", {
      plan_id: f1.planId,
      wording: "model",
    });
    expect(r.wording.reworded).toBe(0);
    expect(r.wording.templates).toBeGreaterThan(0);
  });
});
