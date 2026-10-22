import { spawnSync } from "node:child_process";
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

/** Container runtime for automated execution (L3, OD-16). Optional: everything else works without it. */
export function checkContainerRuntime(): RuntimeCheck {
  const base = {
    id: "container_runtime",
    title: "Container runtime (Docker or Podman)",
    required_for: ["automated execution (L3)"],
  };
  for (const command of ["docker", "podman"]) {
    const result = spawnSync(command, ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout.trim() !== "")
      return { ...base, status: "ok", detail: `${command} ${result.stdout.trim()}` };
    if (result.status !== null && result.error === undefined) {
      return {
        ...base,
        status: "warn",
        detail: `${command} is installed but its engine did not answer`,
        remediation: `Start the ${command} engine to run approved automated tests.`,
      };
    }
  }
  return {
    ...base,
    status: "warn",
    detail: "no container runtime found",
    remediation:
      "Install Docker or Podman to run approved automated tests; manual QA and discovery work without it (CONTAINER_RUNTIME_MISSING).",
  };
}
