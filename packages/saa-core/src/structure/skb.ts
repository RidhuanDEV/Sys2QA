import type { CompletenessReport } from "@sys2qa/contract";
import { writeSkbRun, type SkbManifest } from "@sys2qa/platform";
import { redactOutput } from "../intake/secrets.js";
import type { StructureResult } from "./run.js";

/**
 * Stores an SAA run as SKB partitions (IMP-115, SAA-FR-012) in `dir` (`<home>/projects/<project>/skb/<run>/`). The
 * whole run passes through `redactOutput` first, so no detected secret reaches the files (ST-04); the platform writes
 * each partition atomically and the manifest last.
 */
export function persistSkbRun(
  dir: string,
  input: { runId: string; revision: unknown; structure: StructureResult; completeness?: CompletenessReport },
  now?: () => Date,
): { manifest: SkbManifest; redacted: number } {
  const s = input.structure;
  const { value, redacted } = redactOutput({
    records: {
      entities: s.entities,
      relationships: s.relationships,
      claims: s.claims,
      evidence: s.evidence,
      workflows: s.catalog.workflows,
      component_traces: s.component_traces,
    },
    documents: {
      coverage: s.coverage,
      gaps: s.gaps,
      catalog: { count_scope: s.catalog.count_scope, groups: s.catalog.groups, not_deepened: s.catalog.not_deepened },
      ...(input.completeness ? { completeness: input.completeness } : {}),
    },
  });
  const manifest = writeSkbRun(dir, { run_id: input.runId, producer: "SAA", revision: input.revision, ...value }, now);
  return { manifest, redacted };
}
