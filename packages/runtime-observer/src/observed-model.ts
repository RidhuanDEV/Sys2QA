import { createHash } from "node:crypto";
import { classifyForm, type ObservedForm } from "./forms.js";
import type { L2Result, ObservedPage } from "./l2-worker.js";

/** What `discovery.run` writes for one walk (`sys2qa.discovery-observations/1`): the input of the observed model. */
export interface DiscoveryObservations {
  schema: "sys2qa.discovery-observations/1";
  job_id: string;
  environment_id: string;
  scope_policy_version: number;
  base_url: string;
  started_at: string;
  finished_at: string;
  status: string;
  login: L2Result["login"];
  budget: L2Result["budget"] | null;
  pages: ObservedPage[];
  links_not_followed: Array<{ target: string; from: string | null; reason: string }>;
  traps: Array<{ path: string; reason: string }>;
  forms: Array<{
    form_key: string;
    form: ObservedForm & { observed_at?: string };
    proposal: string;
    signals: string[];
    submitted: boolean;
    decision: string;
  }>;
  submissions: unknown[];
  blocked_requests: unknown[];
  downloads_refused: string[];
}

export interface ObservedModelOptions {
  system_id: string;
  /** Paths the scope declares (default `/`). */
  paths?: string[];
  extractor_version?: string;
}

type Json = Record<string, unknown>;

/** The observed model of one walk: contract documents plus the counts a person reads (QAA-FR-114). */
export interface ObservedModel {
  model: Json;
  evidence_index: Json;
  completeness: Json;
  summary: { pages: number; forms: number; candidate_workflows: number; gaps: number; statement: string };
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const pathOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};
const stripQuery = (url: string) => {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
};
/**
 * A page-supplied name reduced to an identifier token (letters, digits, `.`, `_`, `-`; at most 64): page text is data
 * (SEC-003) and never becomes a sentence in a claim, so a field named "account was deleted" cannot read as one.
 */
const token = (text: string | null | undefined) =>
  (text ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
/** A URL path (percent-encoded, so without spaces) as an ID part; long ones are shortened with a digest. */
const idPath = (path: string) => (path.length <= 180 ? path : `${path.slice(0, 160)}~${hash(path)}`);
const slug = (path: string) =>
  path === "/" ? "home" : token(path.replace(/^\//, "").replace(/\//g, ".")) || hash(path);
const int = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const num = (v: string | undefined) => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Words of a form whose effect cannot be undone: such forms get their own gap. */
const DESTRUCTIVE = /\b(delete|remove|destroy|erase|deactivate|terminate|close account)\b|hapus/i;
const CATEGORY_GAPS: Array<[string, string]> = [
  ["roles_permissions", "Roles and permissions"],
  ["data_model", "The data model"],
  ["integrations", "External integrations"],
  ["state_transitions", "State transitions"],
];

/**
 * Builds the observed model of one discovery walk (QAA-FR-114): `page`, `form` and `field` entities with navigation and
 * containment, the constraints visible in forms as business rules, and an observed workflow catalog, all
 * `runtime_observed` with environment and observation time. It never claims more than a browser saw (CON-023,
 * CR-002): rules name their `inputs` (never `VALIDATES`), no data-flow relationship is produced, and a success
 * message is never a claim. What was not observed is recorded as gaps, coverage and a completeness report:
 * authentication-gated pages, forms not submitted and why, crawler traps, links outside the scope, budgets that ran
 * out, and what a browser can never see. Counts are "within the declared scope". Pure: the same observations give the
 * same documents.
 */
export function buildObservedModel(obs: DiscoveryObservations, options: ObservedModelOptions): ObservedModel {
  const env = obs.environment_id;
  const revision = {
    kind: "observation_window",
    environment_id: env,
    observed_from: obs.started_at,
    observed_to: obs.finished_at,
  };
  const revisionKey = `${env}@${obs.started_at}/${obs.finished_at}`;
  const extractor = {
    component: "runtime-observer",
    version: options.extractor_version ?? "0.1.0",
    method: "dom_snapshot",
  };

  const evidence: Json[] = [];
  const addEvidence = (key: string, subtype: string, url: string, at: string, submission: string) => {
    const id = `evidence:obs-${hash(`${subtype}|${key}`)}`;
    evidence.push({
      id,
      source_type: "runtime_observation",
      subtype,
      environment_id: env,
      url,
      observed_at: at,
      submission,
      extractor,
      excerpt_policy: "none",
      captured_at: at,
    });
    return id;
  };

  const entities: Json[] = [];
  const relationships: Json[] = [];
  const relate = (type: string, from: string, to: string, evidenceId: string) =>
    relationships.push({
      id: `rel:obs-${hash(`${type}|${from}|${to}`)}`,
      type,
      from,
      to,
      status: "runtime_observed",
      evidence_ids: [evidenceId],
    });

  // Pages: one per path, in the order the walk observed them.
  const pageId = (path: string) => `page:observed:${idPath(path)}`;
  const pages = new Map<string, { page: ObservedPage; id: string; evidence: string; entity: Json }>();
  // A page that answered with an error was reached but not observed working: it is no page entity (CON-023).
  const failedPages: ObservedPage[] = [];
  for (const page of obs.pages) {
    if (pages.has(page.path)) continue;
    if (page.status !== null && page.status >= 400) {
      if (!failedPages.some((p) => p.path === page.path)) failedPages.push(page);
      continue;
    }
    const id = pageId(page.path);
    const evidenceId = addEvidence(page.path, "page", page.url, page.observed_at, "none");
    const entity: Json = {
      id,
      kind: "page",
      name: idPath(page.path),
      status: "runtime_observed",
      origin: "runtime",
      evidence_ids: [evidenceId],
      route_pattern: idPath(page.path),
    };
    entities.push(entity);
    pages.set(page.path, { page, id, evidence: evidenceId, entity });
  }
  const reachable = (path: string) => {
    const p = pages.get(path);
    return p !== undefined && p.page.observability === undefined;
  };
  // Navigation: links the browser saw between observed pages.
  for (const { page, id, evidence: evidenceId } of pages.values())
    for (const link of page.links ?? []) {
      const to = pathOf(link);
      if (to !== null && to !== page.path && pages.has(to)) relate("NAVIGATES_TO", id, pages.get(to)!.id, evidenceId);
    }

  // Forms and their fields; visible constraints become business rules and claims.
  interface FormEntry {
    id: string;
    local: string;
    path: string;
    form: DiscoveryObservations["forms"][number];
    proposal: string;
    destructive: boolean;
    evidence: string;
    entity: Json;
  }
  const forms: FormEntry[] = [];
  const claims: Json[] = [];
  const usedIds = new Set<string>();
  const unique = (id: string, fallback: () => string) => {
    const chosen = usedIds.has(id) ? fallback() : id;
    usedIds.add(chosen);
    return chosen;
  };
  for (const entry of obs.forms) {
    const path = pathOf(entry.form.page_url);
    const page = path === null ? undefined : pages.get(path);
    if (path === null || page === undefined) continue;
    const local = token(entry.form.dom_id) || `form-${entry.form.index + 1}`;
    const id = unique(
      `form:observed:${idPath(path)}#${local}`,
      () => `form:observed:${idPath(path)}#${local}-${hash(entry.form_key)}`,
    );
    const formLocal = id.slice(id.lastIndexOf("#") + 1);
    const evidenceId = addEvidence(
      entry.form_key,
      "form",
      stripQuery(entry.form.page_url),
      entry.form.observed_at ?? page.page.observed_at,
      entry.submitted ? "read_only" : "none",
    );
    const entity: Json = {
      id,
      kind: "form",
      name: `${formLocal} on ${idPath(path)}`,
      status: "runtime_observed",
      origin: "runtime",
      evidence_ids: [evidenceId],
      page_id: page.id,
      method: entry.form.method.toUpperCase(),
    };
    entities.push(entity);
    relate("CONTAINS", page.id, id, evidenceId);
    const proposal = classifyForm(entry.form).proposal;
    const words = [...entry.form.buttons, entry.form.action, entry.form.dom_id ?? ""];
    forms.push({
      id,
      local: formLocal,
      path,
      form: entry,
      proposal,
      destructive: words.some((w) => DESTRUCTIVE.test(w)),
      evidence: evidenceId,
      entity,
    });

    entry.form.fields.forEach((field, n) => {
      if (["hidden", "submit", "button", "reset", "image"].includes(field.type)) return;
      const name = token(field.name) || `field-${n + 1}`;
      const fieldId = unique(
        `field:observed:${idPath(path)}#${name}`,
        () => `field:observed:${idPath(path)}#${formLocal}.${name}`,
      );
      const c = field.constraints ?? {};
      const pattern = c.pattern !== undefined && c.pattern !== "" ? `^(?:${c.pattern})$` : undefined;
      const constraints = Object.fromEntries(
        Object.entries({
          required: field.required,
          input_type: field.type,
          max_length: int(c.maxlength),
          min_length: int(c.minlength),
          pattern,
          min: num(c.min),
          max: num(c.max),
        }).filter(([, v]) => v !== undefined),
      );
      entities.push({
        id: fieldId,
        kind: "field",
        name,
        status: "runtime_observed",
        origin: "runtime",
        evidence_ids: [evidenceId],
        form_id: id,
        constraints,
      });
      relate("CONTAINS", id, fieldId, evidenceId);

      const parts: string[] = [];
      const boundary: Json = { field: name, field_id: fieldId };
      if (constraints.min_length !== undefined) {
        parts.push(`at least ${String(constraints.min_length)} characters (minlength)`);
        boundary.min_length = constraints.min_length;
      }
      if (constraints.max_length !== undefined) {
        parts.push(`at most ${String(constraints.max_length)} characters (maxlength)`);
        boundary.max_length = constraints.max_length;
      }
      if (pattern !== undefined) {
        // The pattern itself is page text: it stays in the boundary, out of the sentence.
        parts.push("only values matching its pattern attribute (pattern)");
        boundary.pattern = pattern;
      }
      if (constraints.min !== undefined) {
        parts.push(`values of at least ${String(constraints.min)} (min)`);
        boundary.min = constraints.min;
      }
      if (constraints.max !== undefined) {
        parts.push(`values of at most ${String(constraints.max)} (max)`);
        boundary.max = constraints.max;
      }
      if (parts.length === 0) return;
      const ruleKey = `${idPath(path)}#${fieldId.slice(fieldId.lastIndexOf("#") + 1)}`;
      const ruleId = `business_rule:observed:${ruleKey}`;
      const statement = `In the browser, field ${name} of form ${formLocal} on ${idPath(path)} accepts ${parts.join(", ")}.`;
      entities.push({
        id: ruleId,
        kind: "business_rule",
        name: statement,
        statement,
        status: "runtime_observed",
        origin: "runtime",
        boundaries: [boundary],
        inputs: [fieldId],
        business_intent: null,
        evidence_ids: [evidenceId],
      });
      claims.push({
        id: `claim:observed:${ruleKey}`,
        text: { language: "en", value: statement },
        status: "runtime_observed",
        subject_entity_id: ruleId,
        evidence_ids: [evidenceId],
        scope: "runtime_observation",
        caveats: [
          "Only the constraint the browser enforces was observed; server-side validation is not observable from the browser.",
        ],
        last_validated_revision: revisionKey,
      });
    });
  }

  // Gaps: what discovery did not observe, and why.
  const gaps: Json[] = [];
  const gap = (key: string, type: string, description: string, impact: string, related: string[], extra: Json = {}) => {
    const id = `gap:observed.${key}`;
    gaps.push({
      id,
      type,
      description,
      impact,
      related_entity_ids: [...new Set(related)],
      requires_human_clarification: false,
      status: "unresolved",
      ...extra,
    });
    return id;
  };
  const gated = [...pages.values()].filter((p) => p.page.observability === "auth_required");
  const notSubmitted = forms.filter((f) => !f.form.submitted);
  const loginForms = notSubmitted.filter((f) => f.proposal === "login");
  const loginStopped = obs.login !== null && obs.login !== undefined && obs.login.status !== "logged_in";
  const behindLogin =
    gated.length > 0 || loginForms.length > 0 || loginStopped
      ? gap(
          "behind-login",
          "unobservable",
          loginStopped
            ? `Pages behind the login were not observed: ${obs.login!.reason}.`
            : "Pages behind the login were not observed; login forms are never submitted by discovery.",
          "What authenticated users see and do is unknown without a credential profile.",
          [...gated.map((p) => p.id), ...loginForms.map((f) => f.id)],
        )
      : undefined;
  const effectsUnknown = notSubmitted.filter((f) => f.proposal !== "login" && !f.destructive);
  const effectsGap =
    effectsUnknown.length > 0
      ? gap(
          "form-effects-unknown",
          "unobservable",
          "Forms were inspected but not submitted: what submitting them does was not observed.",
          "Validation responses, stored data and messages after submission are unknown; an approved test or the source would show them.",
          effectsUnknown.map((f) => f.id),
        )
      : undefined;
  const destructive = notSubmitted.filter((f) => f.proposal !== "login" && f.destructive);
  const destructiveGap =
    destructive.length > 0
      ? gap(
          "destructive-form",
          "unobservable",
          "Forms whose labels or targets name an irreversible action were never submitted.",
          "Their effect can only be learned from the source or an approved test with a cleanup plan.",
          destructive.map((f) => f.id),
        )
      : undefined;
  const gapOfForm = (f: FormEntry) =>
    f.proposal === "login" ? behindLogin : f.destructive ? destructiveGap : effectsGap;
  if (obs.traps.length > 0)
    gap(
      "crawler-trap",
      "missing_evidence",
      "Paths that produced endless query variants were cut off after a few variants.",
      "Variants beyond the cut-off were not observed.",
      obs.traps.map((t) => pages.get(t.path)?.id).filter((id): id is string => id !== undefined),
    );
  const outside = obs.links_not_followed.filter((l) => /outside the scope/.test(l.reason));
  if (outside.length > 0)
    gap(
      "outside-scope",
      "external_boundary",
      "Links or redirects leading outside the declared scope were recorded and not followed.",
      "Whatever lies beyond the scope boundary was not observed.",
      outside.map((l) => pages.get(pathOf(l.from) ?? "")?.id).filter((id): id is string => id !== undefined),
    );
  const unreachable = obs.links_not_followed.filter((l) => !/outside the scope/.test(l.reason));
  if (unreachable.length > 0 || failedPages.length > 0)
    gap(
      "unreachable",
      "missing_evidence",
      "Some in-scope URLs could not be loaded or answered with an error.",
      "Pages behind them were not observed.",
      unreachable.map((l) => pages.get(pathOf(l.from) ?? "")?.id).filter((id): id is string => id !== undefined),
    );
  const exhausted = obs.budget?.exhausted ?? null;
  if (exhausted)
    gap(
      "budget-exhausted",
      "missing_evidence",
      `The ${exhausted} budget of the walk ran out before every reachable page was observed.`,
      "Pages and forms beyond the budget were not observed; a larger budget or seeds would cover them.",
      [],
    );
  for (const [category, what] of CATEGORY_GAPS)
    gap(
      `${category.replace(/_/g, "-")}-unobservable`,
      "unobservable",
      `${what} cannot be established from browser observation.`,
      "Source code or documentation would be needed.",
      [],
      { coverage_category: category },
    );
  if (behindLogin) for (const p of gated) p.entity.gap_ids = [behindLogin];
  for (const f of notSubmitted) {
    const g = gapOfForm(f);
    if (g) f.entity.gap_ids = [g];
  }

  // The observed workflow catalog (CON-024): candidate workflows, never "the application's workflows".
  const workflows: Json[] = [];
  const keys = new Set<string>();
  const workflow = (
    key: string,
    name: string,
    category: string,
    steps: string[],
    hop?: { reason_code: string; gap_id: string | undefined; description: string },
  ) => {
    let k = key;
    if (keys.has(k)) k = `${key}-${hash(steps.join("|"))}`;
    keys.add(k);
    const stepRecords = steps.map((entityId, n) => ({
      id: `step:observed.${k}.${n + 1}`,
      order: n + 1,
      entity_id: entityId,
      action: n === 0 ? "open" : entityId.startsWith("form:") ? "inspect" : "navigate",
    }));
    const entry = [...pages.values()].find((p) => p.id === steps[0]);
    workflows.push({
      id: `workflow:observed.${k}`,
      name,
      category,
      origin: "runtime",
      discovery_status: hop ? "partially_reconstructed" : "reconstructed",
      entry_point_ids: [steps[0]],
      component_trace_ids: [],
      steps: stepRecords,
      branches: [],
      unresolved_hops: hop
        ? [
            {
              after_step: stepRecords[stepRecords.length - 1]!.id,
              reason_code: hop.reason_code,
              ...(hop.gap_id ? { gap_id: hop.gap_id } : {}),
              description: hop.description,
            },
          ]
        : [],
      completion: hop ? "partial" : "runtime_observed_for_run",
      deepened: false,
      rank: workflows.length + 1,
      status: "runtime_observed",
      evidence_ids: entry ? [entry.evidence] : [],
    });
  };
  // Browsing a collection: a page linking to pages one level below its own path (/products → /products/1),
  // opened from the page that first links to it.
  for (const { page, id } of pages.values()) {
    if (page.path === "/" || page.observability) continue;
    const children = (page.links ?? [])
      .map(pathOf)
      .filter(
        (p): p is string => p !== null && p.startsWith(`${page.path}/`) && !p.slice(page.path.length + 1).includes("/"),
      )
      .filter((p) => p !== `${page.path}/` && reachable(p))
      .sort();
    if (children.length === 0) continue;
    const referrer = [...pages.values()]
      .filter(
        (p) =>
          p.page.path !== page.path &&
          !p.page.observability &&
          (p.page.links ?? []).some((l) => pathOf(l) === page.path),
      )
      .sort((a, b) => a.page.depth - b.page.depth || a.page.path.localeCompare(b.page.path))[0];
    workflow(`browse.${slug(page.path)}`, `Browse ${idPath(page.path)} and open an item`, "user_interface", [
      ...(referrer ? [referrer.id] : []),
      id,
      pages.get(children[0]!)!.id,
    ]);
  }
  // Opening a form: stops where discovery may not submit.
  for (const f of forms) {
    const page = pages.get(f.path)!;
    const isLogin = f.proposal === "login";
    workflow(
      `form.${slug(f.path)}.${f.local}`,
      `Open form ${f.local} on ${idPath(f.path)}`,
      isLogin ? "auth" : "user_interface",
      [page.id, f.id],
      f.form.submitted
        ? undefined
        : {
            reason_code: isLogin ? "auth_required" : "submission_requires_approval",
            gap_id: gapOfForm(f),
            description: isLogin
              ? "Login forms are never submitted by discovery; what follows the login was not observed."
              : `Not submitted during discovery (${f.form.decision}); its effect was not observed.`,
          },
    );
  }
  // Reaching a page that asks to log in first.
  for (const p of gated) {
    const target = pathOf(p.page.redirected_to);
    const loginPage = target !== null && pages.has(target) && target !== p.page.path ? pages.get(target)! : undefined;
    workflow(
      `gated.${slug(p.page.path)}`,
      `Open ${idPath(p.page.path)} (authentication required)`,
      "auth",
      [p.id, ...(loginPage ? [loginPage.id] : [])],
      {
        reason_code: "auth_required",
        gap_id: behindLogin,
        description: "The page asks for a login; nothing behind it was observed.",
      },
    );
  }

  // Coverage and completeness: what was examined, and what was not.
  const coverage: Json[] = [];
  const unexplored: Json[] = [];
  const excluded: Json[] = [];
  const gatedReason = loginStopped
    ? `Authentication required; the login did not succeed (${obs.login!.reason}).`
    : "Authentication required; no credential profile supplied.";
  for (const p of gated) {
    coverage.push({ area: p.page.path, status: "skipped", reason: gatedReason });
    unexplored.push({ area: p.page.path, reason: gatedReason });
  }
  for (const t of obs.traps) coverage.push({ area: t.path, status: "partial", reason: t.reason });
  for (const l of outside) {
    const area = l.target.slice(0, 300);
    if (excluded.some((e) => e.area === area)) continue;
    coverage.push({ area, status: "excluded", reason: "Outside the declared scope; not followed." });
    excluded.push({ area, reason: "Outside the declared scope; not followed." });
  }
  for (const p of failedPages) {
    const reason = `The page answered HTTP ${String(p.status)}.`;
    coverage.push({ area: p.path, status: "failed", reason });
    unexplored.push({ area: p.path, reason });
  }
  for (const l of unreachable) {
    const area = l.target.slice(0, 300);
    coverage.push({ area, status: "failed", reason: l.reason.slice(0, 300) });
    unexplored.push({ area, reason: l.reason.slice(0, 300) });
  }
  if (exhausted) {
    const area = pathOf(obs.base_url) ?? "/";
    coverage.push({ area, status: "partial", reason: `The ${exhausted} budget ran out.` });
    unexplored.push({ area, reason: `The ${exhausted} budget ran out before every reachable page was observed.` });
  }

  const workflowIds = (filter: (w: Json) => boolean) => workflows.filter(filter).map((w) => w.id as string);
  const suggestions: Json[] = [];
  if (gated.length > 0 || loginForms.length > 0)
    suggestions.push({
      evidence_kind: "credentials",
      description: "A credential profile for each role would let discovery observe the pages behind the login.",
      would_improve: workflowIds((w) => w.category === "auth"),
    });
  if (effectsUnknown.length > 0 || destructive.length > 0)
    suggestions.push({
      evidence_kind: "source",
      description:
        "The source repository would show what submitting the forms does (validation, persistence, messages).",
      would_improve: workflowIds((w) =>
        (w.unresolved_hops as Json[]).some((h) => h.reason_code === "submission_requires_approval"),
      ),
    });
  const readOnlyWaiting = notSubmitted.filter((f) => f.proposal === "read_only");
  if (readOnlyWaiting.length > 0)
    suggestions.push({
      evidence_kind: "read_only_submissions",
      description:
        "Allowing read-only submissions (L2r) and confirming the read-only forms would let discovery observe their results.",
      would_improve: workflowIds((w) =>
        readOnlyWaiting.some((f) => (w.steps as Json[]).some((s) => s.entity_id === f.id)),
      ),
    });
  if (exhausted || obs.traps.length > 0)
    suggestions.push({
      evidence_kind: "runtime",
      description: "A larger budget or seed URLs would let discovery observe the pages it did not reach.",
      would_improve: [],
    });

  const formNotSubmittedReason = (f: FormEntry) =>
    f.proposal === "login"
      ? "login_form"
      : f.proposal === "state_changing"
        ? "state_changing"
        : f.proposal === "read_only" && /not declared/.test(f.form.decision)
          ? "read_only_not_enabled"
          : "submission_requires_approval";
  const byStatus = workflows.reduce<Record<string, number>>((acc, w) => {
    const s = w.discovery_status as string;
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const hosts = [...new Set(obs.pages.map((p) => new URL(p.url).host))].sort();
  const completeness = {
    schema_version: "1.0.0",
    producer: "QAA",
    run_id: obs.job_id,
    count_scope: "within_examined_scope",
    examined: { hosts, paths: options.paths ?? ["/"] },
    constructs: {
      analyzed: [...pages.values()].filter((p) => !p.page.observability).length,
      partial: gated.length + obs.traps.length,
      unsupported: 0,
    },
    entry_points_found: new Set(workflows.map((w) => (w.entry_point_ids as string[])[0])).size,
    workflows_by_status: byStatus,
    unresolved_workflow_ids: workflowIds((w) => (w.unresolved_hops as Json[]).length > 0),
    unavailable_adapters: [],
    excluded,
    unexplored,
    forms_not_submitted: notSubmitted.map((f) => ({ form_id: f.id, reason: formNotSubmittedReason(f) })),
    improvement_suggestions: suggestions,
  };

  const model = {
    schema_version: "1.0.0",
    system_id: options.system_id,
    producer: "QAA",
    revision,
    analysis_run_id: obs.job_id,
    machine_text_language: "en",
    entities,
    relationships,
    component_traces: [],
    workflows,
    claims,
    gaps,
    coverage,
  };
  const statement = `${pages.size} pages and ${workflows.length} candidate workflows observed within the declared scope.`;
  return {
    model,
    evidence_index: { schema_version: "1.0.0", revision, evidence },
    completeness,
    summary: {
      pages: pages.size,
      forms: forms.length,
      candidate_workflows: workflows.length,
      gaps: gaps.length,
      statement,
    },
  };
}
