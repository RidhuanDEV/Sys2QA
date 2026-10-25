import type {
  CoverageItem,
  Entity,
  EntityKind,
  Evidence,
  ProgressParams,
  Relationship,
  RelationshipType,
} from "@sys2qa/contract";

/** Adapter protocol version spoken by this host (ADR-009). A different major version is incompatible. */
export const PROTOCOL_VERSION = "1.0.0";

/**
 * Framing: one JSON-RPC 2.0 message per line (UTF-8, `\n`-terminated) on stdin and stdout. `JSON.stringify` never
 * emits a raw newline, so a line is always one complete message. Adapters write diagnostics to stderr only.
 */
export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** JSON-RPC error codes: the standard ones plus adapter-specific codes in the implementation-defined range. */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  CANCELLED: -32001,
  BUDGET_EXCEEDED: -32002,
} as const;

// Message shapes of schemas/adapter-protocol.schema.json; the host validates every message against the schema.

export interface InitializeParams {
  protocol_version: string;
  host_version: string;
}

export interface FrameworkSupport {
  name: string;
  versions?: string;
  entities: EntityKind[];
  relations: RelationshipType[];
  workflow_tracing: "supported" | "partial" | "unsupported";
  /** Benchmark or unit fixtures that prove the claim (SAA-FR-047). */
  fixtures: string[];
}

export interface SupportMatrix {
  /** Language IDs as in the inventory classification (`typescript`, `sql`, …). */
  languages: Array<{ name: string; versions?: string }>;
  scanned_only_languages: string[];
  frameworks: FrameworkSupport[];
  prerequisites: string[];
  limitations: string[];
}

export interface InitializeResult {
  adapter_id: string;
  adapter_version: string;
  protocol_version: string;
  support_matrix: SupportMatrix;
}

export interface AnalyzeParams {
  run_id: string;
  root_id: string;
  /** Root-relative paths; the adapter's working directory is the root. */
  files: Array<{ path: string; sha256: string }>;
  budget: { max_ms: number; max_output_bytes: number };
}

export interface AnalyzeResult {
  entities: Entity[];
  relationships: Relationship[];
  evidence: Evidence[];
  coverage: CoverageItem[];
}

export type AdapterRequest =
  | { jsonrpc: "2.0"; id: number | string; method: "initialize"; params: InitializeParams }
  | { jsonrpc: "2.0"; id: number | string; method: "analyze"; params: AnalyzeParams }
  | { jsonrpc: "2.0"; id: number | string; method: "cancel"; params: { run_id: string } };

export type AdapterResponse =
  | { jsonrpc: "2.0"; id: number | string; result: object }
  | { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string } };

export type AdapterNotification = { jsonrpc: "2.0"; method: "progress"; params: ProgressParams };

export type { CoverageItem, ProgressParams };

/**
 * Splits a byte stream into lines, refusing any line longer than `maxLineBytes` (a runaway or hostile peer cannot
 * make the reader buffer without bound).
 */
export class LineDecoder {
  #buffer = "";
  #bufferBytes = 0;

  constructor(readonly maxLineBytes: number) {}

  /** Returns the complete lines in `chunk`; throws `RangeError` when a line exceeds the limit. */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines: string[] = [];
    let start = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
      const piece = text.slice(start, i);
      this.#check(Buffer.byteLength(piece));
      lines.push(this.#buffer + piece);
      this.#buffer = "";
      this.#bufferBytes = 0;
      start = i + 1;
    }
    const rest = text.slice(start);
    this.#check(Buffer.byteLength(rest));
    this.#buffer += rest;
    this.#bufferBytes += Buffer.byteLength(rest);
    return lines.filter((l) => l.trim() !== "");
  }

  #check(extra: number): void {
    if (this.#bufferBytes + extra > this.maxLineBytes)
      throw new RangeError(`message longer than ${this.maxLineBytes} bytes`);
  }
}
