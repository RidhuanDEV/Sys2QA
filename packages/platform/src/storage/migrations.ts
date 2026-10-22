import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { StorageError } from "./errors.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** sha256 of the SQL text with line endings normalized, so a checkout on Windows yields the same value. */
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL("../../migrations/", import.meta.url));
}

export function sqlChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex")}`;
}

/** Reads `NNNN_name.sql` files; versions must be 1, 2, 3, … without gaps or duplicates. */
export function loadMigrations(directory = defaultMigrationsDirectory()): Migration[] {
  const migrations = readdirSync(directory)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((x): x is { file: string; match: RegExpExecArray } => x.match !== null)
    .map(({ file, match }) => {
      const sql = readFileSync(join(directory, file), "utf8");
      return { version: Number(match[1]), name: match[2]!, sql, checksum: sqlChecksum(sql) };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new StorageError(
        "STATE_MIGRATION_INVALID",
        `migration versions must be contiguous from 1; found ${m.version} at position ${i + 1}`,
        "Reinstall Sys2QA; the installed migration files are incomplete.",
      );
    }
  });
  return migrations;
}

export function appliedMigrations(db: Database): AppliedMigration[] {
  return db
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
    .all() as AppliedMigration[];
}

/**
 * Applies pending migrations, each in its own IMMEDIATE transaction (forward-only, Data Model §10).
 * Refuses a database written by newer code and a database whose applied migrations were edited afterwards.
 */
export function migrate(db: Database, migrations: Migration[], now: () => Date): Migration[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = appliedMigrations(db);
  const known = new Map(migrations.map((m) => [m.version, m]));
  for (const a of applied) {
    const m = known.get(a.version);
    if (!m) {
      throw new StorageError(
        "STATE_NEWER_THAN_CODE",
        `state database has migration ${a.version} (${a.name}), which this version of Sys2QA does not know`,
        "Upgrade Sys2QA to the version that last opened this state, or restore a backup made by this version.",
      );
    }
    if (m.checksum !== a.checksum) {
      throw new StorageError(
        "STATE_MIGRATION_INVALID",
        `migration ${a.version} (${a.name}) differs from the one applied to this database`,
        "Reinstall Sys2QA; applied migrations must never change.",
      );
    }
  }
  const pending = migrations.filter((m) => m.version > (applied.at(-1)?.version ?? 0));
  const record = db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)");
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, m.checksum, now().toISOString());
    }).immediate();
  }
  return pending;
}
