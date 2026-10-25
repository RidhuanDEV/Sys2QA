import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CONTRACT_VERSION } from "@sys2qa/contract";
import { canonicalJson } from "../canonical-json.js";
import { writeFileAtomic } from "./atomic.js";

/** The record collections of an SKB run (Data Model §2). Entities are grouped by kind. */
export const SKB_COLLECTIONS = [
  "entities",
  "relationships",
  "claims",
  "evidence",
  "workflows",
  "component_traces",
] as const;
export type SkbCollection = (typeof SKB_COLLECTIONS)[number];

/** One analysis run as stored: record collections plus the run-level documents. */
export interface SkbRun {
  run_id: string;
  producer: "SAA" | "QAA";
  revision: unknown;
  records: Record<SkbCollection, ReadonlyArray<{ id: string; kind?: string }>>;
  /** Run-level documents stored whole: `coverage.json`, `completeness.json`, `gaps.json`, and any other. */
  documents: Record<string, unknown>;
}

export interface SkbManifest {
  schema_version: string;
  run_id: string;
  producer: string;
  revision: unknown;
  created_at: string;
  counts: Record<SkbCollection, number>;
  files: Array<{ path: string; collection: SkbCollection | "document"; records?: number; sha256: string }>;
}

export interface ShardLimits {
  maxRecords: number;
  maxBytes: number;
}

/** Data Model §2: ≤ 5,000 records or ≤ 8 MB per shard. */
export const DEFAULT_SHARD_LIMITS: ShardLimits = { maxRecords: 5000, maxBytes: 8 * 1024 * 1024 };

const sha256 = (data: string) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const slot = (id: string, shards: number) =>
  parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % shards;

/**
 * Splits records into shards by a hash of the ID: the fewest shards that keep every shard within the limits. Records
 * are sorted by ID inside a shard, so the same records always give the same files.
 */
export function shardRecords<T extends { id: string }>(
  records: readonly T[],
  limits: ShardLimits = DEFAULT_SHARD_LIMITS,
): T[][] {
  let shards = Math.max(1, Math.ceil(records.length / limits.maxRecords));
  for (;;) {
    const groups: T[][] = Array.from({ length: shards }, () => []);
    for (const r of records) groups[slot(r.id, shards)]!.push(r);
    for (const g of groups) g.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const fits = groups.every(
      (g) => g.length <= limits.maxRecords && Buffer.byteLength(JSON.stringify(g)) <= limits.maxBytes,
    );
    if (fits || shards >= records.length) return groups.filter((g) => g.length > 0 || shards === 1);
    shards *= 2;
  }
}

/**
 * Writes a run to `dir` (normally `<home>/projects/<project>/skb/<run>/`, IMP-115, SAA-FR-012). Every file is written
 * atomically, and `manifest.json` last, listing each file with its record count and SHA-256: a directory without a
 * manifest is an incomplete write that readers ignore and the recovery sweep removes. The caller redacts the content
 * first (ST-04). Files are canonical JSON, so an unchanged run writes identical bytes.
 */
export function writeSkbRun(
  dir: string,
  run: SkbRun,
  now: () => Date = () => new Date(),
  limits = DEFAULT_SHARD_LIMITS,
): SkbManifest {
  if (existsSync(join(dir, "manifest.json"))) throw new Error(`SKB run ${run.run_id} already exists`);
  mkdirSync(dir, { recursive: true });
  const files: SkbManifest["files"] = [];
  const counts = {} as Record<SkbCollection, number>;
  const write = (
    path: string,
    body: unknown,
    collection: SkbManifest["files"][number]["collection"],
    records?: number,
  ) => {
    const text = `${canonicalJson(body)}\n`;
    const full = join(dir, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileAtomic(full, text);
    files.push({ path, collection, ...(records !== undefined ? { records } : {}), sha256: sha256(text) });
  };
  for (const collection of SKB_COLLECTIONS) {
    const records = run.records[collection] ?? [];
    counts[collection] = records.length;
    // A kind names a directory: only contract-shaped kinds, so no record can write outside the run.
    for (const r of collection === "entities" ? records : [])
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(r.kind ?? "unknown")) throw new Error(`invalid entity kind for ${r.id}`);
    // Entities are partitioned by kind first (entities/<kind>/<shard>.json).
    const groups =
      collection === "entities"
        ? [...new Set(records.map((r) => r.kind ?? "unknown"))].sort().map((kind) => ({
            prefix: `entities/${kind}`,
            records: records.filter((r) => (r.kind ?? "unknown") === kind),
          }))
        : [{ prefix: collection, records }];
    for (const group of groups)
      shardRecords(group.records, limits).forEach((shard, i) => {
        if (shard.length === 0 && records.length > 0) return;
        write(
          `${group.prefix}/${String(i).padStart(3, "0")}.json`,
          { run_id: run.run_id, records: shard },
          collection,
          shard.length,
        );
      });
  }
  for (const [name, body] of Object.entries(run.documents).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`invalid SKB document name ${name}`);
    write(`${name}.json`, body, "document");
  }
  const manifest: SkbManifest = {
    schema_version: CONTRACT_VERSION,
    run_id: run.run_id,
    producer: run.producer,
    revision: run.revision,
    created_at: now().toISOString(),
    counts,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileAtomic(join(dir, "manifest.json"), `${canonicalJson(manifest)}\n`);
  return manifest;
}

export class SkbIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkbIntegrityError";
  }
}

/** The manifest of a complete run, or undefined for a directory without one (an incomplete write). */
export function readSkbManifest(dir: string): SkbManifest | undefined {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as SkbManifest;
}

/**
 * Streams the records of a complete run, shard by shard, checking each file against the manifest: a missing or changed
 * file, or a record count that differs, is an `SkbIntegrityError`.
 */
export function* readSkbRecords(
  dir: string,
  manifest: SkbManifest,
): Generator<{ collection: SkbCollection; record: { id: string; [key: string]: unknown } }> {
  for (const file of manifest.files.filter((f) => f.collection !== "document")) {
    const records = readVerified(dir, file).records as Array<{ id: string }>;
    if (records.length !== file.records)
      throw new SkbIntegrityError(`${file.path}: record count differs from the manifest`);
    for (const record of records) yield { collection: file.collection as SkbCollection, record };
  }
}

/** A run-level document (`coverage`, `completeness`, `gaps`, …), checked against the manifest. */
export function readSkbDocument(dir: string, manifest: SkbManifest, name: string): unknown {
  const file = manifest.files.find((f) => f.collection === "document" && f.path === `${name}.json`);
  return file ? readVerified(dir, file) : undefined;
}

function readVerified(
  dir: string,
  file: SkbManifest["files"][number],
): { records: unknown[] } & Record<string, unknown> {
  const path = join(dir, ...file.path.split("/"));
  if (relative(dir, path).split(sep).includes(".."))
    throw new SkbIntegrityError(`${file.path}: outside the run directory`);
  if (!existsSync(path)) throw new SkbIntegrityError(`${file.path}: missing`);
  const text = readFileSync(path, "utf8");
  if (sha256(text) !== file.sha256) throw new SkbIntegrityError(`${file.path}: content differs from the manifest`);
  return JSON.parse(text) as { records: unknown[] };
}

/** Complete runs under `<project>/skb/`, oldest first by manifest time. */
export function listSkbRuns(skbDir: string): Array<{ dir: string; manifest: SkbManifest }> {
  if (!existsSync(skbDir)) return [];
  return readdirSync(skbDir)
    .map((name) => join(skbDir, name))
    .filter((dir) => statSync(dir).isDirectory())
    .flatMap((dir) => {
      const manifest = readSkbManifest(dir);
      return manifest ? [{ dir, manifest }] : [];
    })
    .sort((a, b) => a.manifest.created_at.localeCompare(b.manifest.created_at) || a.dir.localeCompare(b.dir));
}

/**
 * Recovery (Data Model §9 step 4) and retention (§8) for one project's `skb/`: removes run directories without a
 * manifest and `*.tmp-*` files, and keeps the newest `keep` complete runs plus those in `protect` (runs a package
 * references). Returns the removed run directory names.
 */
export function sweepSkbRuns(skbDir: string, options: { keep?: number; protect?: ReadonlySet<string> } = {}): string[] {
  if (!existsSync(skbDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(skbDir)) {
    const dir = join(skbDir, name);
    if (/\.tmp-[0-9a-f]+$/.test(name)) rmSync(dir, { recursive: true, force: true });
    else if (statSync(dir).isDirectory() && !existsSync(join(dir, "manifest.json"))) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } else if (statSync(dir).isDirectory()) removeTempFiles(dir);
  }
  const keep = options.keep ?? 5;
  const runs = listSkbRuns(skbDir);
  for (const run of runs.slice(0, Math.max(0, runs.length - keep)))
    if (!options.protect?.has(run.manifest.run_id)) {
      rmSync(run.dir, { recursive: true, force: true });
      removed.push(relative(skbDir, run.dir));
    }
  return removed;
}

function removeTempFiles(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) removeTempFiles(path);
    else if (/\.tmp-[0-9a-f]+$/.test(name)) rmSync(path, { force: true });
  }
}
