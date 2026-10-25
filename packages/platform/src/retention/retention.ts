import { readdirSync, rmSync, statSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { appendAudit, type AuditContext } from "../audit/audit.js";
import type { ProjectService } from "../projects/projects.js";
import type { SecretService } from "../secrets/service.js";

/**
 * The on-disk name of an operational ID (`project:01J…` → `01J…`). File and directory names never contain the full ID,
 * because `:` is not allowed in Windows paths; the local part is validated so a crafted ID cannot escape its directory.
 */
export function localIdPart(id: string): string {
  const local = id.slice(id.indexOf(":") + 1);
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(local)) throw new Error(`unexpected ID ${id}`);
  return local;
}

/** `<home>/projects/<project-ulid>/` (Data Model §2). */
export function projectDirectory(home: string, projectId: string): string {
  if (!projectId.startsWith("project:")) throw new Error(`unexpected project ID ${projectId}`);
  return join(home, "projects", localIdPart(projectId));
}

/** `<home>/projects/<project-ulid>/skb/<run-ulid>/` (Data Model §2). */
export function runDirectory(home: string, projectId: string, runId: string): string {
  return join(projectDirectory(home, projectId), "skb", localIdPart(runId));
}

export interface DeletionReport {
  project_id: string;
  secrets_removed: number;
  directory_removed: boolean;
  index_rows_removed: number;
}

const INDEX_TABLES = ["idx_entities", "idx_entities_fts", "idx_edges", "idx_workflows", "idx_claims", "idx_evidence"];

/**
 * Deletes a project everywhere (SEC-015, Data Model §8): tombstone first, then secret values, `projects/<id>/`, index
 * rows, and finally the state rows with an installation-wide audit event. Each step is idempotent, so an interrupted
 * deletion (e.g. the secret store was locked) is completed by running it again or by `resumeDeletions`.
 */
export async function deleteProjectEverywhere(options: {
  db: Database;
  home: string;
  projects: ProjectService;
  secrets: () => Promise<SecretService>;
  projectId: string;
  actor: string;
}): Promise<DeletionReport> {
  const { db, projectId } = options;
  options.projects.requestDeletion(projectId, options.actor);
  const hasSecrets =
    (db.prepare("SELECT count(*) AS n FROM secret_refs WHERE project_id = ?").get(projectId) as { n: number }).n > 0;
  const secretsRemoved = hasSecrets ? (await (await options.secrets()).removeAllForProject(projectId)).length : 0;
  const dir = projectDirectory(options.home, projectId);
  let directoryRemoved = false;
  try {
    statSync(dir);
    rmSync(dir, { recursive: true, force: true });
    directoryRemoved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const runIds = (
    db.prepare("SELECT id FROM analysis_runs WHERE project_id = ?").all(projectId) as Array<{ id: string }>
  ).map((r) => r.id);
  let indexRows = 0;
  db.transaction(() => {
    for (const table of INDEX_TABLES) {
      const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table);
      if (!exists) continue;
      for (const runId of runIds) indexRows += db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId).changes;
    }
  }).immediate();
  options.projects.deleteProject(projectId, options.actor);
  return {
    project_id: projectId,
    secrets_removed: secretsRemoved,
    directory_removed: directoryRemoved,
    index_rows_removed: indexRows,
  };
}

/** Projects with a deletion tombstone whose deletion has not finished (host start, Data Model §9). */
export function pendingDeletions(db: Database): string[] {
  return (
    db
      .prepare(
        "SELECT d.project_id FROM project_deletions d JOIN projects p ON p.id = d.project_id ORDER BY d.requested_at",
      )
      .all() as Array<{ project_id: string }>
  ).map((r) => r.project_id);
}

export interface RetentionPolicy {
  blob_days: number;
  log_days: number;
  cache_max_bytes: number;
}

export interface RetentionReport {
  logs_removed: number;
  blobs_removed: number;
  blobs_kept_referenced: number;
  cache_files_removed: number;
  cache_bytes_freed: number;
}

const DAY = 86_400_000;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(d, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat?.isDirectory()) walk(path);
      else if (stat?.isFile()) out.push(path);
    }
  };
  walk(dir);
  return out;
}

function removeEmptyDirs(dir: string): void {
  for (const name of (() => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  })()) {
    const path = join(dir, name);
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      removeEmptyDirs(path);
      try {
        rmdirSync(path);
      } catch {
        // not empty
      }
    }
  }
}

/**
 * The retention sweep (SEC-015, ST-18). Removes logs past `log_days`; evidence blobs past `blob_days` unless a defect
 * references them or they are pinned (`blob_pins`); and the least recently used cache files while a project's cache
 * exceeds `cache_max_bytes`. Audit events are never touched here. Counts (no paths) are audited as `data.deleted`.
 */
export function runRetention(options: {
  db: Database;
  home: string;
  now: () => Date;
  policy: RetentionPolicy;
  audit: AuditContext;
}): RetentionReport {
  const { db, home, policy } = options;
  const now = options.now().getTime();
  const report: RetentionReport = {
    logs_removed: 0,
    blobs_removed: 0,
    blobs_kept_referenced: 0,
    cache_files_removed: 0,
    cache_bytes_freed: 0,
  };

  for (const file of listFiles(join(home, "logs"))) {
    const day = /sys2qa-(\d{4}-\d{2}-\d{2})\.log$/.exec(file)?.[1];
    if (day && now - Date.parse(`${day}T00:00:00Z`) > (policy.log_days + 1) * DAY) {
      rmSync(file, { force: true });
      report.logs_removed++;
    }
  }

  const projects = (db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map((r) => r.id);
  for (const projectId of projects) {
    const dir = projectDirectory(home, projectId);
    const pinned = new Set(
      (db.prepare("SELECT sha256 FROM blob_pins WHERE project_id = ?").all(projectId) as Array<{ sha256: string }>).map(
        (r) => r.sha256,
      ),
    );
    const defectLinks = (
      db.prepare("SELECT links_json FROM defects WHERE project_id = ?").all(projectId) as Array<{ links_json: string }>
    )
      .map((r) => r.links_json)
      .join("\n");
    for (const file of listFiles(join(dir, "blobs"))) {
      const sha = file.split(/[\\/]/).at(-1)!;
      if (now - statSync(file).mtimeMs <= policy.blob_days * DAY) continue;
      if (pinned.has(sha) || defectLinks.includes(sha)) {
        report.blobs_kept_referenced++;
        continue;
      }
      rmSync(file, { force: true });
      report.blobs_removed++;
    }
    removeEmptyDirs(join(dir, "blobs"));

    const cache = listFiles(join(dir, "cache"))
      .map((path) => {
        const s = statSync(path);
        return { path, size: s.size, used: Math.max(s.atimeMs, s.mtimeMs) };
      })
      .sort((a, b) => a.used - b.used);
    let total = cache.reduce((n, f) => n + f.size, 0);
    for (const file of cache) {
      if (total <= policy.cache_max_bytes) break;
      rmSync(file.path, { force: true });
      total -= file.size;
      report.cache_files_removed++;
      report.cache_bytes_freed += file.size;
    }
    removeEmptyDirs(join(dir, "cache"));
  }

  if (report.logs_removed + report.blobs_removed + report.cache_files_removed > 0) {
    db.transaction(() =>
      appendAudit(
        db,
        { projectId: null, actor: "system", action: "data.deleted", target: "retention", details: { ...report } },
        options.audit,
      ),
    ).immediate();
  }
  return report;
}
