import {
  AdapterError,
  AdapterProcess,
  analyzeBatch,
  type AdapterSpec,
  type InitializeResult,
} from "@sys2qa/saa-adapters";
import type { InventoryEntry } from "../intake/inventory.js";
import type { RootSandbox } from "../intake/sandbox.js";
import { redactOutput } from "../intake/secrets.js";
import type { ProjectBoundary } from "../stack/stack.js";
import type { Gap } from "@sys2qa/contract";
import { linkDataModel } from "./datamodel.js";
import { linkFrameworks } from "./frameworks.js";
import { linkStructure, mergeFacts, type DependencyGraph, type StructuralFacts } from "./graph.js";

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
}

export interface StructureResult extends StructuralFacts {
  graph: DependencyGraph;
  /** What could not be established (dynamic routes, requests to endpoints no analyzed route defines). */
  gaps: Gap[];
  adapters: InitializeResult[];
  /** Batches that failed, by adapter and error code; their files are `failed` in `coverage`. */
  failed_batches: Array<{ adapter: string; code: string; files: number }>;
  /** Strings in adapter output that still contained a secret and were redacted by the host. */
  redacted_strings: number;
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
        if (entry.status !== "included" || entry.sensitive || !entry.language || !languages.has(entry.language))
          continue;
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
          const outcome = await analyzeBatch(
            adapter,
            { run_id: options.runId, root_id: group.boundary, files, budget },
            options.signal ? { signal: options.signal } : {},
          );
          if (outcome.status === "completed") {
            const clean = redactOutput(outcome.result);
            redacted += clean.redacted;
            batches.push(clean.value);
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
  const linked = linkStructure(facts, options.boundaries);
  const frameworks = linkFrameworks(facts, options.boundaries);
  const data = linkDataModel(facts);
  return {
    entities: [...facts.entities, ...frameworks.entities, ...data.entities],
    relationships: [
      ...facts.relationships,
      ...linked.relationships,
      ...frameworks.relationships,
      ...data.relationships,
    ],
    evidence: facts.evidence,
    coverage: [...facts.coverage, ...frameworks.coverage, ...data.coverage],
    gaps: frameworks.gaps,
    graph: linked.graph,
    adapters: infos,
    failed_batches: failed,
    redacted_strings: redacted,
  };
}

function failedCoverage(adapter: string, files: Array<{ path: string }>, code: string): StructuralFacts {
  return {
    entities: [],
    relationships: [],
    evidence: [],
    coverage: files.map((f) => ({ area: f.path, status: "failed", reason: `adapter ${adapter}: ${code}` })),
  };
}
