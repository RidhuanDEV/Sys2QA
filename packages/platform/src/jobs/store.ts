import type { Database } from "better-sqlite3";
import { canonicalJson } from "../canonical-json.js";
import type { Logger } from "../logging/logger.js";
import { assertJobTransition, LeaseLostError, TERMINAL_JOB_STATES, type JobError, type JobState } from "./states.js";

/** Per-job limits (NFR-002). The orchestrator enforces duration and memory; handlers charge the others. */
export interface JobBudget {
  max_duration_ms?: number;
  max_memory_mb?: number;
  max_tokens?: number;
  max_pages?: number;
  max_files?: number;
  [resource: string]: number | undefined;
}

export interface Job {
  id: string;
  type: string;
  project_id: string | null;
  state: JobState;
  priority: number;
  payload: unknown;
  budget: JobBudget;
  attempt: number;
  max_attempts: number;
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  run_after: string | null;
  last_progress_at: string | null;
  error: JobError | null;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  seq: number;
  at: string;
  event: string;
  data: Record<string, unknown>;
}

export interface EnqueueRequest {
  type: string;
  projectId?: string | null;
  payload: unknown;
  budget?: JobBudget;
  priority?: number;
  maxAttempts?: number;
  /** Repeating a request with the same key returns the existing job instead of creating another (NFR-004). */
  idempotencyKey?: string;
}

export class IdempotencyConflictError extends Error {
  override readonly name = "IdempotencyConflictError";
}

interface JobRow {
  id: string;
  type: string;
  project_id: string | null;
  state: JobState;
  priority: number;
  payload_json: string;
  budget_json: string;
  attempt: number;
  max_attempts: number;
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  run_after: string | null;
  last_progress_at: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  type: r.type,
  project_id: r.project_id,
  state: r.state,
  priority: r.priority,
  payload: JSON.parse(r.payload_json),
  budget: JSON.parse(r.budget_json) as JobBudget,
  attempt: r.attempt,
  max_attempts: r.max_attempts,
  idempotency_key: r.idempotency_key,
  lease_owner: r.lease_owner,
  lease_expires_at: r.lease_expires_at,
  cancel_requested_at: r.cancel_requested_at,
  run_after: r.run_after,
  last_progress_at: r.last_progress_at,
  error: r.error_json === null ? null : (JSON.parse(r.error_json) as JobError),
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export interface JobStoreOptions {
  now: () => Date;
  newId: (kind: string) => string;
  logger?: Logger;
}

/**
 * Persistent job queue over the `jobs` and `job_events` tables (Data Model §4, §7). Every method runs in one
 * BEGIN IMMEDIATE transaction; methods that act for a worker check that the worker still holds the lease.
 */
export class JobStore {
  constructor(
    private readonly db: Database,
    private readonly options: JobStoreOptions,
  ) {}

  private iso(offsetMs = 0): string {
    return new Date(this.options.now().getTime() + offsetMs).toISOString();
  }

  private tx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn).immediate();
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row && toJob(row);
  }

  events(id: string): JobEvent[] {
    return (
      this.db
        .prepare("SELECT seq, at, event, data_json FROM job_events WHERE job_id = ? ORDER BY seq")
        .all(id) as Array<{ seq: number; at: string; event: string; data_json: string }>
    ).map((e) => ({ seq: e.seq, at: e.at, event: e.event, data: JSON.parse(e.data_json) as Record<string, unknown> }));
  }

  list(filter: { states?: JobState[]; projectId?: string } = {}): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all() as JobRow[];
    return rows
      .map(toJob)
      .filter(
        (j) =>
          (!filter.states || filter.states.includes(j.state)) &&
          (filter.projectId === undefined || j.project_id === filter.projectId),
      );
  }

  private event(job: Pick<Job, "id" | "project_id">, event: string, data: Record<string, unknown> = {}): void {
    const at = this.iso();
    const seq = (
      this.db.prepare("SELECT coalesce(max(seq), 0) + 1 AS seq FROM job_events WHERE job_id = ?").get(job.id) as {
        seq: number;
      }
    ).seq;
    this.db
      .prepare(
        "INSERT INTO job_events (job_id, seq, project_id, at, event, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(job.id, seq, job.project_id, at, event, JSON.stringify(data), at, at);
  }

  private transition(
    job: Job,
    to: JobState,
    set: Record<string, unknown>,
    reason: string,
    data: Record<string, unknown> = {},
  ): Job {
    assertJobTransition(job.state, to);
    const at = this.iso();
    const columns = { ...set, state: to, updated_at: at };
    const assignments = Object.keys(columns)
      .map((c) => `${c} = @${c}`)
      .join(", ");
    this.db.prepare(`UPDATE jobs SET ${assignments} WHERE id = @id`).run({ ...columns, id: job.id });
    this.event(job, to === job.state ? reason : `state.${to}`, { from: job.state, to, reason, ...data });
    this.options.logger?.info("job.transition", {
      job_id: job.id,
      type: job.type,
      from: job.state,
      to,
      reason,
      attempt: job.attempt,
    });
    return this.get(job.id)!;
  }

  enqueue(request: EnqueueRequest): { job: Job; created: boolean } {
    return this.tx(() => {
      const payloadJson = JSON.stringify(request.payload ?? null);
      if (request.idempotencyKey !== undefined) {
        const existing = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(request.idempotencyKey) as
          JobRow | undefined;
        if (existing) {
          if (
            existing.type !== request.type ||
            canonicalJson(JSON.parse(existing.payload_json)) !== canonicalJson(request.payload ?? null)
          ) {
            throw new IdempotencyConflictError(
              `idempotency key ${request.idempotencyKey} was used for a different request`,
            );
          }
          return { job: toJob(existing), created: false };
        }
      }
      const at = this.iso();
      const id = this.options.newId("job");
      this.db
        .prepare(
          `INSERT INTO jobs (id, type, project_id, state, priority, payload_json, budget_json, attempt, max_attempts, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          request.type,
          request.projectId ?? null,
          request.priority ?? 0,
          payloadJson,
          JSON.stringify(request.budget ?? {}),
          request.maxAttempts ?? 1,
          request.idempotencyKey ?? null,
          at,
          at,
        );
      const job = this.get(id)!;
      this.event(job, "state.queued", { to: "queued", reason: "enqueued" });
      this.options.logger?.info("job.transition", {
        job_id: id,
        type: job.type,
        from: null,
        to: "queued",
        reason: "enqueued",
      });
      return { job, created: true };
    });
  }

  /** Leases the next runnable job (highest priority, oldest first) among `types`, or returns undefined. */
  lease(owner: string, leaseMs: number, types: readonly string[]): Job | undefined {
    if (types.length === 0) return undefined;
    return this.tx(() => {
      const now = this.iso();
      const row = this.db
        .prepare(
          `SELECT * FROM jobs WHERE state = 'queued' AND type IN (${types.map(() => "?").join(", ")})
             AND (run_after IS NULL OR run_after <= ?)
           ORDER BY priority DESC, created_at, id LIMIT 1`,
        )
        .get(...types, now) as JobRow | undefined;
      if (!row) return undefined;
      const job = toJob(row);
      return this.transition(
        job,
        "running",
        {
          lease_owner: owner,
          lease_expires_at: this.iso(leaseMs),
          attempt: job.attempt + 1,
          run_after: null,
          last_progress_at: now,
        },
        "leased",
        { owner, attempt: job.attempt + 1 },
      );
    });
  }

  private owned(id: string, owner: string, states: readonly JobState[]): Job {
    const job = this.get(id);
    if (!job || job.lease_owner !== owner || !states.includes(job.state)) {
      throw new LeaseLostError(`job ${id} is not leased by ${owner}${job ? ` (state ${job.state})` : ""}`);
    }
    return job;
  }

  /** Records progress and extends the lease. Returns the job, whose state tells the worker whether to stop. */
  progress(id: string, owner: string, leaseMs: number, data?: Record<string, unknown>): Job {
    return this.tx(() => {
      const job = this.owned(id, owner, ["running", "cancelling"]);
      const now = this.iso();
      this.db
        .prepare("UPDATE jobs SET lease_expires_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ?")
        .run(this.iso(leaseMs), now, now, id);
      if (data !== undefined) this.event(job, "progress", data);
      return this.get(id)!;
    });
  }

  complete(id: string, owner: string, result?: Record<string, unknown>): Job {
    return this.tx(() => {
      const job = this.owned(id, owner, ["running", "cancelling"]);
      // A job that finished while being cancelled still counts as cancelled: its caller asked it to stop.
      if (job.state === "cancelling")
        return this.transition(
          job,
          "cancelled",
          { lease_owner: null, lease_expires_at: null },
          "finished_while_cancelling",
        );
      return this.transition(
        job,
        "completed",
        { lease_owner: null, lease_expires_at: null, error_json: null },
        "completed",
        result ? { result } : {},
      );
    });
  }

  /** Fails the job, or re-queues it after `retryDelayMs` when the failure is transient and attempts remain. */
  fail(id: string, owner: string, error: JobError, options: { retryable: boolean; retryDelayMs?: number }): Job {
    return this.tx(() => {
      const job = this.owned(id, owner, ["running", "cancelling"]);
      const errorJson = JSON.stringify(error);
      if (job.state === "cancelling")
        return this.transition(
          job,
          "cancelled",
          { lease_owner: null, lease_expires_at: null, error_json: errorJson },
          "failed_while_cancelling",
        );
      if (options.retryable && job.attempt < job.max_attempts) {
        return this.transition(
          job,
          "queued",
          {
            lease_owner: null,
            lease_expires_at: null,
            error_json: errorJson,
            run_after: this.iso(options.retryDelayMs ?? 0),
          },
          "retry_scheduled",
          { error },
        );
      }
      return this.transition(
        job,
        "failed",
        { lease_owner: null, lease_expires_at: null, error_json: errorJson },
        "failed",
        { error },
      );
    });
  }

  /** Cancels a queued job at once; asks a running job to stop. Terminal jobs are returned unchanged. */
  requestCancel(id: string, by: string): Job {
    return this.tx(() => {
      const job = this.get(id);
      if (!job) throw new Error(`job ${id} not found`);
      if (TERMINAL_JOB_STATES.has(job.state) || job.state === "cancelling") return job;
      const at = this.iso();
      const error: JobError = { code: "JOB_CANCELLED", message: `cancelled by ${by}` };
      if (job.state === "queued")
        return this.transition(
          job,
          "cancelled",
          { cancel_requested_at: at, error_json: JSON.stringify(error) },
          "cancel_requested",
          { by },
        );
      return this.transition(job, "cancelling", { cancel_requested_at: at }, "cancel_requested", { by });
    });
  }

  /** Called once the worker has stopped (cooperatively or killed). */
  markCancelled(id: string, owner: string, reason: string): Job {
    return this.tx(() => {
      const job = this.owned(id, owner, ["cancelling"]);
      const error: JobError = { code: "JOB_CANCELLED", message: reason };
      return this.transition(
        job,
        "cancelled",
        { lease_owner: null, lease_expires_at: null, error_json: JSON.stringify(error) },
        reason,
      );
    });
  }

  /**
   * Host start and periodic sweep (Data Model §7, §9 step 3): jobs whose lease expired are cancelled if a cancel was
   * requested, re-queued if their type is resumable and attempts remain, and failed otherwise.
   */
  recoverExpiredLeases(resumableTypes: ReadonlySet<string>, reason: "host_restart" | "lease_expired"): Job[] {
    return this.tx(() => {
      const expired = (
        this.db
          .prepare("SELECT * FROM jobs WHERE state IN ('running', 'cancelling') AND lease_expires_at < ?")
          .all(this.iso()) as JobRow[]
      ).map(toJob);
      return expired.map((job) => {
        const error: JobError = {
          code: "LEASE_EXPIRED",
          message: `lease of ${job.lease_owner ?? "unknown"} expired (${reason})`,
        };
        const cleared = { lease_owner: null, lease_expires_at: null, error_json: JSON.stringify(error) };
        if (job.state === "cancelling") return this.transition(job, "cancelled", cleared, reason);
        if (resumableTypes.has(job.type) && job.attempt < job.max_attempts)
          return this.transition(job, "queued", cleared, reason);
        return this.transition(job, "failed", cleared, reason);
      });
    });
  }

  /**
   * Stuck jobs (QAA-FR-102): running or cancelling jobs that reported no progress for `noProgressMs`, or whose lease
   * expired without recovery. Detection only; the caller decides whether to cancel.
   */
  findStuck(noProgressMs: number): Array<{ job: Job; reason: "no_progress" | "lease_expired" }> {
    const now = this.options.now().getTime();
    return this.list({ states: ["running", "cancelling"] }).flatMap(
      (job): Array<{ job: Job; reason: "no_progress" | "lease_expired" }> => {
        if (job.lease_expires_at !== null && Date.parse(job.lease_expires_at) < now)
          return [{ job, reason: "lease_expired" as const }];
        const last = Date.parse(job.last_progress_at ?? job.updated_at);
        return now - last > noProgressMs ? [{ job, reason: "no_progress" as const }] : [];
      },
    );
  }

  countRunning(type?: string): number {
    const row = (
      type === undefined
        ? this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('running', 'cancelling')").get()
        : this.db
            .prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('running', 'cancelling') AND type = ?")
            .get(type)
    ) as { n: number };
    return row.n;
  }
}
