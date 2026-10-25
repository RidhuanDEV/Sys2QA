import { createHash } from "node:crypto";
import type { CoverageItem, Entity, Evidence, Relationship } from "@sys2qa/contract";
import type { ProjectBoundary } from "../stack/stack.js";

/** Facts from every adapter batch of a run, without duplicates. */
export interface StructuralFacts {
  entities: Entity[];
  relationships: Relationship[];
  evidence: Evidence[];
  coverage: CoverageItem[];
}

export interface DependencyGraph {
  /** Module IDs inside the analyzed boundaries. */
  modules: string[];
  /** Import edges between those modules. */
  edges: Array<{ from: string; to: string }>;
  /** Strongly connected groups of two or more modules (or one importing itself), each sorted; recorded, never followed. */
  cycles: string[][];
  /** Boundary-level dependencies through workspace package imports. */
  projects: Array<{ from: string; to: string; packages: string[] }>;
  /** Imports whose target module was not analyzed (excluded, generated or outside the batch scope). */
  unanalyzed_targets: Array<{ from: string; to: string }>;
}

interface ImportRecord {
  specifier: string;
  target?: string;
  names: string[];
  type_only: boolean;
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** Merges adapter batch results; the first occurrence of an ID wins, coverage keeps every record. */
export function mergeFacts(batches: ReadonlyArray<StructuralFacts>): StructuralFacts {
  const out: StructuralFacts = { entities: [], relationships: [], evidence: [], coverage: [] };
  const seen = { entities: new Set<string>(), relationships: new Set<string>(), evidence: new Set<string>() };
  for (const batch of batches) {
    for (const key of ["entities", "relationships", "evidence"] as const)
      for (const item of batch[key] as Array<{ id: string }>) {
        if (seen[key].has(item.id)) continue;
        seen[key].add(item.id);
        (out[key] as Array<{ id: string }>).push(item);
      }
    out.coverage.push(...batch.coverage);
  }
  return out;
}

/**
 * Links what single batches cannot (SAA-FR-005, SAA-FR-006): `REFERENCES` from a module to the symbols it imports by
 * name, `DEPENDS_ON` between boundaries whose packages import each other, the module dependency graph with its cycles
 * (found with Tarjan's algorithm, so a cycle is reported once and never walked again), and imports of modules that
 * were not analyzed. Every derived relationship cites the evidence of the import that supports it.
 */
export function linkStructure(
  facts: StructuralFacts,
  boundaries: ReadonlyArray<ProjectBoundary>,
): { relationships: Relationship[]; graph: DependencyGraph } {
  const modules = facts.entities.filter((e) => e.kind === "module" && !(e as { external?: boolean }).external);
  const moduleIds = new Set(modules.map((m) => m.id));
  const exportsOf = new Map<string, Map<string, string>>();
  for (const symbol of facts.entities) {
    const moduleId = (symbol as { module_id?: string }).module_id;
    const names = (symbol as { export_names?: string[] }).export_names ?? [];
    if (!moduleId || names.length === 0) continue;
    const map = exportsOf.get(moduleId) ?? new Map<string, string>();
    for (const name of names) map.set(name, symbol.id);
    exportsOf.set(moduleId, map);
  }
  const importEvidence = new Map<string, string[]>();
  for (const r of facts.relationships)
    if (r.type === "IMPORTS") importEvidence.set(`${r.from}\0${r.to}`, r.evidence_ids);
  const boundaryByPackage = new Map(boundaries.filter((b) => b.ecosystems.includes("npm")).map((b) => [b.name, b.id]));

  const derived: Relationship[] = [];
  const edges: DependencyGraph["edges"] = [];
  const unanalyzed: DependencyGraph["unanalyzed_targets"] = [];
  const projectEdges = new Map<string, Set<string>>();
  const projectEvidence = new Map<string, string[]>();
  for (const module of modules) {
    for (const record of ((module as { imports?: ImportRecord[] }).imports ?? []).filter((i) => i.target)) {
      const target = record.target!;
      const evidence = importEvidence.get(`${module.id}\0${target}`) ?? module.evidence_ids;
      if (target.startsWith("module:pkg:")) {
        const pkg = target.slice("module:pkg:".length);
        const to = boundaryByPackage.get(pkg);
        const from = (module as { project_boundary?: string }).project_boundary;
        if (to && from && to !== from) {
          const key = `${from}\0${to}`;
          projectEdges.set(key, (projectEdges.get(key) ?? new Set()).add(pkg));
          projectEvidence.set(key, [...new Set([...(projectEvidence.get(key) ?? []), ...evidence])]);
        }
        continue;
      }
      if (target.startsWith("module:node:")) continue;
      if (!moduleIds.has(target)) {
        unanalyzed.push({ from: module.id, to: target });
        continue;
      }
      edges.push({ from: module.id, to: target });
      const symbols = exportsOf.get(target);
      for (const name of record.names) {
        const symbol = symbols?.get(name);
        if (symbol)
          derived.push({
            id: `relationship:${hash16("REFERENCES", module.id, symbol)}`,
            type: "REFERENCES",
            from: module.id,
            to: symbol,
            status: "source_verified",
            evidence_ids: evidence,
          });
      }
    }
  }
  for (const key of projectEdges.keys()) {
    const [from, to] = key.split("\0") as [string, string];
    derived.push({
      id: `relationship:${hash16("DEPENDS_ON", from, to)}`,
      type: "DEPENDS_ON",
      from,
      to,
      status: "source_verified",
      evidence_ids: projectEvidence.get(key)!,
    });
  }
  const unique = new Map(derived.map((r) => [r.id, r]));
  const dedupedEdges = [...new Map(edges.map((e) => [`${e.from}\0${e.to}`, e])).values()];
  return {
    relationships: [...unique.values()],
    graph: {
      modules: [...moduleIds].sort(),
      edges: dedupedEdges.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1)),
      cycles: findCycles([...moduleIds], dedupedEdges),
      projects: [...projectEdges]
        .map(([key, packages]) => {
          const [from, to] = key.split("\0") as [string, string];
          return { from, to, packages: [...packages].sort() };
        })
        .sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1)),
      unanalyzed_targets: unanalyzed,
    },
  };
}

/** Tarjan's strongly connected components, iterative so that deep import chains cannot overflow the stack. */
export function findCycles(nodes: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;
  for (const start of [...nodes].sort()) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const successors = next.get(frame.node) ?? [];
      if (frame.i < successors.length) {
        const to = successors[frame.i++]!;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter++);
          stack.push(to);
          onStack.add(to);
          work.push({ node: to, i: 0 });
        } else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const group: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          group.push(member);
        } while (member !== frame.node);
        const selfLoop = group.length === 1 && successors.includes(frame.node);
        if (group.length > 1 || selfLoop) cycles.push(group.sort());
      }
    }
  }
  return cycles.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}
