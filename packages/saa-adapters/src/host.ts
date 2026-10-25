import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets, validateJsonSchema } from "@sys2qa/contract";
import {
  encodeMessage,
  LineDecoder,
  PROTOCOL_VERSION,
  RPC_ERRORS,
  type AnalyzeParams,
  type AnalyzeResult,
  type CoverageItem,
  type InitializeResult,
  type ProgressParams,
} from "./protocol.js";

const SCHEMA = "https://sys2qa.dev/schemas/adapter-protocol/1.0.json";
const MESSAGE_SCHEMA = { $ref: SCHEMA };
const INITIALIZE_RESULT_SCHEMA = { $ref: `${SCHEMA}#/$defs/initialize_result` };
const ANALYZE_RESULT_SCHEMA = { $ref: `${SCHEMA}#/$defs/analyze_result` };
const ANALYZE_PARAMS_SCHEMA = { $ref: `${SCHEMA}#/$defs/analyze_params` };

/** Preloaded into every adapter before its own code: disables sockets, DNS and fetch (ADR-009). */
export const NETWORK_GUARD = fileURLToPath(new URL("../runtime/network-guard.mjs", import.meta.url));

export interface AdapterSpec {
  id: string;
  /** Absolute path of a self-contained JavaScript entry (`.mjs` or `.js`); TypeScript adapters are bundled first. */
  entry: string;
  args?: string[];
}

export interface AdapterLimits {
  /** V8 old-space limit; exceeding it kills the adapter. */
  memory_mb: number;
  init_timeout_ms: number;
  /** Time between `cancel` and a kill. */
  cancel_grace_ms: number;
  /** Largest single message accepted from the adapter. */
  max_message_bytes: number;
}

export const DEFAULT_ADAPTER_LIMITS: AdapterLimits = {
  memory_mb: 512,
  init_timeout_ms: 10_000,
  cancel_grace_ms: 2_000,
  max_message_bytes: 64 * 1024 * 1024,
};

export interface LaunchOptions {
  /** Real path of the analyzed root: the adapter's working directory and its only readable source. */
  root: string;
  /** The adapter's only writable directory (also its temp directory). */
  scratch: string;
  limits?: Partial<AdapterLimits>;
  hostVersion?: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type AdapterErrorCode =
  | "ADAPTER_START_FAILED"
  | "ADAPTER_PROTOCOL_ERROR"
  | "ADAPTER_INCOMPATIBLE"
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_CANCELLED"
  | "ADAPTER_OUTPUT_TOO_LARGE"
  | "ADAPTER_OUTPUT_INVALID"
  | "ADAPTER_CRASHED"
  | "ADAPTER_FAILED";

export class AdapterError extends Error {
  override readonly name = "AdapterError";
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    /** Last part of the adapter's stderr, secrets redacted. */
    readonly stderr = "",
  ) {
    super(message);
  }
}

/** Node.js flags that confine an adapter process (Threat Model T-14, ST-14). */
export function sandboxFlags(spec: AdapterSpec, options: LaunchOptions, limits: AdapterLimits): string[] {
  const permission = process.allowedNodeEnvironmentFlags.has("--permission")
    ? "--permission"
    : "--experimental-permission";
  // Real paths: the permission model compares resolved paths, and a working directory is reported as its real path
  // (on macOS the temp directory lives behind the /var -> /private/var link).
  const readable = [dirname(real(spec.entry)), dirname(real(NETWORK_GUARD)), options.root, options.scratch].map(real);
  return [
    permission,
    ...readable.map((path) => `--allow-fs-read=${path}`),
    `--allow-fs-write=${real(options.scratch)}`,
    `--max-old-space-size=${limits.memory_mb}`,
    "--disallow-code-generation-from-strings",
    `--import=${pathToFileURL(real(NETWORK_GUARD)).href}`,
  ];
}

/**
 * The adapter's whole environment: no host variables, so no credentials or `NODE_OPTIONS` reach it. On Windows, libuv
 * adds a fixed set of system variables (PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERPROFILE, WINDIR and similar) that
 * every Windows process needs; none of them carries credentials.
 */
function adapterEnvironment(scratch: string): Record<string, string> {
  const env: Record<string, string> = { TMPDIR: scratch, TMP: scratch, TEMP: scratch, LANG: "C.UTF-8" };
  if (process.platform === "win32" && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: AdapterError) => void;
}

/**
 * One adapter worker process (ADR-009). The host starts it confined by the Node.js permission model (read access to
 * its own code, the analyzed root and its scratch directory only; writes to scratch only; no child processes,
 * workers, native addons, inspector or code generation from strings), a heap limit, an empty environment and the
 * network guard. Every message is validated against the adapter-protocol schema; a protocol violation, an oversized
 * message or an exceeded budget kills the process.
 */
export class AdapterProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #limits: AdapterLimits;
  readonly #log: LaunchOptions["log"];
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #stderr = "";
  #failure: AdapterError | undefined;
  #onProgress: ((progress: ProgressParams) => void) | undefined;
  #outputBytes = 0;
  #outputLimit = Number.POSITIVE_INFINITY;
  #exited: Promise<void>;
  #info: InitializeResult | undefined;

  private constructor(
    readonly spec: AdapterSpec,
    options: LaunchOptions,
  ) {
    this.#limits = { ...DEFAULT_ADAPTER_LIMITS, ...options.limits };
    this.#log = options.log;
    this.#child = spawn(
      process.execPath,
      // The entry as a real path too: Node.js resolves the main module through every directory of the given path.
      [...sandboxFlags(spec, options, this.#limits), real(spec.entry), ...(spec.args ?? [])],
      {
        cwd: real(options.root),
        env: adapterEnvironment(real(options.scratch)),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const decoder = new LineDecoder(this.#limits.max_message_bytes);
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#outputBytes += chunk.length;
      if (this.#outputBytes > this.#outputLimit) {
        this.#fail(new AdapterError("ADAPTER_OUTPUT_TOO_LARGE", `output exceeded ${this.#outputLimit} bytes`));
        return;
      }
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        this.#fail(new AdapterError("ADAPTER_OUTPUT_TOO_LARGE", (error as Error).message));
        return;
      }
      for (const line of lines) this.#receive(line);
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4096);
    });
    this.#exited = new Promise((resolve) => {
      this.#child.on("error", (error) => {
        this.#fail(new AdapterError("ADAPTER_START_FAILED", error.message));
        resolve();
      });
      this.#child.on("close", (code, signal) => {
        this.#fail(
          new AdapterError("ADAPTER_CRASHED", `adapter exited (code ${code ?? "none"}, signal ${signal ?? "none"})`),
        );
        resolve();
      });
    });
    // A closed pipe after the adapter died must not crash the host.
    this.#child.stdin.on("error", () => undefined);
  }

  /** Starts the adapter and negotiates the protocol version. */
  static async start(spec: AdapterSpec, options: LaunchOptions): Promise<AdapterProcess> {
    const adapter = new AdapterProcess(spec, options);
    try {
      const result = await adapter.#request(
        "initialize",
        { protocol_version: PROTOCOL_VERSION, host_version: options.hostVersion ?? "0.0.0" },
        adapter.#limits.init_timeout_ms,
      );
      const check = validateJsonSchema(INITIALIZE_RESULT_SCHEMA, result);
      if (!check.ok)
        throw new AdapterError("ADAPTER_PROTOCOL_ERROR", `invalid initialize result: ${check.errors.join("; ")}`);
      const info = result as InitializeResult;
      if (info.adapter_id !== spec.id)
        throw new AdapterError("ADAPTER_PROTOCOL_ERROR", `adapter reports id ${info.adapter_id}, expected ${spec.id}`);
      if (major(info.protocol_version) !== major(PROTOCOL_VERSION))
        throw new AdapterError(
          "ADAPTER_INCOMPATIBLE",
          `adapter speaks protocol ${info.protocol_version}; this host speaks ${PROTOCOL_VERSION}`,
        );
      adapter.#info = info;
      return adapter;
    } catch (error) {
      await adapter.kill();
      throw error instanceof AdapterError ? adapter.#withStderr(error) : error;
    }
  }

  get info(): InitializeResult {
    return this.#info!;
  }

  /** Why the process stopped being usable, if it did. */
  get failure(): AdapterError | undefined {
    return this.#failure;
  }

  /**
   * Analyzes one batch within `params.budget`: past `max_ms` the adapter is cancelled and then killed; past
   * `max_output_bytes` it is killed at once. The result is validated against the contract before it is returned.
   */
  async analyze(
    params: AnalyzeParams,
    options: { signal?: AbortSignal; onProgress?: (progress: ProgressParams) => void } = {},
  ): Promise<AnalyzeResult> {
    if (this.#failure) throw this.#failure;
    const request = validateJsonSchema(ANALYZE_PARAMS_SCHEMA, params);
    if (!request.ok) throw new TypeError(`invalid analyze params: ${request.errors.join("; ")}`);
    this.#outputBytes = 0;
    this.#outputLimit = params.budget.max_output_bytes;
    this.#onProgress = options.onProgress;
    let grace: NodeJS.Timeout | undefined;
    const stop = (code: "ADAPTER_TIMEOUT" | "ADAPTER_CANCELLED", message: string) => {
      this.#send({ jsonrpc: "2.0", id: this.#nextId++, method: "cancel", params: { run_id: params.run_id } });
      // An adapter that answers the cancel in time stays usable; one that does not is killed.
      grace ??= setTimeout(() => this.#fail(new AdapterError(code, message)), this.#limits.cancel_grace_ms);
    };
    const timer = setTimeout(
      () => stop("ADAPTER_TIMEOUT", `analysis exceeded ${params.budget.max_ms} ms`),
      params.budget.max_ms,
    );
    const onAbort = () => stop("ADAPTER_CANCELLED", "analysis cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.#request("analyze", params);
      const check = validateJsonSchema(ANALYZE_RESULT_SCHEMA, result);
      if (!check.ok)
        throw new AdapterError(
          "ADAPTER_OUTPUT_INVALID",
          `invalid analyze result: ${check.errors.slice(0, 5).join("; ")}`,
        );
      return result as AnalyzeResult;
    } catch (error) {
      if (error instanceof AdapterError && error.code === "ADAPTER_FAILED" && (options.signal?.aborted ?? false))
        throw new AdapterError("ADAPTER_CANCELLED", "analysis cancelled");
      throw error instanceof AdapterError ? this.#withStderr(error) : error;
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener("abort", onAbort);
      this.#outputLimit = Number.POSITIVE_INFINITY;
      this.#onProgress = undefined;
    }
  }

  /** Closes stdin and waits for a clean exit; kills the adapter after the grace period. */
  async close(): Promise<void> {
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), this.#limits.cancel_grace_ms);
    await this.#exited;
    clearTimeout(timer);
  }

  async kill(): Promise<void> {
    this.#child.kill("SIGKILL");
    await this.#exited;
  }

  #request(method: string, params: object, timeoutMs?: number): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => this.#fail(new AdapterError("ADAPTER_TIMEOUT", `${method} exceeded ${timeoutMs} ms`)),
              timeoutMs,
            );
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(message: object): void {
    if (!this.#failure) this.#child.stdin.write(encodeMessage(message));
  }

  #receive(line: string): void {
    let message: {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.#fail(new AdapterError("ADAPTER_PROTOCOL_ERROR", "adapter wrote a line that is not JSON"));
      return;
    }
    const check = validateJsonSchema(MESSAGE_SCHEMA, message);
    if (!check.ok || (message.method !== undefined && message.method !== "progress")) {
      this.#fail(
        new AdapterError(
          "ADAPTER_PROTOCOL_ERROR",
          `invalid message from adapter: ${check.errors.slice(0, 3).join("; ")}`,
        ),
      );
      return;
    }
    if (message.method === "progress") {
      this.#onProgress?.(message.params as ProgressParams);
      return;
    }
    const pending = this.#pending.get(message.id as number);
    if (!pending) return; // the answer to a `cancel`, or to a request that already failed
    this.#pending.delete(message.id as number);
    if (message.error)
      pending.reject(
        new AdapterError(
          message.error.code === RPC_ERRORS.CANCELLED ? "ADAPTER_CANCELLED" : "ADAPTER_FAILED",
          redactSecrets(message.error.message).text,
        ),
      );
    else pending.resolve(message.result);
  }

  #fail(error: AdapterError): void {
    if (this.#failure) return;
    this.#failure = this.#withStderr(error);
    this.#log?.("adapter.failed", { adapter: this.spec.id, code: error.code, message: error.message });
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
  }

  #withStderr(error: AdapterError): AdapterError {
    return error.stderr !== "" || this.#stderr === ""
      ? error
      : new AdapterError(error.code, error.message, redactSecrets(this.#stderr).text);
  }
}

export type BatchOutcome =
  { status: "completed"; result: AnalyzeResult } | { status: "failed"; error: AdapterError; coverage: CoverageItem[] };

/**
 * Runs one batch and turns a failure into coverage records instead of an exception, so the run continues as `partial`
 * with every affected file named (SAA-FR-020, ADR-009).
 */
export async function analyzeBatch(
  adapter: AdapterProcess,
  params: AnalyzeParams,
  options: { signal?: AbortSignal; onProgress?: (progress: ProgressParams) => void } = {},
): Promise<BatchOutcome> {
  try {
    return { status: "completed", result: await adapter.analyze(params, options) };
  } catch (error) {
    if (!(error instanceof AdapterError)) throw error;
    return {
      status: "failed",
      error,
      coverage: params.files.map((file) => ({
        area: file.path,
        status: "failed",
        reason: `adapter ${adapter.spec.id}: ${error.code}`,
      })),
    };
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // a missing entry is reported by the start itself
  }
}

function major(version: string): string {
  return version.split(".")[0] ?? "";
}
