import { createHash } from "node:crypto";
import type { Entity, Evidence, Gap, Relationship } from "@sys2qa/contract";
import { scopedId } from "./config.js";
import { snakeCase } from "./datamodel.js";
import type { StructuralFacts } from "./graph.js";
import type { TraceDetails } from "./trace.js";

// Shapes recorded on module and file entities by the adapters (js-ts rules.ts, sql prisma.ts).
interface SchemaField {
  name: string;
  base: string;
  checks: Array<{ kind: string; value?: number | string; message?: string }>;
  optional: boolean;
  text: string;
  evidence: string;
}
interface ModuleFacts {
  id: string;
  path: string;
  project_boundary: string;
  validation_schemas?: Array<{ name: string; library: string; fields: SchemaField[]; evidence: string }>;
  transition_tables?: Array<{
    name: string;
    type?: string;
    states: string[];
    transitions: Array<{ from: string; to: string }>;
    guards: string[];
    evidence: string;
  }>;
  prisma?: { enums: Array<{ name: string; values: string[]; evidence: string }> };
}

export interface RuleLinks {
  entities: Entity[];
  relationships: Relationship[];
  gaps: Gap[];
}

/** The branch outcome an error status stands for; a 400 about a token is `invalid_token`. */
export function outcomeOf(status: number, message?: string): string {
  if (status === 400) return /token/i.test(message ?? "") ? "invalid_token" : "bad_request";
  const known: Record<number, string> = {
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    410: "gone",
    413: "too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
  };
  return known[status] ?? (status >= 500 ? "server_error" : `http_${status}`);
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** `registrationSchema` → `registration`, `CreateOrderInput` → `create_order_input`. */
function schemaKey(name: string): string {
  return snakeCase(name.replace(/(Schema|Validator|Validation)$/, "")) || snakeCase(name);
}

interface RuleDraft {
  key: string;
  statement: string;
  technical: string;
  boundaries: Array<Record<string, unknown>>;
}

/** One business rule per constraint group of a schema field (SAA-FR-032). */
export function rulesOfField(field: SchemaField): RuleDraft[] {
  const f = field.name;
  const check = (kind: string) => field.checks.find((c) => c.kind === kind);
  const num = (kind: string) => {
    const v = check(kind)?.value;
    return typeof v === "number" ? v : undefined;
  };
  const technical = `${field.text}${field.optional ? " (optional)" : ""}`;
  const drafts: RuleDraft[] = [];
  const regex = check("regex")?.value;
  if (typeof regex === "string") {
    const digits = /^\/\^(?:\[0-9\]|\\d)\{(\d+)\}\$\/[a-z]*$/.exec(regex);
    if (digits)
      drafts.push({
        key: `${f}_${digits[1]}_digits`,
        statement: `${f} must be exactly ${digits[1]} digits.`,
        technical,
        boundaries: [{ field: f, min_length: Number(digits[1]), max_length: Number(digits[1]), pattern: regex }],
      });
    else
      drafts.push({
        key: `${f}_pattern`,
        statement: `${f} must match ${regex}.`,
        technical,
        boundaries: [{ field: f, pattern: regex }],
      });
  }
  for (const format of ["email", "url", "uuid"])
    if (check(format))
      drafts.push({
        key: `${f}_${format}_format`,
        statement: `${f} must be a valid ${format}.`,
        technical,
        boundaries: [{ field: f, format }],
      });
  if (field.base === "string") {
    const exact = num("length");
    const min = num("min");
    const max = num("max");
    if (exact !== undefined)
      drafts.push({
        key: `${f}_exactly_${exact}_characters`,
        statement: `${f} must be exactly ${exact} characters.`,
        technical,
        boundaries: [{ field: f, min_length: exact, max_length: exact }],
      });
    else if (min === 1 && max === undefined)
      drafts.push({
        key: `${f}_required`,
        statement: `${f} must not be empty.`,
        technical,
        boundaries: [{ field: f, min_length: 1 }],
      });
    else if (min !== undefined || max !== undefined)
      drafts.push({
        key:
          min !== undefined && max !== undefined
            ? `${f}_${min}_to_${max}_characters`
            : min !== undefined
              ? `${f}_min_${min}_characters`
              : `${f}_max_${max}_characters`,
        statement:
          min !== undefined && max !== undefined
            ? `${f} must be ${min} to ${max} characters long.`
            : min !== undefined
              ? `${f} must be at least ${min} characters long.`
              : `${f} must be at most ${max} characters long.`,
        technical,
        boundaries: [
          {
            field: f,
            ...(min !== undefined ? { min_length: min } : {}),
            ...(max !== undefined ? { max_length: max } : {}),
          },
        ],
      });
  }
  if (field.base === "number" || field.base === "bigint") {
    const min = num("min") ?? num("gte") ?? (check("positive") ? 1 : check("nonnegative") ? 0 : undefined);
    const max = num("max") ?? num("lte") ?? (check("negative") ? -1 : check("nonpositive") ? 0 : undefined);
    const integer = check("int") !== undefined;
    if (min !== undefined || max !== undefined)
      drafts.push({
        key:
          min !== undefined && max !== undefined
            ? `${f}_${min}_to_${max}`
            : min !== undefined
              ? `${f}_min_${min}`
              : `${f}_max_${max}`,
        statement: `${f} must be ${integer ? "an integer " : ""}${
          min !== undefined && max !== undefined
            ? `from ${min} to ${max}`
            : min !== undefined
              ? `at least ${min}`
              : `at most ${max}`
        }.`,
        technical,
        boundaries: [
          {
            field: f,
            ...(min !== undefined ? { min } : {}),
            ...(max !== undefined ? { max } : {}),
            ...(integer ? { integer } : {}),
          },
        ],
      });
    else if (integer)
      drafts.push({
        key: `${f}_integer`,
        statement: `${f} must be an integer.`,
        technical,
        boundaries: [{ field: f, integer }],
      });
  }
  return drafts;
}

/**
 * Rules, roles, state machines and error outcomes (IMP-112, SAA-FR-030, SAA-FR-032, SAA-FR-033, SAA-FR-034).
 *
 * - Business rules: one `business_rule` per constraint of a validation schema field (zod), `business_rule:<schema>.
 *   <field>_<constraint>`, with the code as `technical_rule` and `business_intent` left null (intent is not in code).
 *   `VALIDATES` links a rule to each endpoint whose code validates with it; the fields of forms submitting there are its
 *   inputs. A database CHECK with the same bounds is added as evidence.
 * - Roles: `actor_role` from role enums (Prisma `enum *Role*`) and from literal arguments of middleware that answers 403;
 *   `AUTHORIZES_WITH` from the endpoint to the role, `AUTHENTICATES_WITH` to middleware that answers 401. Without any
 *   check, a gap.
 * - State machines: a closed transition table (`{ A: ["B"], B: [] }`) is a `state_machine` named after its key type
 *   (`OrderStatus` → `state_machine:order.status`), with transitions, the guard that reads it and every other pair as a
 *   known invalid transition. A status column with no state machine is a gap.
 * - Outcomes: each endpoint gets `error_responses` (status, outcome, condition, where it is sent) for the workflow
 *   composer's branches.
 */
export function linkRules(
  facts: StructuralFacts,
  derived: { entities: Entity[]; relationships: Relationship[] },
  details: Map<string, TraceDetails>,
): RuleLinks {
  const out: RuleLinks = { entities: [], relationships: [], gaps: [] };
  const modules = new Map<string, ModuleFacts>();
  for (const e of facts.entities)
    if (e.kind === "module" || e.kind === "file") modules.set(e.id, e as unknown as ModuleFacts);
  const allEntities = [...facts.entities, ...derived.entities];
  const byId = new Map(allEntities.map((e) => [e.id, e]));
  const lineOf = new Map(facts.evidence.map((e: Evidence) => [e.id, e.range?.start_line ?? 0] as const));
  const relate = (type: Relationship["type"], from: string, to: string, evidence: string[]) => {
    const id = `relationship:${hash16(type, from, to)}`;
    if (!out.relationships.some((r) => r.id === id))
      out.relationships.push({ id, type, from, to, status: "source_verified", evidence_ids: evidence.slice(0, 10) });
  };
  const addEntity = (entity: Entity) => {
    if (byId.has(entity.id) || out.entities.some((e) => e.id === entity.id)) return false;
    out.entities.push(entity);
    return true;
  };
  const apis = derived.entities.filter((e) => e.kind === "api");

  // ---------------------------------------------------------------- business rules
  const rulesBySchema = new Map<string, Array<{ id: string; field: string }>>(); // `${module}\0${schema}`
  for (const m of modules.values())
    for (const schema of m.validation_schemas ?? []) {
      const list: Array<{ id: string; field: string }> = [];
      for (const field of schema.fields)
        for (const draft of rulesOfField(field)) {
          const id = scopedId("business_rule", m.project_boundary, `${schemaKey(schema.name)}.${draft.key}`);
          list.push({ id, field: field.name });
          addEntity({
            id,
            kind: "business_rule",
            name: draft.statement,
            project_boundary: m.project_boundary,
            module_id: m.id,
            statement: draft.statement,
            technical_rule: `${schema.library} schema ${schema.name}.${field.name}: ${draft.technical}`,
            source_schema: schema.name,
            business_intent: null,
            inputs: [],
            boundaries: draft.boundaries,
            status: "source_verified",
            origin: "source",
            evidence_ids: [field.evidence],
          } as Entity);
        }
      rulesBySchema.set(`${m.id}\0${schema.name}`, list);
    }
  const ruleEntity = (id: string) =>
    out.entities.find((e) => e.id === id) as unknown as Record<string, unknown> & Entity;
  for (const api of apis) {
    const d = details.get(api.id);
    for (const v of d?.validates ?? []) {
      const rules = (rulesBySchema.get(`${v.module}\0${v.schema}`) ?? []).filter(
        (r) => !v.field || r.field === v.field,
      );
      if (rules.length === 0) continue;
      // The violation answer: the first 400/422 at or after the validation call.
      const at = lineOf.get(v.evidence) ?? 0;
      const answer = (d?.responses ?? [])
        .filter((r) => (r.status === 422 || r.status === 400) && (lineOf.get(r.evidence) ?? 0) >= at)
        .sort((a, b) => (lineOf.get(a.evidence) ?? 0) - (lineOf.get(b.evidence) ?? 0))[0];
      for (const rule of rules) {
        relate("VALIDATES", rule.id, api.id, [v.evidence]);
        const entity = ruleEntity(rule.id);
        const evidence = entity.evidence_ids as string[];
        if (!evidence.includes(v.evidence)) evidence.push(v.evidence);
        if (answer) {
          entity.expected_behavior = { on_violation: `HTTP ${answer.status}` };
          if (!evidence.includes(answer.evidence)) evidence.push(answer.evidence);
        }
        // Inputs: the same-named fields of forms submitting to this endpoint.
        for (const r of derived.relationships.filter((x) => x.type === "SUBMITS_TO" && x.to === api.id))
          for (const c of derived.relationships.filter((x) => x.type === "CONTAINS" && x.from === r.from)) {
            const field = byId.get(c.to);
            const inputs = entity.inputs as string[];
            if (field?.kind === "field" && field.name === rule.field && !inputs.includes(field.id))
              inputs.push(field.id);
          }
      }
    }
  }
  // A database CHECK with the same numeric bounds enforces the rule a second time.
  for (const column of allEntities.filter((e) => e.kind === "column")) {
    const checks = (column as { checks?: string[] }).checks ?? [];
    for (const check of checks) {
      const between = /BETWEEN\s+(-?\d+)\s+AND\s+(-?\d+)/i.exec(check);
      if (!between) continue;
      for (const rule of out.entities.filter((e) => e.kind === "business_rule")) {
        const b = ((rule as { boundaries?: Array<Record<string, unknown>> }).boundaries ?? [])[0];
        if (b?.field === column.name && b.min === Number(between[1]) && b.max === Number(between[2])) {
          const r = rule as unknown as Record<string, unknown>;
          r.technical_rule = `${String(r.technical_rule)}; database CHECK (${check}) on ${column.id}`;
          (r.evidence_ids as string[]).push(
            ...column.evidence_ids.filter((x) => !(r.evidence_ids as string[]).includes(x)),
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------- roles and checks
  const roleId = (boundary: string, name: string) => scopedId("actor_role", boundary, snakeCase(name));
  const roleValues = new Map<string, string>(); // upper value → role id
  for (const m of modules.values())
    for (const e of m.prisma?.enums ?? [])
      if (/role/i.test(e.name))
        for (const value of e.values) {
          const id = roleId(m.project_boundary, value);
          roleValues.set(value.toUpperCase(), id);
          addEntity({
            id,
            kind: "actor_role",
            name: value,
            project_boundary: m.project_boundary,
            status: "source_verified",
            origin: "source",
            evidence_ids: [e.evidence],
          } as Entity);
        }
  let checked = 0;
  for (const api of apis) {
    for (const m of details.get(api.id)?.middleware ?? []) {
      const boundary = api.project_boundary ?? "project:.";
      if (m.statuses.includes(403)) {
        for (const arg of m.args.filter((a) => /^[\w.:-]+$/.test(a))) {
          const known = roleValues.get(arg.toUpperCase());
          const isRole = known !== undefined || /^[A-Z][A-Z0-9_]*$/.test(arg);
          const id = known ?? (isRole ? roleId(boundary, arg) : scopedId("permission", boundary, arg));
          addEntity({
            id,
            kind: isRole ? "actor_role" : "permission",
            name: arg,
            project_boundary: boundary,
            status: "source_verified",
            origin: "source",
            evidence_ids: api.evidence_ids,
          } as Entity);
          relate("AUTHORIZES_WITH", api.id, id, api.evidence_ids);
          checked++;
        }
        if (m.args.length === 0 && m.function_id) {
          relate("AUTHORIZES_WITH", api.id, m.function_id, api.evidence_ids);
          checked++;
        }
      }
      if (m.statuses.includes(401) && m.function_id) {
        relate("AUTHENTICATES_WITH", api.id, m.function_id, api.evidence_ids);
        checked++;
      }
    }
  }
  if (apis.length > 0 && checked === 0)
    out.gaps.push({
      id: "gap:authorization",
      type: "unsupported",
      description:
        "No authentication or authorization check guarding an endpoint was recognized (middleware answering 401 or 403); access rules may live in code or infrastructure the analysis does not read.",
      impact: "Roles and access outcomes cannot be stated from source; confirm them with the team or at run time.",
      related_entity_ids: apis.slice(0, 10).map((a) => a.id),
      requires_human_clarification: true,
      status: "unresolved",
      coverage_category: "roles_permissions",
    });

  // ---------------------------------------------------------------- state machines
  const functionIds = new Map<string, string>();
  for (const e of allEntities)
    if (e.kind === "function") functionIds.set(`${(e as { module_id?: string }).module_id}\0${e.name}`, e.id);
  const subjects = new Set<string>();
  for (const m of modules.values())
    for (const table of m.transition_tables ?? []) {
      const words = snakeCase(table.type ?? table.name).split("_");
      const field =
        words.length > 1 && /^(status|state|stage|phase|step)$/.test(words[words.length - 1]!)
          ? words.pop()!
          : "status";
      const subject = words.join("_") || m.id.slice("module:".length).split(".").pop()!;
      const id = scopedId("state_machine", m.project_boundary, `${subject}.${field}`);
      const entityId = scopedId("entity", m.project_boundary, subject);
      const guard = table.guards.map((g) => functionIds.get(`${m.id}\0${g}`)).find((g) => g !== undefined);
      const allowed = new Set(table.transitions.map((t) => `${t.from}\0${t.to}`));
      const enumEvidence = [...modules.values()]
        .flatMap((x) => x.prisma?.enums ?? [])
        .filter((e) => table.type !== undefined && e.name === table.type)
        .map((e) => e.evidence);
      if (
        addEntity({
          id,
          kind: "state_machine",
          name: `${subject.replace(/_/g, " ")} ${field}`,
          project_boundary: m.project_boundary,
          module_id: m.id,
          ...(byId.has(entityId) ? { subject: entityId } : {}),
          states: table.states,
          transitions: table.transitions.map((t) => ({
            from: t.from,
            to: t.to,
            ...(guard ? { guard } : {}),
            status: "source_verified",
            evidence_ids: [table.evidence],
          })),
          invalid_transitions_known: table.states
            .flatMap((from) =>
              table.states.filter((to) => to !== from && !allowed.has(`${from}\0${to}`)).map((to) => ({ from, to })),
            )
            .slice(0, 100)
            .map((t) => ({ ...t, status: "source_verified", evidence_ids: [table.evidence] })),
          status: "source_verified",
          origin: "source",
          evidence_ids: [table.evidence, ...enumEvidence],
        } as Entity)
      ) {
        subjects.add(entityId);
        for (const g of table.guards) {
          const fn = functionIds.get(`${m.id}\0${g}`);
          if (fn) relate("REFERENCES", fn, id, [table.evidence]);
        }
      }
    }
  for (const column of allEntities.filter(
    (e) => e.kind === "column" && /^(status|state|stage|phase)$/i.test(e.name ?? ""),
  )) {
    const table = byId.get((column as { table_id?: string }).table_id ?? "");
    const entityId = scopedId("entity", column.project_boundary ?? "project:.", snakeCase(table?.name ?? ""));
    if (!table || subjects.has(entityId)) continue;
    out.gaps.push({
      id: `gap:state-machine:${entityId.slice("entity:".length)}`,
      type: "missing_evidence",
      description: `${table.name}.${column.name} holds a state, but no transition table or guard for it was found; which changes are allowed is not known from source.`,
      impact: "State transitions of this entity cannot be tested against an evidenced model.",
      evidence_ids: column.evidence_ids,
      related_entity_ids: [column.id, ...(byId.has(entityId) ? [entityId] : [])],
      requires_human_clarification: true,
      status: "unresolved",
    });
  }

  // ---------------------------------------------------------------- outcomes
  for (const api of apis) {
    const d = details.get(api.id);
    if (!d) continue;
    const fromMiddleware = new Map<number, string>();
    for (const m of d.middleware) for (const s of m.statuses) if (!fromMiddleware.has(s)) fromMiddleware.set(s, m.name);
    const seen = new Set<string>();
    const responses = d.responses
      .map((r) => ({
        status: r.status,
        outcome: outcomeOf(r.status, r.message),
        condition:
          r.condition ??
          (fromMiddleware.has(r.status) ? `middleware ${fromMiddleware.get(r.status)} refuses the request` : "always"),
        ...(r.message ? { message: r.message } : {}),
        evidence_id: r.evidence,
      }))
      .filter((r) => {
        const key = `${r.outcome}\0${r.condition}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (responses.length > 0) (api as unknown as Record<string, unknown>).error_responses = responses;
  }
  return out;
}
