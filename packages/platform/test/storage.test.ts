import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireHostLock,
  appliedMigrations,
  ensureIndexSchema,
  INDEX_SCHEMA_VERSION,
  loadMigrations,
  openStateDatabase,
  sqlChecksum,
  StorageError,
  type StateDatabase,
} from "../src/index.js";

const FIXED_NOW = () => new Date("2026-10-22T10:00:00.000Z");
const AT = "2026-10-22T10:00:00.000Z";
let dir: string;
const opened: StateDatabase[] = [];
const open = (path = join(dir, "state.db"), extra: Partial<Parameters<typeof openStateDatabase>[0]> = {}) => {
  const s = openStateDatabase({ path, now: FIXED_NOW, ...extra });
  opened.push(s);
  return s;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sys2qa-state-"));
});
afterEach(() => {
  for (const s of opened.splice(0)) if (s.db.open) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedProject(s: StateDatabase, id = "project:p1"): void {
  s.db
    .prepare(
      "INSERT INTO projects (id, name, default_languages_json, created_at, updated_at) VALUES (?, 'P', '[\"en\"]', ?, ?)",
    )
    .run(id, AT, AT);
}
const tombstone = (s: StateDatabase, id = "project:p1") =>
  s.db
    .prepare(
      "INSERT INTO project_deletions (project_id, requested_by, requested_at, created_at, updated_at) VALUES (?, 'user', ?, ?, ?)",
    )
    .run(id, AT, AT, AT);
const storageCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof StorageError ? error.code : `not a StorageError: ${String(error)}`;
  }
  return undefined;
};

describe("state database setup [@req NFR-004]", () => {
  it("migrates an empty database to the latest version and applies nothing on the next open", () => {
    const first = open();
    const migrations = loadMigrations();
    expect(first.appliedNow.map((m) => m.version)).toEqual(migrations.map((m) => m.version));
    expect(appliedMigrations(first.db).map((m) => m.checksum)).toEqual(migrations.map((m) => m.checksum));
    const tables = (
      first.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      "projects",
      "jobs",
      "job_events",
      "scenario_versions",
      "approvals",
      "audit_events",
      "settings",
      "idx_entities",
      "idx_edges",
    ]) {
      expect(tables).toContain(t);
    }
    first.close();
    expect(open().appliedNow).toEqual([]);
  });

  it("uses WAL, full sync and foreign keys", () => {
    const s = open();
    expect(s.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(s.db.pragma("synchronous", { simple: true })).toBe(2);
    expect(s.db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("refuses a database written by newer code", () => {
    const s = open();
    s.db.prepare("INSERT INTO schema_migrations VALUES (999, 'future', 'sha256:x', ?)").run(AT);
    s.close();
    expect(storageCode(() => open())).toBe("STATE_NEWER_THAN_CODE");
  });

  it("refuses a database whose applied migration was edited afterwards", () => {
    open().close();
    const edited = loadMigrations().map((m) =>
      m.version === 1 ? { ...m, checksum: sqlChecksum(`${m.sql}\n-- edited`) } : m,
    );
    expect(storageCode(() => open(undefined, { migrations: edited }))).toBe("STATE_MIGRATION_INVALID");
  });

  it("normalizes line endings in migration checksums", () => {
    expect(sqlChecksum("a;\r\nb;\r\n")).toBe(sqlChecksum("a;\nb;\n"));
  });

  it("rejects migration sets with gaps", () => {
    for (const [file, sql] of [
      ["0001_a.sql", "CREATE TABLE a (x INTEGER) STRICT;"],
      ["0003_c.sql", "CREATE TABLE c (x INTEGER) STRICT;"],
    ] as const) {
      writeFileSync(join(dir, file), sql);
    }
    expect(storageCode(() => loadMigrations(dir))).toBe("STATE_MIGRATION_INVALID");
  });

  it("refuses to start on a damaged database [@req NFR-004]", () => {
    const path = join(dir, "state.db");
    const s = open(path);
    seedProject(s);
    const insert = s.db.prepare("INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)");
    s.transaction(() => {
      for (let i = 0; i < 500; i++) insert.run(`k${i}`, JSON.stringify("x".repeat(200)), AT, AT);
    });
    s.db.pragma("wal_checkpoint(TRUNCATE)");
    s.close();
    const pageSize = 4096;
    const size = statSync(path).size;
    const fd = openSync(path, "r+");
    for (let offset = pageSize * 2; offset < size - pageSize; offset += pageSize * 3)
      writeSync(fd, Buffer.alloc(pageSize, 0xab), 0, pageSize, offset);
    closeSync(fd);
    expect(storageCode(() => open(path))).toBe("STATE_INTEGRITY_FAILED");
  });
});

describe("state database invariants [@req NFR-004] [@req SEC-014] [@req QAA-FR-052]", () => {
  it("rejects values outside the documented enumerations and secrets other than references [@req SEC-011]", () => {
    const s = open();
    seedProject(s);
    const env = s.db.prepare(
      "INSERT INTO environments (id, project_id, base_url, classification, state, created_at, updated_at) VALUES (?, 'project:p1', 'https://staging.example', ?, 'configured', ?, ?)",
    );
    expect(() => env.run("env:x", "qa", AT, AT)).toThrow(/CHECK/);
    env.run("env:staging", "staging", AT, AT);
    const cred = s.db.prepare(
      "INSERT INTO credential_profiles (id, environment_id, role_name, secret_ref, created_at, updated_at) VALUES ('cred:1', 'env:staging', 'applicant', ?, ?, ?)",
    );
    expect(() => cred.run("hunter2", AT, AT)).toThrow(/CHECK/);
    expect(() => cred.run("secretref:applicant", AT, AT)).not.toThrow();
  });

  it("keeps audit events append-only until their project has a deletion tombstone", () => {
    const s = open();
    seedProject(s);
    const insert = s.db.prepare(
      "INSERT INTO audit_events (project_id, at, actor, action, details_json, created_at, updated_at) VALUES (?, ?, 'user', 'project.created', '{}', ?, ?)",
    );
    insert.run("project:p1", AT, AT, AT);
    insert.run(null, AT, AT, AT);
    expect(() => s.db.prepare("UPDATE audit_events SET actor = 'mallory'").run()).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM audit_events WHERE project_id = 'project:p1'").run()).toThrow(/append-only/);
    tombstone(s);
    s.db.prepare("DELETE FROM audit_events WHERE project_id = 'project:p1'").run();
    expect(() => s.db.prepare("DELETE FROM audit_events WHERE project_id IS NULL").run()).toThrow(/append-only/);
  });

  it("cascades a project deletion through append-only tables once the project has a deletion tombstone [@req SEC-015]", () => {
    const s = open();
    seedProject(s);
    s.db
      .prepare(
        "INSERT INTO audit_events (project_id, at, actor, action, details_json, created_at, updated_at) VALUES ('project:p1', ?, 'user', 'x', '{}', ?, ?)",
      )
      .run(AT, AT, AT);
    expect(() => s.db.prepare("DELETE FROM projects WHERE id = 'project:p1'").run()).toThrow(/append-only/);
    s.transaction(() => {
      tombstone(s);
      s.db.prepare("DELETE FROM projects WHERE id = 'project:p1'").run();
    });
    expect(s.db.prepare("SELECT count(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
    expect(() => s.db.prepare("DELETE FROM project_deletions").run()).toThrow(/append-only/);
  });

  it("makes approved scenario versions immutable while allowing status and freshness changes", () => {
    const s = open();
    seedProject(s);
    s.db
      .prepare(
        "INSERT INTO scenarios (scenario_id, project_id, display_key, latest_version, created_at, updated_at) VALUES ('scn:1', 'project:p1', 'TC-1', 1, ?, ?)",
      )
      .run(AT, AT);
    s.db
      .prepare(
        `INSERT INTO scenario_versions (scenario_id, version, doc_json, status, freshness, content_sha256, created_at, updated_at)
       VALUES ('scn:1', 1, '{}', 'approved', 'current', ?, ?, ?)`,
      )
      .run(`sha256:${"0".repeat(64)}`, AT, AT);
    expect(() => s.db.prepare("UPDATE scenario_versions SET doc_json = '{\"x\":1}'").run()).toThrow(/immutable/);
    s.db.prepare("UPDATE scenario_versions SET freshness = 'stale', status = 'superseded'").run();
    expect(() => s.db.prepare("UPDATE scenario_versions SET doc_json = '{\"x\":1}'").run()).toThrow(/immutable/);
  });

  it("rolls back a failed transaction completely", () => {
    const s = open();
    expect(() =>
      s.transaction(() => {
        seedProject(s, "project:a");
        seedProject(s, "project:a");
      }),
    ).toThrow(/UNIQUE/);
    expect(s.db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });
});

describe("crash recovery [@req NFR-004]", () => {
  it("keeps committed writes and discards the in-flight transaction of a killed writer", async () => {
    const path = join(dir, "state.db");
    open(path).close();
    const writer = spawn(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/crash-writer.mjs", import.meta.url)), path],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      writer.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) resolve();
      });
      writer.on("exit", (code) => reject(new Error(`writer exited early with ${String(code)}`)));
    });
    const exited = new Promise((resolve) => writer.on("exit", resolve));
    writer.kill("SIGKILL");
    await exited;
    const s = open(path);
    const ids = (s.db.prepare("SELECT id FROM projects ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["project:committed"]);
    expect(s.db.pragma("quick_check", { simple: true })).toBe("ok");
  }, 20_000);
});

describe("index schema (rebuildable) [@req NFR-003]", () => {
  it("is created with the current version and recreated empty when the version changes", () => {
    const s = open();
    expect(s.indexRebuildRequired).toBe(true);
    s.db
      .prepare(
        "INSERT INTO idx_entities (id, run_id, kind, name, status, origin) VALUES ('page:web:/a', 'run:1', 'page', 'A', 'source_verified', 'source')",
      )
      .run();
    s.db
      .prepare(
        "INSERT INTO idx_entities_fts (id, run_id, name, description) VALUES ('page:web:/a', 'run:1', 'Registration form', 'NIB field')",
      )
      .run();
    expect(s.db.prepare("SELECT id FROM idx_entities_fts WHERE idx_entities_fts MATCH 'registration'").all()).toEqual([
      { id: "page:web:/a" },
    ]);
    expect(ensureIndexSchema(s.db, FIXED_NOW).rebuildRequired).toBe(false);
    s.db
      .prepare("UPDATE settings SET value_json = ? WHERE key = 'index_schema_version'")
      .run(JSON.stringify(INDEX_SCHEMA_VERSION - 1));
    expect(ensureIndexSchema(s.db, FIXED_NOW).rebuildRequired).toBe(true);
    expect(s.db.prepare("SELECT count(*) AS n FROM idx_entities").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
  });

  it("names every index object idx_* so that dropping the index never touches state", () => {
    const sql = readFileSync(fileURLToPath(new URL("../migrations/index-schema.sql", import.meta.url)), "utf8");
    const names = [...sql.matchAll(/CREATE (?:VIRTUAL )?(?:TABLE|INDEX) (\w+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !n?.startsWith("idx_"))).toEqual([]);
  });
});

describe("single-writer host lock", () => {
  it("admits one host per home directory and releases on request", () => {
    const lock = acquireHostLock(dir, FIXED_NOW);
    expect(storageCode(() => acquireHostLock(dir, FIXED_NOW))).toBe("HOST_ALREADY_RUNNING");
    lock.release();
    acquireHostLock(dir, FIXED_NOW).release();
  });

  it("takes over a lock left by a process that no longer exists", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = await new Promise<number>((resolve) => child.on("exit", () => resolve(child.pid!)));
    const { hostname } = await import("node:os");
    writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: deadPid, hostname: hostname(), acquired_at: AT }));
    const lock = acquireHostLock(dir, FIXED_NOW);
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(process.pid);
    lock.release();
  });
});
