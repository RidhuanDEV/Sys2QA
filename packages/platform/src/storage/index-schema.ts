import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { defaultMigrationsDirectory } from "./migrations.js";

/** Bump when migrations/index-schema.sql changes; the index is then dropped, recreated and rebuilt (Data Model §5, §9). */
export const INDEX_SCHEMA_VERSION = 1;
const SETTING_KEY = "index_schema_version";

export interface IndexSchemaResult {
  /** True when the index tables were (re)created and are empty, so the caller must rebuild them from artifacts. */
  rebuildRequired: boolean;
}

export function ensureIndexSchema(
  db: Database,
  now: () => Date,
  directory = defaultMigrationsDirectory(),
): IndexSchemaResult {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(SETTING_KEY) as
    { value_json: string } | undefined;
  if (row && JSON.parse(row.value_json) === INDEX_SCHEMA_VERSION && indexTables(db).length > 0)
    return { rebuildRequired: false };
  const sql = readFileSync(join(directory, "index-schema.sql"), "utf8");
  const at = now().toISOString();
  db.transaction(() => {
    dropIndex(db);
    db.exec(sql);
    db.prepare(
      `INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(SETTING_KEY, JSON.stringify(INDEX_SCHEMA_VERSION), at, at);
  }).immediate();
  return { rebuildRequired: true };
}

/** Drops every idx_* table. Only the index group may ever be dropped (ADR-004). */
export function dropIndex(db: Database): void {
  // FTS5 shadow tables (idx_entities_fts_data, …) disappear with their virtual table.
  const tables = indexTables(db).filter((name) => !/_fts_(data|idx|content|docsize|config)$/.test(name));
  for (const name of tables) db.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
}

function indexTables(db: Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'idx\\_%' ESCAPE '\\'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}
