import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TEMPLATE = join(ROOT, "fixtures", "contract", "packages", "valid", "mode-b-qaa");
const TRUTH = join(ROOT, "fixtures", "benchmarks", "F2-url-only", "ground-truth");

const ENV = "env:f2-dev";
const FROM = "2026-11-01T10:00:00Z";
const TO = "2026-11-01T10:20:00Z";
const WINDOW = { kind: "observation_window", environment_id: ENV, observed_from: FROM, observed_to: TO };
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Constraints visible in F2's forms (ground-truth README): what runtime discovery reads from the DOM. A rule names the
 * field it constrains (`inputs`); `VALIDATES` would claim server-side validation, which observation cannot establish
 * (CR-002).
 */
const RULES = [
  {
    id: "business_rule:contact.message_max_500",
    form: "form:observed:/contact#contact",
    field: "field:observed:/contact#message",
    statement: "message accepts at most 500 characters (maxlength).",
    boundaries: [{ field: "message", max_length: 500 }],
  },
  {
    id: "business_rule:register.nib_16_digits",
    form: "form:observed:/register#register",
    field: "field:observed:/register#nib",
    statement: "nib accepts exactly 16 digits (pattern and maxlength).",
    boundaries: [{ field: "nib", min_length: 16, max_length: 16, pattern: "^[0-9]{16}$" }],
  },
  {
    id: "business_rule:register.password_min_8",
    form: "form:observed:/register#register",
    field: "field:observed:/register#password",
    statement: "password needs at least 8 characters (minlength).",
    boundaries: [{ field: "password", min_length: 8 }],
  },
];

/**
 * The QAA runtime package of F2 (Mode B) as runtime discovery will produce it (Gate 4): observed pages, forms, fields,
 * the constraints visible in the forms, the observed workflows with their stop points, and the unobservable gaps, all
 * from F2's ground truth. Gate 2 designs scenarios from it; written to `dir` with fresh checksums.
 */
export function buildF2Package(dir: string): string {
  const truth = (name: string) => JSON.parse(readFileSync(join(TRUTH, name), "utf8"));
  const entitiesTruth = truth("entities.json").entities as Array<{ id: string; kind: string }>;
  const workflowsTruth = truth("workflows.json").workflows as Array<{
    key: string;
    category: string;
    entry_point: string;
    steps: string[];
    stop_points: Array<{ after: string; reason_code: string }>;
  }>;
  const gapsTruth = truth("gaps.json").gaps as Array<{ key: string; type: string; related: string[] }>;

  const evidence: Array<Record<string, unknown>> = [];
  const evidenceFor = (id: string, subtype: string, url: string) => {
    const evidenceId = `evidence:f2-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
    evidence.push({
      id: evidenceId,
      source_type: "runtime_observation",
      subtype,
      environment_id: ENV,
      url: `http://127.0.0.1:4100${url}`,
      observed_at: FROM,
      submission: "none",
      extractor: { component: "runtime-observer", version: "0.1.0", method: "dom_snapshot" },
      excerpt_policy: "none",
      captured_at: FROM,
    });
    return evidenceId;
  };
  const pathOf = (id: string) => id.replace(/^[a-z]+:observed:/, "").replace(/#.*$/, "");

  const entities: Array<Record<string, unknown>> = entitiesTruth.map((e) => {
    const base = {
      id: e.id,
      kind: e.kind,
      name: e.kind === "page" ? pathOf(e.id) : e.id.replace(/^.*#/, ""),
      status: "runtime_observed",
      origin: "runtime",
      evidence_ids: [evidenceFor(e.id, e.kind === "field" ? "form" : e.kind, pathOf(e.id))],
    };
    return e.kind === "page" ? { ...base, route_pattern: pathOf(e.id) } : base;
  });
  const relationships: Array<Record<string, unknown>> = [];
  const relate = (type: string, from: string, to: string) =>
    relationships.push({
      id: `rel:f2-${createHash("sha256").update(`${type}${from}${to}`).digest("hex").slice(0, 12)}`,
      type,
      from,
      to,
      status: "runtime_observed",
      evidence_ids: [evidenceFor(`${type}${from}${to}`, "page", pathOf(from))],
    });
  for (const e of entitiesTruth.filter((x) => x.kind === "form"))
    relate("CONTAINS", `page:observed:${pathOf(e.id)}`, e.id);
  for (const e of entitiesTruth.filter((x) => x.kind === "field"))
    relate("CONTAINS", entitiesTruth.find((f) => f.kind === "form" && pathOf(f.id) === pathOf(e.id))!.id, e.id);
  for (const rule of RULES) {
    entities.push({
      id: rule.id,
      kind: "business_rule",
      name: rule.statement,
      statement: rule.statement,
      status: "runtime_observed",
      origin: "runtime",
      boundaries: rule.boundaries,
      inputs: [rule.field],
      business_intent: null,
      evidence_ids: [evidenceFor(rule.id, "form", pathOf(rule.form))],
    });
  }

  const gapId = (key: string) => `gap:observed.${key}`;
  const gaps = gapsTruth.map((g) => ({
    id: gapId(g.key),
    type: g.type,
    description: `Not observable during discovery: ${g.key.replace(/-/g, " ")}.`,
    impact: "Effects behind this point cannot be observed without approval or credentials.",
    related_entity_ids: g.related,
    requires_human_clarification: false,
    status: "unresolved",
  }));
  // What a browser cannot see is explained by a gap per coverage category (CR-030).
  for (const category of ["roles_permissions", "data_model", "integrations", "state_transitions"])
    gaps.push({
      id: gapId(`${category.replace(/_/g, "-")}-unobservable`),
      type: "unobservable",
      description: `${category.replace(/_/g, " ")} cannot be observed from the browser.`,
      impact: "Source code or documentation would be needed.",
      related_entity_ids: [],
      requires_human_clarification: false,
      status: "unresolved",
      coverage_category: category,
    } as (typeof gaps)[number]);
  const gapOf = (entity: string) => gaps.find((g) => g.related_entity_ids.includes(entity))?.id;
  const workflows = workflowsTruth.map((w, i) => {
    const steps = w.steps.map((entity, n) => ({
      id: `step:observed.${w.key}.${n + 1}`,
      order: n + 1,
      entity_id: entity,
      action: n === 0 ? "open" : entity.startsWith("form:") ? "inspect" : "navigate",
    }));
    const hops = w.stop_points.map((s) => ({
      after_step: steps.find((st) => st.entity_id === s.after)!.id,
      reason_code: s.reason_code,
      gap_id: gapOf(s.after) ?? gaps[0]!.id,
      description: `Discovery stopped: ${s.reason_code.replace(/_/g, " ")}.`,
    }));
    return {
      id: `workflow:observed.${w.key}`,
      name: w.key.replace(/_/g, " "),
      category: w.category,
      origin: "runtime",
      discovery_status: hops.length > 0 ? "partially_reconstructed" : "reconstructed",
      entry_point_ids: [w.entry_point],
      component_trace_ids: [],
      steps,
      branches: [],
      unresolved_hops: hops,
      completion: hops.length > 0 ? "partial" : "runtime_observed_for_run",
      deepened: false,
      rank: i + 1,
      status: "runtime_observed",
      evidence_ids: [evidenceFor(`workflow:${w.key}`, "page", pathOf(w.entry_point))],
    };
  });
  const claims = RULES.map((r) => ({
    id: `claim:f2.${r.id.replace(/^business_rule:/, "")}`,
    text: { language: "en", value: r.statement },
    status: "runtime_observed",
    subject_entity_id: r.id,
    evidence_ids: (entities.find((e) => e.id === r.id)!.evidence_ids as string[]).slice(),
    scope: "runtime_observation",
    caveats: ["Server-side validation is not observable from the browser."],
    last_validated_revision: `${ENV}@${FROM}/${TO}`,
  }));

  const model = {
    schema_version: "1.0.0",
    system_id: "system:f2-site",
    producer: "QAA",
    revision: WINDOW,
    analysis_run_id: "run:01JF2OBSERVED0000000000000",
    machine_text_language: "en",
    entities,
    relationships,
    component_traces: [],
    workflows,
    claims,
    gaps,
    coverage: [
      { area: "/account", status: "skipped", reason: "Authentication required; no credential profile supplied." },
    ],
  };
  const evidenceIndex = { schema_version: "1.0.0", revision: WINDOW, evidence };

  mkdirSync(dir, { recursive: true });
  cpSync(TEMPLATE, dir, { recursive: true });
  const completeness = JSON.parse(readFileSync(join(TEMPLATE, "completeness-report.json"), "utf8"));
  Object.assign(completeness, {
    run_id: model.analysis_run_id,
    examined: { hosts: ["127.0.0.1"], paths: ["/"] },
    entry_points_found: workflows.length,
    workflows_by_status: workflows.reduce<Record<string, number>>((acc, w) => {
      acc[w.discovery_status] = (acc[w.discovery_status] ?? 0) + 1;
      return acc;
    }, {}),
    unresolved_workflow_ids: workflows.filter((w) => w.unresolved_hops.length > 0).map((w) => w.id),
    unexplored: [{ area: "/account", reason: "Authentication required; no credential profile supplied." }],
    forms_not_submitted: truth("runtime.json")
      .forms.filter((f: { withhold: boolean }) => f.withhold)
      .map((f: { id: string }) => ({
        form_id: f.id,
        reason: f.id.includes("login") ? "login_form" : "submission_requires_approval",
      })),
    improvement_suggestions: [],
  });
  const files: Record<string, string> = {
    "system-model.json": json(model),
    "evidence-index.json": json(evidenceIndex),
    "completeness-report.json": json(completeness),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const manifest = JSON.parse(readFileSync(join(TEMPLATE, "manifest.json"), "utf8"));
  manifest.package_id = "pkg:f2-site-observed";
  manifest.package_version = 1;
  delete manifest.previous_package;
  manifest.project = { system_id: "system:f2-site", name: "F2 site" };
  manifest.observed_environments = [
    {
      ...manifest.observed_environments[0],
      environment_id: ENV,
      base_url: "http://127.0.0.1:4100",
      classification: "development",
      observed_from: FROM,
      observed_to: TO,
    },
  ];
  manifest.analysis = {
    ...manifest.analysis,
    run_id: model.analysis_run_id,
    started_at: FROM,
    finished_at: TO,
    scope: { hosts: ["127.0.0.1"], paths: ["/"] },
  };
  manifest.coverage_summary = {
    routes_pages: "partial",
    roles_permissions: "unobservable",
    business_rules: "partial",
    workflows: "partial",
    data_model: "unobservable",
    integrations: "unobservable",
    state_transitions: "unobservable",
  };
  for (const artifact of manifest.artifacts as Array<{ path: string; sha256: string }>)
    artifact.sha256 = sha(readFileSync(join(dir, artifact.path), "utf8"));
  writeFileSync(join(dir, "manifest.json"), json(manifest));
  return dir;
}
