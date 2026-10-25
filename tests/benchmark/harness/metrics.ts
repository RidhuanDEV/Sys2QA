import type { ExpectedWorkflow, GroundTruth } from "./ground-truth.js";
import type { ProducedWorkflow, ProducerOutput } from "./producer-output.js";

/** A metric value, or the reason it cannot be measured yet (never reported as zero). */
export type Measured = number | { not_measured: string };

export interface GateRule {
  metric: string;
  rule: string;
  value: Measured;
  passed: boolean;
}

export interface BenchmarkMetrics {
  fixture: string;
  discovery: { expected: number; discovered: number; matched: number; recall: Measured; precision: Measured };
  reconstruction: {
    step_f1: Measured;
    branch_recall: Measured;
    stop_point_accuracy: Measured;
    external_boundary_accuracy: Measured;
  };
  uncertainty: { true_gap_ratio: Measured; misses_in_unexplored_areas: Measured };
  over_claiming: { count: number; items: string[] };
  evidence_traceability: Measured;
  scenarios: { expected_covered: Measured; forbidden_present: Measured; forbidden_items: string[] };
  runtime: { page_recall: Measured; form_recall: Measured; withheld_form_errors: Measured };
  gates: GateRule[];
}

const ratio = (n: number, d: number, why: string): Measured =>
  d === 0 ? { not_measured: why } : Math.round((n / d) * 10_000) / 10_000;

/** Length of the longest common subsequence of two sequences. */
export function lcs<T>(a: readonly T[], b: readonly T[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
      diagonal = above;
    }
  }
  return row[b.length]!;
}

const stepEntities = (w: ProducedWorkflow) => [...w.steps].sort((a, b) => a.order - b.order).map((s) => s.entity_id);

/** Test Strategy §5: same entry point and ≥ 50% of the canonical steps in order. Gap records never match. */
export function workflowMatches(expected: ExpectedWorkflow, produced: ProducedWorkflow): boolean {
  if (produced.discovery_status === "excluded" || produced.discovery_status === "known_not_traceable") return false;
  if (!produced.entry_point_ids.includes(expected.entry_point)) return false;
  return lcs(expected.steps, stepEntities(produced)) / Math.max(1, expected.steps.length) >= 0.5;
}

/** Pairs each expected workflow with its best-matching produced workflow (each produced workflow used once). */
function pair(truth: GroundTruth, produced: ProducedWorkflow[]): Array<[ExpectedWorkflow, ProducedWorkflow]> {
  const used = new Set<string>();
  const pairs: Array<[ExpectedWorkflow, ProducedWorkflow]> = [];
  for (const expected of truth.workflows) {
    const best = produced
      .filter((p) => !used.has(p.id) && workflowMatches(expected, p))
      .sort((a, b) => lcs(expected.steps, stepEntities(b)) - lcs(expected.steps, stepEntities(a)))[0];
    if (best) {
      used.add(best.id);
      pairs.push([expected, best]);
    }
  }
  return pairs;
}

const UNEXPLORED = new Set(["skipped", "unsupported", "excluded", "failed", "partial"]);
const claimText = (t: ProducerOutput["systemModel"]["claims"][number]["text"]) =>
  typeof t === "string" ? t : Array.isArray(t) ? t.map((x) => x.value).join(" ") : t.value;

export function computeMetrics(truth: GroundTruth, output: ProducerOutput): BenchmarkMetrics {
  const model = output.systemModel;
  const counted = model.workflows.filter((w) => w.discovery_status !== "excluded");
  const pairs = pair(truth, model.workflows);
  const matchedIds = new Set(pairs.map(([, p]) => p.id));

  // Reconstruction quality over matched workflows.
  let lcsTotal = 0;
  let expectedSteps = 0;
  let producedSteps = 0;
  let branchHits = 0;
  let branchTotal = 0;
  let stopHits = 0;
  let stopTotal = 0;
  for (const [expected, produced] of pairs) {
    const steps = stepEntities(produced);
    lcsTotal += lcs(expected.steps, steps);
    expectedSteps += expected.steps.length;
    producedSteps += steps.length;
    const entityOfStep = new Map(produced.steps.map((s) => [s.id, s.entity_id]));
    for (const branch of expected.branches) {
      branchTotal++;
      if (produced.branches.some((b) => entityOfStep.get(b.from_step) === branch.from && b.outcome === branch.outcome))
        branchHits++;
    }
    for (const stop of expected.stop_points) {
      stopTotal++;
      const hit = produced.unresolved_hops.some(
        (h) =>
          h.reason_code === stop.reason_code &&
          (stop.after === null ? h.after_step === undefined : entityOfStep.get(h.after_step ?? "") === stop.after),
      );
      if (hit) stopHits++;
    }
  }
  const precision = producedSteps === 0 ? 0 : lcsTotal / producedSteps;
  const recall = expectedSteps === 0 ? 0 : lcsTotal / expectedSteps;
  const stepF1: Measured =
    pairs.length === 0
      ? { not_measured: "no matched workflows" }
      : Math.round((precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)) * 10_000) / 10_000;

  const boundaries = [...new Set(truth.workflows.flatMap((w) => w.external_boundaries))];
  const labeled = boundaries.filter((id) =>
    model.gaps.some((g) => g.type === "external_boundary" && (g.related_entity_ids ?? []).includes(id)),
  );

  // Uncertainty reporting.
  const trueGaps = model.gaps.filter((g) =>
    truth.gaps.some((t) => t.type === g.type && t.related.some((r) => (g.related_entity_ids ?? []).includes(r))),
  );
  const missed = truth.workflows.filter((w) => !pairs.some(([e]) => e.key === w.key));
  const unexplored = new Set(model.coverage.filter((c) => UNEXPLORED.has(c.status)).map((c) => c.area));
  const honestMisses = missed.filter((w) => unexplored.has(w.area));

  // Over-claiming.
  const overClaims = truth.forbidden_claims
    .filter((f) => {
      const byRelationship =
        f.relationship !== undefined &&
        model.relationships.some(
          (r) =>
            r.type === f.relationship!.type &&
            (f.relationship!.from === undefined || r.from === f.relationship!.from) &&
            (f.relationship!.to === undefined || r.to === f.relationship!.to),
        );
      const byText =
        f.claim_text !== undefined && model.claims.some((c) => new RegExp(f.claim_text!, "i").test(claimText(c.text)));
      return byRelationship || byText;
    })
    .map((f) => f.key);

  // Evidence traceability: every material claim cites evidence that resolves, at the model's revision.
  const evidenceIds = new Set(output.evidenceIndex.evidence.map((e) => e.id));
  const sameRevision = JSON.stringify(output.evidenceIndex.revision) === JSON.stringify(model.revision);
  const material = model.claims.filter((c) => c.status !== "unresolved");
  const traced = material.filter(
    (c) => sameRevision && c.evidence_ids.length > 0 && c.evidence_ids.every((id) => evidenceIds.has(id)),
  );

  // Scenarios (Gate 2 onwards).
  const scenarios = output.scenarios;
  const forbiddenScenarioItems =
    scenarios === undefined
      ? []
      : truth.scenarios.forbidden
          .filter((f) =>
            scenarios.some(
              (s) =>
                (f.objective === undefined || s.qa_objective === f.objective) &&
                s.expected_results.some(
                  (r) =>
                    (f.basis === undefined || r.basis === f.basis) &&
                    (f.oracle_class === undefined || r.oracle_class === f.oracle_class),
                ),
            ),
          )
          .map((f) => f.key);
  const covered =
    scenarios === undefined
      ? 0
      : truth.scenarios.expected.filter((e) =>
          scenarios.some((s) => s.test_condition === e.condition && s.techniques.includes(e.technique)),
        ).length;

  // Runtime discovery (Gate 4 onwards).
  const runtime = output.runtime;
  const truthRuntime = truth.runtime;
  const withheldErrors =
    runtime && truthRuntime
      ? truthRuntime.forms.filter((f) => f.withhold && runtime.submitted_forms.includes(f.id)).length
      : undefined;

  const notYet = (what: string) => ({ not_measured: what });
  const metrics: Omit<BenchmarkMetrics, "gates"> = {
    fixture: truth.fixture,
    discovery: {
      expected: truth.workflows.length,
      discovered: counted.length,
      matched: pairs.length,
      recall: ratio(pairs.length, truth.workflows.length, "no expected workflows"),
      precision: ratio(counted.filter((w) => matchedIds.has(w.id)).length, counted.length, "no discovered workflows"),
    },
    reconstruction: {
      step_f1: stepF1,
      branch_recall: ratio(branchHits, branchTotal, "no expected branches in matched workflows"),
      stop_point_accuracy: ratio(stopHits, stopTotal, "no expected stop points in matched workflows"),
      external_boundary_accuracy: ratio(labeled.length, boundaries.length, "no expected external boundaries"),
    },
    uncertainty: {
      true_gap_ratio: ratio(trueGaps.length, model.gaps.length, "no reported gaps"),
      misses_in_unexplored_areas: ratio(honestMisses.length, missed.length, "no missed workflows"),
    },
    over_claiming: { count: overClaims.length, items: overClaims },
    evidence_traceability: ratio(traced.length, material.length, "no material claims"),
    scenarios: {
      expected_covered:
        scenarios === undefined
          ? notYet("producer emits no scenarios")
          : ratio(covered, truth.scenarios.expected.length, "no expected scenarios"),
      forbidden_present:
        scenarios === undefined ? notYet("producer emits no scenarios") : forbiddenScenarioItems.length,
      forbidden_items: forbiddenScenarioItems,
    },
    runtime: {
      page_recall:
        runtime && truthRuntime
          ? ratio(
              truthRuntime.pages.filter((p) => runtime.visited_pages.includes(p)).length,
              truthRuntime.pages.length,
              "no expected pages",
            )
          : notYet("no runtime discovery for this fixture or producer"),
      form_recall:
        runtime && truthRuntime
          ? ratio(
              truthRuntime.forms.filter((f) => runtime.discovered_forms.includes(f.id)).length,
              truthRuntime.forms.length,
              "no expected forms",
            )
          : notYet("no runtime discovery for this fixture or producer"),
      withheld_form_errors: withheldErrors ?? notYet("no runtime discovery for this fixture or producer"),
    },
  };
  return { ...metrics, gates: evaluateGates(metrics) };
}

/** The gate rules of Test Strategy §5 (✓ rows). A metric that cannot be measured yet does not fail its gate. */
export function evaluateGates(m: Omit<BenchmarkMetrics, "gates">): GateRule[] {
  const rule = (metric: string, text: string, value: Measured, ok: (n: number) => boolean): GateRule => ({
    metric,
    rule: text,
    value,
    passed: typeof value !== "number" || ok(value),
  });
  return [
    rule("over_claiming", "must be 0", m.over_claiming.count, (n) => n === 0),
    rule("evidence_traceability", "must be 100%", m.evidence_traceability, (n) => n === 1),
    rule("scenarios.forbidden_present", "must be 0", m.scenarios.forbidden_present, (n) => n === 0),
    rule("runtime.withheld_form_errors", "must be 0", m.runtime.withheld_form_errors, (n) => n === 0),
  ];
}
