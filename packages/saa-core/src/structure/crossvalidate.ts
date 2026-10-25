import { createHash } from "node:crypto";
import type { Claim, Entity, Evidence, Gap, Relationship } from "@sys2qa/contract";
import type { StructuralFacts } from "./graph.js";

// Shapes recorded by the adapters: documentation statements (docs), imports and schemas (js-ts).
interface DocStatement {
  text: string;
  quantities: Array<{
    kind: "min" | "max" | "exact" | "range";
    value?: number;
    min?: number;
    max?: number;
    unit?: "characters" | "digits";
    at: number;
  }>;
  line: number;
  evidence: string;
}
interface Boundary {
  field?: string;
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  pattern?: string;
}
type Rule = Entity & {
  boundaries?: Boundary[];
  statement?: string;
  source_schema?: string;
  contradiction_ids?: string[];
};

export interface CrossLinks {
  relationships: Relationship[];
  gaps: Gap[];
}

/** Evidence types that can verify a claim on their own (CR-001, contract specification §8.1). */
const VERIFYING = new Set(["source_code", "configuration", "schema", "migration", "manifest"]);
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[a-z]+$/i;

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** Lower-case words with their offsets; a plural "s" is dropped so "amounts" names the field `amount`. */
const words = (text: string) =>
  [...text.toLowerCase().matchAll(/[a-z0-9_]+/g)].flatMap((m) =>
    m[0].length > 3 && m[0].endsWith("s") && !m[0].endsWith("ss")
      ? [
          { word: m[0], at: m.index },
          { word: m[0].slice(0, -1), at: m.index },
        ]
      : [{ word: m[0], at: m.index }],
  );

/** What a documented quantity says about a rule's boundary: `agrees`, `disagrees`, or undefined when not comparable. */
function compare(q: DocStatement["quantities"][number], b: Boundary): "agrees" | "disagrees" | undefined {
  const digits = b.pattern !== undefined && b.min_length !== undefined && b.min_length === b.max_length;
  if (q.kind === "exact" && q.unit === "digits" && digits) return q.value === b.min_length ? "agrees" : "disagrees";
  if (digits) return undefined;
  const text = b.min_length !== undefined || b.max_length !== undefined;
  const number = b.min !== undefined || b.max !== undefined;
  if (q.unit === "digits") return undefined;
  if (q.unit === "characters" && !text) return undefined;
  if (q.kind === "exact") {
    if (b.min_length === undefined || b.min_length !== b.max_length) return undefined;
    return q.value === b.min_length ? "agrees" : "disagrees";
  }
  if (q.kind === "range") {
    const [lo, hi] = text ? [b.min_length, b.max_length] : [b.min, b.max];
    if (lo === undefined || hi === undefined) return undefined;
    return lo === q.min && hi === q.max ? "agrees" : "disagrees";
  }
  if (q.kind === "min" && (text ? b.min_length : number ? b.min : undefined) !== undefined)
    return (text ? b.min_length : b.min) === q.value ? "agrees" : "disagrees";
  if (q.kind === "max" && (text ? b.max_length : number ? b.max : undefined) !== undefined)
    return (text ? b.max_length : b.max) === q.value ? "agrees" : "disagrees";
  return undefined;
}

/**
 * Cross-validation (IMP-113, SAA-FR-011, PRD §11.1 phase 6). Documentation sentences that state a numeric constraint
 * are compared with the business rules found in code: a quantity is attributed to the nearest rule field named in the
 * sentence (preferring rules of a schema the sentence names, and never comparing a minimum with a "required" rule). An
 * agreeing sentence adds documentation evidence to the rule; a disagreeing one becomes a `contradiction` gap, linked
 * from the rule, that asks which is intended. The code stays the evidence of behavior, so the rule keeps its status.
 * A test definition that imports a schema `TESTS` its rules, as `inferred`: no test result was examined.
 */
export function crossValidate(facts: StructuralFacts, entities: readonly Entity[]): CrossLinks {
  const out: CrossLinks = { relationships: [], gaps: [] };
  const rules = entities.filter((e): e is Rule => e.kind === "business_rule");
  const relate = (type: Relationship["type"], from: string, to: string, evidence: string[], rationale?: string) => {
    const id = `relationship:${hash16(type, from, to)}`;
    if (out.relationships.some((r) => r.id === id)) return;
    out.relationships.push({
      id,
      type,
      from,
      to,
      status: rationale ? "inferred" : "source_verified",
      ...(rationale ? { confidence_rationale: rationale } : {}),
      evidence_ids: evidence,
    });
  };

  for (const file of facts.entities) {
    const statements = (file as { doc_statements?: DocStatement[] }).doc_statements ?? [];
    for (const statement of statements) {
      const tokens = words(statement.text);
      const named = new Set(tokens.map((t) => t.word));
      for (const q of statement.quantities) {
        const candidates = rules
          .map((rule) => ({ rule, boundary: rule.boundaries?.[0] }))
          .filter(({ rule, boundary }) => {
            const field = boundary?.field?.toLowerCase();
            return field !== undefined && named.has(field) && !rule.id.endsWith("_required");
          })
          .map((c) => ({ ...c, verdict: compare(q, c.boundary!) }))
          .filter((c) => c.verdict !== undefined);
        if (candidates.length === 0) continue;
        // Nearest field to the quantity; among rules of that field, those of a schema the sentence names.
        const distance = (field: string) =>
          Math.min(...tokens.filter((t) => t.word === field).map((t) => Math.abs(t.at - q.at)));
        const nearest = Math.min(...candidates.map((c) => distance(c.boundary!.field!.toLowerCase())));
        let chosen = candidates.filter((c) => distance(c.boundary!.field!.toLowerCase()) === nearest);
        const bySchema = chosen.filter((c) =>
          (c.rule.source_schema ?? "")
            .replace(/(Schema|Validator|Validation)$/, "")
            .split(/(?=[A-Z])|_/)
            .some((w) => w.length > 2 && named.has(w.toLowerCase())),
        );
        if (bySchema.length > 0) chosen = bySchema;
        // Any agreeing rule settles it; otherwise each disagreeing rule is contradicted.
        const agreeing = chosen.filter((c) => c.verdict === "agrees");
        if (agreeing.length > 0) {
          for (const { rule } of agreeing)
            if (!rule.evidence_ids.includes(statement.evidence)) rule.evidence_ids.push(statement.evidence);
          continue;
        }
        for (const { rule } of chosen) {
          const gapId = `gap:contradiction:${rule.id.slice(rule.id.indexOf(":") + 1)}`;
          if (out.gaps.some((g) => g.id === gapId)) continue;
          out.gaps.push({
            id: gapId,
            type: "contradiction",
            description: `${file.name} (line ${statement.line}) says "${statement.text}", but the code enforces: ${rule.statement ?? rule.name} Which one is intended?`,
            impact:
              "Tests derived from either source would expect different results; the code's behavior is what runs.",
            evidence_ids: [statement.evidence, ...rule.evidence_ids.slice(0, 1)],
            related_entity_ids: [rule.id, file.id],
            requires_human_clarification: true,
            status: "unresolved",
            coverage_category: "business_rules",
          });
          rule.contradiction_ids = [...(rule.contradiction_ids ?? []), gapId];
        }
      }
    }
  }

  // Test definitions that import a schema exercise its rules.
  const modules = facts.entities.filter(
    (e) => e.kind === "module" && TEST_FILE.test((e as { path?: string }).path ?? ""),
  );
  for (const test of modules) {
    const imports =
      (test as { imports?: Array<{ target?: string; bindings?: Array<{ imported: string }>; evidence?: string }> })
        .imports ?? [];
    for (const record of imports)
      for (const binding of record.bindings ?? [])
        for (const rule of rules.filter(
          (r) => (r as { module_id?: string }).module_id === record.target && r.source_schema === binding.imported,
        ))
          relate(
            "TESTS",
            test.id,
            rule.id,
            test.evidence_ids.slice(0, 1),
            "a test definition exercises this rule; no test result was examined",
          );
  }
  return out;
}

/**
 * Status assignment (CR-001, SAA-FR-010, SAA-FR-043): a `source_verified` entity or relationship must cite evidence
 * of a verifying type (source code, configuration, schema, migration, manifest) that exists in the evidence index.
 * Anything else is downgraded to `inferred` with the reason. Returns how many were downgraded.
 */
export function assignStatuses(records: ReadonlyArray<Entity | Relationship>, evidence: readonly Evidence[]): number {
  const types = new Map(evidence.map((e) => [e.id, e.source_type]));
  let downgraded = 0;
  for (const record of records) {
    if (record.status !== "source_verified") continue;
    const cited = (record.evidence_ids ?? []).map((id) => types.get(id));
    if (cited.some((t) => t !== undefined && VERIFYING.has(t))) continue;
    const found = [...new Set(cited.filter((t) => t !== undefined))];
    const r = record as { status: string; confidence_rationale?: string };
    r.status = "inferred";
    r.confidence_rationale =
      found.length > 0
        ? `supported only by ${found.join(", ")} evidence, which cannot verify on its own (CR-001)`
        : "no evidence record supports it directly";
    downgraded++;
  }
  return downgraded;
}

/**
 * Material claims (SAA-FR-010): business rules, state machines, authorization checks and external boundaries, each
 * worded no wider than its evidence, at the analyzed revision. A claim about a request to a provider never says what
 * the provider does.
 */
export function materialClaims(
  entities: readonly Entity[],
  relationships: readonly Relationship[],
  revision: string,
): Claim[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const claims: Claim[] = [];
  const claim = (
    subject: Entity | undefined,
    text: string,
    evidence: string[],
    status: Claim["status"],
    extra: Partial<Claim> = {},
  ) => {
    if (!subject || evidence.length === 0) return;
    claims.push({
      id: `claim:${hash16(subject.id, text)}`,
      text: { language: "en", value: text },
      status,
      subject_entity_id: subject.id,
      evidence_ids: evidence.slice(0, 20),
      scope: "static_analysis",
      caveats: [],
      last_validated_revision: revision,
      ...extra,
    } as Claim);
  };
  for (const e of entities) {
    if (e.kind === "business_rule") {
      const rule = e as Rule;
      const contradictions = rule.contradiction_ids ?? [];
      claim(e, `The code enforces: ${rule.statement ?? e.name}`, e.evidence_ids, e.status, {
        caveats: [
          "Business intent is not stated in code.",
          ...(contradictions.length > 0 ? ["Documentation states a different value; see the linked gap."] : []),
        ],
        ...(contradictions.length > 0 ? { gap_ids: contradictions } : {}),
      });
    }
    if (e.kind === "state_machine") {
      const m = e as Entity & { states?: string[]; transitions?: Array<{ from: string; to: string }> };
      claim(
        e,
        `${e.name} has the states ${(m.states ?? []).join(", ")} and allows only ${(m.transitions ?? []).map((t) => `${t.from} → ${t.to}`).join(", ")}.`,
        e.evidence_ids,
        e.status,
        { caveats: ["Allowed transitions are those of the transition table; callers may not use all of them."] },
      );
    }
  }
  for (const r of relationships) {
    if (r.type === "AUTHORIZES_WITH")
      claim(byId.get(r.from), `${r.from} refuses requests unless the caller has ${r.to}.`, r.evidence_ids, r.status, {
        relationship_ids: [r.id],
        caveats: ["How roles are assigned is not part of this claim."],
      });
    if (r.type === "SENDS_TO" && r.to.startsWith("integration:"))
      claim(byId.get(r.from), `${r.from} sends a request to ${r.to}.`, r.evidence_ids, r.status, {
        relationship_ids: [r.id],
        caveats: ["What the provider does with the request is outside the repository and not verified."],
      });
  }
  return claims.filter((c, i) => claims.findIndex((x) => x.id === c.id) === i);
}
