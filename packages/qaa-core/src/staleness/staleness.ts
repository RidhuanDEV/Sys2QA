import type { PackageQuery } from "@sys2qa/system-model";

/** What changed between two versions of a package (CON-014): computed by QAA, or read from the package's diff report. */
export interface PackageDiff {
  added: string[];
  changed: string[];
  removed: string[];
  /** Records the new version contradicts (a new contradiction gap, or a contradicted claim about them). */
  contradicted: string[];
  renamed: Array<{ from: string; to: string; confidence: "high" | "medium" | "low" }>;
}

/** A record without what changes with every analysis (evidence IDs, ranking), so only meaning is compared. */
function meaning(record: unknown): string {
  return JSON.stringify(record, (key, value: unknown) =>
    key === "evidence_ids" || key === "evidence_id" || key === "rank" || key === "contradiction_ids"
      ? undefined
      : value,
  );
}

/**
 * The difference between two stored versions of one system's package: entities and workflows added, changed (same
 * ID, different meaning) and removed; records the target newly contradicts; and the renames a diff report in the
 * target states for this base, with their confidence.
 */
export function diffPackages(
  base: PackageQuery,
  target: PackageQuery,
  diffReport?: { base: { package_version: number }; renamed?: PackageDiff["renamed"] },
  baseVersion?: number,
): PackageDiff {
  const records = (q: PackageQuery) => {
    const out = new Map<string, unknown>();
    for (const e of q.allEntities()) out.set(e.id, e);
    for (const w of q.workflows()) out.set(w.id, w);
    return out;
  };
  const before = records(base);
  const after = records(target);
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()]
    .filter((id) => before.has(id) && meaning(before.get(id)) !== meaning(after.get(id)))
    .sort();
  const oldContradictions = new Set(
    base
      .unknowns()
      .gaps.filter((g) => g.type === "contradiction")
      .map((g) => g.id),
  );
  const contradicted = new Set<string>();
  for (const gap of target.unknowns().gaps)
    if (gap.type === "contradiction" && !oldContradictions.has(gap.id))
      for (const id of gap.related_entity_ids ?? []) contradicted.add(id);
  for (const id of after.keys())
    for (const claim of target.claimsAbout(id))
      if (
        claim.status === "contradicted" &&
        !base.claimsAbout(id).some((c) => c.id === claim.id && c.status === "contradicted")
      )
        contradicted.add(id);
  const renamed =
    diffReport && baseVersion !== undefined && diffReport.base.package_version === baseVersion
      ? (diffReport.renamed ?? [])
      : [];
  return { added, changed, removed, contradicted: [...contradicted].sort(), renamed };
}

export type ScenarioFreshness = "current" | "potentially_stale" | "stale";
export type ApprovalEffect = "suspended" | "invalidated";

export interface StalenessDecision {
  freshness: ScenarioFreshness;
  /** What happens to the scenario version's active approvals. */
  approval: ApprovalEffect;
  /** Whether a person may rebind the approval to the new baseline in one action (unchanged links only). */
  revalidatable: boolean;
  reason: string;
  /** The linked records that decided it. */
  records: string[];
}

/**
 * Staleness of one scenario under a new package (PRD §13.11, QAA-FR-046): from the records it is linked to (its
 * workflow and the records its expected result rests on). Removed or newly contradicted → `stale`, approval
 * invalidated; changed or renamed with uncertain mapping → `potentially_stale`, approval suspended; unchanged →
 * `current` against the new baseline, approval suspended until a person revalidates it. Without a diff every scenario
 * is `potentially_stale` and suspended.
 */
export function staleness(links: string[], diff: PackageDiff | null): StalenessDecision {
  if (!diff)
    return {
      freshness: "potentially_stale",
      approval: "suspended",
      revalidatable: false,
      reason: "no diff is available for the new package",
      records: [],
    };
  const renamedAway = new Map(diff.renamed.map((r) => [r.from, r]));
  // A renamed record is not removed: a confident rename follows it, an uncertain one waits for confirmation.
  const removed = links.filter((id) => diff.removed.includes(id) && !renamedAway.has(id));
  const contradicted = links.filter((id) => diff.contradicted.includes(id));
  if (removed.length > 0 || contradicted.length > 0)
    return {
      freshness: "stale",
      approval: "invalidated",
      revalidatable: false,
      reason:
        removed.length > 0
          ? `linked record(s) removed: ${removed.join(", ")}`
          : `linked record(s) now contradicted: ${contradicted.join(", ")}`,
      records: [...removed, ...contradicted],
    };
  const uncertain = links.filter((id) => renamedAway.has(id) && renamedAway.get(id)!.confidence !== "high");
  const changed = links.filter((id) => diff.changed.includes(id));
  if (changed.length > 0 || uncertain.length > 0)
    return {
      freshness: "potentially_stale",
      approval: "suspended",
      revalidatable: false,
      reason:
        uncertain.length > 0
          ? `rename with uncertain mapping: ${uncertain.join(", ")}`
          : `linked record(s) changed: ${changed.join(", ")}`,
      records: [...changed, ...uncertain],
    };
  return {
    freshness: "current",
    approval: "suspended",
    revalidatable: true,
    reason: "linked records unchanged; revalidate to rebind",
    records: [],
  };
}
