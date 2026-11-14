import type { PackageQuery } from "@sys2qa/system-model";
import type { TestCondition } from "../conditions/conditions.js";
import { rulesOnPath } from "../model/paths.js";
import type { TestPlan } from "../plan/plan.js";
import type { Scenario } from "../scenarios/generator.js";

/** A coverage ratio with what is behind it; `of` is the stated scope, never the whole system. */
export interface Ratio {
  covered: number;
  of: number;
  ratio: number | null;
}

const ratio = (covered: number, of: number): Ratio => ({ covered, of, ratio: of === 0 ? null : covered / of });

export interface CoverageReport {
  scope_statement: string;
  workflows: {
    designed: Ratio;
    approved: Ratio;
    uncovered: string[];
    branches: { designed: Ratio; approved: Ratio; uncovered: Array<{ workflow_id: string; branch: number; condition: string }> };
    /** What the plan leaves out of QA scope (catalog workflows and excluded boundaries): listed, never dropped. */
    outside_scope: string[];
  };
  rules: {
    designed: Ratio;
    approved: Ratio;
    per_rule: Array<{ rule_id: string; techniques: Record<string, { designed: boolean; approved: boolean }> }>;
    uncovered: string[];
  };
  role_permissions: {
    designed: Ratio;
    approved: Ratio;
    pairs: Array<{ role: string; step: string; allowed: { designed: boolean; approved: boolean }; denied: { designed: boolean; approved: boolean } }>;
    uncovered: Array<{ role: string; step: string }>;
  };
  pages: { designed: Ratio; approved: Ratio; uncovered: string[] };
  execution: { executed: number; of: number; ratio: number | null; note: string };
}

const LIVE = new Set(["draft", "needs_clarification", "pending_review", "approved"]);

/**
 * Coverage relative to the system model and the plan's scope (PRD §15.11, QAA-FR-044). "Designed" counts scenarios
 * that are not rejected, deferred or superseded; "approved" counts those with an active approval. Workflow coverage per workflow and
 * per documented branch; rule coverage per technique that applies to the rule; role-permission coverage per guarded
 * (role, step) pair with an allowed and a denied case; page coverage for documented pages on in-scope workflows. Every
 * ratio states its scope and lists what is not covered; nothing claims completeness of the system.
 */
export function computeCoverage(input: {
  plan: TestPlan;
  conditions: TestCondition[];
  scenarios: Scenario[];
  model: PackageQuery;
  /** Scenarios with an active approval (a suspended or invalidated approval does not count). */
  approved: ReadonlySet<string>;
  /** Scenarios with a recorded case result in a run. */
  executed?: ReadonlySet<string>;
}): CoverageReport {
  const { plan, model } = input;
  const live = input.scenarios.filter((s) => LIVE.has(s.status));
  const approved = live.filter((s) => input.approved.has(s.scenario_id));
  const inScope = plan.scope.in_scope.map((id) => model.workflow(id)).filter((w) => w !== undefined);
  // Scenario IDs end in the condition item they test, cleaned as the generator cleans it.
  const endsWithItem = (s: Scenario, item: string) =>
    s.scenario_id.endsWith(`.${item.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`);
  const withCondition = (list: Scenario[], condition: string) => list.filter((s) => s.test_condition_ids.includes(condition));

  // Workflows and branches.
  const wfDesigned = inScope.filter((w) => live.some((s) => s.feature_ref === w.id));
  const wfApproved = inScope.filter((w) => approved.some((s) => s.feature_ref === w.id));
  const journeyOf = new Map(
    input.conditions.filter((c) => c.condition_id.endsWith("_journey")).flatMap((c) => c.workflow_ids.map((w) => [w, c.condition_id] as const)),
  );
  const branches = inScope.flatMap((w) => w.branches.map((b, i) => ({ workflow_id: w.id, branch: i + 1, condition: b.condition, journey: journeyOf.get(w.id) })));
  const branchCovered = (list: Scenario[], b: (typeof branches)[number]) =>
    b.journey !== undefined && withCondition(list, b.journey).some((s) => endsWithItem(s, `branch-${b.branch}`));

  // Rules and their techniques.
  const rules = rulesOnPath(model, inScope.flatMap((w) => [...w.entry_point_ids, ...w.steps.map((s) => s.entity_id)]));
  const perRule = rules.map((rule) => {
    const condition = input.conditions.find((c) => c.condition_id === `tc:${rule.replace(/^business_rule:/, "")}`);
    const techniques: Record<string, { designed: boolean; approved: boolean }> = {};
    for (const t of condition?.techniques ?? []) {
      const uses = (list: Scenario[]) => withCondition(list, condition!.condition_id).some((s) => s.test_techniques.some((x) => x.id === t.id));
      techniques[t.id] = { designed: uses(live), approved: uses(approved) };
    }
    return { rule_id: rule, techniques };
  });
  const ruleCovered = (r: (typeof perRule)[number], level: "designed" | "approved") =>
    Object.keys(r.techniques).length > 0 && Object.values(r.techniques).every((t) => t[level]);

  // Guarded (role, step) pairs.
  const pairs: CoverageReport["role_permissions"]["pairs"] = [];
  const seenPairs = new Set<string>();
  for (const w of inScope)
    for (const step of new Set([...w.entry_point_ids, ...w.steps.map((s) => s.entity_id)]))
      for (const r of model.related(step, "out", "AUTHORIZES_WITH")) {
        const key = `${r.to}\0${step}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const condition = input.conditions.find((c) => c.condition_id.endsWith("_access") && c.basis_refs.some((b) => b.ref === step));
        const cases = (list: Scenario[], kind: "allowed" | "denied") =>
          condition !== undefined &&
          withCondition(list, condition.condition_id).some((s) =>
            kind === "allowed"
              ? endsWithItem(s, `allowed-${r.to.replace(/^actor_role:/, "")}`)
              : /\.denied-[^.]*$/.test(s.scenario_id),
          );
        pairs.push({
          role: r.to,
          step,
          allowed: { designed: cases(live, "allowed"), approved: cases(approved, "allowed") },
          denied: { designed: cases(live, "denied"), approved: cases(approved, "denied") },
        });
      }
  const pairCovered = (p: (typeof pairs)[number], level: "designed" | "approved") => p.allowed[level] && p.denied[level];

  // Documented pages on in-scope workflows.
  const pages = [
    ...new Set(inScope.flatMap((w) => [...w.entry_point_ids, ...w.steps.map((s) => s.entity_id)]).filter((id) => model.entity(id)?.kind === "page")),
  ].sort();
  const pathOf = new Map(inScope.map((w) => [w.id, new Set([...w.entry_point_ids, ...w.steps.map((s) => s.entity_id)])]));
  const pageCovered = (list: Scenario[], page: string) => list.some((s) => pathOf.get(s.feature_ref)?.has(page));

  const executed = input.executed ?? new Set<string>();
  return {
    scope_statement: `Relative to package ${plan.baseline.packages[0]!.package_id}@${plan.baseline.packages[0]!.package_version} and plan ${plan.plan_id} (${inScope.length} in-scope workflow(s)); it does not measure the completeness of the system.`,
    workflows: {
      designed: ratio(wfDesigned.length, inScope.length),
      approved: ratio(wfApproved.length, inScope.length),
      uncovered: inScope.filter((w) => !wfApproved.includes(w)).map((w) => w.id),
      branches: {
        designed: ratio(branches.filter((b) => branchCovered(live, b)).length, branches.length),
        approved: ratio(branches.filter((b) => branchCovered(approved, b)).length, branches.length),
        uncovered: branches.filter((b) => !branchCovered(approved, b)).map(({ workflow_id, branch, condition }) => ({ workflow_id, branch, condition })),
      },
      outside_scope: [
        ...new Set([
          ...plan.scope.out_of_scope,
          ...model
            .workflows()
            .map((w) => w.id)
            .filter((id) => !plan.scope.in_scope.includes(id)),
        ]),
      ],
    },
    rules: {
      designed: ratio(perRule.filter((r) => ruleCovered(r, "designed")).length, perRule.length),
      approved: ratio(perRule.filter((r) => ruleCovered(r, "approved")).length, perRule.length),
      per_rule: perRule,
      uncovered: perRule.filter((r) => !ruleCovered(r, "approved")).map((r) => r.rule_id),
    },
    role_permissions: {
      designed: ratio(pairs.filter((p) => pairCovered(p, "designed")).length, pairs.length),
      approved: ratio(pairs.filter((p) => pairCovered(p, "approved")).length, pairs.length),
      pairs,
      uncovered: pairs.filter((p) => !pairCovered(p, "approved")).map(({ role, step }) => ({ role, step })),
    },
    pages: {
      designed: ratio(pages.filter((p) => pageCovered(live, p)).length, pages.length),
      approved: ratio(pages.filter((p) => pageCovered(approved, p)).length, pages.length),
      uncovered: pages.filter((p) => !pageCovered(approved, p)),
    },
    execution: {
      executed: approved.filter((s) => executed.has(s.scenario_id)).length,
      of: approved.length,
      ratio: approved.length === 0 ? null : approved.filter((s) => executed.has(s.scenario_id)).length / approved.length,
      note: "Approved scenarios of this plan executed in a recorded run (manual or automated) / approved scenarios.",
    },
  };
}
