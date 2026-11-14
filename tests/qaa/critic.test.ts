import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateScenario } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const PASSWORD_CONFLICT = "qconflict:contradiction:registration.password_min_12_characters";

interface Doc {
  scenario_id: string;
  display_key: string;
  version: number;
  status: string;
  status_reason?: string;
  test_condition_ids: string[];
  steps: Array<{ expected_result: { description: { value: string } } | null }>;
  [key: string]: unknown;
}
interface Critique {
  checked: number;
  by_status: Record<string, number>;
  duplicates: Array<{ scenario_id: string; duplicate_of: string; duplicate_of_status: string; reason: string }>;
  conflicts: Array<{
    conflict_id: string;
    kind: string;
    sides: Array<{ source: string; statement: string; evidence_ids: string[] }>;
    scenario_ids: string[];
  }>;
  critiques: Array<{
    scenario_id: string;
    status: string;
    status_reason?: string;
    checks: Array<{ check: string; passed: boolean }>;
  }>;
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-critic-"));
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r: ServiceResult = await services.execute(operation, input, caller);
  if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
}
const show = async (id: string) => (await call<{ scenario: Doc }>("scenarios.show", { scenario_id: id })).scenario;
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** Stores a scenario document as a new scenario of the project, as a person's edit or an import would. */
function insert(projectId: string, doc: Doc, status = "draft") {
  const at = new Date().toISOString();
  const json = JSON.stringify({ ...doc, status });
  host.state.db
    .prepare(
      "INSERT INTO scenarios (scenario_id, project_id, display_key, latest_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(doc.scenario_id, projectId, doc.display_key, at, at);
  host.state.db
    .prepare(
      "INSERT INTO scenario_versions (scenario_id, version, doc_json, status, freshness, content_sha256, created_at, updated_at) VALUES (?, 1, ?, ?, 'current', ?, ?, ?)",
    )
    .run(doc.scenario_id, json, status, sha(json), at, at);
}

let projectId: string;
let planId: string;
let first: Critique;

beforeAll(async () => {
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
    name: "Acme",
    root: F1,
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
  await call("conditions.derive", { plan_id: planId });
  await call("scenarios.generate", { plan_id: planId });
  first = await call<Critique>("scenarios.critique", { plan_id: planId });
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("quality checklist [@req QAA-FR-034]", () => {
  it("checks every scenario against the ten checklist items and readies the clean ones for review", async () => {
    expect(first.checked).toBeGreaterThan(50);
    for (const c of first.critiques) expect(c.checks.map((x) => x.check)).toHaveLength(10);
    expect(first.by_status.pending_review).toBeGreaterThan(40);
    for (const c of first.critiques.filter((x) => x.status === "pending_review")) {
      expect(
        c.checks.every((x) => x.passed),
        c.scenario_id,
      ).toBe(true);
      expect(validateScenario(await show(c.scenario_id)).issues, c.scenario_id).toEqual([]);
    }
    const listed = await call<{ findings: Array<{ kind: string }> }>("findings.list", {
      project_id: projectId,
      kind: "checklist",
    });
    expect(listed.findings.length).toBe(first.checked);
  });
});

describe("contradictions [@req QAA-FR-016] [@req QAA-FR-034]", () => {
  it("records the documentation/code contradiction with both sides and their evidence, and asks for clarification", async () => {
    const conflict = first.conflicts.find((c) => c.conflict_id === PASSWORD_CONFLICT)!;
    expect(conflict.kind).toBe("documentation_vs_code");
    expect(conflict.sides.map((s) => s.source)).toEqual(["documentation", "code"]);
    for (const side of conflict.sides) expect(side.evidence_ids.length, side.source).toBeGreaterThan(0);
    expect(conflict.sides[1]!.statement).toMatch(/12/);
    expect(conflict.scenario_ids.length).toBeGreaterThan(0);
    for (const id of conflict.scenario_ids) {
      const doc = await show(id);
      expect(doc.status).toBe("needs_clarification");
      expect(doc.status_reason).toContain(PASSWORD_CONFLICT);
    }
  });

  it("records scenarios whose identical steps expect different results, and never keeps one silently", async () => {
    const base = await show(first.critiques.find((c) => c.status === "pending_review")!.scenario_id);
    const other: Doc = JSON.parse(JSON.stringify(base));
    other.scenario_id = `${base.scenario_id}.edited`;
    other.display_key = "TC-EDIT-001";
    other.steps.at(-1)!.expected_result!.description.value = "Something else happens";
    insert(projectId, other);
    const again = await call<Critique>("scenarios.critique", { plan_id: planId });
    const conflict = again.conflicts.find((c) => c.kind === "expectations_disagree")!;
    expect(conflict.scenario_ids.sort()).toEqual([base.scenario_id, other.scenario_id].sort());
    expect(conflict.sides.map((s) => s.statement)).toContain("Something else happens");
    for (const id of conflict.scenario_ids) expect((await show(id)).status).toBe("needs_clarification");
  });
});

describe("duplicates [@req QAA-FR-035]", () => {
  it("flags a scenario that duplicates an approved one, with the reason", async () => {
    const original = await show(first.critiques.filter((c) => c.status === "pending_review").at(-1)!.scenario_id);
    // Approval comes with IMP-207; here the stored version is marked approved directly.
    host.state.db
      .prepare("UPDATE scenario_versions SET status = 'approved' WHERE scenario_id = ? AND version = ?")
      .run(original.scenario_id, original.version);
    const copy: Doc = {
      ...JSON.parse(JSON.stringify(original)),
      scenario_id: `${original.scenario_id}.copy`,
      display_key: "TC-COPY-001",
    };
    insert(projectId, copy);
    const result = await call<Critique>("scenarios.critique", { plan_id: planId });
    const finding = result.duplicates.find((d) => d.scenario_id === copy.scenario_id)!;
    expect(finding).toMatchObject({ duplicate_of: original.scenario_id, duplicate_of_status: "approved" });
    expect(finding.reason).toMatch(/same feature, package records, steps and expected result/);
    const critique = result.critiques.find((c) => c.scenario_id === copy.scenario_id)!;
    expect(critique.status).toBe("needs_clarification");
    expect(critique.checks.find((c) => c.check === "no_duplication")!.passed).toBe(false);
    expect(result.critiques.some((c) => c.scenario_id === original.scenario_id)).toBe(false);
  });
});
