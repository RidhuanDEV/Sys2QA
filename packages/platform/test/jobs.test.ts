import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertJobTransition,
  createIdGenerator,
  createLogger,
  createUlidGenerator,
  IdempotencyConflictError,
  JobOrchestrator,
  JobStateError,
  JobStore,
  loadMigrations,
  memorySink,
  openStateDatabase,
  Redactor,
  TransientJobError,
  type InProcessHandler,
  type JobTypeDefinition,
  type StateDatabase,
} from "../src/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
let dir: string;
let state: StateDatabase;
let clock: number;
const now = () => new Date(clock);
let store: JobStore;
const orchestrators: JobOrchestrator[] = [];

function orchestrator(
  types: Record<string, JobTypeDefinition>,
  options: { maxConcurrent?: number; cancelGraceMs?: number; leaseMs?: number; owner?: string } = {},
) {
  const o = new JobOrchestrator({
    store,
    owner: options.owner ?? "host:test",
    cancelGraceMs: options.cancelGraceMs ?? 200,
    leaseMs: options.leaseMs ?? 60_000,
    maxConcurrent: options.maxConcurrent ?? 4,
    retryDelayMs: () => 1000,
  });
  for (const [type, definition] of Object.entries(types)) o.register(type, definition);
  orchestrators.push(o);
  return o;
}
const inProcess = (
  run: InProcessHandler["run"],
  extra: Omit<JobTypeDefinition, "handler"> = {},
): JobTypeDefinition => ({
  handler: { kind: "in_process", run },
  ...extra,
});
const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  clock = Date.parse("2026-10-22T10:00:00.000Z");
  dir = mkdtempSync(join(tmpdir(), "sys2qa-jobs-"));
  state = openStateDatabase({ path: join(dir, "state.db"), now });
  store = new JobStore(state.db, { now, newId: createIdGenerator(now) });
});
afterEach(async () => {
  for (const o of orchestrators.splice(0)) await o.stop();
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("job queue [@req NFR-004]", () => {
  it("reuses the job for a repeated idempotency key and rejects the key for a different request", () => {
    const first = store.enqueue({
      type: "saa.analyze",
      payload: { root: "/repo", options: { a: 1, b: 2 } },
      idempotencyKey: "analyze:/repo:rev1",
    });
    const again = store.enqueue({
      type: "saa.analyze",
      payload: { options: { b: 2, a: 1 }, root: "/repo" },
      idempotencyKey: "analyze:/repo:rev1",
    });
    expect(first.created).toBe(true);
    expect(again).toEqual({ job: first.job, created: false });
    expect(() =>
      store.enqueue({ type: "saa.analyze", payload: { root: "/other" }, idempotencyKey: "analyze:/repo:rev1" }),
    ).toThrow(IdempotencyConflictError);
    expect(store.list()).toHaveLength(1);
  });

  it("leases by priority, then age, and records every transition", () => {
    const low = store.enqueue({ type: "t", payload: 1 }).job;
    clock += 1;
    const high = store.enqueue({ type: "t", payload: 2, priority: 5 }).job;
    expect(store.lease("w", 1000, ["t"])?.id).toBe(high.id);
    expect(store.lease("w", 1000, ["t"])?.id).toBe(low.id);
    expect(store.lease("w", 1000, ["t"])).toBeUndefined();
    expect(store.events(high.id).map((e) => e.event)).toEqual(["state.queued", "state.running"]);
  });

  it("validates transitions in code", () => {
    expect(() => assertJobTransition("completed", "running")).toThrow(JobStateError);
    expect(() => assertJobTransition("queued", "completed")).toThrow(JobStateError);
    expect(() => assertJobTransition("running", "cancelling")).not.toThrow();
  });

  it("refuses updates from a worker that no longer holds the lease", () => {
    const job = store.enqueue({ type: "t", payload: null }).job;
    store.lease("w1", 1000, ["t"]);
    expect(() => store.complete(job.id, "w2")).toThrow(/not leased by w2/);
  });

  it("logs every job transition without payload secrets [@req OBS-002] [@req QAA-FR-101]", () => {
    const sink = memorySink();
    const logged = new JobStore(state.db, {
      now,
      newId: createIdGenerator(now),
      logger: createLogger({ sink, redactor: new Redactor(), now }),
    });
    const job = logged.enqueue({ type: "t", payload: { password: "hunter2hunter2" } }).job;
    logged.lease("w", 1000, ["t"]);
    logged.complete(job.id, "w");
    expect(sink.lines.map((l) => (JSON.parse(l) as { to: string }).to)).toEqual(["queued", "running", "completed"]);
    expect(sink.lines.join("\n")).not.toContain("hunter2");
  });
});

describe("job orchestration [@req QAA-FR-066] [@req NFR-004]", () => {
  it("runs a job without blocking the caller and stores its result [@req NFR-006]", async () => {
    let release: (() => void) | undefined;
    const o = orchestrator({
      slow: inProcess(
        async (ctx) => (await new Promise<void>((r) => (release = r)), ctx.progress({ done: 1 }), { pages: 3 }),
      ),
    });
    const { job } = store.enqueue({ type: "slow", payload: null });
    expect(o.tick()).toEqual([job.id]);
    expect(store.get(job.id)?.state).toBe("running");
    await waitFor(() => release !== undefined);
    release!();
    await o.drain();
    expect(store.get(job.id)?.state).toBe("completed");
    expect(store.events(job.id).map((e) => e.event)).toEqual([
      "state.queued",
      "state.running",
      "progress",
      "state.completed",
    ]);
  });

  it("respects global and per-type concurrency limits", async () => {
    const gates: Array<() => void> = [];
    const wait = inProcess(() => new Promise<void>((r) => gates.push(r)));
    const o = orchestrator({ a: wait, b: { ...wait, concurrency: 1 } }, { maxConcurrent: 2 });
    for (const type of ["b", "b", "a", "a"]) store.enqueue({ type, payload: null });
    expect(o.tick()).toHaveLength(2);
    expect(store.countRunning("b")).toBe(1);
    expect(store.countRunning()).toBe(2);
    await waitFor(() => gates.length === 2);
    gates.splice(0).forEach((g) => g());
    await o.drain();
    expect(o.tick()).toHaveLength(2);
    await waitFor(() => gates.length === 2);
    gates.splice(0).forEach((g) => g());
    await o.drain();
  });

  it("retries only transient failures of retry-safe types, with backoff, up to the attempt limit [@req QAA-FR-067]", async () => {
    let calls = 0;
    const flaky = inProcess(async () => {
      calls++;
      throw new TransientJobError("browser launch failed");
    });
    const o = orchestrator({ safe: { ...flaky, retry: "transient" }, unsafe: flaky });
    const safe = store.enqueue({ type: "safe", payload: null, maxAttempts: 2 }).job;
    const unsafe = store.enqueue({ type: "unsafe", payload: null, maxAttempts: 3 }).job;
    o.tick();
    await o.drain();
    expect(store.get(unsafe.id)?.state).toBe("failed");
    expect(store.get(safe.id)).toMatchObject({ state: "queued", attempt: 1 });
    expect(o.tick()).toEqual([]); // backoff not yet elapsed
    clock += 1000;
    o.tick();
    await o.drain();
    expect(store.get(safe.id)).toMatchObject({ state: "failed", attempt: 2, error: { code: "JOB_FAILED" } });
    expect(calls).toBe(3);
  });

  it("cancels a queued job at once and a running job cooperatively [@req QAA-FR-102]", async () => {
    const o = orchestrator(
      { loop: inProcess((ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve()))) },
      { maxConcurrent: 1, cancelGraceMs: 5000 },
    );
    const queued = store.enqueue({ type: "loop", payload: null, priority: -1 }).job;
    const running = store.enqueue({ type: "loop", payload: null }).job;
    expect(o.tick()).toEqual([running.id]);
    expect(o.cancel(queued.id, "user").state).toBe("cancelled");
    expect(o.cancel(running.id, "user").state).toBe("cancelling");
    await o.drain();
    expect(store.get(running.id)).toMatchObject({ state: "cancelled", error: { code: "JOB_CANCELLED" } });
  });

  it("settles a job whose in-process handler ignores cancellation once the grace period ends", async () => {
    const o = orchestrator({ stubborn: inProcess(() => new Promise(() => {})) }, { cancelGraceMs: 50 });
    const job = store.enqueue({ type: "stubborn", payload: null }).job;
    o.tick();
    o.cancel(job.id, "user");
    await o.drain();
    expect(store.get(job.id)?.state).toBe("cancelled");
  });

  it("enforces time and counted budgets and never marks a partial job complete [@req NFR-002]", async () => {
    const o = orchestrator({
      endless: inProcess((ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve()))),
      crawler: inProcess(async (ctx) => {
        for (let page = 0; page < 10; page++) ctx.charge("max_pages");
      }),
    });
    const timed = store.enqueue({ type: "endless", payload: null, budget: { max_duration_ms: 30 } }).job;
    const counted = store.enqueue({ type: "crawler", payload: null, budget: { max_pages: 5 } }).job;
    o.tick();
    await o.drain();
    expect(store.get(timed.id)).toMatchObject({
      state: "failed",
      error: { code: "BUDGET_EXHAUSTED", details: { resource: "max_duration_ms" } },
    });
    expect(store.get(counted.id)).toMatchObject({
      state: "failed",
      error: { code: "BUDGET_EXHAUSTED", details: { resource: "max_pages", limit: 5 } },
    });
  });

  it("leaves jobs of types this host does not handle in the queue", () => {
    const o = orchestrator({ known: inProcess(async () => {}) });
    const job = store.enqueue({ type: "qaa.execute", payload: null }).job;
    expect(o.tick()).toEqual([]);
    expect(store.get(job.id)?.state).toBe("queued");
  });
});

describe("worker processes [@req QAA-FR-066]", () => {
  const worker = (name: string, extra: Omit<JobTypeDefinition, "handler"> = {}): JobTypeDefinition => ({
    handler: { kind: "worker", modulePath: fixture(name) },
    ...extra,
  });

  it("runs a worker with the memory budget and without the host's environment [@req NFR-002]", async () => {
    process.env.SYS2QA_TEST_SECRET = "must-not-reach-workers";
    try {
      const o = orchestrator({ echo: worker("worker-echo.mjs") });
      const job = store.enqueue({
        type: "echo",
        payload: { url: "https://staging.example" },
        budget: { max_memory_mb: 256 },
      }).job;
      o.tick();
      await o.drain();
      const done = store.get(job.id)!;
      expect(done.state).toBe("completed");
      const result = store.events(job.id).at(-1)!.data.result as {
        echo: unknown;
        execArgv: string[];
        envKeys: string[];
      };
      expect(result.echo).toEqual({ url: "https://staging.example" });
      expect(result.execArgv).toContain("--max-old-space-size=256");
      expect(result.envKeys).not.toContain("SYS2QA_TEST_SECRET");
    } finally {
      delete process.env.SYS2QA_TEST_SECRET;
    }
  });

  it("kills a worker that ignores cancellation within the grace period [@req QAA-FR-102]", async () => {
    const o = orchestrator({ hang: worker("worker-hang.mjs") }, { cancelGraceMs: 300 });
    const job = store.enqueue({ type: "hang", payload: null }).job;
    o.tick();
    await waitFor(() => store.events(job.id).some((e) => e.event === "progress"));
    const pid = store.events(job.id).find((e) => e.event === "progress")!.data.pid as number;
    const started = Date.now();
    o.cancel(job.id, "user");
    await o.drain();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(store.get(job.id)?.state).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it("stops a cooperative worker on request", async () => {
    const o = orchestrator({ coop: worker("worker-cooperative.mjs") }, { cancelGraceMs: 5000 });
    const job = store.enqueue({ type: "coop", payload: null }).job;
    o.tick();
    await waitFor(() => store.events(job.id).some((e) => e.event === "progress"));
    const started = Date.now();
    o.cancel(job.id, "user");
    await o.drain();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(store.get(job.id)?.state).toBe("cancelled");
  }, 10_000);

  it("treats a crash as a transient failure and a reported error as final", async () => {
    const o = orchestrator({
      crash: worker("worker-crash.mjs", { retry: "transient" }),
      fails: worker("worker-fails.mjs", { retry: "transient" }),
    });
    const crash = store.enqueue({ type: "crash", payload: null, maxAttempts: 2 }).job;
    const fails = store.enqueue({ type: "fails", payload: null, maxAttempts: 2 }).job;
    o.tick();
    await o.drain();
    expect(store.get(crash.id)).toMatchObject({ state: "queued", error: { code: "WORKER_CRASHED" } });
    expect(store.get(fails.id)).toMatchObject({
      state: "failed",
      error: { code: "JOB_FAILED", message: "selector not found" },
    });
  }, 10_000);
});

describe("recovery and stuck jobs [@req NFR-004] [@req QAA-FR-102]", () => {
  it("after a host restart, re-queues resumable jobs, fails the others and completes pending cancels", () => {
    const resumable = store.enqueue({ type: "resumable", payload: null, maxAttempts: 2 }).job;
    const once = store.enqueue({ type: "once", payload: null }).job;
    const cancelling = store.enqueue({ type: "once", payload: null }).job;
    for (let i = 0; i < 3; i++) store.lease("host:old", 1000, ["resumable", "once"]);
    store.requestCancel(cancelling.id, "user");
    clock += 5000; // the old host died; its leases expired
    const o = orchestrator(
      { resumable: inProcess(async () => {}, { resumable: true }), once: inProcess(async () => {}) },
      { owner: "host:new" },
    );
    expect(o.recover().map((j) => [j.id, j.state])).toEqual(
      expect.arrayContaining([
        [resumable.id, "queued"],
        [once.id, "failed"],
        [cancelling.id, "cancelled"],
      ]),
    );
    expect(store.get(once.id)?.error?.code).toBe("LEASE_EXPIRED");
  });

  it("reports running jobs without recent progress or with an expired lease", () => {
    const quiet = store.enqueue({ type: "t", payload: null }).job;
    const lively = store.enqueue({ type: "t", payload: null }).job;
    store.lease("w", 60_000, ["t"]);
    store.lease("w", 60_000, ["t"]);
    clock += 20_000;
    store.progress(lively.id, "w", 60_000, { page: 4 });
    clock += 15_000;
    expect(store.findStuck(30_000).map((s) => [s.job.id, s.reason])).toEqual([[quiet.id, "no_progress"]]);
    clock += 60_000;
    expect(store.findStuck(300_000).map((s) => s.reason)).toEqual(["lease_expired", "lease_expired"]);
  });
});

describe("migrations and IDs", () => {
  it("upgrades a version-1 database with queued jobs to the latest schema [@req NFR-004]", () => {
    const path = join(dir, "v1.db");
    const v1 = openStateDatabase({ path, now, migrations: loadMigrations().filter((m) => m.version === 1) });
    new JobStore(v1.db, { now, newId: createIdGenerator(now) }).enqueue({
      type: "t",
      payload: { keep: true },
      idempotencyKey: "k",
    });
    v1.close();
    const latest = openStateDatabase({ path, now });
    try {
      expect(latest.appliedNow.map((m) => m.name)).toContain("job_scheduling");
      const migrated = new JobStore(latest.db, { now, newId: createIdGenerator(now) });
      expect(migrated.list()).toMatchObject([{ payload: { keep: true }, run_after: null, last_progress_at: null }]);
    } finally {
      latest.close();
    }
  });

  it("generates sortable, monotonic ULIDs", () => {
    const fixed = () => new Date("2026-10-22T10:00:00.000Z");
    const next = createUlidGenerator(fixed, (n) => new Uint8Array(n).fill(255 - 1));
    const ids = Array.from({ length: 5 }, () => next());
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(5);
    expect(createIdGenerator(fixed)("job")).toMatch(/^job:[0-9A-Z]{26}$/);
  });
});
