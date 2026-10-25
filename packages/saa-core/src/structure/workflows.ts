import type { ComponentTrace, Entity, Evidence, Gap, Relationship, Workflow } from "@sys2qa/contract";

type Category = Workflow["category"];
type Step = Workflow["steps"][number];
type Hop = Workflow["unresolved_hops"][number];

/** What the composer reads: the structural result of one run. */
export interface CatalogInput {
  entities: readonly Entity[];
  relationships: readonly Relationship[];
  component_traces: readonly ComponentTrace[];
  gaps: readonly Gap[];
  evidence: readonly Evidence[];
}

export interface CatalogOptions {
  /** Workflows reconstructed in full, best-ranked first; the rest are listed and marked not deepened (SAA-FR-046). */
  maxDeepened?: number;
  /** Workflow IDs to reconstruct in full regardless of rank (the deepen operation). */
  deepen?: readonly string[];
}

export interface CatalogGroup {
  boundary: string;
  /** Directory of the code that handles the workflow, without a leading `src/`. */
  area: string;
  category: Category;
  workflow_ids: string[];
}

/** The workflow catalog (SAA-FR-040, SAA-FR-046). Counts are only ever within the examined scope (CR-043). */
export interface WorkflowCatalog {
  count_scope: "within_examined_scope";
  /** In rank order. */
  workflows: Workflow[];
  groups: CatalogGroup[];
  /** Workflows listed but not reconstructed in full because of the budget; `deepenWorkflow` reconstructs one. */
  not_deepened: string[];
}

const AUTH = /(^|[/._-])(login|logout|sign-?in|sign-?out|password|session|admin|permission|roles?)([/._-]|$)/i;

interface Draft {
  entry: string;
  name: string;
  category: Category;
  boundary: string;
  area: string;
  /** Steps without IDs: entity, action, and the trace that reconstructs it in full. */
  steps: Array<{ entity: string; action: string; trace?: string }>;
  /** Stops known without deepening (the entry's own trace). */
  hops: Array<{ after?: string; reason: Hop["reason_code"]; gap?: string }>;
  traces: string[];
  status: Workflow["discovery_status"];
  score: number;
}

/**
 * Composes component traces into workflows and ranks them (IMP-111, SAA-FR-040, SAA-FR-046, PRD §11.6). No workflow
 * name is needed: every page that submits a form, requests an endpoint or calls a backend is a workflow, and so is
 * every scheduled job and every endpoint no page reaches. A topic published here with no consumer in scope is listed
 * as `known_not_traceable`. Steps follow the user's path (page, form, endpoint, backend); stops come from the traces
 * and make a workflow `partially_reconstructed`. Ranking follows the value heuristics of PRD §11.1 (data mutation,
 * exposed interfaces, external dependencies, authentication, unresolved links); ties are broken by ID. A deepened
 * workflow carries each step's reads, writes, side effects and validating rules, the state machine an endpoint guards
 * transitions with, and branches from form constraints and error responses (IMP-112).
 */
export function composeWorkflows(input: CatalogInput, options: CatalogOptions = {}): WorkflowCatalog {
  const entities = new Map(input.entities.map((e) => [e.id, e]));
  const relationships = new Map(input.relationships.map((r) => [r.id, r]));
  const traces = new Map(input.component_traces.map((t) => [t.entry_point_id, t]));
  const lineOf = new Map(input.evidence.map((e) => [e.id, e.range?.start_line ?? 0] as const));
  const firstLine = (ids: readonly string[] | undefined) => Math.min(...(ids ?? []).map((id) => lineOf.get(id) ?? 0));
  const out = (from: string, type: Relationship["type"]) =>
    input.relationships.filter((r) => r.from === from && r.type === type);
  const traceRelationships = (entry: string) =>
    (traces.get(entry)?.relationship_ids ?? []).map((id) => relationships.get(id)).filter((r) => r !== undefined);
  const pathOf = (moduleId: string | undefined) =>
    (entities.get(moduleId ?? "") as { path?: string } | undefined)?.path;
  const areaOf = (moduleId: string | undefined) => {
    const path = pathOf(moduleId);
    if (!path) return "(unknown)";
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    return dir.replace(/^src\//, "").replace(/^src$/, ".");
  };
  const moduleOf = (id: string) => entities.get(id) as { module_id?: string; component_module_id?: string } | undefined;
  const hopsOf = (entry: string, stepOf: (entity: string | undefined) => string | undefined): Draft["hops"] =>
    (traces.get(entry)?.stopped_at ?? []).map((s) => {
      const after = s.reason_code === "config_unavailable" ? undefined : (stepOf(s.entity_id) ?? stepOf(entry));
      return { ...(after ? { after } : {}), reason: s.reason_code, ...(s.gap_id ? { gap: s.gap_id } : {}) };
    });

  /** An endpoint step, followed by the state machine its code guards transitions with, if any. */
  const pushEndpoint = (steps: Draft["steps"], api: string, action: string) => {
    steps.push({ entity: api, action, trace: api });
    const machines = traceRelationships(api)
      .filter((r) => r.type === "CALLS")
      .flatMap((r) => out(r.to, "REFERENCES").filter((x) => x.to.startsWith("state_machine:")))
      .map((r) => r.to);
    for (const machine of [...new Set(machines)].sort())
      if (!steps.some((s) => s.entity === machine)) steps.push({ entity: machine, action: "transition" });
  };
  /** Rules that validate an endpoint (`VALIDATES` rule → endpoint). */
  const rulesOf = (api: string) =>
    input.relationships.filter((r) => r.type === "VALIDATES" && r.to === api).map((r) => r.from);
  const fieldsOf = (form: string) =>
    out(form, "CONTAINS")
      .map((r) => entities.get(r.to))
      .filter((e): e is Entity => e?.kind === "field");

  const drafts: Draft[] = [];
  const reachedApis = new Set<string>();

  // Pages: open, submit each form (in source order) to its endpoint, then the endpoints and backends the page calls.
  for (const page of input.entities.filter((e) => e.kind === "page")) {
    const forms = out(page.id, "CONTAINS")
      .map((r) => entities.get(r.to))
      .filter((e): e is Entity => e?.kind === "form")
      .sort((a, b) => firstLine(a.evidence_ids) - firstLine(b.evidence_ids) || a.id.localeCompare(b.id));
    const steps: Draft["steps"] = [{ entity: page.id, action: "open" }];
    const apis: string[] = [];
    for (const form of forms) {
      steps.push({ entity: form.id, action: "submit" });
      for (const r of out(form.id, "SUBMITS_TO")) {
        pushEndpoint(steps, r.to, "request");
        apis.push(r.to);
      }
    }
    for (const r of out(page.id, "CONSUMES").sort((a, b) => a.to.localeCompare(b.to)))
      if (!apis.includes(r.to)) {
        pushEndpoint(steps, r.to, "request");
        apis.push(r.to);
      }
    const backends = [
      ...new Set(
        traceRelationships(page.id)
          .filter((r) => r.type === "SENDS_TO")
          .map((r) => r.to),
      ),
    ].sort();
    for (const b of backends) steps.push({ entity: b, action: "send" });
    if (forms.length === 0 && apis.length === 0 && backends.length === 0) continue;
    apis.forEach((a) => reachedApis.add(a));
    const ids = steps.map((s) => s.entity);
    const writes = apis.some((a) => traceRelationships(a).some((r) => r.type === "WRITES_TO"));
    const category: Category = ids.some((id) => AUTH.test(id.slice(id.indexOf(":") + 1)))
      ? "auth"
      : forms.length > 0 || writes
        ? "business_process"
        : "user_interface";
    drafts.push({
      entry: page.id,
      name: `Page ${page.name ?? page.id}`,
      category,
      boundary: page.project_boundary ?? "project:.",
      area: apis.length > 0 ? areaOf(moduleOf(apis[0]!)?.module_id) : areaOf(moduleOf(page.id)?.component_module_id),
      steps,
      hops: hopsOf(page.id, (e) => (e !== undefined && ids.includes(e) ? e : undefined)),
      traces: [page.id, ...apis].filter((t) => traces.has(t)).map((t) => traces.get(t)!.id),
      status: "reconstructed",
      score: 0,
    });
  }

  // Scheduled jobs: run, then the data they write and read (in source order).
  for (const job of input.entities.filter((e) => e.kind === "job")) {
    const data = traceRelationships(job.id)
      .filter((r) => r.type === "WRITES_TO" || r.type === "READS_FROM")
      .sort((a, b) => firstLine(a.evidence_ids) - firstLine(b.evidence_ids) || a.id.localeCompare(b.id));
    const steps: Draft["steps"] = [{ entity: job.id, action: "run", trace: job.id }];
    for (const r of data)
      if (!steps.some((s) => s.entity === r.to))
        steps.push({ entity: r.to, action: r.type === "WRITES_TO" ? "write" : "read" });
    const ids = steps.map((s) => s.entity);
    drafts.push({
      entry: job.id,
      name: `Job ${job.name ?? job.id}`,
      category: "scheduled_processing",
      boundary: job.project_boundary ?? "project:.",
      area: areaOf(moduleOf(job.id)?.module_id),
      steps,
      hops: hopsOf(job.id, (e) => (e !== undefined && ids.includes(e) ? e : job.id)),
      traces: traces.has(job.id) ? [traces.get(job.id)!.id] : [],
      status: "reconstructed",
      score: 0,
    });
  }

  // Endpoints no page reaches: exposed interfaces in their own right.
  for (const api of input.entities.filter((e) => e.kind === "api" && !reachedApis.has(e.id))) {
    drafts.push({
      entry: api.id,
      name: api.name ?? api.id,
      category: AUTH.test(api.id.slice(4)) ? "auth" : "api",
      boundary: api.project_boundary ?? "project:.",
      area: areaOf(moduleOf(api.id)?.module_id),
      steps: (() => {
        const steps: Draft["steps"] = [];
        pushEndpoint(steps, api.id, "handle");
        return steps;
      })(),
      hops: [],
      traces: traces.has(api.id) ? [traces.get(api.id)!.id] : [],
      status: "reconstructed",
      score: 0,
    });
  }

  // Topics published here whose consumer is not in scope: known to exist, not traceable (CR-042).
  for (const gap of input.gaps.filter((g) => g.id.startsWith("gap:consumer:"))) {
    const topic = entities.get(gap.related_entity_ids?.[0] ?? "");
    if (!topic) continue;
    drafts.push({
      entry: topic.id,
      name: `Consumers of ${topic.name ?? topic.id}`,
      category: "async_processing",
      boundary: topic.project_boundary ?? "project:.",
      area: "(outside the analyzed scope)",
      steps: [{ entity: topic.id, action: "consume" }],
      hops: [{ after: topic.id, reason: "missing_repository", gap: gap.id }],
      traces: [],
      status: "known_not_traceable",
      score: 0,
    });
  }

  // Rank by value (PRD §11.1 planning by value), then by ID.
  for (const d of drafts) {
    const deep = d.steps.flatMap((s) => (s.trace ? traceRelationships(s.trace) : []));
    const writes = new Set(deep.filter((r) => r.type === "WRITES_TO").map((r) => r.to)).size;
    const external = new Set(
      [...deep, ...traceRelationships(d.entry)]
        .filter((r) => r.type === "SENDS_TO" || r.type === "PUBLISHES")
        .map((r) => r.to),
    ).size;
    const interfaces = d.steps.filter((s) => s.entity.startsWith("api:")).length;
    d.score =
      3 * Math.min(writes, 3) +
      2 * Math.min(external, 2) +
      Math.min(interfaces, 3) +
      (d.category === "auth" ? 2 : 0) +
      Math.min(d.hops.length, 2) +
      (d.status === "known_not_traceable" ? -5 : 0);
  }
  drafts.sort((a, b) => b.score - a.score || a.entry.localeCompare(b.entry));

  const maxDeepened = options.maxDeepened ?? Number.POSITIVE_INFINITY;
  const forced = new Set(options.deepen ?? []);
  let deepened = 0;
  const workflows: Workflow[] = [];
  const notDeepened: string[] = [];
  drafts.forEach((d, i) => {
    const id = `workflow:${d.entry}`;
    const traceable = d.status !== "known_not_traceable";
    const deep = traceable && (forced.has(id) || deepened < maxDeepened);
    if (deep && !forced.has(id)) deepened++;
    if (traceable && !deep) notDeepened.push(id);
    const steps: Step[] = d.steps.map((s, n) => {
      const step: Step = { id: `step:${d.entry}#${n + 1}`, order: n + 1, entity_id: s.entity, action: s.action };
      if (deep && s.trace) {
        const rels = traceRelationships(s.trace);
        const pick = (...types: Relationship["type"][]) =>
          [...new Set(rels.filter((r) => types.includes(r.type)).map((r) => r.to))].sort();
        const reads = pick("READS_FROM");
        const writes = pick("WRITES_TO");
        const effects = pick("SENDS_TO", "PUBLISHES");
        if (reads.length > 0) step.reads = reads;
        if (writes.length > 0) step.writes = writes;
        if (effects.length > 0) step.side_effects = effects;
        const rules = rulesOf(s.entity);
        if (rules.length > 0) step.validations = rules.sort();
      }
      if (deep && s.entity.startsWith("form:")) {
        // A form's rules: those validating its endpoint whose inputs include one of its fields.
        const fields = new Set(fieldsOf(s.entity).map((f) => f.id));
        const endpoint = out(s.entity, "SUBMITS_TO")[0]?.to;
        const rules = (endpoint ? rulesOf(endpoint) : []).filter((r) =>
          ((entities.get(r) as { inputs?: string[] } | undefined)?.inputs ?? []).some((i) => fields.has(i)),
        );
        if (rules.length > 0) step.validations = rules.sort();
      }
      return step;
    });
    // Branches (SAA-FR-034): a form whose fields carry constraints can be refused in the browser; an endpoint's error
    // responses come from its handler and middleware. An endpoint whose handler was not found has unknown branches.
    const branches: Workflow["branches"] = [];
    if (deep)
      for (const step of steps) {
        const entity = entities.get(step.entity_id) as
          (Entity & { handler?: unknown; error_responses?: Array<{ outcome: string; condition: string }> }) | undefined;
        if (entity?.kind === "form") {
          const constrained = fieldsOf(entity.id).filter(
            (f) =>
              Object.keys((f as { constraints?: object }).constraints ?? {}).some((k) => k !== "input_type") ||
              ["email", "url", "number"].includes(
                String((f as { constraints?: { input_type?: string } }).constraints?.input_type),
              ),
          );
          if (constrained.length > 0)
            branches.push({
              from_step: step.id,
              condition: `a value violates the constraints of ${constrained.map((f) => f.name).join(", ")}`,
              outcome: "validation_error",
              status: "source_verified",
            });
        }
        if (entity?.kind === "api") {
          for (const r of entity.error_responses ?? [])
            branches.push({
              from_step: step.id,
              condition: r.condition,
              outcome: r.outcome,
              status: "source_verified",
            });
          if (!entity.handler)
            branches.push({
              from_step: step.id,
              condition: "the endpoint's handler was not found, so its error handling is not known",
              outcome: "unknown",
              status: "unresolved",
            });
        }
      }
    const stepId = (entity: string | undefined) => steps.find((s) => s.entity_id === entity)?.id;
    const hops: Hop[] = [];
    const addHop = (h: Draft["hops"][number]) => {
      const hop: Hop = { reason_code: h.reason };
      const after = stepId(h.after);
      if (after) hop.after_step = after;
      if (h.gap) {
        hop.gap_id = h.gap;
        const description = input.gaps.find((g) => g.id === h.gap)?.description;
        if (description) hop.description = description;
      }
      if (!hops.some((x) => x.after_step === hop.after_step && x.reason_code === hop.reason_code)) hops.push(hop);
    };
    d.hops.forEach(addHop);
    if (deep)
      // Stops inside the traces of the endpoints a workflow calls happen after that endpoint's step.
      for (const s of d.steps.filter((x) => x.trace && x.trace !== d.entry))
        for (const stop of traces.get(s.trace!)?.stopped_at ?? [])
          addHop({ after: s.entity, reason: stop.reason_code, ...(stop.gap_id ? { gap: stop.gap_id } : {}) });
    if (traceable && !deep)
      hops.push({
        after_step: steps[steps.length - 1]!.id,
        reason_code: "budget_exhausted",
        description: "Not deepened: ranked below the deepening budget of this run; deepen this workflow on demand.",
      });
    const status: Workflow["discovery_status"] = !traceable
      ? "known_not_traceable"
      : hops.length > 0
        ? "partially_reconstructed"
        : "reconstructed";
    const evidence = [...new Set(d.steps.flatMap((s) => entities.get(s.entity)?.evidence_ids ?? []))].slice(0, 20);
    workflows.push({
      id,
      name: d.name,
      category: d.category,
      origin: "source",
      discovery_status: status,
      entry_point_ids: [d.entry],
      component_trace_ids: d.traces,
      steps,
      branches,
      unresolved_hops: hops,
      completion: !traceable
        ? "unresolved"
        : completeWithinStaticScope(deep, steps)
          ? "complete_within_static_scope"
          : "partial",
      deepened: deep,
      rank: i + 1,
      status: traceable ? "source_verified" : "unresolved",
      evidence_ids: evidence,
    });
  });

  /**
   * PRD §11.1: complete within the static scope when the workflow was deepened, its server side was analyzed (an
   * endpoint or a job is a step) and every endpoint's handler was found, so reads, writes, side effects, validations,
   * authorization and error branches are addressed. External boundaries are labeled by the hops.
   */
  function completeWithinStaticScope(deep: boolean, steps: Step[]): boolean {
    const server = steps.filter((s) => /^(api|job):/.test(s.entity_id));
    return (
      deep &&
      server.length > 0 &&
      server.every(
        (s) =>
          s.entity_id.startsWith("job:") || (entities.get(s.entity_id) as { handler?: unknown }).handler !== undefined,
      )
    );
  }

  // Groups: boundary, then area, then category, in order of their best-ranked workflow.
  const groups = new Map<string, CatalogGroup>();
  drafts.forEach((d) => {
    const key = `${d.boundary}\0${d.area}\0${d.category}`;
    const group = groups.get(key) ?? { boundary: d.boundary, area: d.area, category: d.category, workflow_ids: [] };
    group.workflow_ids.push(`workflow:${d.entry}`);
    groups.set(key, group);
  });
  return { count_scope: "within_examined_scope", workflows, groups: [...groups.values()], not_deepened: notDeepened };
}

/** The deepen operation (SAA-FR-009, SAA-FR-046): the same catalog with one more workflow reconstructed in full. */
export function deepenWorkflow(input: CatalogInput, options: CatalogOptions, workflowId: string): WorkflowCatalog {
  return composeWorkflows(input, { ...options, deepen: [...(options.deepen ?? []), workflowId] });
}
