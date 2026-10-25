import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { validateJsonSchema } from "@sys2qa/contract";
import { listSkbRuns, readSkbRecords, SkbIntegrityError, type SkbCollection, type SkbManifest } from "./store.js";

const SM = "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/";
const SCHEMA: Record<SkbCollection, { $ref: string }> = {
  entities: { $ref: `${SM}entity` },
  relationships: { $ref: `${SM}relationship` },
  claims: { $ref: `${SM}claim` },
  workflows: { $ref: `${SM}workflow` },
  component_traces: { $ref: `${SM}component_trace` },
  evidence: { $ref: "https://sys2qa.dev/schemas/evidence-index/1.0.json#/$defs/evidence" },
};
const TABLES = ["idx_entities", "idx_entities_fts", "idx_edges", "idx_workflows", "idx_claims", "idx_evidence"];

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(textOf).join(" ")
      : value && typeof value === "object" && "value" in value
        ? String((value as { value: unknown }).value)
        : "";

/**
 * Indexes one complete SKB run (Data Model §5, IMP-115): every record is checked against its contract schema and
 * inserted in one transaction, replacing the run's earlier rows; the inserted counts must equal the manifest's. A
 * record that fails its schema or a count that differs aborts the transaction, so a bad run is never half indexed.
 */
export function indexSkbRun(db: Database, dir: string, manifest: SkbManifest): Record<SkbCollection, number> {
  const run = manifest.run_id;
  const insert = {
    entity: db.prepare(
      "INSERT INTO idx_entities (id, run_id, kind, name, boundary, status, origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    fts: db.prepare("INSERT INTO idx_entities_fts (id, run_id, name, description) VALUES (?, ?, ?, ?)"),
    edge: db.prepare("INSERT INTO idx_edges (from_id, to_id, type, status, run_id) VALUES (?, ?, ?, ?, ?)"),
    workflow: db.prepare(
      "INSERT INTO idx_workflows (id, run_id, category, discovery_status, completion, rank) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    claim: db.prepare("INSERT INTO idx_claims (id, subject_id, status, run_id) VALUES (?, ?, ?, ?)"),
    evidence: db.prepare("INSERT INTO idx_evidence (id, source_type, path_or_url, run_id) VALUES (?, ?, ?, ?)"),
  };
  const counts = Object.fromEntries(Object.keys(SCHEMA).map((k) => [k, 0])) as Record<SkbCollection, number>;
  db.transaction(() => {
    removeRunFromIndex(db, run);
    for (const { collection, record } of readSkbRecords(dir, manifest)) {
      const errors = validateJsonSchema(SCHEMA[collection], record).errors;
      if (errors.length > 0) throw new SkbIntegrityError(`${collection} ${record.id}: ${errors[0]!}`);
      counts[collection]++;
      const r = record as Record<string, unknown>;
      if (collection === "entities") {
        insert.entity.run(r.id, run, r.kind, r.name ?? null, r.project_boundary ?? null, r.status, r.origin);
        insert.fts.run(r.id, run, r.name ?? "", [textOf(r.description), textOf(r.statement)].join(" ").trim());
      } else if (collection === "relationships") insert.edge.run(r.from, r.to, r.type, r.status, run);
      else if (collection === "workflows")
        insert.workflow.run(r.id, run, r.category, r.discovery_status, r.completion, r.rank ?? null);
      else if (collection === "claims") insert.claim.run(r.id, r.subject_entity_id ?? null, r.status, run);
      else if (collection === "evidence") insert.evidence.run(r.id, r.source_type, r.path ?? r.url ?? null, run);
    }
    for (const collection of Object.keys(SCHEMA) as SkbCollection[])
      if (counts[collection] !== (manifest.counts[collection] ?? 0))
        throw new SkbIntegrityError(
          `${collection}: indexed ${counts[collection]}, manifest lists ${manifest.counts[collection]}`,
        );
  }).immediate();
  return counts;
}

export function removeRunFromIndex(db: Database, runId: string): void {
  for (const table of TABLES) db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
}

/**
 * Rebuilds the whole index from the artifacts (Data Model §5 rebuild procedure, `sys2qa index rebuild`): clears every
 * index table, then indexes every complete run under `<home>/projects/<project>/skb/` and `observed/`. A run that fails
 * its checks is skipped and reported; the others are still indexed.
 */
export function rebuildIndex(
  db: Database,
  home: string,
): { runs: number; failed: Array<{ run_id: string; reason: string }> } {
  db.transaction(() => {
    for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
  }).immediate();
  const projects = join(home, "projects");
  const failed: Array<{ run_id: string; reason: string }> = [];
  let runs = 0;
  for (const project of existsSync(projects) ? readdirSync(projects) : [])
    for (const area of ["skb", "observed"])
      for (const { dir, manifest } of listSkbRuns(join(projects, project, area)))
        try {
          indexSkbRun(db, dir, manifest);
          runs++;
        } catch (error) {
          failed.push({ run_id: manifest.run_id, reason: (error as Error).message });
        }
  return { runs, failed };
}

export interface EntityQuery {
  run_id: string;
  kind?: string;
  /** Full-text search over names and descriptions. */
  text?: string;
  limit?: number;
}

/** Entities of a run, by kind or full text, in ID order. */
export function queryEntities(
  db: Database,
  q: EntityQuery,
): Array<{ id: string; kind: string; name: string | null; status: string }> {
  const limit = Math.min(q.limit ?? 100, 1000);
  if (q.text !== undefined) {
    // Quoted terms: user text never becomes FTS syntax.
    const match = q.text
      .split(/\s+/)
      .filter((t) => t !== "")
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" ");
    if (match === "") return [];
    return db
      .prepare(
        `SELECT e.id, e.kind, e.name, e.status FROM idx_entities_fts f JOIN idx_entities e ON e.id = f.id AND e.run_id = f.run_id
         WHERE f.run_id = ? AND idx_entities_fts MATCH ? ${q.kind ? "AND e.kind = ?" : ""} ORDER BY e.id LIMIT ?`,
      )
      .all(...[q.run_id, match, ...(q.kind ? [q.kind] : []), limit]) as never;
  }
  return db
    .prepare(
      `SELECT id, kind, name, status FROM idx_entities WHERE run_id = ? ${q.kind ? "AND kind = ?" : ""} ORDER BY id LIMIT ?`,
    )
    .all(...[q.run_id, ...(q.kind ? [q.kind] : []), limit]) as never;
}

/** Edges from or to an entity, in a stable order. */
export function queryEdges(
  db: Database,
  runId: string,
  entityId: string,
  direction: "out" | "in" = "out",
): Array<{ from_id: string; to_id: string; type: string; status: string }> {
  return db
    .prepare(
      `SELECT from_id, to_id, type, status FROM idx_edges WHERE run_id = ? AND ${direction === "out" ? "from_id" : "to_id"} = ?
       ORDER BY type, from_id, to_id`,
    )
    .all(runId, entityId) as never;
}

/** The workflow catalog of a run in rank order. */
export function queryWorkflows(
  db: Database,
  runId: string,
): Array<{ id: string; category: string; discovery_status: string; completion: string; rank: number | null }> {
  return db
    .prepare(
      "SELECT id, category, discovery_status, completion, rank FROM idx_workflows WHERE run_id = ? ORDER BY rank, id",
    )
    .all(runId) as never;
}
