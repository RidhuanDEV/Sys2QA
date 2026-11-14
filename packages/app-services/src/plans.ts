import { validateDocument } from "@sys2qa/contract";
import { appendAudit } from "@sys2qa/platform";
import { buildTestPlan, editRisk, EXPOSURE_FLAGS, prioritizedRisks, type TestPlan } from "@sys2qa/qaa-core";
import { serviceError, ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";
import { assessStoredPackage } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const LANGUAGE = { type: "string", pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" } as const;
const SCORE = { type: "integer", minimum: 1, maximum: 5 } as const;

function checked(plan: TestPlan): TestPlan {
  const check = validateDocument("test-plan", plan);
  if (!check.ok)
    throw new ServiceError(
      "INTERNAL_ERROR",
      "internal",
      "the test plan does not match its contract schema",
      "Report it with the listed issues.",
      { issues: check.issues.slice(0, 10).map((i) => i.message) },
    );
  return plan;
}

function stored(host: Host, planId: string): { project_id: string; plan: TestPlan } {
  const row = host.state.db.prepare("SELECT project_id, doc_json FROM test_plans WHERE id = ?").get(planId) as
    { project_id: string; doc_json: string } | undefined;
  if (!row) throw serviceError("NOT_FOUND", `no test plan ${planId}`);
  return { project_id: row.project_id, plan: JSON.parse(row.doc_json) as TestPlan };
}

const planCreate = defineOperation<
  {
    project_id: string;
    package_id: string;
    version: number;
    workflow_ids?: string[];
    language?: string;
    objective?: string;
  },
  unknown
>({
  name: "plan.create",
  title: "Create a test plan",
  description:
    "Builds a test plan from an imported package (QAA-FR-030): objectives, QA objectives consistent with the evidence, scope from the discovered catalog (blocked flows and external boundaries excluded, with the reason), one transparent risk per workflow (impact, likelihood, exposure, rationale; QAA-FR-038), test basis, assumptions, exit criteria and the suggested coverage. Refused while scenario design is blocked.",
  level: "L0",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version"],
    properties: {
      project_id: ID,
      package_id: { type: "string", pattern: "^pkg:[a-z0-9][a-z0-9._-]{0,127}$" },
      version: { type: "integer", minimum: 1 },
      workflow_ids: { type: "array", minItems: 1, maxItems: 500, items: ID },
      language: LANGUAGE,
      objective: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
    },
  },
  run: async ({ host, caller }, input) => {
    const { project, row, model, manifest, result } = await assessStoredPackage(host, input);
    const design = result.assessment.activities.scenario_design;
    if (!model || design.readiness === "blocked")
      throw serviceError(
        "READINESS_BLOCKED",
        model ? "scenario design is blocked for this package and scope" : "the package has no structured model",
        { reasons: design.reasons },
      );
    const planId = host.newId("plan");
    const { plan, suggested_coverage } = buildTestPlan({
      planId,
      language: input.language ?? project.default_languages[0] ?? "en",
      packageRef: { package_id: row.package_id, package_version: row.version },
      manifest,
      model,
      readiness: result,
      ...(input.workflow_ids ? { scope: input.workflow_ids } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
    });
    checked(plan);
    host.state.transaction(() => {
      const at = host.now().toISOString();
      host.state.db
        .prepare(
          "INSERT INTO test_plans (id, project_id, baseline_json, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(planId, project.id, JSON.stringify(plan.baseline), JSON.stringify(plan), at, at);
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "plan.created",
          target: planId,
          details: { package_id: row.package_id, version: row.version, in_scope: plan.scope.in_scope.length },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return {
      plan,
      risks: prioritizedRisks(plan.risks),
      suggested_coverage,
      readiness: { scenario_design: design, flows: result.flows },
    };
  },
});

const planShow = defineOperation<{ plan_id: string }, unknown>({
  name: "plan.show",
  title: "Show a test plan",
  description:
    "A test plan with its risks in priority order (impact × likelihood, exposure as tie-breaker; a prioritization aid, not a probability) and the history of every risk edit.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["plan_id"], properties: { plan_id: ID } },
  run: ({ host }, input) => {
    const { plan } = stored(host, input.plan_id);
    const history = (
      host.state.db
        .prepare(
          "SELECT at, actor, details_json FROM audit_events WHERE action = 'plan.risk_changed' AND target = ? ORDER BY seq",
        )
        .all(input.plan_id) as Array<{ at: string; actor: string; details_json: string }>
    ).map((r) => ({ at: r.at, actor: r.actor, ...(JSON.parse(r.details_json) as Record<string, unknown>) }));
    return { plan, risks: prioritizedRisks(plan.risks), risk_history: history };
  },
});

const planList = defineOperation<{ project_id: string }, unknown>({
  name: "plan.list",
  title: "List test plans",
  description: "The project's test plans with their baseline and scope size.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["project_id"], properties: { project_id: ID } },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const rows = host.state.db
      .prepare("SELECT id, doc_json, created_at FROM test_plans WHERE project_id = ? ORDER BY created_at, id")
      .all(project.id) as Array<{ id: string; doc_json: string; created_at: string }>;
    return {
      project_id: project.id,
      plans: rows.map((r) => {
        const plan = JSON.parse(r.doc_json) as TestPlan;
        return {
          plan_id: r.id,
          baseline: plan.baseline,
          qa_objectives: plan.qa_objectives,
          in_scope: plan.scope.in_scope.length,
          risks: plan.risks.length,
          created_at: r.created_at,
        };
      }),
    };
  },
});

const planUpdateRisk = defineOperation<
  {
    plan_id: string;
    risk_id: string;
    impact?: number;
    likelihood?: number;
    exposure?: Array<(typeof EXPOSURE_FLAGS)[number]>;
    rationale: string;
  },
  unknown
>({
  name: "plan.update_risk",
  title: "Edit a plan risk",
  description:
    "Changes a risk's impact, likelihood or exposure flags with a rationale (QAA-FR-038, PRD §15.7). The plan is revalidated, and the edit is audited with the values before and after.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["plan_id", "risk_id", "rationale"],
    properties: {
      plan_id: ID,
      risk_id: ID,
      impact: SCORE,
      likelihood: SCORE,
      exposure: { type: "array", maxItems: 6, items: { enum: [...EXPOSURE_FLAGS] } },
      rationale: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
    },
  },
  run: ({ host, caller }, input) => {
    const { project_id, plan } = stored(host, input.plan_id);
    if (!plan.risks.some((r) => r.id === input.risk_id))
      throw serviceError("NOT_FOUND", `no risk ${input.risk_id} in plan ${input.plan_id}`);
    const {
      plan: updated,
      before,
      after,
    } = editRisk(plan, input.risk_id, {
      ...(input.impact !== undefined ? { impact: input.impact } : {}),
      ...(input.likelihood !== undefined ? { likelihood: input.likelihood } : {}),
      ...(input.exposure !== undefined ? { exposure: input.exposure } : {}),
      rationale: input.rationale,
    });
    checked(updated);
    const pick = (r: typeof before) => ({
      impact: r.impact,
      likelihood: r.likelihood,
      exposure: r.exposure,
      rationale: r.rationale,
    });
    host.state.transaction(() => {
      host.state.db
        .prepare("UPDATE test_plans SET doc_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(updated), host.now().toISOString(), input.plan_id);
      appendAudit(
        host.state.db,
        {
          projectId: project_id,
          actor: caller.actor,
          action: "plan.risk_changed",
          target: input.plan_id,
          details: { risk_id: input.risk_id, before: pick(before), after: pick(after) },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return { plan_id: input.plan_id, risk: after, risks: prioritizedRisks(updated.risks) };
  },
});

export const PLAN_OPERATIONS = [planCreate, planShow, planList, planUpdateRisk];
