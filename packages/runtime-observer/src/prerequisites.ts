import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/** Same shape as the platform's DoctorCheck; runtime-observer may not import platform internals beyond its entry. */
export interface RuntimeCheck {
  id: string;
  title: string;
  status: "ok" | "warn" | "fail";
  required_for: string[];
  detail: string;
  remediation?: string;
}

// Resolved by name at run time: the browser runtime is an optional install until runtime discovery lands (IMP-404).
const PLAYWRIGHT_PACKAGE = "playwright-core";

/** Browser runtime for discovery and verification (L2; ADR-005). Missing browsers do not block repository analysis. */
export async function checkBrowserRuntime(): Promise<RuntimeCheck> {
  const base = {
    id: "browser",
    title: "Browser runtime (Playwright Chromium)",
    required_for: ["URL discovery (Modes B and C)", "automated runs"],
  };
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve(PLAYWRIGHT_PACKAGE);
  } catch {
    return {
      ...base,
      status: "warn",
      detail: "Playwright is not installed",
      remediation:
        "Install the browser runtime for URL discovery (`npx playwright install chromium`); repository analysis and packages work without it.",
    };
  }
  try {
    const playwright = (await import(entry)) as { chromium: { executablePath(): string } };
    const executable = playwright.chromium.executablePath();
    return existsSync(executable)
      ? { ...base, status: "ok", detail: `Chromium at ${executable}` }
      : {
          ...base,
          status: "warn",
          detail: "Playwright is installed but Chromium is not",
          remediation: "Run `npx playwright install chromium`.",
        };
  } catch (error) {
    return {
      ...base,
      status: "warn",
      detail: `Playwright could not be loaded: ${(error as Error).message}`,
      remediation: "Reinstall the browser runtime.",
    };
  }
}

interface ProbeResult {
  command: string;
  status: number | null;
  stdout: string;
  missing: boolean;
}

/** Runs `<command> version` with a time limit; resolves (never rejects) with what happened. */
function probe(command: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (result: Omit<ProbeResult, "command" | "stdout">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, stdout: stdout.trim(), ...result });
    };
    const child = spawn(command, ["version", "--format", "{{.Server.Version}}"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      done({ status: null, missing: false });
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.on("error", () => done({ status: null, missing: true }));
    child.on("close", (status) => done({ status, missing: false }));
  });
}

/**
 * Container runtime for automated execution (L3, OD-16). Optional: everything else works without it. Docker and Podman
 * are probed concurrently, so the check takes as long as the slowest probe (at most `timeoutMs`), not their sum.
 */
export async function checkContainerRuntime(timeoutMs = 5000): Promise<RuntimeCheck> {
  const base = {
    id: "container_runtime",
    title: "Container runtime (Docker or Podman)",
    required_for: ["automated execution (L3)"],
  };
  const results = await Promise.all(["docker", "podman"].map((c) => probe(c, timeoutMs)));
  const running = results.find((r) => r.status === 0 && r.stdout !== "");
  if (running) return { ...base, status: "ok", detail: `${running.command} ${running.stdout}` };
  const installed = results.find((r) => !r.missing);
  if (installed) {
    return {
      ...base,
      status: "warn",
      detail: `${installed.command} is installed but its engine did not answer`,
      remediation: `Start the ${installed.command} engine to run approved automated tests.`,
    };
  }
  return {
    ...base,
    status: "warn",
    detail: "no container runtime found",
    remediation:
      "Install Docker or Podman to run approved automated tests; manual QA and discovery work without it (CONTAINER_RUNTIME_MISSING).",
  };
}
