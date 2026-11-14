import { computeCoverage, type Scenario } from "@sys2qa/qaa-core";
import { planContext, storedConditions } from "./conditions.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;

const coverageReport = defineOperation<{ plan_id: string }, unknown>({
  name: "coverage.report",
  title: "Coverage report",
  description:
    "Coverage of a plan relative to its package's system model and the plan's scope (QAA-FR-044, PRD §15.11): workflows and their documented branches, rules per applicable technique, guarded role-permission pairs with an allowed and a denied case, documented pages, and approved scenarios executed; each as designed and approved, with what is not covered and the workflows outside scope. It never claims completeness of the system.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["plan_id"], properties: { plan_id: ID } },
  run: ({ host }, input) => planCoverage(host, input.plan_id),
});

/** Coverage of one plan relative to its package's model (PRD §15.11), as `coverage.report` returns it. */
export function planCoverage(host: Host, planId: string) {
  const { projectId, plan, model } = planContext(host, planId);
  const conditions = storedConditions(host, plan.plan_id);
  const conditionIds = new Set(conditions.map((c) => c.condition_id));
  const packageId = plan.baseline.packages[0]?.package_id;
  const scenarios = (
    host.state.db
      .prepare(
        `SELECT v.doc_json FROM scenarios s
         JOIN scenario_versions v ON v.scenario_id = s.scenario_id AND v.version = s.latest_version
         WHERE s.project_id = ?`,
      )
      .all(projectId) as Array<{ doc_json: string }>
  )
    .map((r) => JSON.parse(r.doc_json) as Scenario)
    .filter(
      (s) =>
        s.test_condition_ids.some((id) => conditionIds.has(id)) && s.baseline.packages[0]?.package_id === packageId,
    );
  const ids = (sql: string) =>
    new Set((host.state.db.prepare(sql).all(projectId) as Array<{ scenario_id: string }>).map((r) => r.scenario_id));
  const approved = ids(
    `SELECT DISTINCT a.scenario_id FROM approvals a JOIN scenarios s ON s.scenario_id = a.scenario_id
     WHERE s.project_id = ? AND a.state = 'active'`,
  );
  const executed = ids("SELECT DISTINCT scenario_id FROM case_results WHERE project_id = ?");
  return {
    plan_id: plan.plan_id,
    coverage: computeCoverage({ plan, conditions, scenarios, model, approved, executed }),
  };
}

export const COVERAGE_OPERATIONS = [coverageReport];
