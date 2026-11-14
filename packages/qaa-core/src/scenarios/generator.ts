import type { Workflow } from "@sys2qa/contract";
import type { PackageQuery } from "@sys2qa/system-model";
import type { ConditionItem, TechniqueId, TestCondition } from "../conditions/conditions.js";
import type { LangText, TestPlan } from "../plan/plan.js";
import { say, type Language } from "./messages.js";

export type ResultBasis = "saa_documented" | "source_supported" | "observed" | "inferred" | "unresolved";
export type OracleClass = "intended" | "implemented" | "observed" | "none";

export interface ExpectedResult {
  description: LangText;
  assertions: Array<Record<string, unknown>>;
  basis: ResultBasis;
  saa_status?: string;
  oracle_class: OracleClass;
  trace: { saa_ids: string[]; evidence_ids: string[]; requirement_ids: string[] };
}

export interface ScenarioStep {
  step_id: string;
  instruction: LangText;
  automation?: { action: string; target: Record<string, unknown> };
  expected_result: ExpectedResult | null;
}

/** The contract's `scenario` document (PRD §15.10). */
export interface Scenario {
  schema_version: string;
  scenario_id: string;
  display_key: string;
  version: number;
  content_language: string;
  title: LangText;
  feature_ref: string;
  test_condition_ids: string[];
  category: string;
  qa_objective: string;
  test_techniques: Array<{ id: TechniqueId; rationale: string }>;
  priority: "high" | "medium" | "low";
  risk: { impact: number; likelihood: number; exposure: string[]; score: number; rationale: string };
  execution_modes: Array<"manual" | "automated">;
  execution_classification: "manual_only" | "automation_candidate" | "automation_ready" | "both";
  state_changing: boolean;
  preconditions: Array<{ id: string; text: LangText; credential_profile_ref?: string }>;
  test_data: Array<{ name: string; value_ref: string; sensitivity: "non_secret" | "secret" }>;
  steps: ScenarioStep[];
  cleanup: LangText[];
  assumptions: LangText[];
  open_gaps: string[];
  baseline: TestPlan["baseline"];
  freshness: "current" | "potentially_stale" | "stale";
  status: "draft" | "needs_clarification";
  status_reason?: string;
}

/** Oracle class derived from the basis, never set on its own (CR-052, PRD §15.9). */
export function oracleOf(basis: ResultBasis): OracleClass {
  if (basis === "saa_documented" || basis === "source_supported") return "implemented";
  if (basis === "observed") return "observed";
  return "none";
}

/** The QA objective an expected-result basis permits (PRD §15.9); requirement conformance needs requirements. */
export function objectiveOf(basis: ResultBasis): string {
  if (basis === "saa_documented" || basis === "source_supported") return "implementation_conformance";
  if (basis === "observed") return "characterization";
  return "exploratory";
}

/** Techniques of a condition that the item exercises. */
function techniquesOf(condition: TestCondition, item: ConditionItem): TestCondition["techniques"] {
  const key = item.phrase.key;
  const want: TechniqueId[] = key.startsWith("bva_")
    ? ["boundary_value_analysis"]
    : key.startsWith("ep_")
      ? ["equivalence_partitioning"]
      : key.startsWith("dt_")
        ? ["decision_table"]
        : key === "st_move"
          ? ["state_transition"]
          : key.startsWith("role_")
            ? ["role_matrix"]
            : key.startsWith("journey_")
              ? ["use_case"]
              : key.startsWith("eg_")
                ? ["error_guessing"]
                : ["negative"];
  if (item.outcome.key === "rejected" || item.outcome.key === "denied" || item.outcome.key === "http_response")
    want.push("negative");
  const picked = condition.techniques.filter((t) => want.includes(t.id));
  return picked.length > 0 ? picked : condition.techniques.slice(0, 1);
}

function categoryOf(item: ConditionItem): string {
  const key = item.phrase.key;
  if (key.startsWith("bva_")) return "boundary";
  if (key.startsWith("role_")) return "authorization";
  if (key === "st_move") return "state_transition";
  if (key === "error_trigger") return "error_path";
  if (key === "journey_branch") return "alternative_path";
  if (key.startsWith("eg_")) return "error_guessing";
  return ["accepted", "allowed", "completes"].includes(item.outcome.key) ? "positive" : "negative_validation";
}

const sanitize = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

export interface GenerateInput {
  plan: TestPlan;
  conditions: TestCondition[];
  model: PackageQuery;
  /** A short project-unique prefix, so scenario IDs never collide across projects. */
  projectKey: string;
  language: Language;
  /** Source analysis available in the package (`evidence_profile.source_analysis`). */
  sourceBased: boolean;
}

/**
 * Generates draft scenarios from test conditions with deterministic templates (IMP-205, PRD §15.10): one scenario per
 * condition item, linked to its condition, its workflow and the package records and evidence it rests on
 * (QAA-FR-015/033a), with a basis and derived oracle per expected result (QAA-FR-033/041), a QA objective the basis
 * permits (QAA-FR-111) and wording in the chosen language (QAA-FR-037). Inferred expectations are labelled as such
 * (QAA-FR-036); a runtime-only package never yields an assertion about internal effects or an unobserved submission
 * (QAA-FR-110). Unknown or contradicted expectations become `needs_clarification`, never invented results.
 */
export function generateScenarios(input: GenerateInput): Scenario[] {
  const { plan, model, language } = input;
  const say_ = (key: string, params: Record<string, string | number> = {}) => say(language, key, params);
  const text = (value: string): LangText => ({ language, value });
  const risks = new Map(plan.risks.map((r) => [r.id, r]));
  const riskOfWorkflow = (w: Workflow) =>
    risks.get(
      `risk:${w.id
        .replace(/^[a-z_]+:/, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()}`,
    );
  const counters = new Map<string, number>();
  const gapsOpen = new Map(model.unknowns().gaps.map((g) => [g.id, g]));
  const out: Scenario[] = [];

  for (const condition of input.conditions) {
    const workflow = model.workflow(condition.workflow_ids[0]!);
    if (!workflow) continue;
    const area =
      (condition.condition_id.replace(/^tc:/, "").split(/[._]/)[0] ?? "GEN")
        .replace(/[^a-z0-9]/gi, "")
        .toUpperCase()
        .slice(0, 8) || "GEN";
    const risk = riskOfWorkflow(workflow);
    const entry = model.entity(workflow.entry_point_ids[0] ?? "");
    const writes = workflow.steps.some((s) => model.related(s.entity_id, "out", "WRITES_TO").length > 0);
    const submissionUnobserved = workflow.unresolved_hops.some((h) => h.reason_code === "submission_requires_approval");

    for (const item of condition.items) {
      // Basis of the expected result: the package's status of the record it rests on (CR-053).
      const record = model.entity(item.refs[0] ?? "") ?? model.workflow(item.refs[0] ?? "");
      const recordStatus = (record as { status?: string } | undefined)?.status;
      let basis: ResultBasis =
        item.basis === "source_supported"
          ? recordStatus === "source_verified" || recordStatus === "test_verified"
            ? "saa_documented"
            : "source_supported"
          : item.basis === "observed"
            ? "observed"
            : "inferred";
      const assumptions: LangText[] = [];
      let clarification: string | undefined = condition.needs_clarification;
      // A runtime package saw the form, not what submitting it does: acceptance is not an observation (QAA-FR-110).
      if (!input.sourceBased && submissionUnobserved && ["accepted", "completes"].includes(item.outcome.key)) {
        basis = "inferred";
        assumptions.push(text(say_("submission_unobserved")));
        clarification ??= "The effect of submitting the form was not observed.";
      }
      if (!input.sourceBased) assumptions.push(text(say_("observed_only")));
      if (basis === "inferred") assumptions.push(text(say_("inferred")));

      const contradictions = item.refs.flatMap(
        (id) => (model.entity(id) as { contradiction_ids?: string[] } | undefined)?.contradiction_ids ?? [],
      );
      if (contradictions.length > 0)
        clarification ??= `Documentation and code disagree (${contradictions.join(", ")}); confirm which is intended.`;
      const openGaps = [
        ...new Set([
          ...contradictions,
          ...workflow.unresolved_hops.map((h) => h.gap_id).filter((g): g is string => Boolean(g)),
        ]),
      ].filter((g) => gapsOpen.has(g));

      const evidenceIds = [
        ...new Set(
          item.refs.flatMap(
            (id) =>
              ((model.entity(id) ?? model.workflow(id)) as { evidence_ids?: string[] } | undefined)?.evidence_ids ?? [],
          ),
        ),
      ].slice(0, 8);
      const saaIds = item.refs.filter((id) => model.entity(id) || model.workflow(id));
      const expected: ExpectedResult = {
        description: text(say_(item.outcome.key, item.outcome.params)),
        assertions: [],
        basis,
        ...(basis === "saa_documented" ? { saa_status: recordStatus! } : {}),
        oracle_class: oracleOf(basis),
        trace: { saa_ids: saaIds, evidence_ids: evidenceIds, requirement_ids: [] },
      };

      const preconditions: Scenario["preconditions"] = [];
      const page =
        entry?.kind === "page" ? ((entry as { route_pattern?: string }).route_pattern ?? entry.name) : undefined;
      if (page) preconditions.push({ id: "pre-1", text: text(say_("reachable", { page })) });
      if (item.phrase.key === "role_as") {
        const role = String(item.phrase.params.role);
        preconditions.push({
          id: `pre-${preconditions.length + 1}`,
          text: text(say_("signed_in", { role })),
          credential_profile_ref: `secretref:role-${sanitize(role.toLowerCase())}`,
        });
      }
      if (item.phrase.key === "role_anonymous")
        preconditions.push({ id: `pre-${preconditions.length + 1}`, text: text(say_("signed_out")) });
      if (item.phrase.key === "st_move")
        preconditions.push({
          id: `pre-${preconditions.length + 1}`,
          text: text(say_("item_in_state", { state: String(item.phrase.params.from) })),
        });

      const steps: ScenarioStep[] = [];
      steps.push(
        page
          ? {
              step_id: "S1",
              instruction: text(say_("open_page", { page })),
              automation: { action: "navigate", target: { kind: "route", value: page } },
              expected_result: null,
            }
          : {
              step_id: "S1",
              instruction: text(say_("prepare", { target: entry?.name ?? workflow.name })),
              expected_result: null,
            },
      );
      steps.push({
        step_id: "S2",
        instruction: text(`${say_(item.phrase.key, item.phrase.params)}.`),
        expected_result: null,
      });
      steps.push({ step_id: "S3", instruction: text(say_("perform")), expected_result: expected });

      const field = item.phrase.params.field;
      const local = sanitize(`${condition.condition_id.replace(/^tc:/, "")}.${item.id.replace(/^.*#/, "")}`);
      const counter = (counters.get(area) ?? 0) + 1;
      counters.set(area, counter);
      const stateChanging =
        writes || !input.sourceBased ? ["accepted", "allowed", "completes"].includes(item.outcome.key) : false;
      const score = risk ? risk.impact * risk.likelihood : 4;
      out.push({
        schema_version: "1.0.0",
        scenario_id: `scenario:${input.projectKey}.${local}`,
        display_key: `TC-${area}-${String(counter).padStart(3, "0")}`,
        version: 1,
        content_language: language,
        title: text(
          say_("title", {
            what: say_(item.phrase.key, item.phrase.params),
            expected: say_(item.outcome.key, item.outcome.params),
          }).slice(0, 300),
        ),
        feature_ref: workflow.id,
        test_condition_ids: [condition.condition_id],
        category: categoryOf(item),
        qa_objective: objectiveOf(basis),
        test_techniques: techniquesOf(condition, item),
        priority: score >= 16 ? "high" : score >= 9 ? "medium" : "low",
        risk: risk
          ? {
              impact: risk.impact,
              likelihood: risk.likelihood,
              exposure: risk.exposure,
              score,
              rationale: risk.rationale,
            }
          : { impact: 2, likelihood: 2, exposure: [], score: 4, rationale: "No plan risk for this workflow; default." },
        execution_modes: ["manual"],
        execution_classification: "manual_only",
        state_changing: stateChanging,
        preconditions,
        test_data:
          field !== undefined
            ? [
                {
                  name: String(field),
                  value_ref: `fixture:${local}.${sanitize(String(field))}`,
                  sensitivity: "non_secret",
                },
              ]
            : [],
        steps,
        cleanup: stateChanging ? [text(say_("cleanup"))] : [],
        assumptions,
        open_gaps: openGaps,
        baseline: plan.baseline,
        freshness: "current",
        ...(clarification
          ? { status: "needs_clarification" as const, status_reason: clarification }
          : { status: "draft" as const }),
      });
    }
  }
  return out;
}
