import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  buildTelemetryPayload,
  checkHealth,
  collectMetrics,
  createIdGenerator,
  JobStore,
  maybeSendTelemetry,
  openStateDatabase,
  ProjectService,
  Redactor,
  renderPrometheus,
  type StateDatabase,
} from "../src/index.js";

let dir: string;
let state: StateDatabase;
let jobs: JobStore;
let clock: number;
const now = () => new Date(clock);
beforeEach(() => {
  clock = Date.parse("2026-10-22T10:00:00.000Z");
  dir = mkdtempSync(join(tmpdir(), "sys2qa-obs-"));
  state = openStateDatabase({ path: join(dir, "state.db"), now });
  jobs = new JobStore(state.db, { now, newId: createIdGenerator(now) });
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function runJob(type: string, durationMs: number, end: (id: string) => void): void {
  const { job } = jobs.enqueue({ type, payload: null });
  jobs.lease("w", 3_600_000, [type]);
  clock += durationMs;
  end(job.id);
}

describe("metrics [@req OBS-001] [@req QAA-FR-103]", () => {
  it("reports queue depth, outcomes, durations, crashes, stuck jobs and model usage from persisted state", () => {
    runJob("saa.analyze", 1000, (id) => jobs.complete(id, "w"));
    runJob("saa.analyze", 3000, (id) => jobs.complete(id, "w"));
    runJob("qaa.discover", 2000, (id) =>
      jobs.fail(id, "w", { code: "WORKER_CRASHED", message: "exit 3" }, { retryable: false }),
    );
    runJob("qaa.discover", 500, (id) => (jobs.requestCancel(id, "user"), jobs.markCancelled(id, "w", "cancelled")));
    jobs.enqueue({ type: "qaa.discover", payload: null });
    jobs.enqueue({ type: "saa.analyze", payload: null });
    const { job: stuck } = jobs.enqueue({ type: "qaa.execute", payload: null });
    jobs.lease("w", 3_600_000, ["qaa.execute"]);
    clock += 20 * 60_000;
    state.db
      .prepare(
        "INSERT INTO model_usage (provider, model, prompt_template_version, tokens_in, tokens_out, outcome, created_at, updated_at) VALUES ('p', 'm', 't@1', 100, 10, ?, 'x', 'x')",
      )
      .run("ok");
    state.db
      .prepare(
        "INSERT INTO model_usage (provider, model, prompt_template_version, tokens_in, tokens_out, outcome, created_at, updated_at) VALUES ('p', 'm', 't@1', 0, 0, 'error', 'x', 'x')",
      )
      .run();

    const m = collectMetrics({ db: state.db, jobs, now, stateDbPath: join(dir, "state.db") });
    expect(m.jobs.queued_by_type).toEqual({ "qaa.discover": 1, "saa.analyze": 1 });
    expect(m.jobs.running).toBe(1);
    expect(m.jobs.by_state).toEqual({ cancelled: 1, completed: 2, failed: 1, queued: 2, running: 1 });
    expect(m.jobs.failures_by_code).toEqual({ WORKER_CRASHED: 1 });
    expect(m.jobs.worker_crashes).toBe(1);
    expect(m.jobs.cancellations).toBe(1);
    expect(m.jobs.stuck).toBe(1);
    expect(m.jobs.duration_ms).toEqual({ count: 4, p50: 1000, p95: 3000, max: 3000 });
    expect(m.model_usage).toMatchObject({ calls: 2, errors: 1, tokens_in: 100, tokens_out: 10 });
    expect(m.storage.state_db_bytes).toBeGreaterThan(0);
    expect(m.not_collected).toEqual({
      evidence_volume: null,
      cache_hit_rate: null,
      adapter_failure_rate: null,
      browser_duration: null,
    });
    void stuck;

    const text = renderPrometheus(m);
    expect(text).toContain('sys2qa_jobs_queued{type="qaa.discover"} 1');
    expect(text).toContain('sys2qa_job_failures_total{code="WORKER_CRASHED"} 1');
    expect(text).toContain('sys2qa_job_duration_ms{quantile="0.95"} 3000');
    expect(text).toMatch(/# TYPE sys2qa_llm_tokens_total counter\nsys2qa_llm_tokens_total\{direction="in"\} 100/);
  });
});

describe("health checks [@req OBS-004] [@req QAA-FR-103]", () => {
  it("is ok on a fresh installation, degraded with a stuck job and failing with a broken audit chain", () => {
    expect(checkHealth({ db: state.db, jobs, now, home: dir, minFreeBytes: 0 })).toMatchObject({ status: "ok" });
    jobs.enqueue({ type: "t", payload: null });
    jobs.lease("w", 60_000, ["t"]);
    clock += 120_000;
    const degraded = checkHealth({ db: state.db, jobs, now, home: dir, minFreeBytes: 0 });
    expect(degraded.status).toBe("degraded");
    expect(degraded.checks.find((c) => c.name === "jobs")?.detail).toContain("lease_expired");
    state.transaction(() =>
      appendAudit(state.db, { actor: "user", action: "export.created" }, { redactor: new Redactor(), now }),
    );
    state.db.exec("DROP TRIGGER audit_events_no_update");
    state.db.prepare("UPDATE audit_events SET actor = 'mallory'").run();
    expect(checkHealth({ db: state.db, jobs, now, home: dir, minFreeBytes: 0 }).status).toBe("failing");
  });
});

describe("telemetry [@req OBS-005]", () => {
  it("sends nothing with the default configuration", async () => {
    const projects = new ProjectService(state.db, {
      audit: { redactor: new Redactor(), now },
      newId: createIdGenerator(now),
    });
    let sent = 0;
    const transport = () => {
      sent++;
      return Promise.resolve();
    };
    const payload = () => buildTelemetryPayload(collectMetrics({ db: state.db, jobs, now }), "0.0.0");
    expect(projects.settings().telemetry_enabled).toBe(false);
    expect(await maybeSendTelemetry(projects.settings().telemetry_enabled, transport, payload)).toBe(false);
    projects.setSetting("telemetry_enabled", true, "admin");
    expect(await maybeSendTelemetry(projects.settings().telemetry_enabled, undefined, payload)).toBe(false);
    expect(await maybeSendTelemetry(projects.settings().telemetry_enabled, transport, payload)).toBe(true);
    expect(sent).toBe(1);
  });

  it("contains only counts and versions, never project content", () => {
    const projects = new ProjectService(state.db, {
      audit: { redactor: new Redactor(), now },
      newId: createIdGenerator(now),
    });
    const project = projects.createProject({ name: "Secret Acme Rebrand", actor: "owner" });
    projects.addEvidenceSource(project.id, "source_root", join(dir, "private", "acme"));
    jobs.enqueue({ type: "saa.analyze", projectId: project.id, payload: { root: join(dir, "private", "acme") } });
    const payload = buildTelemetryPayload(collectMetrics({ db: state.db, jobs, now }), "0.0.0");
    const text = JSON.stringify(payload);
    expect(Object.keys(payload).sort()).toEqual([
      "jobs_by_state",
      "llm_calls",
      "node_major",
      "os_family",
      "product_version",
      "schema",
    ]);
    for (const forbidden of ["Acme", "private", "project:", "saa.analyze", dir]) expect(text).not.toContain(forbidden);
  });
});
