import { statfsSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { verifyAuditChain } from "../audit/audit.js";
import type { JobStore } from "../jobs/store.js";
import { appliedMigrations, loadMigrations } from "../storage/migrations.js";

export type HealthStatus = "ok" | "degraded" | "failing";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  status: HealthStatus;
  checked_at: string;
  checks: HealthCheck[];
}

export interface HealthSources {
  db: Database;
  jobs: JobStore;
  now: () => Date;
  home?: string;
  stuckAfterMs?: number;
  minFreeBytes?: number;
}

/** Health checks (OBS-004, QAA-FR-103). The worst check decides the overall status. */
export function checkHealth(sources: HealthSources): HealthReport {
  const checks: HealthCheck[] = [];
  const add = (name: string, status: HealthStatus, detail: string) => checks.push({ name, status, detail });

  const integrity = sources.db.pragma("quick_check", { simple: true }) as string;
  add(
    "state_integrity",
    integrity === "ok" ? "ok" : "failing",
    integrity === "ok" ? "state.db passes its integrity check" : `state.db integrity check failed: ${integrity}`,
  );

  const latest = loadMigrations().at(-1)?.version ?? 0;
  const applied = appliedMigrations(sources.db).at(-1)?.version ?? 0;
  add("migrations", applied === latest ? "ok" : "failing", `schema version ${applied} of ${latest}`);

  const audit = verifyAuditChain(sources.db);
  add(
    "audit_chain",
    audit.ok ? "ok" : "failing",
    audit.ok ? `${audit.events} audit events verified` : `audit chain broken at event ${audit.seq}: ${audit.reason}`,
  );

  const stuck = sources.jobs.findStuck(sources.stuckAfterMs ?? 15 * 60_000);
  add(
    "jobs",
    stuck.length === 0 ? "ok" : "degraded",
    stuck.length === 0
      ? "no stuck jobs"
      : `${stuck.length} stuck job(s): ${stuck.map((s) => `${s.job.id} (${s.reason})`).join(", ")}`,
  );

  if (sources.home) {
    try {
      const fs = statfsSync(sources.home);
      const free = Number(fs.bavail) * Number(fs.bsize);
      const min = sources.minFreeBytes ?? 1024 ** 3;
      add("disk_space", free >= min ? "ok" : "degraded", `${Math.round(free / 1024 ** 2)} MB free in the Sys2QA home`);
    } catch (error) {
      add("disk_space", "degraded", `free space unknown: ${(error as Error).message}`);
    }
  }

  const status: HealthStatus = checks.some((c) => c.status === "failing")
    ? "failing"
    : checks.some((c) => c.status === "degraded")
      ? "degraded"
      : "ok";
  return { status, checked_at: sources.now().toISOString(), checks };
}
