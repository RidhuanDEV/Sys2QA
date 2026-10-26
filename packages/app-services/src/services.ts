import { validateJsonSchema } from "@sys2qa/contract";
import { ConfigError, ProjectError, SecretAccessError, SecretStoreError, StorageError } from "@sys2qa/platform";
import { OPERATIONS } from "./catalog.js";
import { serviceError, ServiceError, SERVICE_ERRORS, type ServiceErrorDto } from "./errors.js";
import type { Host } from "./host.js";
import type { Caller, Operation } from "./operations.js";
import { pathOutsideApprovedRoots } from "./paths.js";

export type ServiceResult = { ok: true; data: unknown } | { ok: false; error: ServiceErrorDto };

export interface OperationInfo {
  name: string;
  title: string;
  description: string;
  level: Operation["level"];
  effect: Operation["effect"];
  destructive: boolean;
  input: object;
}

/**
 * The single entry point of every interface (SYS-005): CLI, HTTP API, MCP and Skill call `execute` with the same names
 * and inputs and receive the same results and errors.
 */
export class AppServices {
  readonly #operations: Map<string, Operation<never, unknown>>;

  constructor(
    readonly host: Host,
    operations: ReadonlyArray<Operation<never, unknown>> = OPERATIONS,
  ) {
    this.#operations = new Map(operations.map((o) => [o.name, o]));
  }

  /**
   * The catalog for one interface: without L4 operations unless L4 is enabled (SEC-006), and without operations the
   * interface may not call (e.g. secret values through MCP).
   */
  catalog(forInterface?: Caller["interface"]): OperationInfo[] {
    const l4 = this.host.projects.settings().l4_enabled;
    return [...this.#operations.values()]
      .filter((o) => o.level !== "L4" || l4)
      .filter((o) => forInterface === undefined || o.interfaces === undefined || o.interfaces.includes(forInterface))
      .map((o) => ({
        name: o.name,
        title: o.title,
        description: o.description,
        level: o.level,
        effect: o.effect,
        destructive: o.destructive === true,
        input: o.input,
      }));
  }

  async execute(name: string, input: unknown, caller: Caller): Promise<ServiceResult> {
    const started = Date.now();
    const result = await this.#execute(name, input ?? {}, caller);
    this.host.logger.info("service.call", {
      operation: name,
      interface: caller.interface,
      outcome: result.ok ? "ok" : "error",
      ...(result.ok ? {} : { code: result.error.code }),
      duration_ms: Date.now() - started,
    });
    return result;
  }

  async #execute(name: string, input: unknown, caller: Caller): Promise<ServiceResult> {
    const operation = this.catalog(caller.interface).some((o) => o.name === name)
      ? this.#operations.get(name)
      : undefined;
    if (!operation) return { ok: false, error: serviceError("OPERATION_UNKNOWN", `unknown operation ${name}`).toDto() };
    const check = validateJsonSchema(operation.input, input);
    if (!check.ok)
      return {
        ok: false,
        error: serviceError("INPUT_INVALID", `invalid input for ${name}`, { problems: check.errors }).toDto(),
      };
    if (caller.interface === "mcp" && operation.paths) {
      const paths = operation.paths(input as never).filter((p): p is string => typeof p === "string");
      const outside = pathOutsideApprovedRoots(this.host, paths);
      if (outside !== undefined)
        return {
          ok: false,
          error: new ServiceError(
            "SCOPE_DENIED",
            "denied",
            `${outside} is outside the Sys2QA home and every registered source`,
            "MCP clients may use only paths inside the Sys2QA home or a registered source root or package; register new sources from the CLI.",
            { field: "path" },
          ).toDto(),
        };
    }
    try {
      const data = await operation.run(
        { host: this.host, caller, catalog: () => this.catalog(caller.interface) },
        input as never,
      );
      return { ok: true, data: JSON.parse(JSON.stringify(data ?? null)) as unknown };
    } catch (error) {
      return { ok: false, error: toServiceError(error, this.host).toDto() };
    }
  }
}

function toServiceError(error: unknown, host: Host): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof ProjectError) {
    const code = error.code === "INVALID" ? "INPUT_INVALID" : error.code;
    return serviceError(code, error.message);
  }
  if (error instanceof StorageError && SERVICE_ERRORS[error.code])
    return new ServiceError(error.code, SERVICE_ERRORS[error.code]!.kind, error.message, error.remediation);
  if (error instanceof SecretAccessError)
    return serviceError(error.code === "INVALID" ? "INPUT_INVALID" : error.code, error.message);
  if (error instanceof SecretStoreError)
    return new ServiceError(error.code, "unavailable", error.message, error.remediation);
  if (error instanceof ConfigError)
    return new ServiceError(error.code, "invalid_input", error.message, error.remediation);
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/.test(message)) return serviceError("CONFLICT", "the record already exists");
  // Unexpected failures are logged (redacted) and reported without internals.
  host.logger.error("service.unexpected_error", { error });
  return serviceError("INTERNAL_ERROR", "an unexpected error occurred");
}
