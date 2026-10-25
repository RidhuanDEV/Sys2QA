/** How an error is surfaced: HTTP status, CLI exit code (stable, documented in Architecture §8), MCP isError. */
export type ErrorKind = "invalid_input" | "not_found" | "denied" | "conflict" | "unavailable" | "internal";

/**
 * One error shape for every interface (OBS-003, NFR-010): what failed (`message`), what to do next (`remediation`),
 * and whether retrying can help. Codes from the contract catalog keep their meaning; service codes are listed in
 * SERVICE_ERRORS.
 */
export interface ServiceErrorDto {
  code: string;
  kind: ErrorKind;
  message: string;
  remediation: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ServiceError extends Error {
  override readonly name = "ServiceError";
  constructor(
    readonly code: string,
    readonly kind: ErrorKind,
    message: string,
    readonly remediation: string,
    readonly details?: Record<string, unknown>,
    readonly retryable = false,
  ) {
    super(message);
  }

  toDto(): ServiceErrorDto {
    return {
      code: this.code,
      kind: this.kind,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const SERVICE_ERRORS: Record<string, { kind: ErrorKind; remediation: string }> = {
  OPERATION_UNKNOWN: {
    kind: "invalid_input",
    remediation: "List the available operations (`sys2qa operations`) and use one of their names.",
  },
  INPUT_INVALID: { kind: "invalid_input", remediation: "Fix the listed fields and run the operation again." },
  NOT_FOUND: { kind: "not_found", remediation: "Check the ID; list existing records to find the right one." },
  DECLARATION_REQUIRED: {
    kind: "denied",
    remediation: "Record a scoped authorization declaration for this evidence source first.",
  },
  SCOPE_DENIED: {
    kind: "denied",
    remediation: "Stay within the declared scope, or record a new declaration that covers this operation.",
  },
  PRODUCTION_REFUSED: {
    kind: "denied",
    remediation: "Use a development or staging environment; production is out of scope.",
  },
  CONFLICT: { kind: "conflict", remediation: "Reload the current state and try again." },
  HOST_ALREADY_RUNNING: { kind: "unavailable", remediation: "Use the running Sys2QA instance, or stop it first." },
  STATE_INTEGRITY_FAILED: {
    kind: "unavailable",
    remediation: "Restore state.db and projects/ from your latest backup.",
  },
  SECRET_STORE_UNAVAILABLE: {
    kind: "unavailable",
    remediation:
      "Unlock or install the OS credential store, or set SYS2QA_SECRETS_PASSPHRASE to use the encrypted file.",
  },
  INTERNAL_ERROR: {
    kind: "internal",
    remediation: "Retry once; if it fails again, report it with the log file (it contains no secrets).",
  },
};

export function serviceError(
  code: keyof typeof SERVICE_ERRORS,
  message: string,
  details?: Record<string, unknown>,
): ServiceError {
  const entry = SERVICE_ERRORS[code]!;
  return new ServiceError(code, entry.kind, message, entry.remediation, details);
}
