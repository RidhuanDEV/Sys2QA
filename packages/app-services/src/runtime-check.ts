import { appendAudit } from "@sys2qa/platform";
import { correlatePackages, type CorrelationModel } from "@sys2qa/qaa-core";
import {
  buildObservedModel,
  classifyForm,
  formKey,
  runL2Job,
  type DiscoveryObservations,
  type L2Result,
} from "@sys2qa/runtime-observer";
import { observation } from "./environments.js";
import { serviceError, ServiceError } from "./errors.js";
import { defineOperation } from "./operations.js";
import { packageRow, revalidated } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;

/** Targeted verification budgets (QAA-FR-029, NFR-002): defaults and caller limits. */
export const VERIFICATION_BUDGET = { pages: 10, ms: 60_000 } as const;
const VERIFICATION_LIMITS = { pages: 50, ms: 300_000 } as const;

type Outcome = "verified" | "not_confirmed" | "unverified";
interface ItemResult {
  record_id: string;
  kind: string;
  url: string | null;
  outcome: Outcome;
  reason: string;
  observed_at?: string;
}

const KINDS = new Set(["page", "form", "field"]);
const isParameterized = (route: string) => /\{[^}]+\}|:[A-Za-z_]|\[[^\]]+\]/.test(route);

const runtimeVerify = defineOperation<
  {
    project_id: string;
    package_id: string;
    version: number;
    source_id: string;
    record_ids: string[];
    budget?: { pages?: number; ms?: number };
  },
  unknown
>({
  name: "runtime.verify",
  title: "Verify package items in the environment",
  description:
    "Targeted runtime verification (QAA-FR-029): the pages, forms and fields named from a package are checked in an L2 browser worker that opens only their pages, follows no link and submits nothing, within a page and time budget. Each item is `verified` (seen as the package describes it), `not_confirmed` (the page answered with an error, the form or field is missing, or a visible limit differs) or `unverified` (not reached: budget, authentication, or a route with parameters). When the budget runs out the record is `partial` and lists the items left unverified. Whole-application discovery is the separate `discovery.run`. The record is QAA evidence (`targeted_runtime_check`) and never changes the package.",
  level: "L2",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version", "source_id", "record_ids"],
    properties: {
      project_id: ID,
      package_id: { type: "string", pattern: "^pkg:[a-z0-9][a-z0-9._-]{0,127}$" },
      version: { type: "integer", minimum: 1 },
      source_id: ID,
      record_ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: ID },
      budget: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(VERIFICATION_LIMITS).map(([k, max]) => [k, { type: "integer", minimum: 1, maximum: max }]),
        ),
      },
    },
  },
  run: async ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    const prepared = revalidated(packageRow(host, project.id, input.package_id, input.version));
    const text = prepared.files.get("system-model.json");
    if (!text) throw serviceError("NOT_FOUND", "the package has no structured model to verify");
    const model = JSON.parse(Buffer.from(text).toString("utf8")) as CorrelationModel;
    const byId = new Map(model.entities.map((e) => [e.id, e]));
    const env = host.projects.getEvidenceSource(input.source_id);
    if (env.project_id !== project.id || env.kind !== "environment")
      throw serviceError("INPUT_INVALID", "source_id must be an environment of this project", { field: "source_id" });

    // The page each item lives on.
    const pageOf = (id: string) => {
      const e = byId.get(id);
      if (!e) return undefined;
      if (e.kind === "page") return e;
      if (e.kind === "form") return e.page_id ? byId.get(e.page_id) : undefined;
      const form = e.form_id ? byId.get(e.form_id) : undefined;
      return form?.page_id ? byId.get(form.page_id) : undefined;
    };
    for (const id of input.record_ids) {
      const e = byId.get(id);
      if (!e) throw serviceError("NOT_FOUND", `no record ${id} in this package`);
      if (!KINDS.has(e.kind))
        throw serviceError(
          "INPUT_INVALID",
          `${id} is a ${e.kind}; only pages, forms and fields can be checked in a browser`,
        );
    }
    const policy = host.projects.currentScopePolicy(env.id);
    if (!policy)
      throw serviceError("NOT_FOUND", "the environment has no scope policy; configure it first", {
        field: "source_id",
      });
    const base = new URL(policy.base_url);
    const urlOfRoute = (route: string) => new URL(route, `${base.protocol}//${base.host}`).href;
    const routes: string[] = [];
    for (const id of input.record_ids) {
      const route = pageOf(id)?.route_pattern;
      if (route && !isParameterized(route) && !routes.includes(route)) routes.push(route);
    }
    const budget = { ...VERIFICATION_BUDGET, ...(input.budget ?? {}) };
    const results: ItemResult[] = [];
    let result: L2Result | undefined;
    let jobId: string | undefined;
    let window = { from: host.now().toISOString(), to: host.now().toISOString() };
    if (routes.length > 0) {
      const urls = routes.map(urlOfRoute);
      for (const url of urls) {
        const allowed = host.projects.authorize(env.id, "observe", { kind: "url", url });
        if (!allowed.allowed)
          throw new ServiceError(
            "SCOPE_DENIED",
            "denied",
            `${url} is outside the scope (${allowed.reason})`,
            "Verify only items whose pages are inside the declared hosts and paths.",
          );
      }
      const obs = await observation(host, env.id, urls[0]);
      jobId = obs.jobId;
      window = { from: host.now().toISOString(), to: window.to };
      try {
        result = await runL2Job(
          {
            action: "discover",
            url: urls[0]!,
            seeds: urls.slice(1),
            scope: obs.scope,
            // Only the named pages: no link is followed (depth 0), one variant per path.
            budget: { pages: budget.pages, depth: 0, ms: budget.ms, variants: 1 },
          },
          obs.proxy,
          { budgetMs: budget.ms + 60_000, onForms: () => [] },
        );
      } finally {
        await obs.proxy.close();
      }
      window = { from: window.from, to: host.now().toISOString() };
    }

    // What the browser saw, as an observed model, correlated with the package.
    const pages = result?.pages ?? [];
    const observed =
      result && jobId
        ? buildObservedModel(
            {
              schema: "sys2qa.discovery-observations/1",
              job_id: jobId,
              environment_id: env.id,
              scope_policy_version: policy.version,
              base_url: policy.base_url,
              started_at: window.from,
              finished_at: window.to,
              status: "completed",
              login: null,
              budget: result.budget ?? null,
              pages,
              links_not_followed: result.links_not_followed ?? [],
              traps: [],
              forms: (result.forms_seen ?? []).map((form) => {
                const c = classifyForm(form);
                return {
                  form_key: formKey(form),
                  form,
                  proposal: c.proposal,
                  signals: c.signals,
                  submitted: false,
                  decision: "verification never submits",
                };
              }),
              submissions: [],
              blocked_requests: result.blocked,
              downloads_refused: result.downloads ?? [],
            } satisfies DiscoveryObservations,
            { system_id: "system:verification" },
          ).model
        : undefined;
    const report = observed
      ? correlatePackages({
          report_id: "correlation:verification",
          generated_at: window.to,
          saa: { package_id: input.package_id, package_version: input.version, model },
          qaa: {
            package_id: input.package_id,
            package_version: input.version,
            model: observed as unknown as CorrelationModel,
          },
          revision_correspondence: "unconfirmed",
        })
      : undefined;
    const linkedTo = new Map((report?.links ?? []).map((l) => [l.source_id, l.observed_id]));
    const exhausted = result?.budget?.exhausted ?? null;

    const pageOutcome = (route: string | undefined): Omit<ItemResult, "record_id" | "kind"> => {
      if (!route)
        return { url: null, outcome: "unverified", reason: "the item has no page with a route in the package" };
      if (isParameterized(route))
        return { url: null, outcome: "unverified", reason: `the route ${route} has parameters; name a concrete page` };
      const url = urlOfRoute(route);
      const seen = pages.find((p) => p.path === new URL(url).pathname);
      if (!seen)
        return {
          url,
          outcome: "unverified",
          reason: exhausted ? `not reached: the ${exhausted} budget ran out` : "not reached",
        };
      if (seen.status !== null && seen.status >= 400)
        return {
          url,
          outcome: "not_confirmed",
          reason: `the page answered HTTP ${seen.status}`,
          observed_at: seen.observed_at,
        };
      if (seen.observability === "auth_required")
        return { url, outcome: "unverified", reason: "the page asks for a login", observed_at: seen.observed_at };
      return { url, outcome: "verified", reason: "the page was observed", observed_at: seen.observed_at };
    };
    for (const id of input.record_ids) {
      const entity = byId.get(id)!;
      const page = pageOutcome(pageOf(id)?.route_pattern);
      const item = (outcome: Outcome, reason: string): ItemResult => ({
        record_id: id,
        kind: entity.kind,
        ...page,
        outcome,
        reason,
      });
      if (entity.kind === "page" || page.outcome !== "verified") {
        results.push({ record_id: id, kind: entity.kind, ...page });
        continue;
      }
      const formId = entity.kind === "form" ? entity.id : entity.form_id!;
      if (!linkedTo.has(formId)) {
        results.push(item("not_confirmed", "the form was not found on the page"));
        continue;
      }
      if (entity.kind === "form") {
        results.push(item("verified", "the form was observed on its page"));
        continue;
      }
      const observedField = linkedTo.get(entity.id);
      if (!observedField) {
        results.push(item("not_confirmed", "the field was not found in the form"));
        continue;
      }
      const mismatch = report!.discrepancies.find(
        (d) => d.type === "constraint_mismatch" && d.observed_ids.includes(observedField),
      );
      results.push(
        mismatch
          ? item("not_confirmed", mismatch.description)
          : item("verified", "the field was observed with no differing visible limit"),
      );
    }
    const unverified = results.filter((r) => r.outcome === "unverified").map((r) => r.record_id);
    const status = unverified.length > 0 ? "partial" : "complete";
    const doc = {
      source_type: "targeted_runtime_check",
      package: { package_id: input.package_id, package_version: input.version },
      environment_id: env.id,
      job_id: jobId ?? null,
      observed_from: window.from,
      observed_to: window.to,
      status,
      budget: { ...budget, exhausted },
      items: results,
      unverified,
      submission: "none",
    };
    const id = host.newId("rtcheck");
    const at = host.now().toISOString();
    host.state.transaction(() => {
      host.state.db
        .prepare(
          "INSERT INTO runtime_checks (id, project_id, package_id, package_version, environment_id, job_id, status, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          project.id,
          input.package_id,
          input.version,
          env.id,
          jobId ?? "job:none",
          status,
          JSON.stringify(doc),
          at,
          at,
        );
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "runtime.verified",
          target: `${input.package_id}@${input.version}`,
          details: {
            check_id: id,
            status,
            items: results.length,
            verified: results.filter((r) => r.outcome === "verified").length,
            not_confirmed: results.filter((r) => r.outcome === "not_confirmed").length,
            unverified: unverified.length,
          },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return { check_id: id, ...doc };
  },
});

export const RUNTIME_CHECK_OPERATIONS = [runtimeVerify];
