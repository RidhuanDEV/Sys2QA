import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProxyScope, ScopeProxy } from "./proxy.js";

/** A request the L2 worker refused in the browser layer (outside the scope, or a non-GET while validating). */
export interface BlockedRequest {
  method: string;
  target: string;
  reason: string;
}

export interface L2Result {
  ok: boolean;
  status?: number | null;
  final_url?: string;
  title?: string;
  /** Cookie names present before the first navigation: always none, since every job starts from a fresh profile. */
  cookies_before?: string[];
  cookies_after?: string[];
  blocked: BlockedRequest[];
  error?: string;
}

export interface L2Job {
  /** `validate`: reachability without side effects (QAA-FR-006): GET and HEAD only. */
  action: "validate";
  url: string;
  scope: Pick<ProxyScope, "allowed_hosts" | "path_prefixes">;
  timeoutMs?: number;
}

const WORKER = fileURLToPath(new URL("../worker/l2-worker.mjs", import.meta.url));
/** What the worker process may see of the host environment: where the browser lives and temp space, nothing else. */
const PASSED_ENV = [
  "PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "SYS2QA_BROWSER_EXECUTABLE",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
];

/**
 * Runs one L2 job in its own OS process (ADR-005, SEC-012): a fresh browser profile, deleted afterwards, and every
 * request through the given scope proxy. The process gets a minimal environment (no secrets, no Sys2QA settings) and
 * is killed when the time budget runs out.
 */
export function runL2Job(job: L2Job, proxy: ScopeProxy, options: { budgetMs?: number } = {}): Promise<L2Result> {
  const env = Object.fromEntries(
    PASSED_ENV.flatMap((k) => (process.env[k] !== undefined ? [[k, process.env[k]!]] : [])),
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (result: L2Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: "the L2 job ran out of its time budget", blocked: [] });
    }, options.budgetMs ?? 60_000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    child.on("error", (e) => finish({ ok: false, error: `the L2 worker did not start: ${e.message}`, blocked: [] }));
    child.on("close", () => {
      const line = out.split("\n").find((l) => l.startsWith("{"));
      if (!line)
        return finish({
          ok: false,
          error: `the L2 worker gave no result${err ? `: ${err.trim().split("\n").at(-1)}` : ""}`,
          blocked: [],
        });
      const { type: _type, ...result } = JSON.parse(line) as L2Result & { type: string };
      finish(result);
    });
    child.stdin.end(
      `${JSON.stringify({ ...job, proxy: { server: proxy.url, username: proxy.username, password: proxy.password } })}\n`,
    );
  });
}
