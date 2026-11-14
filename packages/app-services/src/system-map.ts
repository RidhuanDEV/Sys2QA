import { packageModel } from "@sys2qa/qaa-core";
import { serviceError } from "./errors.js";
import { defineOperation } from "./operations.js";
import { packageRow, revalidated } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;

const packageCatalog = defineOperation<{ project_id: string; package_id: string; version: number }, unknown>({
  name: "package.catalog",
  title: "System map and catalog of a package",
  description:
    "The discovered catalog of a stored package, revalidated: every workflow with its status, completion, ordered steps (each with the entity's kind, name and status), branches and where the trace stopped; the entities by kind with their status; the open gaps; and the package's evidence profile with what it cannot establish (SYS-004). Read-only; works for exported and imported packages alike.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version"],
    properties: {
      project_id: ID,
      package_id: { type: "string", pattern: "^pkg:[a-z0-9][a-z0-9._-]{0,127}$" },
      version: { type: "integer", minimum: 1 },
    },
  },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const prepared = revalidated(packageRow(host, project.id, input.package_id, input.version));
    const model = packageModel(prepared);
    const evidenceProfile = prepared.provenance.evidence_profile;
    if (!model)
      throw serviceError("READINESS_BLOCKED", "the package has no structured model; only its Markdown can be read");
    const brief = (id: string) => {
      const e = model.entity(id);
      return { id, kind: e?.kind ?? null, name: e?.name ?? id, status: e?.status ?? null };
    };
    const byKind: Record<string, Array<{ id: string; name: string; status: string }>> = {};
    for (const e of model.allEntities()) (byKind[e.kind] ??= []).push({ id: e.id, name: e.name, status: e.status });
    for (const list of Object.values(byKind)) list.sort((a, b) => a.id.localeCompare(b.id));
    return {
      package_id: input.package_id,
      version: input.version,
      evidence_profile: evidenceProfile,
      workflows: model.workflows().map((w) => ({
        id: w.id,
        name: w.name,
        category: w.category,
        status: w.status,
        discovery_status: w.discovery_status,
        completion: w.completion,
        entry_points: w.entry_point_ids.map(brief),
        steps: [...w.steps].sort((a, b) => a.order - b.order).map((s) => ({ ...brief(s.entity_id), action: s.action })),
        branches: w.branches.map((b) => ({
          from_step: b.from_step,
          condition: b.condition,
          outcome: b.outcome,
          status: b.status,
        })),
        stops: w.unresolved_hops.map((h) => ({
          after_step: h.after_step ?? null,
          reason_code: h.reason_code,
          description: h.description ?? null,
        })),
      })),
      entities: Object.entries(byKind)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, items]) => ({ kind, count: items.length, items })),
      gaps: model.unknowns().gaps.map((g) => ({
        id: g.id,
        type: g.type,
        description: g.description,
        status: g.status,
        requires_human_clarification: g.requires_human_clarification,
      })),
    };
  },
});

export const SYSTEM_MAP_OPERATIONS = [packageCatalog];
