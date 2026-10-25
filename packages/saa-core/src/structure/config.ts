import { createHash } from "node:crypto";
import type { CoverageItem, Entity, Relationship } from "@sys2qa/contract";
import type { StructuralFacts } from "./graph.js";

type ConfigFacts =
  | {
      config_kind: "package_scripts";
      scripts: Array<{ name: string; command: string; runs_on_install: boolean; evidence: string }>;
    }
  | { config_kind: "env_template"; variables: Array<{ name: string; documented_value: boolean; evidence: string }> }
  | {
      config_kind: "dockerfile";
      base_images: string[];
      exposed_ports: string[];
      variables: Array<{ name: string; kind: string; evidence: string }>;
      commands: Array<{ instruction: string; text: string; evidence: string }>;
    }
  | {
      config_kind: "compose";
      services: Array<{
        name: string;
        image?: string;
        builds: boolean;
        ports: string[];
        variables: string[];
        env_files: string[];
        depends_on: string[];
        evidence: string;
      }>;
    }
  | {
      config_kind: "ci_workflow";
      triggers: string[];
      variables: string[];
      jobs: Array<{
        name: string;
        variables: string[];
        uses: string[];
        runs: string[];
        secrets: string[];
        evidence: string;
      }>;
    };

export interface ConfigLinks {
  entities: Entity[];
  relationships: Relationship[];
  coverage: CoverageItem[];
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/**
 * Configuration keys and deployment units (IMP-109, SAA-FR-020). A key is one `config_key` per boundary and name,
 * gathered from code reads (js-ts `env_reads`), environment templates, Dockerfiles, Compose services and CI files, with
 * the sources that mention it; CI secrets become `secret_ref` entities by name. Dockerfiles, Compose services and CI
 * jobs become `deployment_unit` entities, linked to their keys with `CONFIGURED_BY` and to each other with
 * `DEPENDS_ON`. No value is modeled. Install lifecycle scripts are reported, because they would run on `npm install`.
 */
export function linkConfig(facts: StructuralFacts): ConfigLinks {
  const out: ConfigLinks = { entities: [], relationships: [], coverage: [] };
  const keys = new Map<
    string,
    {
      id: string;
      name: string;
      boundary: string;
      sources: Set<string>;
      evidence: Set<string>;
      readWithDefault: boolean;
      documented: boolean;
    }
  >();
  const scoped = (kind: string, boundary: string, key: string) =>
    boundary === "project:." ? `${kind}:${key}` : `${kind}:${boundary.slice("project:".length)}:${key}`;
  const relate = (type: Relationship["type"], from: string, to: string, evidence: string[]) =>
    out.relationships.push({
      id: `relationship:${hash16(type, from, to)}`,
      type,
      from,
      to,
      status: "source_verified",
      evidence_ids: evidence.slice(0, 10),
    });
  const key = (
    boundary: string,
    name: string,
    source: string,
    evidence: string,
    extra: { readWithDefault?: boolean; documented?: boolean } = {},
  ) => {
    const id = scoped("config_key", boundary, name);
    const k = keys.get(id) ?? {
      id,
      name,
      boundary,
      sources: new Set(),
      evidence: new Set(),
      readWithDefault: false,
      documented: false,
    };
    k.sources.add(source);
    k.evidence.add(evidence);
    if (extra.readWithDefault) k.readWithDefault = true;
    if (extra.documented) k.documented = true;
    keys.set(id, k);
    return id;
  };
  const units: Entity[] = [];

  for (const entity of facts.entities) {
    const e = entity as unknown as {
      id: string;
      kind: string;
      path?: string;
      project_boundary: string;
      evidence_ids: string[];
      env_reads?: Array<{ name: string; has_default: boolean; evidence: string }>;
      config?: ConfigFacts;
    };
    const boundary = e.project_boundary;
    for (const read of e.env_reads ?? []) {
      const id = key(boundary, read.name, "code", read.evidence, { readWithDefault: read.has_default });
      relate("CONFIGURED_BY", e.id, id, [read.evidence]);
    }
    const c = e.config;
    if (!c) continue;
    if (c.config_kind === "package_scripts") {
      for (const s of c.scripts.filter((x) => x.runs_on_install))
        out.coverage.push({
          area: e.path!,
          status: "analyzed",
          reason: `script "${s.name}" would run on package installation; Sys2QA records it and never runs it`,
        });
    } else if (c.config_kind === "env_template") {
      for (const v of c.variables) key(boundary, v.name, "env_template", v.evidence, { documented: true });
    } else if (c.config_kind === "dockerfile") {
      const id = scoped("deployment_unit", boundary, `docker:${e.path}`);
      units.push({
        id,
        kind: "deployment_unit",
        name: e.path!,
        project_boundary: boundary,
        unit_type: "container_image",
        base_images: c.base_images,
        exposed_ports: c.exposed_ports,
        commands: c.commands.map((x) => ({ instruction: x.instruction, text: x.text })),
        status: "source_verified",
        origin: "source",
        evidence_ids: e.evidence_ids,
      } as Entity);
      for (const v of c.variables)
        relate("CONFIGURED_BY", id, key(boundary, v.name, "dockerfile", v.evidence), [v.evidence]);
    } else if (c.config_kind === "compose") {
      const ids = new Map(c.services.map((s) => [s.name, scoped("deployment_unit", boundary, `compose:${s.name}`)]));
      for (const s of c.services) {
        const id = ids.get(s.name)!;
        units.push({
          id,
          kind: "deployment_unit",
          name: s.name,
          project_boundary: boundary,
          unit_type: "compose_service",
          ...(s.image ? { image: s.image } : {}),
          builds: s.builds,
          ports: s.ports,
          env_files: s.env_files,
          status: "source_verified",
          origin: "source",
          evidence_ids: [s.evidence],
        } as Entity);
        for (const v of s.variables) relate("CONFIGURED_BY", id, key(boundary, v, "compose", s.evidence), [s.evidence]);
        for (const d of s.depends_on) {
          const target = ids.get(d);
          if (target) relate("DEPENDS_ON", id, target, [s.evidence]);
        }
      }
    } else if (c.config_kind === "ci_workflow") {
      for (const job of c.jobs) {
        const id = scoped("deployment_unit", boundary, `ci:${e.path}#${job.name}`);
        units.push({
          id,
          kind: "deployment_unit",
          name: job.name,
          project_boundary: boundary,
          unit_type: "ci_job",
          triggers: c.triggers,
          uses: job.uses,
          runs: job.runs,
          status: "source_verified",
          origin: "source",
          evidence_ids: [job.evidence],
        } as Entity);
        for (const v of [...c.variables, ...job.variables])
          relate("CONFIGURED_BY", id, key(boundary, v, "ci", job.evidence), [job.evidence]);
        for (const secret of job.secrets) {
          const secretId = scoped("secret_ref", boundary, secret);
          if (!units.some((u) => u.id === secretId))
            units.push({
              id: secretId,
              kind: "secret_ref",
              name: secret,
              project_boundary: boundary,
              status: "source_verified",
              origin: "source",
              evidence_ids: [job.evidence],
            } as Entity);
          relate("AUTHENTICATES_WITH", id, secretId, [job.evidence]);
        }
      }
    }
  }
  for (const k of [...keys.values()].sort((a, b) => a.id.localeCompare(b.id)))
    out.entities.push({
      id: k.id,
      kind: "config_key",
      name: k.name,
      project_boundary: k.boundary,
      sources: [...k.sources].sort(),
      documented: k.documented,
      read_with_default: k.readWithDefault,
      status: "source_verified",
      origin: "source",
      evidence_ids: [...k.evidence].slice(0, 10),
    } as Entity);
  out.entities.push(...units);
  out.relationships = [...new Map(out.relationships.map((r) => [r.id, r])).values()];
  return out;
}
