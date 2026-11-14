import type { Entity, Workflow } from "@sys2qa/contract";
import type { PackageQuery } from "@sys2qa/system-model";
import type { LangText, TestPlan } from "../plan/plan.js";

/** Techniques of PRD §15.4, named as the scenario contract names them (`test_techniques[].id`). */
export type TechniqueId =
  | "equivalence_partitioning"
  | "boundary_value_analysis"
  | "decision_table"
  | "state_transition"
  | "use_case"
  | "negative"
  | "error_guessing"
  | "exploratory_charter"
  | "role_matrix";

/** Expected-result basis of PRD §15.9 that a condition item can claim from a package. */
export type ItemBasis = "saa_documented" | "source_supported" | "observed" | "inferred";

/** One thing to test inside a condition: an input class, a boundary, a transition, a role, a branch. */
export interface ConditionItem {
  id: string;
  description: string;
  /** What the item feeds the system, described, never concrete test data (scenario generation picks the data). */
  input: string;
  expected: string;
  basis: ItemBasis;
  /** The package records the item rests on. */
  refs: string[];
}

/** A test condition derived from the test basis (QAA-FR-048, PRD §15.1 analysis). */
export interface TestCondition {
  condition_id: string;
  plan_id: string;
  title: LangText;
  workflow_ids: string[];
  techniques: Array<{ id: TechniqueId; rationale: string }>;
  /** Each item of the basis: the package and the record (QAA-FR-048, §15.2 provenance). */
  basis_refs: Array<{ kind: "package_entity" | "package_workflow"; package: string; ref: string; status: string }>;
  items: ConditionItem[];
  /** Why the condition cannot be designed as is (an inferred role, an unknown path); scenarios become clarifications. */
  needs_clarification?: string;
}

/** A local key from a semantic ID: kind and namespace dropped, path segments and parameters joined by dots. */
export function conditionKey(id: string): string {
  const [kind, ...rest] = id.split(":");
  let local = rest.join(":");
  if (kind === "api") local = local.replace(/^[A-Z]+:/, "").replace(/^\/api\//, "/");
  if (kind === "page" || kind === "form") local = local.replace(/^[a-z0-9_-]+:/, "");
  return local
    .replace(/[{}]/g, "")
    .split(/[^A-Za-z0-9_.]+/)
    .filter(Boolean)
    .join(".")
    .toLowerCase();
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

interface Boundary {
  field?: string;
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  pattern?: string;
  format?: string;
  enum?: unknown[];
}

const basisOf = (status: string | undefined): ItemBasis =>
  status === "source_verified" || status === "test_verified"
    ? "source_supported"
    : status === "runtime_observed"
      ? "observed"
      : "inferred";

function onViolation(rule: Entity): string {
  const behavior = (rule as { expected_behavior?: { on_violation?: string } }).expected_behavior;
  return behavior?.on_violation ? `rejected (${behavior.on_violation})` : "rejected";
}

function ruleItems(rule: Entity): { ep: ConditionItem[]; bva: ConditionItem[] } {
  const bounds = ((rule as { boundaries?: Boundary[] }).boundaries ?? []).filter(Boolean);
  const basis = basisOf(rule.status);
  const refs = [rule.id];
  const reject = onViolation(rule);
  const ep: ConditionItem[] = [];
  const bva: ConditionItem[] = [];
  const add = (list: ConditionItem[], tag: string, description: string, input: string, expected: string) =>
    list.push({ id: `${tag}`, description, input, expected, basis, refs });
  for (const b of bounds) {
    const field = b.field ?? "the value";
    add(ep, "valid", `A valid ${field}`, `${field} satisfying every constraint`, "accepted");
    if (b.min_length !== undefined || b.max_length !== undefined) {
      const lengths = new Set<number>();
      for (const n of [b.min_length, b.max_length]) if (n !== undefined) for (const d of [-1, 0, 1]) lengths.add(n + d);
      for (const n of [...lengths].filter((x) => x >= 0).sort((x, y) => x - y)) {
        const inside =
          (b.min_length === undefined || n >= b.min_length) && (b.max_length === undefined || n <= b.max_length);
        add(
          bva,
          `length-${n}`,
          `${field} of length ${n}`,
          `${field} with ${n} character(s)`,
          inside ? "accepted" : reject,
        );
      }
      if (b.min_length !== undefined && b.min_length > 0)
        add(ep, "empty", `An empty ${field}`, `${field} left empty`, reject);
    }
    if (b.min !== undefined || b.max !== undefined) {
      const values = new Set<number>();
      for (const n of [b.min, b.max]) if (n !== undefined) for (const d of [-1, 0, 1]) values.add(n + d);
      for (const n of [...values].sort((x, y) => x - y)) {
        const inside = (b.min === undefined || n >= b.min) && (b.max === undefined || n <= b.max);
        add(bva, `value-${n}`, `${field} = ${n}`, `${field} set to ${n}`, inside ? "accepted" : reject);
      }
      if (b.integer) add(ep, "non-integer", `A non-integer ${field}`, `${field} with a fractional part`, reject);
    }
    if (b.pattern)
      add(
        ep,
        "pattern-mismatch",
        `A ${field} not matching ${b.pattern}`,
        `${field} of a valid length with a disallowed character`,
        reject,
      );
    if (b.format)
      add(
        ep,
        "format-invalid",
        `A ${field} that is not a valid ${b.format}`,
        `${field} in the wrong ${b.format} format`,
        reject,
      );
    if (b.enum)
      add(
        ep,
        "enum-invalid",
        `A ${field} outside its allowed values`,
        `${field} set to a value not in the list`,
        reject,
      );
  }
  const unique = (list: ConditionItem[]) => [...new Map(list.map((i) => [i.id, i])).values()];
  return { ep: unique(ep), bva: unique(bva) };
}

function withIds(conditionId: string, items: ConditionItem[]): ConditionItem[] {
  return items.map((item) => ({ ...item, id: `${conditionId}#${item.id}` }));
}

/**
 * The technique engine (PRD §15.4–§15.6, QAA-FR-031/042/048): test conditions for the in-scope workflows of a plan,
 * each from identifiable package records and with the techniques that apply and why. Techniques are applied
 * selectively: boundary values only where ordered limits exist, decision tables only where several rules combine,
 * state transitions only for documented state machines, role matrices only for guarded steps (one allowed and one
 * denied case at least), negative cases for documented error responses, error guessing as a labelled heuristic.
 * Unknown paths are never filled in: a condition that cannot be designed says why (`needs_clarification`).
 */
export function deriveConditions(input: { plan: TestPlan; model: PackageQuery }): TestCondition[] {
  const { plan, model } = input;
  const language = plan.content_language;
  const pkg = `${plan.baseline.packages[0]!.package_id}@${plan.baseline.packages[0]!.package_version}`;
  const out = new Map<string, TestCondition>();
  const ref = (id: string) => ({
    kind: "package_entity" as const,
    package: pkg,
    ref: id,
    status: model.entity(id)?.status ?? "unknown",
  });
  const upsert = (c: TestCondition) => {
    const existing = out.get(c.condition_id);
    if (existing) {
      existing.workflow_ids = [...new Set([...existing.workflow_ids, ...c.workflow_ids])];
      return;
    }
    out.set(c.condition_id, c);
  };

  const workflows = plan.scope.in_scope.map((id) => model.workflow(id)).filter((w): w is Workflow => Boolean(w));
  const roles = model.byKind("actor_role");
  for (const workflow of workflows) {
    const path = [...new Set([...workflow.entry_point_ids, ...workflow.steps.map((s) => s.entity_id)])];

    // Journey (use case): the main path and each documented branch.
    // The entry point's kind stays in the key: a page and an API with the same path are different journeys.
    const entry = workflow.entry_point_ids[0] ?? workflow.id;
    const journeyId = `tc:${entry.split(":")[0]}.${conditionKey(entry)}_journey`;
    upsert({
      condition_id: journeyId,
      plan_id: plan.plan_id,
      title: { language, value: `${workflow.name}: main path and documented branches` },
      workflow_ids: [workflow.id],
      techniques: [
        {
          id: "use_case",
          rationale: `The catalog documents ${workflow.steps.length} step(s) and ${workflow.branches.length} branch(es) for this workflow.`,
        },
      ],
      basis_refs: [{ kind: "package_workflow", package: pkg, ref: workflow.id, status: workflow.status }],
      items: withIds(journeyId, [
        {
          id: "main",
          description: "The main path from the entry point to the last documented step",
          input: workflow.steps.map((s) => `${s.action} ${s.entity_id}`).join(" → "),
          expected: "every step completes",
          basis: basisOf(workflow.status),
          refs: [workflow.id],
        },
        ...workflow.branches.map((b, i) => ({
          id: `branch-${i + 1}`,
          description: `Branch at ${b.from_step}: ${b.condition}`,
          input: b.condition,
          expected: b.outcome,
          basis: basisOf(b.status),
          refs: [workflow.id],
        })),
      ]),
      ...(workflow.unresolved_hops.length > 0
        ? {
            needs_clarification: `The path is not known beyond ${workflow.unresolved_hops.map((h) => h.after_step).join(", ")}; expectations stop there.`,
          }
        : {}),
    });

    // Rules on the path: equivalence classes and, where ordered limits exist, boundary values.
    const rules = new Set<string>();
    for (const id of path) for (const r of model.related(id, "in", "VALIDATES")) rules.add(r.from);
    for (const ruleId of [...rules].sort()) {
      const rule = model.entity(ruleId);
      if (!rule) continue;
      const { ep, bva } = ruleItems(rule);
      const conditionId = `tc:${ruleId.replace(/^business_rule:/, "")}`;
      const techniques: TestCondition["techniques"] = [];
      if (ep.length > 0)
        techniques.push({
          id: "equivalence_partitioning",
          rationale: `The rule splits input into valid and invalid classes: ${String((rule as { statement?: string }).statement ?? rule.name)}`,
        });
      if (bva.length > 0)
        techniques.push({
          id: "boundary_value_analysis",
          rationale: "The rule has ordered limits; values on and next to each limit are tested.",
        });
      techniques.push({ id: "negative", rationale: `A violation is ${onViolation(rule)} per the package.` });
      upsert({
        condition_id: conditionId,
        plan_id: plan.plan_id,
        title: { language, value: String((rule as { statement?: string }).statement ?? rule.name) },
        workflow_ids: [workflow.id],
        techniques,
        basis_refs: [ref(ruleId), ...((rule as { inputs?: string[] }).inputs ?? []).map(ref)],
        items: withIds(conditionId, [...ep, ...bva]),
        ...(rule.status === "inferred"
          ? { needs_clarification: "The rule is inferred; its expected result needs confirmation." }
          : {}),
      });
    }

    // Several rules on one schema combine: a decision table of valid and invalid inputs.
    const bySchema = new Map<string, string[]>();
    for (const ruleId of rules) {
      const schema = (model.entity(ruleId) as { source_schema?: string } | undefined)?.source_schema;
      if (schema) bySchema.set(schema, [...(bySchema.get(schema) ?? []), ruleId]);
    }
    for (const [schema, ids] of bySchema) {
      if (ids.length < 2) continue;
      const key = ids[0]!.replace(/^business_rule:/, "").split(".")[0]!;
      const conditionId = `tc:${key}.combinations`;
      const sorted = [...ids].sort();
      upsert({
        condition_id: conditionId,
        plan_id: plan.plan_id,
        title: { language, value: `Combinations of the ${sorted.length} rules of ${schema}` },
        workflow_ids: [workflow.id],
        techniques: [
          { id: "decision_table", rationale: `${sorted.length} rules of ${schema} decide the outcome together.` },
        ],
        basis_refs: sorted.map(ref),
        items: withIds(conditionId, [
          {
            id: "all-valid",
            description: "Every rule satisfied",
            input: "all fields valid",
            expected: "accepted",
            basis: "source_supported",
            refs: sorted,
          },
          ...sorted.map((r) => ({
            id: `only-${r.replace(/^business_rule:[^.]+\./, "")}`,
            description: `Only ${r} violated`,
            input: `${r} violated, every other rule satisfied`,
            expected: onViolation(model.entity(r)!),
            basis: basisOf(model.entity(r)?.status),
            refs: [r],
          })),
          {
            id: "all-invalid",
            description: "Every rule violated",
            input: "all fields invalid",
            expected: "rejected",
            basis: "source_supported",
            refs: sorted,
          },
        ]),
      });
    }

    // Documented state machines: every valid transition, and the known invalid ones.
    for (const id of path) {
      const machine = model.entity(id);
      if (machine?.kind !== "state_machine") continue;
      const m = machine as unknown as {
        transitions?: Array<{ from: string; to: string; status?: string; guard?: string }>;
        invalid_transitions_known?: Array<{ from: string; to: string; status?: string }>;
      };
      const conditionId = `tc:${id.replace(/^state_machine:/, "")}_transitions`;
      upsert({
        condition_id: conditionId,
        plan_id: plan.plan_id,
        title: { language, value: `Transitions of ${id}` },
        workflow_ids: [workflow.id],
        techniques: [
          {
            id: "state_transition",
            rationale: `The package documents ${m.transitions?.length ?? 0} valid and ${m.invalid_transitions_known?.length ?? 0} known invalid transition(s).`,
          },
        ],
        basis_refs: [ref(id)],
        items: withIds(conditionId, [
          ...(m.transitions ?? []).map((t) => ({
            id: `${t.from}-${t.to}`,
            description: `${t.from} → ${t.to}${t.guard ? ` (guard: ${t.guard})` : ""}`,
            input: `an item in ${t.from} moved to ${t.to}`,
            expected: "allowed",
            basis: basisOf(t.status ?? machine.status),
            refs: [id],
          })),
          ...(m.invalid_transitions_known ?? []).map((t) => ({
            id: `${t.from}-${t.to}-refused`,
            description: `${t.from} → ${t.to} (invalid)`,
            input: `an item in ${t.from} moved to ${t.to}`,
            expected: "refused",
            basis: basisOf(t.status ?? machine.status),
            refs: [id],
          })),
        ]),
      });
    }

    // Guarded steps: a role matrix with allowed and denied cases (QAA-FR-042, PRD §15.6).
    for (const id of path) {
      const guards = model.related(id, "out", "AUTHORIZES_WITH").map((r) => r.to);
      if (guards.length === 0) continue;
      const others = roles.filter((r) => !guards.includes(r.id));
      const conditionId = `tc:${conditionKey(id)}_access`;
      const inferred = guards.filter((g) => model.entity(g)?.status === "inferred");
      upsert({
        condition_id: conditionId,
        plan_id: plan.plan_id,
        title: { language, value: `Access to ${model.entity(id)?.name ?? id} by role` },
        workflow_ids: [workflow.id],
        techniques: [
          {
            id: "role_matrix",
            rationale: `${id} is guarded by ${guards.join(", ")}; each allowed role and the others are tried.`,
          },
        ],
        basis_refs: [ref(id), ...guards.map(ref)],
        items: withIds(conditionId, [
          ...guards.map((g) => ({
            id: `allowed-${g.replace(/^actor_role:/, "")}`,
            description: `${model.entity(g)?.name ?? g} is allowed`,
            input: `signed in as ${model.entity(g)?.name ?? g}`,
            expected: "allowed",
            basis: basisOf(model.entity(g)?.status),
            refs: [id, g],
          })),
          ...others.map((r) => ({
            id: `denied-${r.id.replace(/^actor_role:/, "")}`,
            description: `${r.name} is denied`,
            input: `signed in as ${r.name}`,
            expected: "denied",
            basis: basisOf(r.status),
            refs: [id, ...guards, r.id],
          })),
          {
            id: "denied-anonymous",
            description: "An unauthenticated request is denied",
            input: "not signed in",
            expected: "denied",
            basis: basisOf(model.entity(id)?.status),
            refs: [id, ...guards],
          },
        ]),
        ...(inferred.length > 0
          ? { needs_clarification: `${inferred.join(", ")} is inferred; confirm the role before testing it.` }
          : {}),
      });
    }

    // Documented error responses other than validation: negative cases.
    for (const id of path) {
      const responses =
        (
          model.entity(id) as
            | { error_responses?: Array<{ status: number; outcome: string; message?: string; condition?: string }> }
            | undefined
        )?.error_responses ?? [];
      for (const response of responses) {
        if (response.outcome === "validation_error") continue;
        const conditionId = `tc:${conditionKey(id)}.${slug(response.message ?? response.outcome)}`;
        upsert({
          condition_id: conditionId,
          plan_id: plan.plan_id,
          title: {
            language,
            value: `${model.entity(id)?.name ?? id} answers ${response.status} (${response.message ?? response.outcome})`,
          },
          workflow_ids: [workflow.id],
          techniques: [
            {
              id: "negative",
              rationale: `The package documents HTTP ${response.status} ${response.outcome} when ${response.condition ?? "the condition holds"}.`,
            },
          ],
          basis_refs: [ref(id)],
          items: withIds(conditionId, [
            {
              id: response.outcome,
              description: `Trigger: ${response.condition ?? response.outcome}`,
              input: response.condition ?? response.outcome,
              expected: `HTTP ${response.status} ${response.outcome}${response.message ? ` ("${response.message}")` : ""}`,
              basis: basisOf(model.entity(id)?.status),
              refs: [id],
            },
          ]),
        });
      }
    }

    // Forms: error guessing, a labelled heuristic whose basis is at most inferred (PRD §15.4).
    for (const id of path) {
      const form = model.entity(id);
      if (form?.kind !== "form") continue;
      const fields = (form as { inputs?: string[] }).inputs ?? [];
      if (fields.length === 0) continue;
      const conditionId = `tc:${conditionKey(id)}_error_guessing`;
      upsert({
        condition_id: conditionId,
        plan_id: plan.plan_id,
        title: { language, value: `Likely failure points of form ${form.name}` },
        workflow_ids: [workflow.id],
        techniques: [
          {
            id: "error_guessing",
            rationale: "Heuristic: common input mistakes on a form with free-text fields; not documented behavior.",
          },
        ],
        basis_refs: [ref(id), ...fields.map(ref)],
        items: withIds(conditionId, [
          {
            id: "whitespace",
            description: "Values with leading or trailing spaces",
            input: "each field padded with spaces",
            expected: "handled consistently",
            basis: "inferred",
            refs: [id],
          },
          {
            id: "double-submit",
            description: "The form submitted twice quickly",
            input: "two submissions",
            expected: "one effect",
            basis: "inferred",
            refs: [id],
          },
        ]),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.condition_id.localeCompare(b.condition_id));
}
