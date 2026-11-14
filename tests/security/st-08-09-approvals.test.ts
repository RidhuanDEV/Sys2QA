import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));

interface Doc {
  scenario_id: string;
  version: number;
  status: string;
  state_changing: boolean;
  cleanup: unknown[];
  display_key: string;
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-approvals-"));
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
}
const code = (r: ServiceResult) => (r.ok ? "ok" : r.error.code);
const show = async (id: string, version?: number) =>
  (await call<{ scenario: Doc }>("scenarios.show", { scenario_id: id, ...(version ? { version } : {}) })).scenario;

let projectId: string;
let sourceId: string;
let runId: string;
let pending: Doc[];
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;

async function approve(
  ids: string[],
  binding: Record<string, unknown> = DECLARED,
  extra: Record<string, unknown> = {},
) {
  const preview = await call<{ preview_token: string; items: Array<{ scenario_id: string; version: number }> }>(
    "approvals.preview",
    {
      project_id: projectId,
      scenario_ids: ids,
      ...binding,
    },
  );
  return raw("approvals.approve", {
    project_id: projectId,
    scenario_ids: ids,
    ...binding,
    preview_token: preview.preview_token,
    ...extra,
  });
}
const check = (id: string, binding: Record<string, unknown> = DECLARED, version?: number) =>
  call<{ allowed: boolean; issues: Array<{ code: string; message: string; details?: { mismatched?: string[] } }> }>(
    "execution.check",
    {
      scenario_id: id,
      ...(version ? { version } : {}),
      ...binding,
    },
  );

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
  sourceId = started.source.id;
  await call("project.declare", { source_id: sourceId, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: sourceId });
  runId = run.run_id;
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: runId });
  const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: projectId,
    package_id: exported.package_id,
    version: exported.version,
  });
  await call("scenarios.generate", { plan_id: plan.plan.plan_id });
  await call("scenarios.critique", { plan_id: plan.plan.plan_id });
  const list = await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
    project_id: projectId,
    status: "pending_review",
  });
  pending = [];
  for (const s of list.scenarios) pending.push(await show(s.scenario_id));
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const changing = () => pending.filter((s) => s.state_changing);
const readOnly = () => pending.filter((s) => !s.state_changing);

describe("ST-08 state-changing approval [@req QAA-FR-057] [@req SEC-010]", () => {
  it("refuses a state-changing scenario without the explicit acknowledgment", async () => {
    const s = changing()[0]!;
    expect(code(await approve([s.scenario_id]))).toBe("APPROVAL_REQUIRED");
    expect((await show(s.scenario_id)).status).toBe("pending_review");
  });

  it("refuses it without a cleanup plan even when acknowledged, and accepts an acknowledged irreversibility", async () => {
    const s = changing()[1]!;
    const edited = await call<{ version: number }>("scenarios.edit", { scenario_id: s.scenario_id, cleanup: [] });
    await call("scenarios.decide", {
      scenario_id: s.scenario_id,
      version: edited.version,
      decision: "ready_for_review",
      reason: "Reviewed after edit.",
    });
    expect(code(await approve([s.scenario_id], DECLARED, { state_changing_ack: true }))).toBe("APPROVAL_REQUIRED");
    const irreversible = await call<{ version: number }>("scenarios.edit", {
      scenario_id: s.scenario_id,
      irreversible_ack: true,
    });
    await call("scenarios.decide", {
      scenario_id: s.scenario_id,
      version: irreversible.version,
      decision: "ready_for_review",
      reason: "Irreversibility accepted.",
    });
    expect(code(await approve([s.scenario_id], DECLARED, { state_changing_ack: true }))).toBe("ok");
  });

  it("approves a state-changing scenario with a cleanup plan and the acknowledgment, recorded on the approval", async () => {
    const s = changing()[2]!;
    const r = await approve([s.scenario_id], DECLARED, { state_changing_ack: true });
    expect(code(r)).toBe("ok");
    const [approval] = (r as { ok: true; data: { approvals: Array<Record<string, unknown>> } }).data.approvals;
    expect(approval).toMatchObject({ state_changing_ack: true });
    expect((await check(s.scenario_id)).allowed).toBe(true);
  });
});

describe("ST-09 approval binding [@req QAA-FR-054] [@req QAA-FR-052] [@req QAA-FR-053]", () => {
  it("binds every approval to version, baseline, environment, scope policy version and test-data profile", async () => {
    const s = readOnly()[0]!;
    const r = await approve([s.scenario_id]);
    const [approval] = (r as { ok: true; data: { approvals: Array<Record<string, unknown>> } }).data.approvals;
    expect(validateDocument("approval", approval).issues).toEqual([]);
    expect(approval).toMatchObject({
      scenario_id: s.scenario_id,
      scenario_version: s.version,
      baseline: expect.objectContaining({ packages: expect.any(Array), revision: expect.any(Object) }),
      declared_environment_id: "denv:tester-laptop",
      scope_policy_version: 1,
      test_data_profile: "default",
      mode: "manual",
      approver: caller.actor,
      state: "active",
    });
    expect((await check(s.scenario_id)).allowed).toBe(true);
  });

  it("refuses an unapproved scenario and a different test-data profile or mode", async () => {
    const approved = readOnly()[0]!;
    const unapproved = readOnly()[5]!;
    expect((await check(unapproved.scenario_id)).issues.map((i) => i.code)).toContain("APPROVAL_REQUIRED");
    const other = await check(approved.scenario_id, { ...DECLARED, test_data_profile: "seeded" });
    expect(other.allowed).toBe(false);
    expect(other.issues.find((i) => i.code === "APPROVAL_MISMATCH")?.details?.mismatched).toContain(
      "test_data_profile",
    );
    expect((await check(approved.scenario_id, { ...DECLARED, declared_environment: "someone else" })).allowed).toBe(
      false,
    );
  });

  it("refuses after an edit: the new version is unapproved and the old approval does not transfer", async () => {
    const s = readOnly()[1]!;
    await approve([s.scenario_id]);
    expect((await check(s.scenario_id)).allowed).toBe(true);
    const edited = await call<{ version: number; status: string }>("scenarios.edit", {
      scenario_id: s.scenario_id,
      title: "Admin is refused a guarded page (reworded)",
    });
    expect(edited).toMatchObject({ version: s.version + 1, status: "draft" });
    expect((await check(s.scenario_id)).allowed).toBe(false);
    expect((await check(s.scenario_id, DECLARED, s.version)).allowed).toBe(false);
    const approvals = await call<{ approvals: Array<{ scenario_version: number; state: string }> }>("approvals.list", {
      scenario_id: s.scenario_id,
    });
    expect(approvals.approvals).toEqual([
      expect.objectContaining({ scenario_version: s.version, state: "superseded" }),
    ]);
  });

  it("refuses a suspended or revoked approval", async () => {
    const [a, b] = [readOnly()[2]!, readOnly()[3]!];
    const ra = await approve([a.scenario_id]);
    await approve([b.scenario_id]);
    const approvalA = (ra as { ok: true; data: { approvals: Array<{ approval_id: string }> } }).data.approvals[0]!
      .approval_id;
    await call("approvals.revoke", { approval_id: approvalA, reason: "Wrong environment chosen." });
    expect((await check(a.scenario_id)).allowed).toBe(false);
    // Suspension comes from staleness (IMP-208); here the stored approval is suspended directly.
    host.state.db.prepare("UPDATE approvals SET state = 'suspended' WHERE scenario_id = ?").run(b.scenario_id);
    expect((await check(b.scenario_id)).issues.map((i) => i.message).join(" ")).toMatch(/suspended/);
  });

  it("refuses after the environment's scope policy changes", async () => {
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
    const s = readOnly()[4]!;
    const binding = { mode: "manual", environment_id: env.id };
    expect(code(await approve([s.scenario_id], binding))).toBe("ok");
    expect((await check(s.scenario_id, binding)).allowed).toBe(true);
    await configure(["staging.acme.example", "api.staging.acme.example"]);
    const after = await check(s.scenario_id, binding);
    expect(after.allowed).toBe(false);
    expect(after.issues.find((i) => i.code === "APPROVAL_MISMATCH")?.details?.mismatched).toContain(
      "scope_policy_version",
    );
  });

  it("refuses after a newer package of the system is stored", async () => {
    const s = readOnly()[6]!;
    await approve([s.scenario_id]);
    expect((await check(s.scenario_id)).allowed).toBe(true);
    await call("saa.export", { run_id: runId });
    const after = await check(s.scenario_id);
    expect(after.allowed).toBe(false);
    expect(after.issues.find((i) => i.code === "APPROVAL_MISMATCH")?.details?.mismatched).toContain("baseline");
  });
});

describe("review actions [@req QAA-FR-050] [@req QAA-FR-051] [@req QAA-FR-055]", () => {
  it("previews the exact versions of a bulk approval and refuses a selection that changed since", async () => {
    const ids = readOnly()
      .slice(7, 10)
      .map((s) => s.scenario_id);
    const preview = await call<{
      items: Array<{ scenario_id: string; version: number; title: string }>;
      preview_token: string;
    }>("approvals.preview", {
      project_id: projectId,
      scenario_ids: ids,
      ...DECLARED,
    });
    expect(preview.items.map((i) => i.scenario_id)).toEqual(ids);
    for (const item of preview.items) expect(item.version).toBeGreaterThanOrEqual(1);
    await call("scenarios.edit", { scenario_id: ids[0], title: "Changed after the preview was shown" });
    await call("scenarios.decide", {
      scenario_id: ids[0],
      version: (await show(ids[0]!)).version,
      decision: "ready_for_review",
      reason: "Re-reviewed.",
    });
    const stale = await raw("approvals.approve", {
      project_id: projectId,
      scenario_ids: ids,
      ...DECLARED,
      preview_token: preview.preview_token,
    });
    expect(code(stale)).toBe("CONFLICT");
    const fresh = await approve(ids);
    expect((fresh as { ok: true; data: { approved: number } }).data.approved).toBe(3);
  });

  it("rejects, defers and requests regeneration with a reason, each audited, and refuses to approve them", async () => {
    const [r, d, g] = readOnly().slice(10, 13);
    for (const [s, decision] of [
      [r!, "reject"],
      [d!, "defer"],
      [g!, "request_regeneration"],
    ] as const)
      await call("scenarios.decide", {
        scenario_id: s.scenario_id,
        version: s.version,
        decision,
        reason: `Decided: ${decision}.`,
      });
    expect((await show(r!.scenario_id)).status).toBe("rejected");
    expect((await show(d!.scenario_id)).status).toBe("deferred");
    expect((await show(g!.scenario_id)).status).toBe("needs_clarification");
    expect(
      code(await raw("approvals.preview", { project_id: projectId, scenario_ids: [r!.scenario_id], ...DECLARED })),
    ).toBe("SCENARIO_NOT_READY");
    const audited = host.state.db
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'scenario.decided'")
      .get() as { n: number };
    expect(audited.n).toBeGreaterThanOrEqual(3);
  });

  it("overrides the execution classification with a reason, audited, and refuses automation_ready without automation", async () => {
    const s = readOnly()[13]!;
    const ok = await call<{ classification: string }>("scenarios.classify", {
      scenario_id: s.scenario_id,
      classification: "automation_candidate",
      reason: "Stable page; worth automating once locators exist.",
    });
    expect(ok.classification).toBe("automation_candidate");
    expect(
      code(
        await raw("scenarios.classify", {
          scenario_id: s.scenario_id,
          classification: "automation_ready",
          reason: "Try.",
        }),
      ),
    ).toBe("SCN_NOT_AUTOMATABLE");
    const event = host.state.db
      .prepare("SELECT details_json FROM audit_events WHERE action = 'scenario.classified' ORDER BY seq DESC LIMIT 1")
      .get() as {
      details_json: string;
    };
    expect(JSON.parse(event.details_json)).toMatchObject({
      from: "manual_only",
      to: "automation_candidate",
      reason: expect.any(String),
    });
  });

  it("filters the list by status", async () => {
    const approved = await call<{ scenarios: Array<{ status: string }> }>("scenarios.list", {
      project_id: projectId,
      status: "approved",
    });
    expect(approved.scenarios.length).toBeGreaterThan(5);
    expect(approved.scenarios.every((s) => s.status === "approved")).toBe(true);
  });
});
