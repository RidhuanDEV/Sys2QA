import { createHash } from "node:crypto";

/** The parts of a system model the correlator reads (any producer). */
export interface CorrelationModel {
  entities: Array<{
    id: string;
    kind: string;
    route_pattern?: string;
    page_id?: string;
    form_id?: string;
    constraints?: Record<string, unknown>;
    inputs?: string[];
    boundaries?: Array<Record<string, unknown>>;
  }>;
  relationships: Array<{ type: string; from: string; to: string }>;
  coverage?: Array<{ area: string; status: string; reason?: string }>;
}

export interface CorrelationInput {
  report_id: string;
  generated_at: string;
  saa: { package_id: string; package_version: number; model: CorrelationModel };
  qaa: { package_id: string; package_version: number; model: CorrelationModel };
  /**
   * Whether the observed environment runs the analyzed revision (PRD W2c step 2): `user_confirmed` when a person said
   * so, `observed` when a version endpoint showed it, otherwise `unconfirmed`, and then every discrepancy may be
   * version-related.
   */
  revision_correspondence: "user_confirmed" | "observed" | "unconfirmed";
}

export interface CorrelationLink {
  observed_id: string;
  source_id: string;
  rationale: string;
  confidence: "high" | "medium" | "low";
}

export interface Discrepancy {
  id: string;
  type: "route_unreachable" | "constraint_mismatch" | "unmatched_page" | "behavior_mismatch" | "other";
  observed_ids: string[];
  source_ids: string[];
  description: string;
  possibly_version_related: boolean;
}

export interface CorrelationReport {
  contract: "sys2qa.correlation-report";
  schema_version: "1.0.0";
  report_id: string;
  saa_package: { package_id: string; package_version: number };
  qaa_package: { package_id: string; package_version: number };
  revision_correspondence: CorrelationInput["revision_correspondence"];
  links: CorrelationLink[];
  unmatched: { observed: string[]; source: string[] };
  discrepancies: Discrepancy[];
  generated_at: string;
}

type Entity = CorrelationModel["entities"][number];

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const local = (id: string) => id.slice(id.lastIndexOf("#") + 1);
/** A source route as a matcher: `{id}`, `:id` and `[id]` parameters match one path segment. */
const routeMatcher = (route: string) =>
  new RegExp(
    `^${route
      .split(/(\{[^}/]+\}|:[A-Za-z_][A-Za-z0-9_]*|\[[^\]/]+\])/)
      .map((part, i) => (i % 2 === 1 ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("")}/?$`,
  );
const isParameterized = (route: string) => /\{[^}]+\}|:[A-Za-z_]|\[[^\]]+\]/.test(route);
/** A pattern in any notation (`/^x$/i`, `^(?:x)$`, `x`) reduced to its body, for comparison. */
const patternBody = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  let p = value.trim();
  const literal = /^\/(.*)\/[a-z]*$/s.exec(p);
  if (literal) p = literal[1]!;
  const anchored = /^\^\(\?:(.*)\)\$$/s.exec(p);
  if (anchored) return anchored[1];
  return p.replace(/^\^/, "").replace(/\$$/, "");
};
const LIMITS = ["min_length", "max_length", "pattern", "min", "max"] as const;
type Limits = Partial<Record<(typeof LIMITS)[number], string | number>>;
const limitsOf = (record: Record<string, unknown> | undefined): Limits => {
  const out: Limits = {};
  for (const key of LIMITS) {
    const v = record?.[key];
    if (key === "pattern") {
      const body = patternBody(v);
      if (body !== undefined && body !== "") out.pattern = body;
    } else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
};
/** The limits on which both sides state a value and disagree. */
const disagreements = (observed: Limits, source: Limits) =>
  LIMITS.filter((k) => observed[k] !== undefined && source[k] !== undefined && observed[k] !== source[k]);
const show = (limits: Limits, keys: readonly string[]) =>
  keys.map((k) => `${k} ${String(limits[k as keyof Limits]).slice(0, 80)}`).join(", ");

/**
 * Correlates an SAA package with a QAA package (QAA-FR-115, CON-026): links observed pages, forms and fields to source
 * routes, forms and fields with a rationale and a confidence; lists what stays unmatched on each side; and records
 * discrepancies: a field constraint that differs, a source route the environment answered with an error, an observed
 * page without a source route. It links only what the IDs, routes and names support: an observed page without a source
 * route is never given one (no invented link), and a source route never counts as observed. Neither package changes
 * (CON-023). Deterministic.
 */
export function correlatePackages(input: CorrelationInput): CorrelationReport {
  const source = input.saa.model.entities;
  const observed = input.qaa.model.entities;
  const versionRelated = input.revision_correspondence === "unconfirmed";
  const links: CorrelationLink[] = [];
  const linkOf = new Map<string, string>();
  const link = (o: string, s: string, rationale: string, confidence: CorrelationLink["confidence"]) => {
    links.push({ observed_id: o, source_id: s, rationale, confidence });
    linkOf.set(o, s);
  };
  const linkedSource = () => new Set(links.map((l) => l.source_id));

  // Pages: same path first, then a parameterized route that matches the path.
  const sourcePages = source.filter((e) => e.kind === "page" && typeof e.route_pattern === "string");
  for (const page of observed.filter((e) => e.kind === "page" && typeof e.route_pattern === "string")) {
    const path = page.route_pattern!;
    const exact = sourcePages.find((s) => s.route_pattern === path);
    if (exact) {
      link(page.id, exact.id, `The observed path ${path} equals the source route.`, "high");
      continue;
    }
    const pattern = sourcePages.find(
      (s) => isParameterized(s.route_pattern!) && routeMatcher(s.route_pattern!).test(path),
    );
    if (pattern)
      link(
        page.id,
        pattern.id,
        `The observed path ${path} matches the source route ${pattern.route_pattern!}.`,
        "medium",
      );
  }

  // Forms on linked pages: the same form id, otherwise the same field names.
  const fieldsOf = (entities: Entity[], formId: string) =>
    entities.filter((e) => e.kind === "field" && e.form_id === formId);
  const fieldName = (id: string) => {
    const tail = local(id);
    return tail.slice(tail.lastIndexOf(".") + 1);
  };
  for (const form of observed.filter((e) => e.kind === "form" && e.page_id && linkOf.has(e.page_id))) {
    const sourcePage = linkOf.get(form.page_id!)!;
    const candidates = source.filter((e) => e.kind === "form" && e.page_id === sourcePage && !linkedSource().has(e.id));
    const byId = candidates.find((c) => local(c.id) === local(form.id));
    if (byId) {
      link(form.id, byId.id, `Same page and the same form id (${local(form.id)}).`, "high");
      continue;
    }
    const names = fieldsOf(observed, form.id)
      .map((f) => fieldName(f.id))
      .sort()
      .join(",");
    const byFields = candidates.find(
      (c) =>
        names !== "" &&
        fieldsOf(source, c.id)
          .map((f) => fieldName(f.id))
          .sort()
          .join(",") === names,
    );
    if (byFields) link(form.id, byFields.id, `Same page and the same field names (${names}).`, "medium");
  }

  // Fields of linked forms, by name; their constraints are compared with the source field and the rules on it.
  const discrepancies: Discrepancy[] = [];
  const discrepancy = (type: Discrepancy["type"], observedIds: string[], sourceIds: string[], description: string) =>
    discrepancies.push({
      id: `discrepancy:${type}.${hash(`${observedIds.join("|")}>${sourceIds.join("|")}`)}`,
      type,
      observed_ids: observedIds,
      source_ids: sourceIds,
      description,
      possibly_version_related: versionRelated,
    });
  for (const field of observed.filter((e) => e.kind === "field" && e.form_id && linkOf.has(e.form_id))) {
    const sourceForm = linkOf.get(field.form_id!)!;
    const match = fieldsOf(source, sourceForm).find((s) => fieldName(s.id) === fieldName(field.id));
    if (!match) continue;
    link(field.id, match.id, `Field ${fieldName(field.id)} of linked forms.`, "high");
    const seen = limitsOf(field.constraints);
    const rules = source.filter((e) => e.kind === "business_rule" && (e.inputs ?? []).includes(match.id));
    const ruleDiffs = rules
      .map((rule) => {
        const limits = limitsOf(
          (rule.boundaries ?? []).find((b) => b.field === fieldName(match.id)) ?? rule.boundaries?.[0],
        );
        return { rule, limits, keys: disagreements(seen, limits) };
      })
      .filter((r) => r.keys.length > 0);
    const fieldLimits = limitsOf(match.constraints);
    const fieldKeys = disagreements(seen, fieldLimits);
    if (ruleDiffs.length === 0 && fieldKeys.length === 0) continue;
    const keys = [...new Set([...fieldKeys, ...ruleDiffs.flatMap((r) => r.keys)])];
    const sourceLimits = ruleDiffs[0]?.limits ?? fieldLimits;
    discrepancy(
      "constraint_mismatch",
      [field.id],
      ruleDiffs.length > 0 ? ruleDiffs.map((r) => r.rule.id) : [match.id],
      `The browser field allows ${show(seen, keys)}; the source states ${show(
        sourceLimits,
        keys.filter((k) => sourceLimits[k] !== undefined),
      )}.`,
    );
  }

  // Source pages without an observed counterpart: unreachable when the environment answered with an error.
  const failed = new Map(
    (input.qaa.model.coverage ?? []).filter((c) => c.status === "failed").map((c) => [c.area, c.reason ?? "failed"]),
  );
  const linked = linkedSource();
  for (const page of sourcePages.filter((p) => !linked.has(p.id))) {
    const route = page.route_pattern!;
    const reason = isParameterized(route) ? undefined : failed.get(route);
    if (reason === undefined) continue;
    const consumed = input.saa.model.relationships
      .filter((r) => r.from === page.id && (r.type === "CONSUMES" || r.type === "CALLS"))
      .map((r) => r.to);
    discrepancy(
      "route_unreachable",
      [],
      [page.id, ...[...new Set(consumed)].sort()],
      `The source declares ${route}, but the environment did not serve it (${reason.replace(/\.$/, "")}).`,
    );
  }
  // Observed pages without a source route: perhaps another repository, a CMS or a proxy.
  for (const page of observed.filter((e) => e.kind === "page" && !linkOf.has(e.id)))
    discrepancy(
      "unmatched_page",
      [page.id],
      [],
      `The environment serves ${page.route_pattern ?? page.id}, which no source route declares (another repository, a CMS or a proxy may serve it).`,
    );

  const kinds = new Set(["page", "form"]);
  return {
    contract: "sys2qa.correlation-report",
    schema_version: "1.0.0",
    report_id: input.report_id,
    saa_package: { package_id: input.saa.package_id, package_version: input.saa.package_version },
    qaa_package: { package_id: input.qaa.package_id, package_version: input.qaa.package_version },
    revision_correspondence: input.revision_correspondence,
    links,
    unmatched: {
      observed: observed.filter((e) => kinds.has(e.kind) && !linkOf.has(e.id)).map((e) => e.id),
      source: source.filter((e) => kinds.has(e.kind) && !linked.has(e.id)).map((e) => e.id),
    },
    discrepancies,
    generated_at: input.generated_at,
  };
}
