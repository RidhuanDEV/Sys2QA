import type { Gap } from "@sys2qa/contract";
import type { PackageQuery } from "@sys2qa/system-model";
import type { Scenario } from "./generator.js";

/** The test-case quality checklist of PRD §15.13. */
export const CHECKLIST = [
  "clear_title",
  "feature_and_risk",
  "preconditions_and_data",
  "ordered_steps",
  "expected_result_at_decision_points",
  "technique_and_rationale",
  "evidence_or_marked_assumption",
  "cleanup_if_data_changes",
  "execution_suitability",
  "no_duplication",
] as const;
export type CheckId = (typeof CHECKLIST)[number];

export interface CheckResult {
  check: CheckId;
  passed: boolean;
  detail?: string;
}

/** Two scenarios that test the same thing, and why (QAA-FR-035). */
export interface DuplicateFinding {
  scenario_id: string;
  duplicate_of: string;
  duplicate_of_display_key: string;
  duplicate_of_status: string;
  reason: string;
}

/** A disagreement between sources, shown with every side; QAA never picks one silently (QAA-FR-016). */
export interface ConflictRecord {
  conflict_id: string;
  kind: "documentation_vs_code" | "expectations_disagree";
  description: string;
  sides: Array<{ source: string; statement: string; evidence_ids: string[] }>;
  scenario_ids: string[];
  gap_id?: string;
  status: "open";
}

export interface Critique {
  scenario_id: string;
  version: number;
  checks: CheckResult[];
  /** The status the critic gives: ready for review, or the reason it needs clarification (QAA-FR-034). */
  status: "pending_review" | "needs_clarification";
  status_reason?: string;
}

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const expectedOf = (s: Scenario) => s.steps.find((st) => st.expected_result)?.expected_result ?? null;

/** What a scenario does and expects, independent of its ID, wording language and version. */
function signature(s: Scenario): { act: string; expect: string } {
  const expected = expectedOf(s);
  const refs = [...(expected?.trace.saa_ids ?? [])].sort().join(",");
  const act = `${s.feature_ref}|${refs}|${s.steps.map((st) => norm(st.instruction.value)).join("|")}`;
  return { act, expect: norm(expected?.description.value ?? "") };
}

function checklist(s: Scenario, model: PackageQuery, duplicate?: DuplicateFinding): CheckResult[] {
  const expected = expectedOf(s);
  const inputStep = s.steps.find((st) => st.step_id === "S2");
  const needsData = /\b(enter|isi|fill)\b/i.test(inputStep?.instruction.value ?? "") && s.test_data.length === 0;
  const ids = s.steps.map((st) => st.step_id);
  const ordered = ids.every((id, i) => id === `S${i + 1}`);
  const result = (check: CheckId, passed: boolean, detail?: string): CheckResult =>
    passed ? { check, passed } : { check, passed, ...(detail ? { detail } : {}) };
  return [
    result("clear_title", s.title.value.trim().length >= 10, "the title is too short to state the purpose"),
    result(
      "feature_and_risk",
      Boolean(model.workflow(s.feature_ref) ?? model.entity(s.feature_ref)) && s.risk.score >= 1,
      `feature ${s.feature_ref} does not resolve in the package`,
    ),
    result("preconditions_and_data", !needsData, "the steps enter data but the scenario names no test data"),
    result("ordered_steps", s.steps.length >= 2 && ordered, "steps must be at least two, numbered S1, S2, … in order"),
    result(
      "expected_result_at_decision_points",
      s.steps.at(-1)?.expected_result !== null && s.steps.at(-1)?.expected_result !== undefined,
      "the last step has no expected result",
    ),
    result(
      "technique_and_rationale",
      s.test_techniques.length > 0 && s.test_techniques.every((t) => t.rationale.trim().length > 0),
      "a technique or its rationale is missing",
    ),
    result(
      "evidence_or_marked_assumption",
      (expected?.trace.evidence_ids.length ?? 0) > 0 || s.assumptions.length > 0,
      "the expected result has neither evidence nor a marked assumption",
    ),
    result(
      "cleanup_if_data_changes",
      !s.state_changing || s.cleanup.length > 0,
      "the scenario changes data but has no cleanup",
    ),
    result(
      "execution_suitability",
      s.execution_modes.length > 0 &&
        (s.execution_classification !== "manual_only" || s.execution_modes.includes("manual")) &&
        (s.execution_classification !== "automation_ready" || s.execution_modes.includes("automated")),
      "execution modes and classification disagree",
    ),
    result(
      "no_duplication",
      duplicate === undefined,
      duplicate ? `${duplicate.reason} (${duplicate.duplicate_of_display_key})` : undefined,
    ),
  ];
}

export interface CritiqueInput {
  /** Scenarios to critique (latest versions, not yet approved). */
  scenarios: Scenario[];
  /** Approved scenarios of the project, which new ones must not duplicate. */
  approved: Scenario[];
  model: PackageQuery;
}

/**
 * The critic and validator (IMP-206, PRD §15.13, QAA-FR-016/034/035): every scenario is checked against the quality
 * checklist; duplicates are found by what a scenario does and expects (the same feature, package records, steps and
 * expected result), against approved scenarios and within the batch, and reported with the reason; disagreements
 * become conflict records with every side and their evidence: documentation against code (the package's
 * contradiction gaps) and scenarios whose identical actions expect different results. A scenario that fails a check,
 * duplicates another, has a conflict or was already unclear needs clarification; the others are ready for review.
 */
export function critiqueScenarios(input: CritiqueInput): {
  critiques: Critique[];
  duplicates: DuplicateFinding[];
  conflicts: ConflictRecord[];
} {
  const { model } = input;
  const duplicates: DuplicateFinding[] = [];
  const seen = new Map<string, Scenario>();
  for (const s of input.approved) seen.set(JSON.stringify(signature(s)), s);
  const byAct = new Map<string, Scenario[]>();
  const duplicateOf = new Map<string, DuplicateFinding>();
  for (const s of input.scenarios) {
    const sig = signature(s);
    const key = JSON.stringify(sig);
    const prior = seen.get(key);
    if (prior && prior.scenario_id !== s.scenario_id) {
      const finding: DuplicateFinding = {
        scenario_id: s.scenario_id,
        duplicate_of: prior.scenario_id,
        duplicate_of_display_key: prior.display_key,
        duplicate_of_status: input.approved.includes(prior) ? "approved" : prior.status,
        reason: `same feature, package records, steps and expected result as ${prior.display_key}`,
      };
      duplicates.push(finding);
      duplicateOf.set(s.scenario_id, finding);
    } else seen.set(key, s);
    byAct.set(sig.act, [...(byAct.get(sig.act) ?? []), s]);
  }

  // Conflicts: the package's documentation/code contradictions, and identical actions with different expectations.
  const conflicts: ConflictRecord[] = [];
  const conflictOf = new Map<string, string[]>();
  const note = (scenarioId: string, conflictId: string) =>
    conflictOf.set(scenarioId, [...(conflictOf.get(scenarioId) ?? []), conflictId]);
  const gaps = new Map(model.unknowns().gaps.map((g) => [g.id, g]));
  const contradictionGaps = new Set(
    input.scenarios.flatMap((s) => s.open_gaps).filter((id) => gaps.get(id)?.type === "contradiction"),
  );
  for (const gapId of [...contradictionGaps].sort()) {
    const gap = gaps.get(gapId) as Gap & { description?: string };
    const subjects = gap.related_entity_ids ?? [];
    const evidence =
      model.evidenceFor(gapId).length > 0 ? model.evidenceFor(gapId) : subjects.flatMap((id) => model.evidenceFor(id));
    const documentation = evidence.filter((e) => e.source_type === "documentation");
    const code = evidence.filter((e) => e.source_type !== "documentation");
    const scenarioIds = input.scenarios.filter((s) => s.open_gaps.includes(gapId)).map((s) => s.scenario_id);
    const conflictId = `qconflict:${gapId.replace(/^gap:/, "")}`;
    conflicts.push({
      conflict_id: conflictId,
      kind: "documentation_vs_code",
      description: gap.description ?? `Documentation and code disagree (${gapId}).`,
      sides: [
        {
          source: "documentation",
          statement: "What the project's documentation states.",
          evidence_ids: documentation.map((e) => e.id),
        },
        {
          source: "code",
          statement: subjects
            .map((id) => String((model.entity(id) as { statement?: string } | undefined)?.statement ?? id))
            .join("; "),
          evidence_ids: code.map((e) => e.id),
        },
      ],
      scenario_ids: scenarioIds,
      gap_id: gapId,
      status: "open",
    });
    for (const id of scenarioIds) note(id, conflictId);
  }
  for (const group of byAct.values()) {
    const expectations = new Map(group.map((s) => [signature(s).expect, s]));
    if (expectations.size < 2) continue;
    const conflictId = `qconflict:expectations.${group[0]!.scenario_id.replace(/^scenario:/, "")}`;
    conflicts.push({
      conflict_id: conflictId,
      kind: "expectations_disagree",
      description: "Scenarios with the same feature, records and steps expect different results.",
      sides: [...expectations.values()].map((s) => ({
        source: s.display_key,
        statement: expectedOf(s)?.description.value ?? "",
        evidence_ids: expectedOf(s)?.trace.evidence_ids ?? [],
      })),
      scenario_ids: group.map((s) => s.scenario_id),
      status: "open",
    });
    for (const s of group) note(s.scenario_id, conflictId);
  }

  const critiques = input.scenarios.map((s): Critique => {
    const checks = checklist(s, model, duplicateOf.get(s.scenario_id));
    const failed = checks.filter((c) => !c.passed);
    const reasons = [
      ...(s.status === "needs_clarification" && s.status_reason ? [s.status_reason] : []),
      ...(conflictOf.get(s.scenario_id) ?? []).map((c) => `open conflict ${c}`),
      ...failed.map((c) => `${c.check}: ${c.detail ?? "failed"}`),
    ];
    // An inferred or unresolved expectation is not a reviewable assertion on its own (PRD §15.9: exploratory).
    const expected = expectedOf(s);
    if (expected?.basis === "unresolved") reasons.push("the expected result is unresolved");
    return reasons.length > 0
      ? {
          scenario_id: s.scenario_id,
          version: s.version,
          checks,
          status: "needs_clarification",
          status_reason: [...new Set(reasons)].join("; ").slice(0, 1000),
        }
      : { scenario_id: s.scenario_id, version: s.version, checks, status: "pending_review" };
  });
  return { critiques, duplicates, conflicts };
}
