import type {
  CompletenessReport,
  ComponentTrace,
  Entity,
  Evidence,
  Gap,
  Relationship,
  Workflow,
} from "@sys2qa/contract";
import { readSkbDocument, readSkbManifest, readSkbRecords, type SkbManifest } from "@sys2qa/platform";
import type { StackReport } from "../stack/stack.js";
import type { CatalogGroup } from "../structure/workflows.js";

/** Everything the documentation is rendered from: one SKB run as stored (SAA-FR-013: documents come from the SKB). */
export interface SkbView {
  manifest: SkbManifest;
  entities: Entity[];
  relationships: Relationship[];
  claims: Array<{ id: string; text: unknown; status: string; subject_entity_id: string; gap_ids?: string[] }>;
  evidence: Evidence[];
  workflows: Workflow[];
  component_traces: ComponentTrace[];
  coverage: Array<{ area: string; status: string; reason?: string }>;
  gaps: Gap[];
  catalog?: { groups: CatalogGroup[]; not_deepened: string[] };
  completeness?: CompletenessReport;
  stack?: StackReport;
  graph?: {
    cycles: string[][];
    projects: Array<{ from: string; to: string; packages: string[] }>;
    unanalyzed_targets: number;
  };
  run?: { profile: string; adapters: Array<{ id: string; version: string; support_level?: number }> };
}

/** Reads a complete SKB run, verifying every file against its manifest. */
export function loadSkbView(dir: string): SkbView {
  const manifest = readSkbManifest(dir);
  if (!manifest) throw new Error(`no complete SKB run in ${dir}`);
  const view: SkbView = {
    manifest,
    entities: [],
    relationships: [],
    claims: [],
    evidence: [],
    workflows: [],
    component_traces: [],
    coverage: (readSkbDocument(dir, manifest, "coverage") as SkbView["coverage"]) ?? [],
    gaps: (readSkbDocument(dir, manifest, "gaps") as Gap[]) ?? [],
  };
  for (const { collection, record } of readSkbRecords(dir, manifest)) (view[collection] as unknown[]).push(record);
  const optional = <K extends "catalog" | "completeness" | "stack" | "graph" | "run">(name: K) => {
    const doc = readSkbDocument(dir, manifest, name);
    if (doc !== undefined) view[name] = doc as SkbView[K];
  };
  optional("catalog");
  optional("completeness");
  optional("stack");
  optional("graph");
  optional("run");
  view.workflows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id.localeCompare(b.id));
  return view;
}
