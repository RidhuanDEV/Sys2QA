import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

export type DoctorStatus = "ok" | "warn" | "fail";

/** One prerequisite (NFR-007): what was checked, what it is needed for, and what to do if it is missing. */
export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  /** Features that need it; `core` means Sys2QA cannot run without it. */
  required_for: string[];
  detail: string;
  remediation?: string;
}

export const MIN_NODE = [22, 12, 0] as const;
const MIN_SQLITE = [3, 37, 0] as const;

const atLeast = (version: string, min: readonly number[]) => {
  const parts = version.split(".").map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i]!;
  }
  return true;
};

export function checkNode(version = process.versions.node): DoctorCheck {
  const ok = atLeast(version, MIN_NODE);
  return {
    id: "node",
    title: "Node.js",
    status: ok ? "ok" : "fail",
    required_for: ["core"],
    detail: `Node.js ${version}`,
    ...(ok ? {} : { remediation: `Install Node.js ${MIN_NODE.join(".")} or newer (an LTS release: 22 or 24).` }),
  };
}

export function checkSqlite(): DoctorCheck {
  try {
    const db = new BetterSqlite3(":memory:");
    try {
      const version = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
      const options = (db.pragma("compile_options") as Array<{ compile_options: string }>).map(
        (o) => o.compile_options,
      );
      const missing = [
        ...(atLeast(version, MIN_SQLITE) ? [] : [`SQLite ${MIN_SQLITE.join(".")}+ (STRICT tables)`]),
        ...(options.includes("ENABLE_FTS5") ? [] : ["FTS5"]),
      ];
      return {
        id: "sqlite",
        title: "SQLite driver",
        status: missing.length === 0 ? "ok" : "fail",
        required_for: ["core"],
        detail: `better-sqlite3 with SQLite ${version}${missing.length ? `; missing ${missing.join(", ")}` : ""}`,
        ...(missing.length ? { remediation: "Reinstall Sys2QA so that its bundled SQLite driver is used." } : {}),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      id: "sqlite",
      title: "SQLite driver",
      status: "fail",
      required_for: ["core"],
      detail: `the SQLite driver did not load: ${(error as Error).message}`,
      remediation: "Reinstall Sys2QA; the driver ships prebuilt binaries for Linux, macOS and Windows (x64, arm64).",
    };
  }
}

export function checkHome(home: string, minFreeBytes = 1024 ** 3): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  try {
    mkdirSync(home, { recursive: true });
    const probe = join(home, `.doctor-${process.pid}`);
    writeFileSync(probe, "probe");
    rmSync(probe);
    checks.push({
      id: "home",
      title: "Sys2QA home directory",
      status: "ok",
      required_for: ["core"],
      detail: `${home} is writable`,
    });
  } catch (error) {
    checks.push({
      id: "home",
      title: "Sys2QA home directory",
      status: "fail",
      required_for: ["core"],
      detail: `${home} is not writable: ${(error as Error).message}`,
      remediation: "Choose a writable location with --home or SYS2QA_HOME.",
    });
    return checks;
  }
  try {
    const fs = statfsSync(home);
    const free = Number(fs.bavail) * Number(fs.bsize);
    checks.push({
      id: "disk_space",
      title: "Free disk space",
      status: free >= minFreeBytes ? "ok" : "warn",
      required_for: ["analysis", "discovery", "runs"],
      detail: `${Math.round(free / 1024 ** 2)} MB free`,
      ...(free >= minFreeBytes
        ? {}
        : {
            remediation:
              "Free at least 1 GB; analysis runs, packages and run evidence are stored in the home directory.",
          }),
    });
  } catch {
    // statfs is unavailable on some file systems; nothing to report.
  }
  return checks;
}

export function checkGit(): DoctorCheck {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (result.status === 0)
    return {
      id: "git",
      title: "Git",
      status: "ok",
      required_for: ["revision identity (Mode A)"],
      detail: result.stdout.trim(),
    };
  return {
    id: "git",
    title: "Git",
    status: "warn",
    required_for: ["revision identity (Mode A)"],
    detail: "git was not found",
    remediation:
      "Install Git to bind analyses to commits; without it, local sources are identified by a content fingerprint.",
  };
}

export function doctorStatus(checks: DoctorCheck[]): DoctorStatus {
  return checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
}
