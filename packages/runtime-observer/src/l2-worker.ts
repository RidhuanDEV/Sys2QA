import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ObservedForm } from "./forms.js";
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
  /** `inspect`: the page's forms, and the ones the parent let the worker submit. */
  forms?: ObservedForm[];
  submissions?: Array<{ index: number; status: number | null; final_url: string; page?: string; action?: string }>;
  /** Downloads the page started; none is saved (SEC-019). */
  downloads?: string[];
  error?: string;
  /** `discover`: what the walk observed. */
  pages?: ObservedPage[];
  links_not_followed?: Array<{ target: string; from: string | null; reason: string }>;
  forms_seen?: Array<ObservedForm & { observed_at: string }>;
  traps?: Array<{ path: string; reason: string }>;
  login?: { status: "logged_in" | "failed" | "unsupported"; reason: string } | null;
  stopped?: "login";
  budget?: { pages: number; depth: number; ms: number; variants: number; exhausted: "pages" | "time" | null };
}

/** One page of the walk (QAA-FR-024): where, when, from which source and with which confidence. */
export interface ObservedPage {
  path: string;
  url: string;
  status: number | null;
  title: string;
  observed_at: string;
  depth: number;
  source: "runtime_observation";
  confidence: "observed";
  redirected_to?: string;
  observability?: "auth_required";
  /** The language the page declares (`<html lang>`), when it is a well-formed language tag. */
  lang?: string;
  /** In-scope link targets on the page (scheme, host and path; at most 200), read after scripts ran. */
  links?: string[];
}

export interface L2Job {
  /**
   * `validate`: reachability without side effects (QAA-FR-006). `inspect`: also read the page's forms and submit only
   * those the parent's policy names (SEC-024). Both let only GET and HEAD requests leave the browser.
   */
  action: "validate" | "inspect" | "discover";
  url: string;
  /** `discover`: extra in-scope entry URLs. */
  seeds?: string[];
  /** `discover`: limits of the walk. */
  budget?: { pages?: number; depth?: number; ms?: number; variants?: number };
  /** `discover`: a credential profile's values, given to this one worker process only (SEC-011). */
  login?: { url: string; username: string; password: string };
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
export function runL2Job(
  job: L2Job,
  proxy: ScopeProxy,
  options: {
    budgetMs?: number;
    /** `inspect`: the parent decides which forms the worker may submit (their indexes); the worker decides nothing. */
    onForms?: (forms: ObservedForm[]) => number[];
  } = {},
): Promise<L2Result> {
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
    let pending = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      pending += c.toString();
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.startsWith("{")) continue;
        const message = JSON.parse(line) as { type: string; forms?: ObservedForm[] };
        if (message.type === "forms")
          child.stdin.write(
            `${JSON.stringify({ type: "submit", submit: options.onForms?.(message.forms ?? []) ?? [] })}\n`,
          );
      }
    });
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    child.on("error", (e) => finish({ ok: false, error: `the L2 worker did not start: ${e.message}`, blocked: [] }));
    child.on("close", () => {
      child.stdin.destroy();
      const line = out.split("\n").find((l) => l.startsWith('{"type":"result"'));
      if (!line)
        return finish({
          ok: false,
          error: `the L2 worker gave no result${err ? `: ${err.trim().split("\n").at(-1)}` : ""}`,
          blocked: [],
        });
      const { type: _type, ...result } = JSON.parse(line) as L2Result & { type: string };
      finish(result);
    });
    const message = `${JSON.stringify({ ...job, proxy: { server: proxy.url, username: proxy.username, password: proxy.password } })}\n`;
    // A validation job needs nothing more; an inspection waits for the parent's decision on its forms.
    if (job.action === "validate") child.stdin.end(message);
    else child.stdin.write(message);
  });
}
