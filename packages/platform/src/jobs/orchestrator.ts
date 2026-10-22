import { fork, type ChildProcess } from "node:child_process";
import type { Logger } from "../logging/logger.js";
import { BudgetExhaustedError, LeaseLostError, TransientJobError, type JobError } from "./states.js";
import type { Job, JobStore } from "./store.js";

export interface JobContext {
  readonly job: Job;
  /** Aborted when the job is cancelled or its time budget runs out; `signal.reason` is "cancelled" or "budget". */
  readonly signal: AbortSignal;
  /** Reports progress and renews the lease. */
  progress(data?: Record<string, unknown>): void;
  /** Counts use of a budgeted resource (e.g. "max_pages"); throws BudgetExhaustedError past the job's limit. */
  charge(resource: string, amount?: number): void;
}

export interface InProcessHandler {
  kind: "in_process";
  run(context: JobContext): Promise<Record<string, unknown> | void>;
}

/** A Node.js module run in a child process that speaks the worker protocol (see WorkerMessage). */
export interface WorkerHandler {
  kind: "worker";
  modulePath: string;
  execArgv?: string[];
}

export interface JobTypeDefinition {
  handler: InProcessHandler | WorkerHandler;
  /** "transient" retries only TransientJobError and worker crashes; "never" (default) for non-idempotent work (QAA-FR-067). */
  retry?: "never" | "transient";
  /** Re-queued after a host restart instead of failed (Data Model §7). */
  resumable?: boolean;
  /** Maximum concurrently running jobs of this type. */
  concurrency?: number;
}

/**
 * Worker protocol over the IPC channel. Parent → child: start, cancel. Child → parent: progress, result, error.
 * After sending its result or error a worker disconnects (`process.disconnect()`) and exits.
 */
export type WorkerMessage =
  | { type: "start"; job: { id: string; type: string; payload: unknown; budget: Job["budget"] } }
  | { type: "cancel" }
  | { type: "progress"; data?: Record<string, unknown> }
  | { type: "result"; result?: Record<string, unknown> }
  | { type: "error"; message: string; transient?: boolean };

export interface OrchestratorOptions {
  store: JobStore;
  /** Lease owner identity of this host (e.g. `host:<pid>`). */
  owner: string;
  leaseMs?: number;
  /** Time a job gets to stop after a cancel or budget stop, before its worker is killed (Architecture §7). */
  cancelGraceMs?: number;
  maxConcurrent?: number;
  retryDelayMs?: (attempt: number) => number;
  logger?: Logger;
}

/** Environment variables passed to worker processes; everything else (including credentials) is withheld. */
const WORKER_ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];

interface Execution {
  job: Job;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Runs queued jobs (QAA-FR-066, QAA-FR-102, NFR-004): leases within concurrency limits, renews leases, enforces the
 * time and memory budgets, and cancels cooperatively and then forcibly. Workers never touch the database: all state
 * changes go through the store here, in the host (Data Model §6.5).
 */
export class JobOrchestrator {
  readonly #types = new Map<string, JobTypeDefinition>();
  readonly #running = new Map<string, Execution>();
  readonly #leaseMs: number;
  readonly #graceMs: number;
  readonly #maxConcurrent: number;
  readonly #retryDelay: (attempt: number) => number;
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: OrchestratorOptions) {
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#graceMs = options.cancelGraceMs ?? 10_000;
    this.#maxConcurrent = options.maxConcurrent ?? 2;
    this.#retryDelay = options.retryDelayMs ?? ((attempt) => Math.min(60_000, 1000 * 2 ** (attempt - 1)));
  }

  register(type: string, definition: JobTypeDefinition): void {
    this.#types.set(type, definition);
  }

  /** Host start (Data Model §9 step 3). */
  recover(): Job[] {
    const resumable = new Set([...this.#types].filter(([, d]) => d.resumable).map(([t]) => t));
    return this.options.store.recoverExpiredLeases(resumable, "host_restart");
  }

  /** Leases and starts as many jobs as the limits allow. Returns the IDs started. */
  tick(): string[] {
    const started: string[] = [];
    while (this.#running.size < this.#maxConcurrent) {
      const types = [...this.#types]
        .filter(([type, d]) => d.concurrency === undefined || this.options.store.countRunning(type) < d.concurrency)
        .map(([type]) => type);
      const job = this.options.store.lease(this.options.owner, this.#leaseMs, types);
      if (!job) break;
      this.#start(job);
      started.push(job.id);
    }
    return started;
  }

  start(pollMs = 500): void {
    this.#timer ??= setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.options.logger?.error("job.tick_failed", { error });
      }
    }, pollMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.drain();
  }

  /** Waits until no job runs (tests and shutdown). */
  async drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()].map((e) => e.done));
  }

  isRunning(jobId: string): boolean {
    return this.#running.has(jobId);
  }

  cancel(jobId: string, by: string): Job {
    const job = this.options.store.requestCancel(jobId, by);
    this.#running.get(jobId)?.controller.abort("cancelled");
    return job;
  }

  #start(job: Job): void {
    const controller = new AbortController();
    const execution: Execution = { job, controller, done: Promise.resolve() };
    this.#running.set(job.id, execution);
    execution.done = this.#execute(job, controller).finally(() => this.#running.delete(job.id));
  }

  async #execute(job: Job, controller: AbortController): Promise<void> {
    const { store, owner } = this.options;
    const definition = this.#types.get(job.type);
    const log = this.options.logger?.child({ job_id: job.id, type: job.type });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        fn();
      } catch (error) {
        if (!(error instanceof LeaseLostError)) throw error;
        log?.warn("job.lease_lost", { error });
      }
    };
    if (!definition) {
      settle(() =>
        store.fail(
          job.id,
          owner,
          { code: "JOB_TYPE_UNKNOWN", message: `no handler for job type ${job.type}` },
          { retryable: false },
        ),
      );
      return;
    }
    const renew = setInterval(
      () => {
        try {
          store.progress(job.id, owner, this.#leaseMs);
        } catch (error) {
          if (error instanceof LeaseLostError) controller.abort("cancelled");
        }
      },
      Math.max(10, Math.floor(this.#leaseMs / 3)),
    );
    const durationLimit = job.budget.max_duration_ms;
    const budgetTimer =
      durationLimit === undefined ? undefined : setTimeout(() => controller.abort("budget"), durationLimit);
    const finishStopped = () => {
      if (controller.signal.reason === "budget") {
        settle(() =>
          store.fail(job.id, owner, budgetError("max_duration_ms", durationLimit ?? 0), { retryable: false }),
        );
      } else {
        settle(() => store.markCancelled(job.id, owner, "cancelled"));
      }
    };
    const onFailure = (error: unknown, crashed = false) => {
      if (controller.signal.aborted) return finishStopped();
      if (error instanceof BudgetExhaustedError) {
        return settle(() => store.fail(job.id, owner, budgetError(error.resource, error.limit), { retryable: false }));
      }
      const transient = crashed || error instanceof TransientJobError;
      const jobError: JobError = {
        code: crashed ? "WORKER_CRASHED" : "JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
      settle(() =>
        store.fail(job.id, owner, jobError, {
          retryable: transient && definition.retry === "transient",
          retryDelayMs: this.#retryDelay(job.attempt),
        }),
      );
    };
    try {
      if (definition.handler.kind === "in_process") {
        await this.#runInProcess(
          job,
          definition.handler,
          controller,
          (result) => settle(() => store.complete(job.id, owner, result ?? undefined)),
          onFailure,
          finishStopped,
        );
      } else {
        await this.#runWorker(
          job,
          definition.handler,
          controller,
          (result) => settle(() => store.complete(job.id, owner, result)),
          onFailure,
          finishStopped,
          log,
        );
      }
    } finally {
      clearInterval(renew);
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  }

  async #runInProcess(
    job: Job,
    handler: InProcessHandler,
    controller: AbortController,
    onResult: (result: Record<string, unknown> | void) => void,
    onFailure: (error: unknown) => void,
    finishStopped: () => void,
  ): Promise<void> {
    const used = new Map<string, number>();
    const context: JobContext = {
      job,
      signal: controller.signal,
      progress: (data) => {
        this.options.store.progress(job.id, this.options.owner, this.#leaseMs, data);
      },
      charge: (resource, amount = 1) => {
        const total = (used.get(resource) ?? 0) + amount;
        used.set(resource, total);
        const limit = job.budget[resource];
        if (limit !== undefined && total > limit) throw new BudgetExhaustedError(resource, limit);
      },
    };
    // An in-process handler that ignores the signal cannot be killed; after the grace period the job is settled
    // anyway and whatever the handler does later is discarded (its lease is gone).
    const graceAfterAbort = new Promise<"grace_expired">((resolve) => {
      controller.signal.addEventListener("abort", () => setTimeout(() => resolve("grace_expired"), this.#graceMs), {
        once: true,
      });
    });
    const outcome = await Promise.race([
      Promise.resolve()
        // A job cancelled before its handler started never runs.
        .then(() => (controller.signal.aborted ? undefined : handler.run(context)))
        .then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      graceAfterAbort,
    ]);
    if (outcome === "grace_expired") return finishStopped();
    if (controller.signal.aborted) return finishStopped();
    if (outcome.ok) onResult(outcome.result);
    else onFailure(outcome.error);
  }

  #runWorker(
    job: Job,
    handler: WorkerHandler,
    controller: AbortController,
    onResult: (result: Record<string, unknown> | undefined) => void,
    onFailure: (error: unknown, crashed?: boolean) => void,
    finishStopped: () => void,
    log: Logger | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const memory = job.budget.max_memory_mb;
      const env = Object.fromEntries(
        WORKER_ENV_ALLOWLIST.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]),
      );
      let child: ChildProcess;
      try {
        child = fork(handler.modulePath, [], {
          execArgv: [...(handler.execArgv ?? []), ...(memory === undefined ? [] : [`--max-old-space-size=${memory}`])],
          env,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
      } catch (error) {
        onFailure(error, true);
        return resolve();
      }
      let outcome:
        | { kind: "result"; result?: Record<string, unknown> }
        | { kind: "error"; message: string; transient: boolean }
        | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString();
      });
      child.on("message", (raw) => {
        const message = raw as WorkerMessage;
        if (message.type === "progress") {
          try {
            this.options.store.progress(job.id, this.options.owner, this.#leaseMs, message.data);
          } catch (error) {
            if (error instanceof LeaseLostError) controller.abort("cancelled");
          }
        } else if (message.type === "result")
          outcome = { kind: "result", ...(message.result ? { result: message.result } : {}) };
        else if (message.type === "error")
          outcome = { kind: "error", message: message.message, transient: message.transient === true };
      });
      const onAbort = () => {
        if (child.connected) child.send({ type: "cancel" } satisfies WorkerMessage);
        killTimer = setTimeout(() => {
          log?.warn("job.worker_killed", { pid: child.pid, grace_ms: this.#graceMs });
          child.kill("SIGKILL");
        }, this.#graceMs);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        if (child.pid === undefined) {
          // Spawning failed; no exit event follows.
          controller.signal.removeEventListener("abort", onAbort);
          onFailure(error, true);
          resolve();
        } else if (!outcome) outcome = { kind: "error", message: error.message, transient: true };
      });
      // "close" rather than "exit": Node may report the exit before the last IPC messages are delivered
      // (observed on Windows), which would lose a result the worker did send.
      child.on("close", (code, signal) => {
        if (killTimer) clearTimeout(killTimer);
        controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) finishStopped();
        else if (outcome?.kind === "result") onResult(outcome.result);
        else if (outcome?.kind === "error")
          onFailure(outcome.transient ? new TransientJobError(outcome.message) : new Error(outcome.message));
        else
          onFailure(
            new Error(
              `worker exited without a result (code ${String(code)}, signal ${String(signal)})${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`,
            ),
            true,
          );
        resolve();
      });
      child.send({
        type: "start",
        job: { id: job.id, type: job.type, payload: job.payload, budget: job.budget },
      } satisfies WorkerMessage);
    });
  }
}

function budgetError(resource: string, limit: number): JobError {
  return { code: "BUDGET_EXHAUSTED", message: `budget exhausted: ${resource}`, details: { resource, limit } };
}
