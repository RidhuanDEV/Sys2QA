import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ground truth of a benchmark fixture (Test Strategy §4.1). Entities are referred to by their semantic IDs, which are
 * deterministic functions of kind, boundary and natural key (Data Model §3), never by generated IDs.
 */
export interface ExpectedWorkflow {
  key: string;
  category: string;
  entry_point: string;
  /** Canonical step list: entity IDs in order. */
  steps: string[];
  branches: Array<{ from: string; outcome: string }>;
  /** Where a correct analysis must stop, and why (`after: null` = before the first step). */
  stop_points: Array<{ after: string | null; reason_code: string }>;
  /** Integrations this workflow reaches that must be labeled as external boundaries. */
  external_boundaries: string[];
  /** Coverage area the workflow lives in, so a miss inside a reported unexplored area counts as honest. */
  area: string;
}

export interface ForbiddenClaim {
  key: string;
  description: string;
  /** A relationship that must not be asserted (any field omitted matches anything). */
  relationship?: { type: string; from?: string; to?: string };
  /** Claim text that must not appear (case-insensitive regular expression). */
  claim_text?: string;
}

export interface GroundTruth {
  fixture: string;
  entities: Array<{ id: string; kind: string }>;
  workflows: ExpectedWorkflow[];
  gaps: Array<{ key: string; type: string; related: string[] }>;
  forbidden_claims: ForbiddenClaim[];
  scenarios: {
    expected: Array<{ key: string; condition: string; technique: string }>;
    forbidden: Array<{ key: string; description: string; basis?: string; objective?: string; oracle_class?: string }>;
  };
  runtime?: { pages: string[]; forms: Array<{ id: string; withhold: boolean }> };
}

const read = <T>(dir: string, file: string, fallback?: T): T => {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
};

/** Loads `fixtures/benchmarks/<F>/ground-truth/`. */
export function loadGroundTruth(dir: string, fixture: string): GroundTruth {
  return {
    fixture,
    entities: read<{ entities: GroundTruth["entities"] }>(dir, "entities.json").entities,
    workflows: read<{ workflows: ExpectedWorkflow[] }>(dir, "workflows.json").workflows,
    gaps: read<{ gaps: GroundTruth["gaps"] }>(dir, "gaps.json").gaps,
    forbidden_claims: read<{ claims: ForbiddenClaim[] }>(dir, "forbidden-claims.json").claims,
    scenarios: read<GroundTruth["scenarios"]>(dir, "scenarios-expected.json"),
    ...(() => {
      const runtime = read<GroundTruth["runtime"] | null>(dir, "runtime.json", null);
      return runtime ? { runtime } : {};
    })(),
  };
}
