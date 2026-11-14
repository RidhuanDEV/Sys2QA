import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Shown {
  defect: {
    defect_id: string;
    state: string;
    severity: string;
    priority: string;
    suspected_type: string;
    links: { scenario_id: string; scenario_version: number; run_id: string; step_id: string; evidence_refs: string[] };
    environment: unknown;
    baseline: unknown;
  };
  transitions: Array<{ from_state: string; to_state: string; by: string; reason: string | null }>;
}

// Each test runs whole flows (import, plan, generation, approval, runs); slow CI machines need more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const work = mkdtempSync(join(tmpdir(), "sys2qa-defects-"));
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
let scenarioId: string;
let runId: string;
let evidenceRef: string;

/** A manual run of the scenario with every step recorded as given (S3 fails unless `pass`). */
async function runScenario(pass: boolean): Promise<string> {
  const shown = await call<{ run: { run_id: string }; cases: Array<{ steps: Array<{ step_id: string }> }> }>(
    "runs.start_manual",
    { project_id: projectId, scenario_ids: [scenarioId], declared_environment: "tester laptop" },
  );
  const id = shown.run.run_id;
  for (const s of shown.cases[0]!.steps) {
    const failing = !pass && s.step_id === "S3";
    if (failing) {
      const attached = await call<{ evidence_ref: string }>("runs.attach", {
        run_id: id,
        scenario_id: scenarioId,
        step_id: "S3",
        name: "screenshot.png",
        content_base64: PNG.toString("base64"),
      });
      evidenceRef = attached.evidence_ref;
    }
    await call("runs.record_step", {
      run_id: id,
      scenario_id: scenarioId,
      step_id: s.step_id,
      status: failing ? "fail" : "pass",
      ...(failing ? { actual: "The list did not load.", evidence_refs: [evidenceRef] } : {}),
    });
  }
  return id;
}

beforeAll(async () => {
  const repo = join(work, "acme-portal");
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
  await call("scenarios.generate", { plan_id: plan.plan.plan_id });
  await call("scenarios.critique", { plan_id: plan.plan.plan_id });
  scenarioId = (
    await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
      project_id: projectId,
      status: "pending_review",
    })
  ).scenarios.find((s) => s.scenario_id.endsWith("admin.users_access.allowed-admin"))!.scenario_id;
  const preview = await call<{ preview_token: string }>("approvals.preview", {
    project_id: projectId,
    scenario_ids: [scenarioId],
    ...DECLARED,
  });
  await call("approvals.approve", {
    project_id: projectId,
    scenario_ids: [scenarioId],
    ...DECLARED,
    preview_token: preview.preview_token,
  });
  runId = await runScenario(false);
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const create = (step: string, extra: Record<string, unknown> = {}) =>
  raw("defects.create", {
    run_id: runId,
    scenario_id: scenarioId,
    step_id: step,
    title: "Admin user list does not load",
    severity: "major",
    priority: "high",
    ...extra,
  });
const move = (defectId: string, to: string, extra: Record<string, unknown> = {}) =>
  raw("defects.transition", { defect_id: defectId, to, ...extra });

describe("defects from failed steps [@req QAA-FR-084] [@req QAA-FR-088]", () => {
  it("links a defect to the scenario version, run, failed step, its evidence, baseline and environment", async () => {
    expect(code(await create("S1"))).toBe("DEFECT_STEP_NOT_FAILED");
    expect(
      code(
        await raw("defects.create", {
          run_id: runId,
          scenario_id: scenarioId,
          step_id: "S3",
          title: "x",
          priority: "high",
        }),
      ),
    ).toBe("INPUT_INVALID");
    const shown = (await create("S3", { suspected_type: "product_defect", description: "Seen twice." })) as {
      ok: true;
      data: Shown;
    };
    const d = shown.data.defect;
    expect(validateDocument("defect", d).issues).toEqual([]);
    expect(d).toMatchObject({
      state: "new",
      severity: "major",
      priority: "high",
      suspected_type: "product_defect",
      links: {
        scenario_id: scenarioId,
        scenario_version: 1,
        run_id: runId,
        step_id: "S3",
        evidence_refs: [evidenceRef],
      },
      environment: { declared: { name: "tester laptop" } },
    });
    // The run's case result names the defect, and retention keeps the linked screenshot.
    const result = await call<{ cases: Array<{ defect_ids?: string[] }> }>("runs.result", { run_id: runId });
    expect(result.cases[0]!.defect_ids).toEqual([d.defect_id]);
    const links = host.state.db.prepare("SELECT links_json FROM defects WHERE id = ?").get(d.defect_id) as {
      links_json: string;
    };
    const sha = (
      host.state.db.prepare("SELECT sha256 FROM run_attachments WHERE id = ?").get(evidenceRef) as { sha256: string }
    ).sha256.slice(7);
    expect(links.links_json).toContain(sha);
  });

  it("reclassifies severity, priority and suspected type with a reason", async () => {
    const id = ((await create("S3")) as { ok: true; data: Shown }).data.defect.defect_id;
    const updated = await call<Shown>("defects.update", {
      defect_id: id,
      severity: "critical",
      suspected_type: "test_defect",
      reason: "Blocks every admin.",
    });
    expect(updated.defect).toMatchObject({ severity: "critical", priority: "high", suspected_type: "test_defect" });
    expect(code(await raw("defects.update", { defect_id: id, reason: "nothing" }))).toBe("INPUT_INVALID");
  });
});

describe("defect lifecycle [@req QAA-FR-088] [@req CR-070]", () => {
  it("follows PRD §15.12, refuses every other move, and closes only on a passing retest or a reason", async () => {
    const id = ((await create("S3")) as { ok: true; data: Shown }).data.defect.defect_id;
    expect(code(await move(id, "fixed"))).toBe("DEFECT_TRANSITION_INVALID");
    expect(code(await move(id, "triaged"))).toBe("ok");
    expect(code(await move(id, "rejected"))).toBe("DEFECT_TRANSITION_INVALID");
    expect(code(await move(id, "confirmed"))).toBe("ok");
    expect(code(await move(id, "fixed"))).toBe("ok");
    expect(code(await move(id, "ready_for_retest"))).toBe("ok");
    expect(code(await move(id, "closed"))).toBe("DEFECT_TRANSITION_INVALID");
    // The failing run is no passing retest.
    expect(code(await move(id, "closed", { retest_run_id: runId }))).toBe("DEFECT_TRANSITION_INVALID");
    const retest = await runScenario(true);
    await call("runs.submit", { run_id: retest });
    expect(code(await move(id, "closed", { retest_run_id: retest }))).toBe("ok");
    expect(code(await move(id, "reopened"))).toBe("ok");
    const shown = await call<Shown>("defects.show", { defect_id: id });
    expect(shown.transitions.map((t) => [t.from_state, t.to_state])).toEqual([
      ["new", "triaged"],
      ["triaged", "confirmed"],
      ["confirmed", "fixed"],
      ["fixed", "ready_for_retest"],
      ["ready_for_retest", "closed"],
      ["closed", "reopened"],
    ]);
    expect(shown.transitions[4]!.reason).toBe(`retest passed in ${retest}`);
    expect(shown.transitions.every((t) => t.by === caller.actor)).toBe(true);
  });

  it("rejects only with a reason and marks a duplicate only of another defect; both are terminal", async () => {
    const a = ((await create("S3")) as { ok: true; data: Shown }).data.defect.defect_id;
    const b = ((await create("S3")) as { ok: true; data: Shown }).data.defect.defect_id;
    await call("defects.transition", { defect_id: a, to: "triaged" });
    await call("defects.transition", { defect_id: b, to: "triaged" });
    expect(code(await move(a, "duplicate"))).toBe("DEFECT_TRANSITION_INVALID");
    expect(code(await move(a, "duplicate", { duplicate_of: a }))).toBe("NOT_FOUND");
    const dup = await call<Shown & { defect: { duplicate_of?: string } }>("defects.transition", {
      defect_id: a,
      to: "duplicate",
      duplicate_of: b,
    });
    expect(dup.defect.duplicate_of).toBe(b);
    expect(code(await move(a, "triaged"))).toBe("DEFECT_TRANSITION_INVALID");
    expect(code(await move(b, "rejected", { reason: "Works as designed." }))).toBe("ok");
    expect(code(await move(b, "triaged"))).toBe("DEFECT_TRANSITION_INVALID");
    const listed = await call<{ defects: Array<{ defect_id: string; state: string }> }>("defects.list", {
      project_id: projectId,
      state: "duplicate",
    });
    expect(listed.defects.map((d) => d.defect_id)).toEqual([a]);
  });
});
