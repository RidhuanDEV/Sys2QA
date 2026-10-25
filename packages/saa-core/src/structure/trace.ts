import { createHash } from "node:crypto";
import type { ComponentTrace, Entity, Gap, Relationship } from "@sys2qa/contract";
import { snakeCase } from "./datamodel.js";
import type { StructuralFacts } from "./graph.js";

// Shapes recorded on module entities by the js-ts adapter (adapters/js-ts/trace.ts and frameworks.ts).
interface Unit {
  key: string;
  calls: Array<{ name: string; evidence: string }>;
  data: Array<{ model: string; access: "read" | "write"; evidence: string }>;
  outbound: Array<{ target: string; literal: boolean; evidence: string }>;
  dynamic_imports: Array<{ line: number; evidence: string }>;
}
interface ModuleFacts {
  id: string;
  path: string;
  project_boundary: string;
  imports?: Array<{
    target?: string;
    kind: string;
    names: string[];
    bindings?: Array<{ local: string; imported: string }>;
  }>;
  units?: Unit[];
  jobs?: Array<{ expression: string; unit: string; evidence: string }>;
}

export interface TraceLinks {
  entities: Entity[];
  relationships: Relationship[];
  gaps: Gap[];
  component_traces: ComponentTrace[];
}

export interface TraceOptions {
  /** Calls followed from an entry point before the trace stops with `budget_exhausted`. */
  maxDepth?: number;
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/**
 * A readable label for a cron schedule, used in job IDs: a fixed time before 06:00 every day is `nightly`, another
 * fixed time every day is `daily`, a fixed weekday is `weekly`, a fixed minute every hour is `hourly`, anything else is
 * `scheduled`.
 */
export function scheduleLabel(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = fields.length === 6 ? fields.slice(1) : fields;
  const fixed = (f: string | undefined) => f !== undefined && /^\d+$/.test(f);
  if (fixed(minute) && fixed(hour) && day === "*" && month === "*" && weekday === "*")
    return Number(hour) < 6 ? "nightly" : "daily";
  if (fixed(minute) && fixed(hour) && day === "*" && month === "*" && fixed(weekday)) return "weekly";
  if (fixed(minute) && hour === "*" && day === "*" && month === "*" && weekday === "*") return "hourly";
  return "scheduled";
}

/**
 * Component traces (IMP-110, SAA-FR-009, SAA-FR-041). Entry points are the API endpoints, pages and scheduled jobs
 * found so far. From each, the tracer follows the units the adapter recorded: calls to functions of analyzed modules
 * (through imports and up to `maxDepth` hops, each unit once per trace), Prisma reads and writes (`READS_FROM`,
 * `WRITES_TO` an entity), and outbound requests (`SENDS_TO` an integration). A trace stops, with a gap, where the code
 * leaves what can be known statically: an external service (`external_service`), an import computed at run time
 * (`dynamic_registration`), a module that was not analyzed (`out_of_scope`) or the depth budget (`budget_exhausted`).
 * A page's trace holds its forms, their submissions, its requests and navigation. Traces are component traces only;
 * composing them into workflows is IMP-111.
 */
export function traceComponents(
  facts: StructuralFacts,
  derived: { entities: Entity[]; relationships: Relationship[] },
  options: TraceOptions = {},
): TraceLinks {
  const maxDepth = options.maxDepth ?? 12;
  const out: TraceLinks = { entities: [], relationships: [], gaps: [], component_traces: [] };
  const modules = new Map<string, ModuleFacts>();
  for (const e of facts.entities)
    if (e.kind === "module" && !(e as { external?: boolean }).external) modules.set(e.id, e as unknown as ModuleFacts);
  const allEntities = [...facts.entities, ...derived.entities];
  const functionId = new Map<string, string>(); // `${module}\0${name}` → function entity
  for (const e of allEntities) {
    const m = (e as { module_id?: string }).module_id;
    if (m && (e.kind === "function" || e.kind === "class")) functionId.set(`${m}\0${e.name}`, e.id);
  }
  const entityByModel = new Map<string, string>(); // lower model/table name → entity
  for (const e of allEntities) if (e.kind === "entity") entityByModel.set(e.name.toLowerCase(), e.id);
  const seenEntities = new Set(allEntities.map((e) => e.id));
  const seenGaps = new Set<string>();
  const relationships = new Map<string, Relationship>();
  const relate = (type: Relationship["type"], from: string, to: string, evidence: string[]): string => {
    const id = `relationship:${hash16(type, from, to)}`;
    if (!relationships.has(id))
      relationships.set(id, { id, type, from, to, status: "source_verified", evidence_ids: evidence });
    return id;
  };
  const addGap = (gap: Gap) => {
    if (seenGaps.has(gap.id)) return;
    seenGaps.add(gap.id);
    out.gaps.push(gap);
  };
  const local = (moduleId: string) => moduleId.slice("module:".length).split(":").pop()!;

  /** The module and unit a name in `moduleId` refers to; `external` for packages and built-ins. */
  const resolveCall = (
    moduleId: string,
    name: string,
  ): { module: string; unit: string } | "external" | "unanalyzed" | undefined => {
    const module = modules.get(moduleId);
    if (!module) return undefined;
    const [head, member] = name.split(".");
    if (member === undefined && module.units?.some((u) => u.key === `fn:${name}`))
      return { module: moduleId, unit: `fn:${name}` };
    if (member === undefined && functionId.has(`${moduleId}\0${name}`)) return { module: moduleId, unit: `fn:${name}` };
    for (const record of module.imports ?? []) {
      const binding = record.bindings?.find((b) => b.local === head);
      if (!binding) continue;
      if (!record.target || record.target.startsWith("module:pkg:") || record.target.startsWith("module:node:"))
        return "external";
      if (!modules.has(record.target)) return "unanalyzed";
      const imported = binding.imported === "*" ? (member ?? "") : binding.imported;
      return imported === "" ? undefined : { module: record.target, unit: `fn:${imported}` };
    }
    return undefined;
  };

  const integrationFor = (module: ModuleFacts, target: { target: string; literal: boolean }) => {
    const host = target.literal ? /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(target.target)?.[1] : undefined;
    const key = host ?? `${local(module.id).split(".").pop()}.provider`;
    return { id: `integration:${key}`, host };
  };

  const trace = (
    entryId: string,
    start: Array<{ node: string; module: string; unit: string }>,
    extra: string[] = [],
  ): ComponentTrace => {
    const ids = new Set<string>(extra);
    const stops = new Map<string, ComponentTrace["stopped_at"][number]>();
    const visited = new Set<string>();
    const queue = start.map((s) => ({ ...s, depth: 0 }));
    while (queue.length > 0) {
      const { node, module: moduleId, unit: unitKey, depth } = queue.shift()!;
      const visitKey = `${moduleId}\0${unitKey}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const module = modules.get(moduleId);
      const unit = module?.units?.find((u) => u.key === unitKey);
      if (!module || !unit) continue;
      for (const d of unit.data) {
        const entity =
          entityByModel.get(d.model.toLowerCase()) ?? entityByModel.get(snakeCase(d.model).replace(/_/g, ""));
        if (entity) ids.add(relate(d.access === "write" ? "WRITES_TO" : "READS_FROM", node, entity, [d.evidence]));
      }
      for (const o of unit.outbound) {
        const integration = integrationFor(module, o);
        if (!seenEntities.has(integration.id)) {
          seenEntities.add(integration.id);
          out.entities.push({
            id: integration.id,
            kind: "integration",
            name: integration.host ?? o.target,
            project_boundary: module.project_boundary,
            ...(integration.host ? {} : { target_expression: o.target }),
            status: "source_verified",
            origin: "source",
            evidence_ids: [o.evidence],
          } as Entity);
        }
        const gapId = `gap:external:${integration.id.slice("integration:".length)}`;
        addGap({
          id: gapId,
          type: "external_boundary",
          description: `Requests to ${integration.host ?? o.target} leave the analyzed code (${module.path}); what the provider does with them is not visible.`,
          impact:
            "Outcomes after the request (delivery, side effects at the provider) cannot be confirmed from source.",
          evidence_ids: [o.evidence],
          related_entity_ids: [integration.id],
          requires_human_clarification: false,
          status: "unresolved",
        });
        ids.add(relate("SENDS_TO", node, integration.id, [o.evidence]));
        stops.set(`ext\0${integration.id}`, {
          entity_id: integration.id,
          reason_code: "external_service",
          gap_id: gapId,
        });
      }
      for (const dyn of unit.dynamic_imports) {
        const gapId = `gap:dynamic-import:${local(moduleId)}`;
        addGap({
          id: gapId,
          type: "unsupported",
          description: `${module.path} imports a module whose name is computed at run time; the code it loads is not known statically.`,
          evidence_ids: [dyn.evidence],
          related_entity_ids: [moduleId],
          requires_human_clarification: false,
          status: "unresolved",
        });
        stops.set(`dyn\0${moduleId}`, { entity_id: node, reason_code: "dynamic_registration", gap_id: gapId });
      }
      for (const call of unit.calls) {
        const target = resolveCall(moduleId, call.name);
        if (target === undefined || target === "external") continue;
        if (target === "unanalyzed") {
          const gapId = `gap:unanalyzed-call:${local(moduleId)}.${call.name}`;
          addGap({
            id: gapId,
            type: "missing_evidence",
            description: `${module.path} calls ${call.name} from a module that was not analyzed (excluded or outside the analyzed scope).`,
            evidence_ids: [call.evidence],
            related_entity_ids: [moduleId],
            requires_human_clarification: false,
            status: "unresolved",
          });
          stops.set(`out\0${gapId}`, { entity_id: node, reason_code: "out_of_scope", gap_id: gapId });
          continue;
        }
        const fn = functionId.get(`${target.module}\0${target.unit.slice(3)}`);
        if (!fn) continue;
        ids.add(relate("CALLS", node, fn, [call.evidence]));
        if (depth + 1 > maxDepth) {
          const gapId = `gap:trace-depth:${entryId}`;
          addGap({
            id: gapId,
            type: "unsupported",
            description: `The trace from ${entryId} was stopped after ${maxDepth} calls; deeper code was not followed.`,
            evidence_ids: [call.evidence],
            related_entity_ids: [entryId],
            requires_human_clarification: false,
            status: "unresolved",
          });
          stops.set(`budget\0${entryId}`, { entity_id: fn, reason_code: "budget_exhausted", gap_id: gapId });
          continue;
        }
        queue.push({ node: fn, module: target.module, unit: target.unit, depth: depth + 1 });
      }
    }
    return {
      id: `trace:${entryId}`,
      entry_point_id: entryId,
      relationship_ids: [...ids].sort(),
      stopped_at: [...stops.values()],
      status: "source_verified",
    };
  };

  // Scheduled jobs become entities and entry points.
  const jobs: Array<{ id: string; module: string; unit: string }> = [];
  for (const module of modules.values())
    for (const job of module.jobs ?? []) {
      const base = `${local(module.id).split(".").pop()}.${scheduleLabel(job.expression)}`;
      let id =
        module.project_boundary === "project:." ? `job:${base}` : `job:${module.project_boundary.slice(8)}:${base}`;
      if (seenEntities.has(id)) id = `${id}~${hash16(module.id, job.unit).slice(0, 8)}`;
      seenEntities.add(id);
      out.entities.push({
        id,
        kind: "job",
        name: base,
        project_boundary: module.project_boundary,
        module_id: module.id,
        schedule: job.expression,
        trigger: "cron",
        status: "source_verified",
        origin: "source",
        evidence_ids: [job.evidence],
      } as Entity);
      jobs.push({ id, module: module.id, unit: job.unit });
    }

  // API endpoints: from the handler.
  for (const api of derived.entities.filter((e) => e.kind === "api")) {
    const a = api as unknown as { id: string; module_id?: string; handler?: { name: string } | { unit: string } };
    const start: Array<{ node: string; module: string; unit: string }> = [];
    if (a.module_id && a.handler) {
      if ("unit" in a.handler) start.push({ node: a.id, module: a.module_id, unit: a.handler.unit });
      else {
        const target = resolveCall(a.module_id, a.handler.name);
        if (target && typeof target === "object") start.push({ node: a.id, module: target.module, unit: target.unit });
      }
    }
    out.component_traces.push(trace(a.id, start));
  }
  for (const job of jobs)
    out.component_traces.push(trace(job.id, [{ node: job.id, module: job.module, unit: job.unit }]));

  // Pages: their forms, submissions, requests and navigation, as linked by the framework layer.
  for (const page of derived.entities.filter((e) => e.kind === "page")) {
    const forms = new Set(
      derived.relationships.filter((r) => r.type === "CONTAINS" && r.from === page.id).map((r) => r.to),
    );
    const ids = derived.relationships
      .filter(
        (r) =>
          (r.from === page.id && ["CONTAINS", "CONSUMES", "NAVIGATES_TO"].includes(r.type)) ||
          (forms.has(r.from) && r.type === "SUBMITS_TO"),
      )
      .map((r) => r.id);
    out.component_traces.push(trace(page.id, [], ids));
  }
  out.relationships = [...relationships.values()];
  return out;
}
