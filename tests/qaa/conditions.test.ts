import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const F1 = repo("fixtures/benchmarks/F1-repository-only/repo");
const F4 = repo("fixtures/benchmarks/F4-incomplete-evidence/repo");
const EXPECTED = JSON.parse(
  readFileSync(repo("fixtures/benchmarks/F1-repository-only/ground-truth/scenarios-expected.json"), "utf8"),
) as { expected: Array<{ key: string; condition: string; technique: string }> };

interface Item {
  id: string;
  input: string;
  expected: string;
  basis: string;
  refs: string[];
}
interface Condition {
  condition_id: string;
  workflow_ids: string[];
  techniques: Array<{ id: string; rationale: string }>;
  basis_refs: Array<{ kind: string; ref: string; package: string }>;
  items: Item[];
  needs_clarification?: string;
}
interface Derived {
  conditions: Condition[];
  techniques: Record<string, number>;
  needs_clarification: string[];
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-conditions-"));
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r: ServiceResult = await services.execute(operation, input, caller);
  if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
}
async function planFor(name: string, root: string): Promise<{ planId: string; runId: string }> {
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", { name, root });
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  await call("readiness.confirm_baseline", {
    project_id: started.project.id,
    package_id: exported.package_id,
    version: exported.version,
    statement: "The test environment runs this working tree.",
  });
  const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: started.project.id,
    package_id: exported.package_id,
    version: exported.version,
  });
  return { planId: plan.plan.plan_id, runId: run.run_id };
}

let f1: Derived;
let f1Run: string;
let f1Plan: string;
let f4: Derived;

beforeAll(async () => {
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);
  const a = await planFor("Acme portal", F1);
  f1Plan = a.planId;
  f1Run = a.runId;
  f1 = await call<Derived>("conditions.derive", { plan_id: a.planId });
  const b = await planFor("Shop front", F4);
  f4 = await call<Derived>("conditions.derive", { plan_id: b.planId });
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const byId = (d: Derived, id: string) => d.conditions.find((c) => c.condition_id === id)!;

describe("test conditions from the test basis [@req QAA-FR-048] [@req QAA-FR-031]", () => {
  it.each(EXPECTED.expected)(
    "covers F1's expected condition $key ($condition, $technique)",
    ({ condition, technique }) => {
      const c = byId(f1, condition);
      expect(c, condition).toBeDefined();
      expect(c.techniques.map((t) => t.id)).toContain(technique);
    },
  );

  it("names a technique with a rationale and a basis that resolves in the package for every condition", async () => {
    for (const c of [...f1.conditions, ...f4.conditions]) {
      expect(c.techniques.length, c.condition_id).toBeGreaterThan(0);
      for (const t of c.techniques) expect(t.rationale, c.condition_id).toMatch(/\S{3}/);
      expect(c.basis_refs.length, c.condition_id).toBeGreaterThan(0);
      expect(c.items.length, c.condition_id).toBeGreaterThan(0);
    }
    for (const c of f1.conditions)
      for (const b of c.basis_refs) {
        const op = b.kind === "package_workflow" ? "saa.workflows.show" : "saa.entity";
        const input =
          b.kind === "package_workflow" ? { run_id: f1Run, workflow_id: b.ref } : { run_id: f1Run, entity_id: b.ref };
        const r = await services.execute(op, input, caller);
        expect(r.ok, `${c.condition_id} → ${b.ref}`).toBe(true);
      }
  });

  it("puts values on and next to each limit", () => {
    const lengths = (id: string) =>
      Object.fromEntries(
        byId(f1, id)
          .items.filter((i) => /#(length|value)-/.test(i.id))
          .map((i) => [i.id.replace(/^.*#/, ""), i.expected]),
      );
    expect(lengths("tc:registration.nib_13_digits")).toEqual({
      "length-12": "rejected (HTTP 422)",
      "length-13": "accepted",
      "length-14": "rejected (HTTP 422)",
    });
    expect(lengths("tc:order.amount_1_to_10000")).toEqual({
      "value-0": "rejected (HTTP 422)",
      "value-1": "accepted",
      "value-2": "accepted",
      "value-9999": "accepted",
      "value-10000": "accepted",
      "value-10001": "rejected (HTTP 422)",
    });
    expect(byId(f1, "tc:registration.password_min_12_characters").items.map((i) => i.id.replace(/^.*#/, ""))).toEqual(
      expect.arrayContaining(["length-11", "length-12", "length-13"]),
    );
  });

  it("tests valid and known invalid transitions of the order state machine", () => {
    const items = byId(f1, "tc:order.status_transitions").items;
    expect(items).toContainEqual(
      expect.objectContaining({ id: "tc:order.status_transitions#SUBMITTED-APPROVED", expected: "allowed" }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ id: "tc:order.status_transitions#DRAFT-APPROVED-refused", expected: "refused" }),
    );
  });

  it("combines the registration rules in a decision table and applies techniques selectively", () => {
    expect(byId(f1, "tc:registration.combinations").techniques.map((t) => t.id)).toEqual(["decision_table"]);
    // A scheduled job with no rule, role or state gets a journey only.
    const job = f1.conditions.filter((c) => c.workflow_ids.includes("workflow:job:cleanup.nightly"));
    expect(job.map((c) => c.condition_id)).toEqual(["tc:job.cleanup.nightly_journey"]);
    // A page and an API on the same path are separate journeys.
    expect(byId(f1, "tc:page.orders.id_journey").workflow_ids).toEqual(["workflow:page:web:/orders/{id}"]);
    expect(byId(f1, "tc:api.orders.id_journey").workflow_ids).toEqual(["workflow:api:GET:/api/orders/{id}"]);
  });

  it("never claims an observed basis without runtime evidence, and labels error guessing as inferred", () => {
    for (const c of f1.conditions) for (const i of c.items) expect(i.basis, i.id).not.toBe("observed");
    const guessing = f1.conditions.filter((c) => c.techniques.some((t) => t.id === "error_guessing"));
    expect(guessing.length).toBeGreaterThan(0);
    for (const c of guessing) for (const i of c.items) expect(i.basis).toBe("inferred");
  });

  it("says what is unknown instead of inventing it", () => {
    expect(f4.needs_clarification.length).toBeGreaterThan(0);
    const cart = f4.conditions.find((c) => c.condition_id.endsWith("cart_journey"))!;
    expect(cart.needs_clarification).toMatch(/not known beyond/);
  });

  it("derives again without duplicates and lists by technique", async () => {
    const again = await call<Derived>("conditions.derive", { plan_id: f1Plan });
    expect(again.conditions.map((c) => c.condition_id)).toEqual(f1.conditions.map((c) => c.condition_id));
    const roles = await call<Derived>("conditions.list", { plan_id: f1Plan, technique: "role_matrix" });
    expect(roles.conditions.every((c) => c.techniques.some((t) => t.id === "role_matrix"))).toBe(true);
  });
});

describe("role-based conditions [@req QAA-FR-042]", () => {
  it("gives every guarded step at least one allowed and one denied case", async () => {
    const guarded = ["api:GET:/api/admin/users", "api:POST:/api/orders/{id}/decision"];
    for (const id of guarded) {
      const entity = await call<{ outgoing: Array<{ type: string; to: string }> }>("saa.entity", {
        run_id: f1Run,
        entity_id: id,
      });
      expect(
        entity.outgoing.some((r) => r.type === "AUTHORIZES_WITH"),
        id,
      ).toBe(true);
    }
    for (const condition of ["tc:admin.users_access", "tc:orders.id.decision_access"]) {
      const items = byId(f1, condition).items;
      expect(items.filter((i) => i.expected === "allowed").length, condition).toBeGreaterThanOrEqual(1);
      expect(items.filter((i) => i.expected === "denied").length, condition).toBeGreaterThanOrEqual(1);
      expect(items.map((i) => i.id.replace(/^.*#/, ""))).toEqual(
        expect.arrayContaining(["allowed-admin", "denied-customer", "denied-anonymous"]),
      );
    }
  });
});
