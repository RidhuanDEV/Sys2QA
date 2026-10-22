import type { PermissionLevel } from "@sys2qa/platform";
import type { Host } from "./host.js";

export interface Caller {
  interface: "cli" | "api" | "mcp" | "test";
  actor: string;
}

export interface OperationContext {
  host: Host;
  caller: Caller;
}

/**
 * An application-service operation (SYS-005). Interfaces never decide policy, scope, approval or state; they only
 * translate their protocol into `execute(name, input)`.
 */
export interface Operation<I = Record<string, unknown>, O = unknown> {
  name: string;
  title: string;
  description: string;
  /** Highest permission level the operation can exercise (SEC-006); "none" for local bookkeeping. */
  level: PermissionLevel | "none";
  effect: "read" | "write";
  /** JSON Schema (2020-12) of the input; validated before `run`. */
  input: object;
  run(context: OperationContext, input: I): O | Promise<O>;
}

export const defineOperation = <I, O>(operation: Operation<I, O>): Operation<I, O> => operation;
