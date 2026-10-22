/** Failures of the local state store. They stop the host; none of them is retried automatically. */
export type StorageErrorCode =
  "STATE_INTEGRITY_FAILED" | "STATE_MIGRATION_INVALID" | "STATE_NEWER_THAN_CODE" | "HOST_ALREADY_RUNNING";

export class StorageError extends Error {
  override readonly name = "StorageError";
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    /** What the user can do about it (printed by the CLI and `doctor`). */
    readonly remediation: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
