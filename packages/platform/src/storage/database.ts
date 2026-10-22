import BetterSqlite3, { type Database, SqliteError } from "better-sqlite3";
import { StorageError } from "./errors.js";
import { ensureIndexSchema } from "./index-schema.js";
import { loadMigrations, migrate, type Migration } from "./migrations.js";

export interface OpenStateOptions {
  /** Path of state.db, or ":memory:" in tests. */
  path: string;
  /** Overrides the migration set (tests). */
  migrations?: Migration[];
  migrationsDirectory?: string;
  now?: () => Date;
}

export interface StateDatabase {
  readonly db: Database;
  /** Migrations applied by this open, oldest first. */
  readonly appliedNow: readonly Migration[];
  /** True when the index tables are empty after a schema change and must be rebuilt from artifacts. */
  readonly indexRebuildRequired: boolean;
  /** Runs `fn` in one BEGIN IMMEDIATE transaction (Data Model §6.3); rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

const CORRUPTION_CODES = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);

/**
 * Opens the state database the way the host must on every start (Data Model §9 steps 1–2 and the index-version
 * check of step 5): integrity check first, then forward-only migrations, then the index schema.
 */
export function openStateDatabase(options: OpenStateOptions): StateDatabase {
  const now = options.now ?? (() => new Date());
  let db: Database | undefined;
  try {
    db = new BetterSqlite3(options.path);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    checkIntegrity(db);
    const appliedNow = migrate(db, options.migrations ?? loadMigrations(options.migrationsDirectory), now);
    const { rebuildRequired } = ensureIndexSchema(db, now, options.migrationsDirectory);
    const handle = db;
    return {
      db: handle,
      appliedNow,
      indexRebuildRequired: rebuildRequired,
      transaction: <T>(fn: () => T): T => handle.transaction(fn).immediate(),
      close: () => handle.close(),
    };
  } catch (error) {
    db?.close();
    if (error instanceof SqliteError && CORRUPTION_CODES.has(error.code)) throw integrityError(error.message, error);
    throw error;
  }
}

function checkIntegrity(db: Database): void {
  const rows = db.pragma("quick_check") as { quick_check: string }[];
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw integrityError(
      rows
        .map((r) => r.quick_check)
        .slice(0, 5)
        .join("; "),
    );
  }
}

function integrityError(detail: string, cause?: unknown): StorageError {
  return new StorageError(
    "STATE_INTEGRITY_FAILED",
    `state database failed its integrity check: ${detail}`,
    "Sys2QA will not start on a damaged state database. Restore state.db together with the projects/ directory from your latest backup (Data Model §1).",
    cause === undefined ? undefined : { cause },
  );
}
