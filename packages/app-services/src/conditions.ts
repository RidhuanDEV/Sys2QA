import { appendAudit } from "@sys2qa/platform";
import { deriveConditions, packageModel, type TestCondition, type TestPlan } from "@sys2qa/qaa-core";
import { serviceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";
import { packageRow, revalidated } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;

/** The plan and the structured model of its baseline package, revalidated. */
export function planContext(host: Host, planId: string) {
  const row = host.state.db.prepare("SELECT project_id, doc_json FROM test_plans WHERE id = ?").get(planId) as
    { project_id: string; doc_json: string } | undefined;
  if (!row) throw serviceError("NOT_FOUND", `no test plan ${planId}`);
  const plan = JSON.parse(row.doc_json) as TestPlan;
  const ref = plan.baseline.packages[0]!;
  const prepared = revalidated(packageRow(host, row.project_id, ref.package_id, ref.package_version));
  const model = packageModel(prepared);
  if (!model) throw serviceError("READINESS_BLOCKED", "the plan's package has no structured model");
  return { projectId: row.project_id, plan, model, prepared };
}

export function storedConditions(host: Host, planId: string): TestCondition[] {
  return (
    host.state.db
      .prepare("SELECT doc_json FROM test_conditions WHERE plan_id = ? ORDER BY condition_id")
      .all(planId) as Array<{ doc_json: string }>
  ).map((r) => JSON.parse(r.doc_json) as TestCondition);
}

/** Replaces a plan's stored conditions (audited); used by derivation and by scenario generation. */
export function storeConditions(
  host: Host,
  projectId: string,
  planId: string,
  conditions: TestCondition[],
  actor: string,
): void {
  host.state.transaction(() => {
    const at = host.now().toISOString();
    host.state.db.prepare("DELETE FROM test_conditions WHERE plan_id = ?").run(planId);
    const insert = host.state.db.prepare(
      "INSERT INTO test_conditions (id, plan_id, basis_refs_json, condition_id, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of conditions)
      insert.run(
        `${planId}#${c.condition_id}`,
        planId,
        JSON.stringify(c.basis_refs),
        c.condition_id,
        JSON.stringify(c),
        at,
        at,
      );
    appendAudit(
      host.state.db,
      { projectId, actor, action: "conditions.derived", target: planId, details: { conditions: conditions.length } },
      { redactor: host.redactor, now: host.now },
    );
  });
}

const conditionsDerive = defineOperation<{ plan_id: string }, unknown>({
  name: "conditions.derive",
  title: "Derive test conditions",
  description:
    "Derives the test conditions of a plan's in-scope workflows from its package (QAA-FR-048, PRD §15.4–§15.6): journeys, rule classes and boundaries, rule combinations, state transitions, role matrices with allowed and denied cases, documented error responses and labelled error guessing, each with its techniques and rationale and its basis in the package. Deriving again replaces the plan's conditions.",
  level: "L0",
  effect: "write",
  input: { type: "object", additionalProperties: false, required: ["plan_id"], properties: { plan_id: ID } },
  run: ({ host, caller }, input) => {
    const { projectId, plan, model } = planContext(host, input.plan_id);
    const conditions = deriveConditions({ plan, model });
    storeConditions(host, projectId, plan.plan_id, conditions, caller.actor);
    return summary(plan.plan_id, conditions);
  },
});

function summary(planId: string, conditions: TestCondition[]) {
  const techniques: Record<string, number> = {};
  for (const c of conditions) for (const t of c.techniques) techniques[t.id] = (techniques[t.id] ?? 0) + 1;
  return {
    plan_id: planId,
    techniques,
    needs_clarification: conditions.filter((c) => c.needs_clarification).map((c) => c.condition_id),
    conditions,
  };
}

const conditionsList = defineOperation<{ plan_id: string; technique?: string }, unknown>({
  name: "conditions.list",
  title: "List test conditions",
  description: "A plan's test conditions with their techniques, items and basis, optionally of one technique.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["plan_id"],
    properties: { plan_id: ID, technique: { type: "string", pattern: "^[a-z_]{3,40}$" } },
  },
  run: ({ host }, input) => {
    if (!host.state.db.prepare("SELECT 1 FROM test_plans WHERE id = ?").get(input.plan_id))
      throw serviceError("NOT_FOUND", `no test plan ${input.plan_id}`);
    const conditions = storedConditions(host, input.plan_id).filter(
      (c) => !input.technique || c.techniques.some((t) => t.id === input.technique),
    );
    return summary(input.plan_id, conditions);
  },
});

export const CONDITION_OPERATIONS = [conditionsDerive, conditionsList];
