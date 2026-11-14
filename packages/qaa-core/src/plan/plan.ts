import type { Workflow } from "@sys2qa/contract";
import type { PackageQuery } from "@sys2qa/system-model";
import type { ReadinessResult } from "../readiness/readiness.js";

/** Exposure flags of PRD §15.7; nothing else is accepted, so no sensitive domain is inferred without evidence. */
export const EXPOSURE_FLAGS = [
  "high_traffic",
  "security_sensitive",
  "permission_sensitive",
  "data_critical",
  "primary_workflow",
  "recently_changed",
] as const;
export type ExposureFlag = (typeof EXPOSURE_FLAGS)[number];

export interface LangText {
  language: string;
  value: string;
}

export interface PlanRisk {
  id: string;
  description: LangText;
  impact: number;
  likelihood: number;
  exposure: ExposureFlag[];
  rationale: string;
}

/** The contract's `test-plan` document (QAA-FR-030). */
export interface TestPlan {
  schema_version: string;
  plan_id: string;
  content_language: string;
  baseline: { packages: Array<{ package_id: string; package_version: number }>; revision: Record<string, unknown> };
  objectives: LangText[];
  qa_objectives: string[];
  scope: { in_scope: string[]; out_of_scope: string[]; exclusions_reason?: string };
  risks: PlanRisk[];
  test_basis: Array<{ kind: string; ref: string }>;
  assumptions: LangText[];
  exit_criteria: LangText[];
  evidence_profile_summary?: string;
}

/** What the plan suggests covering per workflow; the technique engine (IMP-204) turns it into conditions. */
export interface SuggestedCoverage {
  workflow_id: string;
  paths: { main: number; branches: number };
  rules: string[];
  roles: string[];
  state_machines: string[];
  error_responses: number;
  techniques: string[];
  limitations: string[];
}

export interface PlanInput {
  planId: string;
  language: string;
  packageRef: { package_id: string; package_version: number };
  manifest: Record<string, unknown>;
  model: PackageQuery;
  readiness: ReadinessResult;
  /** Selected workflows; every workflow that is not blocked when absent. */
  scope?: string[];
  /** A person's own objective, added before the derived ones. */
  objective?: string;
}

const text = (language: string, value: string): LangText => ({ language, value });
const keyOf = (id: string) =>
  id
    .replace(/^[a-z_]+:/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .toLowerCase();

/** The package's revision as a baseline: the repository revision, or the observation window of a runtime package. */
function baselineRevision(manifest: Record<string, unknown>): Record<string, unknown> {
  const repository = manifest.repository as { revision?: Record<string, unknown> } | null;
  if (repository?.revision) return repository.revision;
  const [env] = (manifest.observed_environments as Array<Record<string, string>>) ?? [];
  return {
    kind: "observation_window",
    environment_id: env?.environment_id ?? "env:unknown",
    observed_from: env?.observed_from ?? (manifest.generated_at as string),
    observed_to: env?.observed_to ?? (manifest.generated_at as string),
  };
}

interface PathFacts {
  entities: Set<string>;
  rules: string[];
  roles: string[];
  stateMachines: string[];
  writes: boolean;
  authenticated: boolean;
  errorResponses: number;
}

function factsOf(model: PackageQuery, workflow: Workflow): PathFacts {
  const entities = new Set<string>([...workflow.entry_point_ids, ...workflow.steps.map((s) => s.entity_id)]);
  const rules = new Set<string>();
  const roles = new Set<string>();
  const machines = new Set<string>();
  let writes = false;
  let authenticated = false;
  let errorResponses = 0;
  for (const id of entities) {
    if (model.entity(id)?.kind === "state_machine") machines.add(id);
    for (const r of model.related(id, "in", "VALIDATES")) rules.add(r.from);
    for (const r of model.related(id, "out", "AUTHORIZES_WITH")) roles.add(r.to);
    if (model.related(id, "out", "AUTHENTICATES_WITH").length > 0) authenticated = true;
    if (model.related(id, "out", "WRITES_TO").length > 0) writes = true;
    for (const r of model.related(id, "out", "REFERENCES"))
      if (model.entity(r.to)?.kind === "state_machine") machines.add(r.to);
    const responses = (model.entity(id) as { error_responses?: unknown[] } | undefined)?.error_responses;
    errorResponses += Array.isArray(responses) ? responses.length : 0;
  }
  for (const rule of rules)
    for (const r of model.related(rule, "out", "REFERENCES"))
      if (model.entity(r.to)?.kind === "state_machine") machines.add(r.to);
  return {
    entities,
    rules: [...rules].sort(),
    roles: [...roles].sort(),
    stateMachines: [...machines].sort(),
    writes,
    authenticated,
    errorResponses,
  };
}

/**
 * The default risk of one workflow (PRD §15.7): impact and likelihood on 1–5 from evidence in the package only, with
 * every factor named in the rationale. They are a prioritization aid, editable by a person (audited), never a
 * probability.
 */
function defaultRisk(language: string, workflow: Workflow, facts: PathFacts, flowGaps: number, rank: number): PlanRisk {
  const exposure: ExposureFlag[] = [];
  const impactFactors: string[] = [];
  const likelihoodFactors: string[] = [];
  let impact = 2;
  let likelihood = 2;
  if (facts.writes) {
    impact++;
    exposure.push("data_critical");
    impactFactors.push("it writes stored data");
  }
  if (facts.roles.length > 0) {
    impact++;
    exposure.push("permission_sensitive");
    impactFactors.push(`it is guarded by ${facts.roles.join(", ")}`);
  }
  if (facts.authenticated || workflow.category === "auth") {
    exposure.push("security_sensitive");
    if (facts.roles.length === 0) {
      impact++;
      impactFactors.push("it authenticates the user");
    }
  }
  if (rank <= 3) {
    impact++;
    exposure.push("primary_workflow");
    impactFactors.push(`it ranks ${rank} in the discovered catalog`);
  }
  if (facts.rules.length > 0) {
    likelihood++;
    likelihoodFactors.push(`${facts.rules.length} business rule(s) constrain its input`);
  }
  if (workflow.branches.length > 1 || facts.errorResponses > 0) {
    likelihood++;
    likelihoodFactors.push(
      `${workflow.branches.length} branch(es) and ${facts.errorResponses} documented error response(s)`,
    );
  }
  if (flowGaps > 0) {
    likelihood++;
    likelihoodFactors.push(`${flowGaps} open gap(s) or contradiction(s) touch it`);
  }
  impact = Math.min(5, impact);
  likelihood = Math.min(5, likelihood);
  const rationale = [
    `Default from package evidence. Impact ${impact}: ${impactFactors.length ? impactFactors.join("; ") : "no data, permission, authentication or ranking factor found"}.`,
    `Likelihood ${likelihood}: ${likelihoodFactors.length ? likelihoodFactors.join("; ") : "no rule, branch, error response or gap found"}.`,
  ].join(" ");
  return {
    id: `risk:${keyOf(workflow.id)}`,
    description: text(language, `${workflow.name} does not behave as the package documents.`),
    impact,
    likelihood,
    exposure: [...new Set(exposure)],
    rationale,
  };
}

function techniquesFor(workflow: Workflow, facts: PathFacts, model: PackageQuery, limitations: number): string[] {
  const techniques = ["user_journey"];
  const bounded = facts.rules.some((id) => {
    const bounds = (model.entity(id) as { boundaries?: Array<Record<string, unknown>> } | undefined)?.boundaries ?? [];
    return bounds.some((b) => ["min_length", "max_length", "minimum", "maximum", "min", "max"].some((k) => k in b));
  });
  if (facts.rules.length > 0) techniques.push("equivalence_partitioning");
  if (bounded) techniques.push("boundary_value_analysis");
  if (facts.rules.length > 1 && workflow.branches.length > 1) techniques.push("decision_table");
  if (facts.stateMachines.length > 0) techniques.push("state_transition");
  if (facts.roles.length > 0) techniques.push("role_matrix");
  if (workflow.branches.length > 0 || facts.errorResponses > 0 || facts.rules.length > 0) techniques.push("negative");
  if (limitations > 0) techniques.push("exploratory");
  return techniques;
}

/** Risk score shown next to the inputs: impact × likelihood, exposure as tie-breaker (PRD §15.7). */
export function riskScore(risk: Pick<PlanRisk, "impact" | "likelihood">): number {
  return risk.impact * risk.likelihood;
}

/** Risks in priority order: score, then exposure count, then ID. */
export function prioritizedRisks(risks: readonly PlanRisk[]): Array<PlanRisk & { score: number }> {
  return risks
    .map((r) => ({ ...r, score: riskScore(r) }))
    .sort((a, b) => b.score - a.score || b.exposure.length - a.exposure.length || a.id.localeCompare(b.id));
}

/**
 * Builds a test plan from an imported package and its readiness (QAA-FR-030, PRD §15.1): objectives, QA objectives
 * consistent with the evidence (implementation conformance for source evidence, characterization for runtime-only
 * evidence, exploratory where gaps remain; never requirement conformance without supplied requirements, §15.9), scope
 * from the discovered catalog with blocked flows and external boundaries excluded and why, one transparent risk per
 * in-scope workflow, the package as test basis, assumptions from freshness and limitations, exit criteria, and the
 * suggested coverage per workflow.
 */
export function buildTestPlan(input: PlanInput): { plan: TestPlan; suggested_coverage: SuggestedCoverage[] } {
  const { model, readiness, language } = input;
  const flows = new Map(readiness.flows.map((f) => [f.workflow_id, f]));
  const catalog = model.workflows().filter((w) => w.discovery_status !== "excluded");
  const selected = catalog.filter((w) => !input.scope || input.scope.includes(w.id));
  const blocked = selected.filter((w) => flows.get(w.id)?.readiness === "blocked");
  const inScope = selected.filter((w) => flows.get(w.id)?.readiness !== "blocked");
  const notSelected = catalog.filter((w) => !selected.includes(w));

  const limitationGaps = new Set<string>();
  for (const w of inScope)
    for (const g of flows.get(w.id)?.gaps ?? []) if (g.effect === "limitation") limitationGaps.add(g.gap_id);
  const openGaps = new Map(model.unknowns().gaps.map((g) => [g.id, g]));
  const boundaryEntities = new Set<string>();
  for (const id of limitationGaps)
    for (const e of openGaps.get(id)?.related_entity_ids ?? [])
      if (model.entity(e)?.kind === "integration") boundaryEntities.add(e);

  const reasons: string[] = [];
  if (blocked.length > 0)
    reasons.push(
      `${blocked.map((w) => w.id).join(", ")}: a material gap blocks scenario design until it is resolved or overridden`,
    );
  if (boundaryEntities.size > 0)
    reasons.push(`${[...boundaryEntities].join(", ")}: outside the analyzed scope; scenarios stop at the boundary`);
  if (notSelected.length > 0) reasons.push(`${notSelected.length} workflow(s) not selected for this plan`);

  const evidence = (input.manifest.evidence_profile ?? {}) as Record<string, unknown>;
  const sourceBased = evidence.source_analysis === "available";
  const qaObjectives = [sourceBased ? "implementation_conformance" : "characterization"];
  if (limitationGaps.size > 0 || readiness.flows.some((f) => f.gaps.length > 0)) qaObjectives.push("exploratory");

  const rankOf = new Map(catalog.map((w, i) => [w.id, w.rank ?? i + 1]));
  const risks: PlanRisk[] = [];
  const suggested: SuggestedCoverage[] = [];
  for (const w of inScope) {
    const facts = factsOf(model, w);
    const gaps = flows.get(w.id)?.gaps ?? [];
    risks.push(defaultRisk(language, w, facts, gaps.length, rankOf.get(w.id) ?? 99));
    const limits = gaps.filter((g) => g.effect === "limitation").map((g) => g.gap_id);
    suggested.push({
      workflow_id: w.id,
      paths: { main: 1, branches: w.branches.length },
      rules: facts.rules,
      roles: facts.roles,
      state_machines: facts.stateMachines,
      error_responses: facts.errorResponses,
      techniques: techniquesFor(w, facts, model, limits.length),
      limitations: limits,
    });
  }

  const assumptions: LangText[] = [];
  const freshness = readiness.assessment.freshness;
  assumptions.push(
    text(
      language,
      freshness === "current"
        ? `The system under test matches the package revision (freshness ${freshness}).`
        : `The package is ${freshness} against the baseline; scenarios are drafts until the baseline is confirmed.`,
    ),
  );
  if (limitationGaps.size > 0)
    assumptions.push(text(language, `Behavior behind ${[...limitationGaps].join(", ")} is not verified by this plan.`));
  if (!sourceBased)
    assumptions.push(
      text(language, "Expected results come from observed behavior; internal effects are not asserted."),
    );

  const exitCriteria = [
    text(language, "Every approved scenario of the in-scope workflows has been executed or run manually."),
    text(language, "No open critical or major defect remains on an in-scope workflow."),
    text(language, "Every contradiction and material gap in scope is resolved or accepted with a recorded decision."),
  ];
  const objectives = [
    ...(input.objective ? [text(language, input.objective)] : []),
    text(
      language,
      sourceBased
        ? `Verify that ${inScope.length} workflow(s) behave as the package documents the current implementation.`
        : `Characterize the observed behavior of ${inScope.length} workflow(s) within the observed scope.`,
    ),
  ];
  const ref = `${input.packageRef.package_id}@${input.packageRef.package_version}`;
  const plan: TestPlan = {
    schema_version: "1.0.0",
    plan_id: input.planId,
    content_language: language,
    baseline: { packages: [input.packageRef], revision: baselineRevision(input.manifest) },
    objectives,
    qa_objectives: qaObjectives,
    scope: {
      in_scope: inScope.map((w) => w.id),
      out_of_scope: [...blocked.map((w) => w.id), ...[...boundaryEntities].sort(), ...notSelected.map((w) => w.id)],
      ...(reasons.length > 0 ? { exclusions_reason: `${reasons.join(". ")}.` } : {}),
    },
    risks,
    test_basis: [{ kind: "package", ref }],
    assumptions,
    exit_criteria: exitCriteria,
    evidence_profile_summary: Object.entries(evidence)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("; "),
  };
  return { plan, suggested_coverage: suggested };
}

export interface RiskEdit {
  impact?: number;
  likelihood?: number;
  exposure?: ExposureFlag[];
  rationale: string;
}

/** Applies a person's edit to one risk; the rationale is required and replaces the default one (QAA-FR-038). */
export function editRisk(
  plan: TestPlan,
  riskId: string,
  edit: RiskEdit,
): { plan: TestPlan; before: PlanRisk; after: PlanRisk } {
  const before = plan.risks.find((r) => r.id === riskId);
  if (!before) throw new Error(`no risk ${riskId} in plan ${plan.plan_id}`);
  const after: PlanRisk = {
    ...before,
    ...(edit.impact !== undefined ? { impact: edit.impact } : {}),
    ...(edit.likelihood !== undefined ? { likelihood: edit.likelihood } : {}),
    ...(edit.exposure !== undefined ? { exposure: [...new Set(edit.exposure)] } : {}),
    rationale: edit.rationale,
  };
  return { plan: { ...plan, risks: plan.risks.map((r) => (r.id === riskId ? after : r)) }, before, after };
}
