/** Job states (Data Model §7). Transitions are validated in code, never inferred (PRD §20.2). */
export const JOB_STATES = ["queued", "running", "cancelling", "completed", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  // queued → queued is not a transition; a retry goes running → queued.
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelling", "queued"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(["completed", "failed", "cancelled"]);

export function assertJobTransition(from: JobState, to: JobState): void {
  if (!JOB_TRANSITIONS[from].includes(to)) throw new JobStateError(`job cannot move from ${from} to ${to}`);
}

export class JobStateError extends Error {
  override readonly name = "JobStateError";
}

/** A worker acted on a job whose lease it no longer holds (expired, revoked by cancellation, or taken over). */
export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
}

/** Error codes stored in jobs.error_json. JOB_CANCELLED and BUDGET_EXHAUSTED are contract catalog codes. */
export type JobErrorCode =
  "JOB_FAILED" | "JOB_CANCELLED" | "BUDGET_EXHAUSTED" | "WORKER_CRASHED" | "LEASE_EXPIRED" | "JOB_TYPE_UNKNOWN";

export interface JobError {
  code: JobErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Thrown by handlers for infrastructure failures that are safe to retry (NFR-004). Anything else is never retried. */
export class TransientJobError extends Error {
  override readonly name = "TransientJobError";
}

/** Thrown when a job uses more of a budgeted resource than allowed (NFR-002). */
export class BudgetExhaustedError extends Error {
  override readonly name = "BudgetExhaustedError";
  constructor(
    readonly resource: string,
    readonly limit: number,
  ) {
    super(`budget exhausted: ${resource} limit ${limit}`);
  }
}
