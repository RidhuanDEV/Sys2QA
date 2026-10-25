import type { Readable, Writable } from "node:stream";
import {
  encodeMessage,
  LineDecoder,
  RPC_ERRORS,
  type AdapterRequest,
  type AnalyzeParams,
  type AnalyzeResult,
  type InitializeParams,
  type InitializeResult,
} from "./protocol.js";

export interface AnalyzeContext {
  /** Aborted when the host sends `cancel` for this run. */
  signal: AbortSignal;
  progress(filesDone: number, filesTotal: number): void;
}

export interface AdapterHandlers {
  initialize(params: InitializeParams): InitializeResult | Promise<InitializeResult>;
  analyze(params: AnalyzeParams, context: AnalyzeContext): Promise<AnalyzeResult>;
}

/** Largest request an adapter accepts (a file batch is paths and hashes, never contents). */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/**
 * Runs an adapter's side of the protocol (ADR-009) on stdin/stdout until stdin closes. Requests are handled one at a
 * time, except `cancel`, which aborts the running analysis. Anything the adapter prints with `console` goes to stderr,
 * so stdout carries protocol messages only.
 */
export function serveAdapter(
  handlers: AdapterHandlers,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  if (io.output === process.stdout) {
    for (const method of ["log", "info", "debug"] as const)
      console[method] = (...args: unknown[]) => console.error(...args);
  }
  const send = (message: unknown) => io.output.write(encodeMessage(message));
  const decoder = new LineDecoder(MAX_REQUEST_BYTES);
  const running = new Map<string, AbortController>();
  let queue = Promise.resolve();

  const handle = async (request: AdapterRequest, controller: AbortController) => {
    try {
      if (request.method === "initialize") {
        send({ jsonrpc: "2.0", id: request.id, result: await handlers.initialize(request.params) });
      } else if (request.method === "analyze") {
        try {
          if (controller.signal.aborted) {
            // Cancelled while still queued: the handler never starts.
            send({ jsonrpc: "2.0", id: request.id, error: { code: RPC_ERRORS.CANCELLED, message: "cancelled" } });
            return;
          }
          const result = await handlers.analyze(request.params, {
            signal: controller.signal,
            progress: (done, total) =>
              send({
                jsonrpc: "2.0",
                method: "progress",
                params: { run_id: request.params.run_id, files_done: done, files_total: total },
              }),
          });
          if (controller.signal.aborted)
            send({ jsonrpc: "2.0", id: request.id, error: { code: RPC_ERRORS.CANCELLED, message: "cancelled" } });
          else send({ jsonrpc: "2.0", id: request.id, result });
        } finally {
          if (running.get(request.params.run_id) === controller) running.delete(request.params.run_id);
        }
      } else {
        send({
          jsonrpc: "2.0",
          id: (request as { id: number | string }).id,
          error: { code: RPC_ERRORS.METHOD_NOT_FOUND, message: "unknown method" },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ jsonrpc: "2.0", id: request.id, error: { code: RPC_ERRORS.INTERNAL_ERROR, message } });
    }
  };

  return new Promise((resolve) => {
    io.input.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
        io.input.destroy();
        return;
      }
      for (const line of lines) {
        let request: AdapterRequest;
        try {
          request = JSON.parse(line) as AdapterRequest;
        } catch {
          console.error("adapter: ignoring a line that is not JSON");
          continue;
        }
        if (request.method === "cancel") {
          running.get(request.params.run_id)?.abort();
          send({ jsonrpc: "2.0", id: request.id, result: {} });
          continue;
        }
        // Registered on receipt, so a cancel that arrives while the analysis is still queued is not lost.
        const controller = new AbortController();
        if (request.method === "analyze") running.set(request.params.run_id, controller);
        queue = queue.then(() => handle(request, controller));
      }
    });
    io.input.on("close", () => void queue.then(() => resolve()));
    io.input.on("end", () => void queue.then(() => resolve()));
  });
}
