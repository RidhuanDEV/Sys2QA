import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import {
  analyzeStructure,
  budgetFor,
  completenessReport,
  detectStack,
  RootSandbox,
  scanInventory,
  type InventoryEntry,
} from "../../../packages/saa-core/src/index.js";
import type { ProducerOutput } from "./producer-output.js";

const ADAPTERS = ["js-ts", "sql", "config", "docs"] as const;
/** Benchmarks compare models of one fixture with each other, so both documents carry the same placeholder revision. */
const REVISION = { kind: "git_commit", value: "0".repeat(40), worktree_dirty: false };

/** Bundles the analyzer adapters into `dir` once per harness run (adapters always run as bundles). */
export async function bundleSaaAdapters(dir: string): Promise<Array<{ id: string; entry: string }>> {
  mkdirSync(dir, { recursive: true });
  const specs: Array<{ id: string; entry: string }> = [];
  for (const id of ADAPTERS)
    specs.push({
      id,
      entry: await bundleAdapter({
        entry: fileURLToPath(new URL(`../../../packages/saa-adapters/src/adapters/${id}/main.ts`, import.meta.url)),
        outfile: join(dir, `${id}.mjs`),
      }),
    });
  return specs;
}

/**
 * The SAA producer as far as Gate 1 has built it (IMP-114): inventory, stack, structural analysis, traces, the
 * workflow catalog, rules, cross-validation, material claims and the completeness report of a repository fixture.
 */
export async function saaProducer(
  repository: string,
  work: { adapters: Array<{ id: string; entry: string }>; scratch: string },
): Promise<ProducerOutput> {
  const sandbox = await RootSandbox.open([repository]);
  const inventory: InventoryEntry[] = [];
  await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
    inventory.push(e);
  });
  const included = inventory.filter((e) => e.status === "included");
  const stack = await detectStack(sandbox, included);
  const result = await analyzeStructure({
    sandbox,
    included,
    boundaries: stack.boundaries,
    adapters: work.adapters,
    scratch: work.scratch,
    runId: "run:01BENCHMARKSAA",
    revision: REVISION.value,
  });
  const completeness = completenessReport({
    runId: "run:01BENCHMARKSAA",
    roots: ["repo"],
    inventory,
    boundaries: stack.boundaries,
    structure: result,
  });
  return {
    systemModel: {
      revision: REVISION,
      entities: result.entities.map((e) => ({ id: e.id, kind: e.kind, status: e.status })),
      relationships: result.relationships.map((r) => ({
        id: r.id,
        type: r.type,
        from: r.from,
        to: r.to,
        status: r.status,
        evidence_ids: r.evidence_ids ?? [],
      })),
      workflows: result.catalog.workflows.map((w) => ({
        id: w.id,
        category: w.category,
        discovery_status: w.discovery_status,
        entry_point_ids: w.entry_point_ids,
        steps: w.steps,
        branches: w.branches,
        unresolved_hops: w.unresolved_hops,
      })),
      claims: result.claims,
      gaps: result.gaps,
      coverage: result.coverage,
    },
    evidenceIndex: { revision: REVISION, evidence: result.evidence },
    completeness,
  };
}
