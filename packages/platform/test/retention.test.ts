import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIdGenerator,
  deleteProjectEverywhere,
  exportAudit,
  JobStore,
  MemorySecretBackend,
  openStateDatabase,
  pendingDeletions,
  projectDirectory,
  ProjectService,
  Redactor,
  runRetention,
  SecretService,
  SecretStoreError,
  verifyAuditChain,
  type StateDatabase,
} from "../src/index.js";

const DAY = 86_400_000;
let home: string;
let state: StateDatabase;
let projects: ProjectService;
let backend: MemorySecretBackend;
let secrets: SecretService;
let clock: number;
const now = () => new Date(clock);
const audit = () => ({ redactor: new Redactor(), now });

beforeEach(() => {
  clock = Date.parse("2026-10-25T10:00:00.000Z");
  home = mkdtempSync(join(tmpdir(), "sys2qa-retention-"));
  state = openStateDatabase({ path: join(home, "state.db"), now });
  projects = new ProjectService(state.db, { audit: audit(), newId: createIdGenerator(now) });
  backend = new MemorySecretBackend();
  secrets = new SecretService(state.db, backend, audit());
});
afterEach(() => {
  state.close();
  rmSync(home, { recursive: true, force: true });
});

/** A project with something in every place deletion must clean (Data Model §8). */
async function populatedProject(name: string) {
  const project = projects.createProject({ name, actor: "owner" });
  const source = projects.addEvidenceSource(project.id, "source_root", join(home, "repo"));
  projects.declare(source.id, { declaredBy: "owner", operationLevel: "L1" });
  const env = projects.addEvidenceSource(project.id, "environment", "https://staging.acme.example/");
  projects.declare(env.id, { declaredBy: "owner", operationLevel: "L2" });
  projects.configureEnvironment(
    env.id,
    { baseUrl: "https://staging.acme.example/", classification: "staging", allowedHosts: ["staging.acme.example"] },
    "owner",
  );
  await secrets.put(project.id, "staging-login", `value-of-${name}`, "owner");
  new JobStore(state.db, { now, newId: createIdGenerator(now) }).enqueue({
    type: "saa.analyze",
    projectId: project.id,
    payload: { root: join(home, "repo") },
  });
  const runId = `run:${project.id.slice(8)}`;
  state.db
    .prepare(
      "INSERT INTO analysis_runs (id, project_id, producer, status, created_at, updated_at) VALUES (?, ?, 'SAA', 'completed', 'x', 'x')",
    )
    .run(runId, project.id);
  state.db
    .prepare(
      "INSERT INTO idx_entities (id, run_id, kind, name, status, origin) VALUES ('page:web:/a', ?, 'page', 'A', 'source_verified', 'source')",
    )
    .run(runId);
  const dir = projectDirectory(home, project.id);
  mkdirSync(join(dir, "skb", runId), { recursive: true });
  writeFileSync(join(dir, "skb", runId, "manifest.json"), "{}");
  return { project, dir, runId };
}

function rowsMentioning(text: string): string[] {
  const tables = (
    state.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'idx_entities_fts_%'",
      )
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
  return tables.flatMap((table) => {
    const rows = state.db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
    return rows.filter((r) => JSON.stringify(r).includes(text)).map(() => table);
  });
}

describe("project deletion [@req SEC-015] [@req QAA-FR-001]", () => {
  it("removes state, files, index rows and credential values, and leaves a verifiable audit trail", async () => {
    const keep = await populatedProject("Keep");
    const gone = await populatedProject("Gone");
    const report = await deleteProjectEverywhere({
      db: state.db,
      home,
      projects,
      secrets: async () => secrets,
      projectId: gone.project.id,
      actor: "owner",
    });
    expect(report).toEqual({
      project_id: gone.project.id,
      secrets_removed: 1,
      directory_removed: true,
      index_rows_removed: 1,
    });
    const ulid = gone.project.id.slice("project:".length);
    // Only the tombstone and the installation-wide deletion event may still name the project.
    expect([...new Set(rowsMentioning(ulid))].sort()).toEqual(["audit_events", "project_deletions"]);
    expect(exportAudit(state.db, { projectId: gone.project.id })).toEqual([]);
    expect(exportAudit(state.db, { projectId: null }).at(-1)).toMatchObject({
      action: "project.deleted",
      target: gone.project.id,
    });
    expect(existsSync(gone.dir)).toBe(false);
    expect([...backend.values.values()]).toEqual(["value-of-Keep"]);
    expect(projects.getProject(keep.project.id).name).toBe("Keep");
    expect(existsSync(keep.dir)).toBe(true);
    expect(verifyAuditChain(state.db).ok).toBe(true);
  });

  it("can be resumed after an interruption, e.g. a locked secret store", async () => {
    const { project, dir } = await populatedProject("Interrupted");
    const locked = async (): Promise<SecretService> => {
      throw new SecretStoreError("SECRET_STORE_LOCKED", "locked", "unlock it");
    };
    await expect(
      deleteProjectEverywhere({ db: state.db, home, projects, secrets: locked, projectId: project.id, actor: "owner" }),
    ).rejects.toThrow(/locked/);
    expect(pendingDeletions(state.db)).toEqual([project.id]);
    expect(existsSync(dir)).toBe(true);
    await deleteProjectEverywhere({
      db: state.db,
      home,
      projects,
      secrets: async () => secrets,
      projectId: project.id,
      actor: "owner",
    });
    expect(pendingDeletions(state.db)).toEqual([]);
    expect(backend.values.size).toBe(0);
  });

  it("refuses project IDs that could escape the projects directory", () => {
    expect(() => projectDirectory(home, "project:../../etc")).toThrow(/unexpected project ID/);
  });
});

describe("retention (ST-18) [@req SEC-015]", () => {
  const policy = { blob_days: 30, log_days: 14, cache_max_bytes: 1000 };
  const age = (path: string, days: number) => {
    const t = (clock - days * DAY) / 1000;
    utimesSync(path, t, t);
  };

  it("removes expired blobs, logs and cache overflow, and keeps referenced blobs and audit events", async () => {
    const { project, dir } = await populatedProject("Acme");
    const blob = (sha: string, days: number) => {
      const path = join(dir, "blobs", sha.slice(0, 2), sha);
      mkdirSync(join(dir, "blobs", sha.slice(0, 2)), { recursive: true });
      writeFileSync(path, "png");
      age(path, days);
      return path;
    };
    const old = blob("a".repeat(64), 45);
    const fresh = blob("b".repeat(64), 5);
    const byDefect = blob("c".repeat(64), 45);
    const pinned = blob("d".repeat(64), 45);
    state.db
      .prepare(
        "INSERT INTO defects (id, project_id, state, severity, priority, links_json, created_at, updated_at) VALUES ('defect:1', ?, 'new', 'major', 'high', ?, 'x', 'x')",
      )
      .run(project.id, JSON.stringify({ evidence_refs: [`sha256:${"c".repeat(64)}`] }));
    state.db
      .prepare(
        "INSERT INTO blob_pins (project_id, sha256, reason, created_at, updated_at) VALUES (?, ?, 'export', 'x', 'x')",
      )
      .run(project.id, "d".repeat(64));

    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", "sys2qa-2026-09-01.log"), "old\n");
    writeFileSync(join(home, "logs", "sys2qa-2026-10-24.log"), "recent\n");

    mkdirSync(join(dir, "cache"), { recursive: true });
    for (const [name, days] of [
      ["oldest", 3],
      ["middle", 2],
      ["newest", 1],
    ] as const) {
      writeFileSync(join(dir, "cache", name), "x".repeat(400));
      age(join(dir, "cache", name), days);
    }
    const auditBefore = exportAudit(state.db).length;

    const report = runRetention({ db: state.db, home, now, policy, audit: audit() });
    expect(report).toEqual({
      logs_removed: 1,
      blobs_removed: 1,
      blobs_kept_referenced: 2,
      cache_files_removed: 1,
      cache_bytes_freed: 400,
    });
    expect([old, fresh, byDefect, pinned].map(existsSync)).toEqual([false, true, true, true]);
    expect(readdirSync(join(home, "logs"))).toEqual(["sys2qa-2026-10-24.log"]);
    expect(readdirSync(join(dir, "cache")).sort()).toEqual(["middle", "newest"]);
    const after = exportAudit(state.db);
    expect(after.length).toBe(auditBefore + 1);
    expect(after.at(-1)).toMatchObject({ action: "data.deleted", details: { blobs_removed: 1 } });
    expect(runRetention({ db: state.db, home, now, policy, audit: audit() })).toEqual({
      logs_removed: 0,
      blobs_removed: 0,
      blobs_kept_referenced: 2,
      cache_files_removed: 0,
      cache_bytes_freed: 0,
    });
  });
});
