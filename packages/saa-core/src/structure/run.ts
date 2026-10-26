import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdapterError,
  AdapterProcess,
  analyzeBatch,
  type AdapterSpec,
  type InitializeResult,
} from "@sys2qa/saa-adapters";
import { writeFileAtomic } from "@sys2qa/platform";
import type { InventoryEntry } from "../intake/inventory.js";
import type { RootSandbox } from "../intake/sandbox.js";
import { redactOutput } from "../intake/secrets.js";
import type { ProjectBoundary } from "../stack/stack.js";
import type { Claim, ComponentTrace, Entity, Evidence, Gap } from "@sys2qa/contract";
import { linkConfig } from "./config.js";
import { assignStatuses, crossValidate, materialClaims } from "./crossvalidate.js";
import { linkDataModel } from "./datamodel.js";
import { linkFrameworks } from "./frameworks.js";
import { linkStructure, mergeFacts, type DependencyGraph, type StructuralFacts } from "./graph.js";
import { linkRules } from "./rules.js";
import { traceComponents } from "./trace.js";
import { composeWorkflows, type CatalogOptions, type WorkflowCatalog } from "./workflows.js";

export interface StructureOptions {
  sandbox: RootSandbox;
  included: ReadonlyArray<InventoryEntry>;
  boundaries: ReadonlyArray<ProjectBoundary>;
  adapters: ReadonlyArray<AdapterSpec>;
  /** Writable directory for the adapters (one subdirectory per adapter). */
  scratch: string;
  runId: string;
  batchSize?: number;
  budget?: { max_ms: number; max_output_bytes: number };
  /** Restarts allowed per adapter after a crash before its remaining batches are skipped. */
  maxRestarts?: number;
  signal?: AbortSignal;
  /** Workflow catalog budget and deepen requests (SAA-FR-046). */
  catalog?: CatalogOptions;
  /** The analyzed revision (commit), recorded on claims; without it no claims are made. */
  revision?: string;
  /**
   * Adapter result cache (class E, NFR-005): a batch whose adapter version, boundary, files and fingerprints and whose
   * root's file list are unchanged reuses the stored, already redacted result instead of being analyzed again.
   */
  cache?: { dir: string };
}

export interface StructureResult extends StructuralFacts {
  graph: DependencyGraph;
  /** What could not be established (dynamic routes, requests to endpoints no analyzed route defines). */
  gaps: Gap[];
  /** One trace per entry point (API endpoint, page, scheduled job) with where and why it stopped (SAA-FR-041). */
  component_traces: ComponentTrace[];
  /** Material claims at the analyzed revision (SAA-FR-010); empty without `revision`. */
  claims: Claim[];
  /** Entities and relationships downgraded to `inferred` because their evidence cannot verify them (CR-001). */
  downgraded: number;
  /** Workflows composed from the traces, ranked and grouped (SAA-FR-040, SAA-FR-046). */
  catalog: WorkflowCatalog;
  adapters: InitializeResult[];
  /** Batches that failed, by adapter and error code; their files are `failed` in `coverage`. */
  failed_batches: Array<{ adapter: string; code: string; files: number }>;
  /** Strings in adapter output that still contained a secret and were redacted by the host. */
  redacted_strings: number;
  /** Batches answered from the cache and batches analyzed (NFR-005: the hit rate is reported). */
  cache: { hits: number; misses: number };
}

/**
 * Runs the analyzer adapters over the included files (SAA-FR-005, SAA-FR-006): files are grouped by project boundary
 * (the boundary travels as `root_id`), batched, and sent only to an adapter that declares their language. Sensitive
 * files are never sent. Each result is redacted before it is kept; a failed batch becomes `failed` coverage and the
 * run continues, restarting a crashed adapter a bounded number of times. The merged facts are linked across batches.
 */
export async function analyzeStructure(options: StructureOptions): Promise<StructureResult> {
  const batchSize = options.batchSize ?? 200;
  const budget = options.budget ?? { max_ms: 120_000, max_output_bytes: 256 * 1024 * 1024 };
  const batches: StructuralFacts[] = [];
  const infos: InitializeResult[] = [];
  const failed: StructureResult["failed_batches"] = [];
  let redacted = 0;
  const cache = { hits: 0, misses: 0 };
  // The js-ts adapter resolves imports against the files that exist, so a cached result is valid only for the same tree.
  const treeDigest = new Map<number, string>();
  for (const entry of options.included) treeDigest.set(entry.root, "");
  for (const root of treeDigest.keys())
    treeDigest.set(
      root,
      createHash("sha256")
        .update(
          options.included
            .filter((e) => e.root === root && e.status === "included")
            .map((e) => e.path)
            .sort()
            .join("\0"),
        )
        .digest("hex"),
    );
  const ordered = [...options.boundaries].sort((a, b) => b.path.length - a.path.length);
  const ownerOf = (entry: InventoryEntry) =>
    ordered.find(
      (b) => b.root === entry.root && (b.path === "" || entry.path === b.path || entry.path.startsWith(`${b.path}/`)),
    );

  for (const spec of options.adapters) {
    let restarts = 0;
    const processes = new Map<number, AdapterProcess>();
    const start = async (root: number) => {
      const adapter = await AdapterProcess.start(spec, {
        root: options.sandbox.roots[root]!,
        scratch: `${options.scratch}/${spec.id}`,
      });
      processes.set(root, adapter);
      return adapter;
    };
    try {
      let info: InitializeResult;
      try {
        info = (await start(0)).info;
      } catch (error) {
        if (!(error instanceof AdapterError)) throw error;
        failed.push({ adapter: spec.id, code: error.code, files: 0 });
        continue;
      }
      infos.push(info);
      const languages = new Set(info.support_matrix.languages.map((l) => l.name));
      const groups = new Map<string, { root: number; boundary: string; files: InventoryEntry[] }>();
      for (const entry of options.included) {
        // Lockfiles are dependency metadata, not configuration or code; sensitive files never leave the host.
        if (entry.status !== "included" || entry.sensitive || entry.category === "lockfile") continue;
        if (!entry.language || !languages.has(entry.language)) continue;
        const boundary = ownerOf(entry)?.id ?? (entry.root === 0 ? "project:." : `project:root${entry.root}/.`);
        const key = `${entry.root}\0${boundary}`;
        const group = groups.get(key) ?? { root: entry.root, boundary, files: [] };
        group.files.push(entry);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        for (let i = 0; i < group.files.length; i += batchSize) {
          if (options.signal?.aborted) break;
          const slice = group.files.slice(i, i + batchSize);
          const files = [];
          for (const entry of slice) {
            const { digest } = await options.sandbox.sha256(await options.sandbox.resolve(entry.root, entry.path));
            files.push({ path: entry.path, sha256: `sha256:${digest}` });
          }
          let adapter = processes.get(group.root);
          if (!adapter || adapter.failure) {
            if (adapter?.failure) {
              if (restarts >= (options.maxRestarts ?? 2)) {
                batches.push(failedCoverage(spec.id, files, "ADAPTER_RESTART_LIMIT"));
                failed.push({ adapter: spec.id, code: "ADAPTER_RESTART_LIMIT", files: files.length });
                continue;
              }
              restarts++;
            }
            adapter = await start(group.root);
          }
          const cacheFile = options.cache
            ? join(
                options.cache.dir,
                `${createHash("sha256")
                  .update(
                    JSON.stringify([
                      info.adapter_id,
                      info.adapter_version,
                      info.protocol_version,
                      group.boundary,
                      treeDigest.get(group.root),
                      files,
                    ]),
                  )
                  .digest("hex")}.json`,
              )
            : undefined;
          const cached = cacheFile ? readCached(cacheFile) : undefined;
          if (cached) {
            cache.hits++;
            batches.push(cached);
            continue;
          }
          const outcome = await analyzeBatch(
            adapter,
            { run_id: options.runId, root_id: group.boundary, files, budget },
            options.signal ? { signal: options.signal } : {},
          );
          if (outcome.status === "completed") {
            const clean = redactOutput(outcome.result);
            redacted += clean.redacted;
            batches.push(clean.value);
            if (cacheFile) {
              cache.misses++;
              mkdirSync(options.cache!.dir, { recursive: true });
              writeFileAtomic(cacheFile, JSON.stringify(clean.value));
            }
          } else {
            batches.push({ entities: [], relationships: [], evidence: [], coverage: outcome.coverage });
            failed.push({ adapter: spec.id, code: outcome.error.code, files: files.length });
          }
        }
      }
    } finally {
      for (const adapter of processes.values()) await adapter.close().catch(() => adapter.kill());
    }
  }
  const facts = mergeFacts(batches);
  await addProjectEntities(facts, options);
  const linked = linkStructure(facts, options.boundaries);
  const frameworks = linkFrameworks(facts, options.boundaries);
  const data = linkDataModel(facts);
  const config = linkConfig(facts);
  const traces = traceComponents(facts, {
    entities: [...frameworks.entities, ...data.entities],
    relationships: frameworks.relationships,
  });
  const rules = linkRules(
    facts,
    {
      entities: [...frameworks.entities, ...data.entities, ...traces.entities],
      relationships: [...frameworks.relationships, ...traces.relationships],
    },
    traces.details,
  );
  const cross = crossValidate(facts, rules.entities);
  const entities = [
    ...facts.entities,
    ...frameworks.entities,
    ...data.entities,
    ...config.entities,
    ...traces.entities,
    ...rules.entities,
  ];
  // An import of a module that was not analyzed (excluded or generated) has no entity to point to; it is recorded in
  // graph.unanalyzed_targets instead of as a dangling relationship (CR-010).
  const known = new Set(entities.map((e) => e.id));
  const relationships = [
    ...facts.relationships.filter((r) => r.type !== "IMPORTS" || known.has(r.to)),
    ...linked.relationships,
    ...frameworks.relationships,
    ...data.relationships,
    ...config.relationships,
    ...traces.relationships,
    ...rules.relationships,
    ...cross.relationships,
  ];
  const gaps = [...frameworks.gaps, ...traces.gaps, ...rules.gaps, ...cross.gaps];
  const downgraded = assignStatuses([...entities, ...relationships], facts.evidence);
  const claims = options.revision ? materialClaims(entities, relationships, options.revision) : [];
  const catalog = composeWorkflows(
    { entities, relationships, component_traces: traces.component_traces, gaps, evidence: facts.evidence },
    options.catalog,
  );
  return {
    entities,
    relationships,
    evidence: facts.evidence,
    coverage: [...facts.coverage, ...frameworks.coverage, ...data.coverage, ...config.coverage],
    gaps,
    component_traces: traces.component_traces,
    claims,
    downgraded,
    catalog,
    graph: linked.graph,
    adapters: infos,
    failed_batches: failed,
    redacted_strings: redacted,
    cache,
  };
}

/**
 * One `project` entity per boundary (SAA-FR-002), cited by every `project_boundary`. Its evidence is its manifests,
 * recorded by the host as `manifest` evidence (digest only); a boundary without a readable manifest is `inferred`
 * from the directory layout and cites the evidence of the files it contains.
 */
async function addProjectEntities(facts: StructuralFacts, options: StructureOptions): Promise<void> {
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const boundary of options.boundaries) {
    const evidence: string[] = [];
    for (const manifest of boundary.manifests.slice(0, 5)) {
      try {
        const resolved = await options.sandbox.resolve(boundary.root, manifest);
        const read = await options.sandbox.readText(resolved, 1024 * 1024);
        if (read.kind !== "text") continue;
        const fingerprint = `sha256:${createHash("sha256").update(read.text).digest("hex")}`;
        const id = `evidence:${createHash("sha256").update(["manifest", manifest, fingerprint, "saa-core", "stack-detection"].join("\0")).digest("hex").slice(0, 16)}`;
        if (!facts.evidence.some((e) => e.id === id))
          facts.evidence.push({
            id,
            source_type: "manifest",
            captured_at: capturedAt,
            extractor: { adapter: "saa-core", version: "0.1.0", method: "stack-detection" },
            path: manifest,
            range: { start_line: 1, end_line: Math.max(1, read.text.split("\n").length) },
            file_fingerprint: fingerprint,
            excerpt_policy: "digest_only",
            excerpt_digest: fingerprint,
          } as Evidence);
        evidence.push(id);
      } catch {
        // An unreadable manifest leaves the boundary inferred.
      }
    }
    const fallback = facts.entities
      .filter((e) => e.project_boundary === boundary.id && e.evidence_ids.length > 0)
      .slice(0, 1)
      .flatMap((e) => e.evidence_ids.slice(0, 1));
    if (evidence.length === 0 && fallback.length === 0) continue;
    facts.entities.push({
      id: boundary.id,
      kind: "project",
      name: boundary.name,
      project_boundary: boundary.id,
      path: boundary.path,
      boundary_kind: boundary.kind,
      status: evidence.length > 0 ? "source_verified" : "inferred",
      ...(evidence.length > 0
        ? {}
        : { confidence_rationale: boundary.confidence_rationale ?? "boundary inferred from the directory layout" }),
      origin: "source",
      evidence_ids: evidence.length > 0 ? evidence : fallback,
    } as Entity);
  }
}

/** A cached batch result, or undefined when it is missing or unreadable (then the batch is analyzed again). */
function readCached(file: string): StructuralFacts | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StructuralFacts;
  } catch {
    return undefined;
  }
}

function failedCoverage(adapter: string, files: Array<{ path: string }>, code: string): StructuralFacts {
  return {
    entities: [],
    relationships: [],
    evidence: [],
    coverage: files.map((f) => ({ area: f.path, status: "failed", reason: `adapter ${adapter}: ${code}` })),
  };
}
