import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** Receives one JSON line (without newline). */
export type LogSink = (line: string) => void;

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** A logger that adds `bindings` (e.g. job_id) to every line. */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  sink: LogSink;
  redactor: Redactor;
  level?: LogLevel;
  now?: () => Date;
}

/**
 * Structured JSON-lines logger (OBS-002). Every field passes through the redactor, so secrets never reach a log
 * (SEC-004). Event names are dotted lowercase identifiers such as `job.transition` or `policy.decision`.
 */
export function createLogger(options: LoggerOptions, bindings: Record<string, unknown> = {}): Logger {
  const min = LEVELS[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  const write = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[level] < min) return;
    if (!EVENT_NAME.test(event)) throw new Error(`invalid log event name: ${event}`);
    const { value, redactedPaths } = options.redactor.redact({ ...bindings, ...fields });
    const line: Record<string, unknown> = { ts: now().toISOString(), level, event, ...value };
    if (redactedPaths.length > 0) line.redacted_paths = redactedPaths;
    options.sink(JSON.stringify(line));
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (more) => createLogger(options, { ...bindings, ...more }),
  };
}

/** Appends to `<dir>/sys2qa-YYYY-MM-DD.log` (UTC day). Rotation by day; retention is a deletion job (IMP-019). */
export function fileSink(dir: string, now: () => Date = () => new Date()): LogSink {
  mkdirSync(dir, { recursive: true });
  return (line) =>
    appendFileSync(join(dir, `sys2qa-${now().toISOString().slice(0, 10)}.log`), `${line}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
}

export function memorySink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  const sink = ((line: string) => {
    lines.push(line);
  }) as LogSink & { lines: string[] };
  sink.lines = lines;
  return sink;
}
