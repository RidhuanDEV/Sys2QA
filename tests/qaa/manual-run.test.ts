import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { projectDirectory } from "../../packages/platform/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Shown {
  run: { run_id: string; state: string; label: string; reported_by: string; baseline_changed: boolean };
  progress: { steps_total: number; steps_recorded: number };
  language: { requested: string; shown: string[]; fallback: boolean };
  cases: Array<{
    scenario_id: string;
    steps: Array<{
      step_id: string;
      expected_result: unknown;
      not_applicable_allowed: boolean;
      result: { status: string; actual: string | null; evidence_refs: string[] } | null;
      attachments: Array<{ evidence_ref: string; media_type: string }>;
    }>;
  }>;
}

// Each test runs whole flows (import, plan, generation, approval, runs); slow CI machines need more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const work = mkdtempSync(join(tmpdir(), "sys2qa-manual-run-"));
const repo = join(work, "acme-portal");
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "tester@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok)
    throw new Error(`${operation}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data as T;
}
const code = (r: ServiceResult) => (r.ok ? "ok" : r.error.code);

let projectId: string;
let approved: string[];
let unapproved: string;

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
  await call("project.declare", {
    source_id: started.source.id,
    declared_by: "owner@example.com",
    operation_level: "L1",
  });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
    project_id: projectId,
    package_id: exported.package_id,
    version: exported.version,
  });
  await call("scenarios.generate", { plan_id: plan.plan.plan_id });
  await call("scenarios.critique", { plan_id: plan.plan.plan_id });
  const pending = (
    await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
      project_id: projectId,
      status: "pending_review",
    })
  ).scenarios.map((s) => s.scenario_id);
  approved = pending.filter((id) => /admin\.users_access\.(allowed-admin|denied-customer)$/.test(id));
  unapproved = pending.find((id) => id.endsWith("admin.users_access.denied-anonymous"))!;
  const preview = await call<{ preview_token: string }>("approvals.preview", {
    project_id: projectId,
    scenario_ids: approved,
    ...DECLARED,
  });
  await call("approvals.approve", {
    project_id: projectId,
    scenario_ids: approved,
    ...DECLARED,
    preview_token: preview.preview_token,
  });
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const start = (ids: string[], extra: Record<string, unknown> = {}) =>
  raw("runs.start_manual", {
    project_id: projectId,
    scenario_ids: ids,
    declared_environment: "tester laptop",
    declared_environment_url: "https://staging.acme.example",
    ...extra,
  });

describe("starting a manual run [@req QAA-FR-080] [@req QAA-FR-054]", () => {
  it("refuses an unapproved scenario and an environment the approval does not cover, and starts approved ones", async () => {
    expect(code(await start([...approved, unapproved]))).toMatch(/^APPROVAL_(REQUIRED|MISMATCH)$/);
    expect(code(await start(approved, { declared_environment: "another laptop" }))).toMatch(/^APPROVAL_/);
    expect(code(await raw("runs.start_manual", { project_id: projectId, scenario_ids: approved }))).toBe(
      "INPUT_INVALID",
    );
    const r = await start(approved);
    expect(code(r)).toBe("ok");
    const shown = (r as { ok: true; data: Shown }).data;
    expect(shown.run).toMatchObject({ state: "running", reported_by: "tester", label: "tester-reported" });
    expect(shown.run.run_id).toMatch(/^mrun:[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(shown.cases.map((c) => c.scenario_id)).toEqual(approved);
  });
});

describe("executing a manual run [@req QAA-FR-081] [@req QAA-FR-082] [@req QAA-FR-083] [@req QAA-FR-085] [@req QAA-FR-086] [@req SEC-019]", () => {
  it("records steps with the rules for each status, attaches evidence, pauses and resumes with progress kept, and submits", async () => {
    const shown = (await start(approved)) as { ok: true; data: Shown };
    const runId = shown.data.run.run_id;
    const [first, second] = shown.data.cases;
    const record = (scenario: string, step: string, status: string, extra: Record<string, unknown> = {}) =>
      raw("runs.record_step", { run_id: runId, scenario_id: scenario, step_id: step, status, ...extra });

    // The step with the expected result cannot be not applicable; a failure needs the actual result.
    const checked = first!.steps.find((s) => s.expected_result !== null)!;
    const setup = first!.steps.find((s) => s.expected_result === null)!;
    expect(checked.not_applicable_allowed).toBe(false);
    expect(code(await record(first!.scenario_id, checked.step_id, "not_applicable"))).toBe("RESULT_INCOMPLETE");
    expect(code(await record(first!.scenario_id, checked.step_id, "fail"))).toBe("RESULT_INCOMPLETE");
    expect(code(await record(first!.scenario_id, checked.step_id, "blocked"))).toBe("RESULT_INCOMPLETE");
    expect(code(await record(first!.scenario_id, setup.step_id, "not_applicable"))).toBe("ok");

    // Evidence: a PNG is accepted (recognized from its bytes), an HTML file renamed .png is not.
    const attach = (name: string, bytes: Buffer) =>
      raw("runs.attach", {
        run_id: runId,
        scenario_id: first!.scenario_id,
        step_id: checked.step_id,
        name,
        content_base64: bytes.toString("base64"),
      });
    const png = await attach("screenshot.png", PNG);
    expect(code(png)).toBe("ok");
    const evidence = (png as { ok: true; data: { evidence_ref: string; sha256: string; media_type: string } }).data;
    expect(evidence.media_type).toBe("image/png");
    const blob = join(
      projectDirectory(host.home, projectId),
      "blobs",
      evidence.sha256.slice(7, 9),
      evidence.sha256.slice(7),
    );
    expect(readFileSync(blob).equals(PNG)).toBe(true);
    expect(code(await attach("page.png", Buffer.from("<html><script>alert(1)</script></html>")))).toBe(
      "ATTACHMENT_REFUSED",
    );
    expect(code(await attach("drawing.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toBe(
      "ATTACHMENT_REFUSED",
    );
    // A pasted secret never reaches the store.
    // A fake key, joined at run time so the source holds no token-shaped string (as fixtures/security does).
    const fakeKey = ["sk", "live", "1234567890abcdefghijklmn"].join("_");
    const log = await attach("console.log", Buffer.from(`login ok\napi_key=${fakeKey}\n`));
    expect((log as { ok: true; data: { redacted: boolean } }).data.redacted).toBe(true);

    expect(
      code(
        await record(first!.scenario_id, checked.step_id, "fail", {
          actual: "The user list loaded without the admin role.",
          notes: "Reproduced twice.",
          evidence_refs: [evidence.evidence_ref],
        }),
      ),
    ).toBe("ok");

    // Pause: nothing can be recorded; resume restores the progress.
    await call("runs.pause", { run_id: runId });
    expect(code(await record(second!.scenario_id, second!.steps[0]!.step_id, "pass"))).toBe("RUN_STATE_INVALID");
    const resumed = await call<Shown>("runs.resume", { run_id: runId });
    expect(resumed.run.state).toBe("running");
    const before = resumed.cases[0]!.steps.find((s) => s.step_id === checked.step_id)!;
    expect(before.result).toMatchObject({ status: "fail", evidence_refs: [evidence.evidence_ref] });
    expect(before.attachments.map((a) => a.media_type)).toEqual(["image/png", "text/plain"]);

    // Submitting needs every step.
    expect(code(await raw("runs.submit", { run_id: runId }))).toBe("RESULT_INCOMPLETE");
    for (const c of resumed.cases)
      for (const s of c.steps) if (!s.result) expect(code(await record(c.scenario_id, s.step_id, "pass"))).toBe("ok");
    // Correcting a step supersedes the earlier record.
    expect(code(await record(second!.scenario_id, second!.steps[0]!.step_id, "pass", { notes: "Rechecked." }))).toBe(
      "ok",
    );
    const submitted = await call<{ result: Record<string, unknown> }>("runs.submit", { run_id: runId });
    expect(validateDocument("run-result", submitted.result).issues).toEqual([]);
    const cases = submitted.result.cases as Array<{ scenario_id: string; outcome: string; reported_by: string }>;
    expect(cases.map((c) => [c.scenario_id, c.outcome, c.reported_by])).toEqual([
      [first!.scenario_id, "failed", "tester"],
      [second!.scenario_id, "passed", "tester"],
    ]);
    expect(submitted.result).toMatchObject({
      state: "completed",
      environment: { declared: { name: "tester laptop", url: "https://staging.acme.example" } },
    });
    const superseded = host.state.db
      .prepare("SELECT COUNT(*) AS n FROM step_results WHERE run_id = ? AND supersedes IS NOT NULL")
      .get(runId) as { n: number };
    expect(superseded.n).toBe(1);
    expect(code(await record(second!.scenario_id, second!.steps[0]!.step_id, "pass"))).toBe("RUN_STATE_INVALID");
    const audits = host.state.db
      .prepare("SELECT action FROM audit_events WHERE target = ? ORDER BY seq")
      .all(runId) as Array<{ action: string }>;
    expect(new Set(audits.map((a) => a.action))).toEqual(
      new Set([
        "run.started",
        "run.step_recorded",
        "run.attachment_added",
        "run.paused",
        "run.resumed",
        "run.submitted",
      ]),
    );
  });

  it("keeps step identity whatever language is asked for, and flags a version shown in another language", async () => {
    const shown = ((await start(approved, { language: "id" })) as { ok: true; data: Shown }).data;
    const asked = await call<Shown>("runs.show", { run_id: shown.run.run_id, language: "en" });
    expect(asked.cases.map((c) => c.steps.map((s) => s.step_id))).toEqual(
      shown.cases.map((c) => c.steps.map((s) => s.step_id)),
    );
    expect(shown.language).toMatchObject({ requested: "id", shown: ["en"], fallback: true });
    expect(asked.language.fallback).toBe(false);
    await call("runs.abandon", { run_id: shown.run.run_id, reason: "Wrong language for this tester." });
  });
});

describe("abandoning a manual run [@req QAA-FR-089]", () => {
  it("records the reason, turns unrecorded steps into not_run and reports the run as abandoned", async () => {
    const shown = ((await start(approved)) as { ok: true; data: Shown }).data;
    const runId = shown.run.run_id;
    const c = shown.cases[0]!;
    await call("runs.record_step", {
      run_id: runId,
      scenario_id: c.scenario_id,
      step_id: c.steps[0]!.step_id,
      status: "pass",
    });
    expect(code(await raw("runs.abandon", { run_id: runId }))).toBe("INPUT_INVALID");
    const ended = await call<{
      result: { state: string; cases: Array<{ outcome: string; reason?: string; steps: Array<{ status: string }> }> };
    }>("runs.abandon", { run_id: runId, reason: "Staging went down." });
    expect(ended.result.state).toBe("abandoned");
    expect(ended.result.cases[0]!.steps.slice(1).every((s) => s.status === "not_run")).toBe(true);
    expect(ended.result.cases.map((x) => x.outcome)).toEqual(["inconclusive", "not_run"]);
    expect(ended.result.cases[0]!.reason).toBe("Staging went down.");
    const listed = await call<{ runs: Array<{ run_id: string; state: string; label: string }> }>("runs.list", {
      project_id: projectId,
      state: "abandoned",
    });
    expect(listed.runs.map((r) => r.run_id)).toContain(runId);
    expect(code(await raw("runs.resume", { run_id: runId }))).toBe("RUN_STATE_INVALID");
    expect(existsSync(projectDirectory(host.home, projectId))).toBe(true);
  });
});
