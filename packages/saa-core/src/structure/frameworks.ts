import { createHash } from "node:crypto";
import type { CoverageItem, Entity, Gap, Relationship } from "@sys2qa/contract";
import type { ProjectBoundary } from "../stack/stack.js";
import type { StructuralFacts } from "./graph.js";

// Shapes recorded on module entities by the js-ts adapter (packages/saa-adapters/src/adapters/js-ts/frameworks.ts).
interface ImportRecord {
  target?: string;
  bindings?: Array<{ local: string; imported: string }>;
  kind: string;
  names: string[];
}
interface ExpressFacts {
  receivers: Array<{ local: string; kind: "app" | "router" | "parameter" }>;
  routes: Array<{
    receiver: string;
    method: string;
    path?: string;
    dynamic?: string;
    middleware: Array<{ name: string; args: string[] }>;
    handler?: { name: string } | { unit: string };
    line: number;
    evidence: string;
  }>;
  mounts: Array<{ receiver: string; prefix: string; target: string; evidence: string }>;
}
interface FormFacts {
  key: string;
  fields: Array<{ name: string; constraints: Record<string, string | number | boolean> }>;
  submits: Array<{ method: string; url: string }>;
  evidence: string;
}
interface ComponentFacts {
  name: string;
  forms: FormFacts[];
  navigations: Array<{ to: string; evidence: string }>;
  requests?: Array<{ method: string; url: string; evidence: string }>;
}
interface ModuleFacts {
  id: string;
  path: string;
  project_boundary: string;
  evidence_ids: string[];
  exports?: string[];
  imports?: ImportRecord[];
  express?: ExpressFacts;
  react_router?: { routes: Array<{ path: string; component?: string; evidence: string }> };
  components?: ComponentFacts[];
}

export interface FrameworkLinks {
  entities: Entity[];
  relationships: Relationship[];
  gaps: Gap[];
  coverage: CoverageItem[];
}

const NEXT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** `:id` and `[id]` become `{id}`; a trailing slash is dropped (Data Model §3: route keys). */
export function normalizeRoutePath(path: string): string {
  const clean = path.split("?")[0]!.replace(/\/+$/, "") || "/";
  return clean
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)\??/g, "{$1}")
    .replace(/\[\.\.\.([^\]]+)\]/g, "{$1}")
    .replace(/\[([^\]]+)\]/g, "{$1}")
    .replace(/\/\*$/, "/{*}");
}

/**
 * Turns the framework facts of every module into the API and UI model (SAA-FR-007, SAA-FR-031):
 * - Express: a route belongs to the API only if its router is mounted, directly or through other routers, on an
 *   application; prefixes compose. Routes of routers that are never mounted are reported as such, not as API (dead
 *   code). Routes registered on an application received as a parameter are kept as `inferred`. A computed path
 *   becomes an `unsupported` gap instead of an invented route.
 * - React Router: pages with nested paths; the rendered component's forms, fields (with constraints) and navigation.
 * - Next.js (only in boundaries that depend on `next`): `app/**\/page`, `app/**\/route` and `pages/` conventions.
 * - A form whose request matches no analyzed endpoint yields a `missing_evidence` gap rather than a guessed link.
 */
export function linkFrameworks(facts: StructuralFacts, boundaries: ReadonlyArray<ProjectBoundary>): FrameworkLinks {
  const modules = new Map<string, ModuleFacts>();
  for (const e of facts.entities)
    if (e.kind === "module" && !(e as { external?: boolean }).external) modules.set(e.id, e as unknown as ModuleFacts);
  const out: FrameworkLinks = { entities: [], relationships: [], gaps: [], coverage: [] };
  const seen = new Set<string>();
  const add = (entity: Entity) => {
    if (seen.has(entity.id)) return false;
    seen.add(entity.id);
    out.entities.push(entity);
    return true;
  };
  const relate = (
    type: Relationship["type"],
    from: string,
    to: string,
    evidence: string[],
    status: Relationship["status"] = "source_verified",
  ) =>
    out.relationships.push({
      id: `relationship:${hash16(type, from, to)}`,
      type,
      from,
      to,
      status,
      evidence_ids: evidence,
    });

  /** Follows a local identifier to the module that declares it (imports, then up to five re-export hops). */
  const resolve = (moduleId: string, local: string, depth = 0): { module: string; name: string } | undefined => {
    const module = modules.get(moduleId);
    if (!module || depth > 5) return undefined;
    const declares =
      module.express?.receivers.some((r) => r.local === local) || module.components?.some((c) => c.name === local);
    if (declares) return { module: moduleId, name: local };
    for (const record of module.imports ?? []) {
      if (!record.target || !modules.has(record.target)) continue;
      const binding = record.bindings?.find((b) => b.local === local);
      if (binding) {
        const target = modules.get(record.target)!;
        const name =
          binding.imported === "default"
            ? (target.components?.[0]?.name ?? target.express?.receivers[0]?.local ?? local)
            : binding.imported;
        return resolve(record.target, name, depth + 1);
      }
      if (record.kind === "re_export" && (record.names.includes(local) || record.names.includes("*")) && depth > 0)
        return resolve(record.target, local, depth + 1);
    }
    return undefined;
  };

  // ---------------------------------------------------------------- Express
  const apis = new Set<string>();
  const reachable = new Map<string, Set<string>>(); // `${module}\0${receiver}` → prefixes
  const queue: Array<{ module: string; receiver: string; prefix: string }> = [];
  for (const m of modules.values())
    for (const r of m.express?.receivers ?? [])
      if (r.kind === "app" || r.kind === "parameter") queue.push({ module: m.id, receiver: r.local, prefix: "" });
  while (queue.length > 0) {
    const item = queue.shift()!;
    const key = `${item.module}\0${item.receiver}`;
    const prefixes = reachable.get(key) ?? new Set<string>();
    if (prefixes.has(item.prefix) || prefixes.size > 20) continue; // a mount cycle is followed once
    prefixes.add(item.prefix);
    reachable.set(key, prefixes);
    for (const mount of modules.get(item.module)?.express?.mounts ?? []) {
      if (mount.receiver !== item.receiver) continue;
      const target = resolve(item.module, mount.target);
      if (target && modules.get(target.module)?.express?.receivers.some((r) => r.local === target.name))
        queue.push({ module: target.module, receiver: target.name, prefix: joinPrefix(item.prefix, mount.prefix) });
    }
  }
  for (const m of modules.values()) {
    const express = m.express;
    if (!express) continue;
    const dynamic = express.routes.filter((r) => r.path === undefined);
    if (dynamic.length > 0)
      out.gaps.push({
        id: `gap:dynamic-routes:${m.id.slice("module:".length)}`,
        type: "unsupported",
        description: `${dynamic.length} route(s) in ${m.path} are registered with a computed path (${dynamic
          .map((r) => `${r.method} ${r.dynamic} at line ${r.line}`)
          .join("; ")}); the paths are decided at run time and are not listed as API endpoints.`,
        impact:
          "Endpoints behind these registrations are missing from the catalog; runtime evidence or configuration is needed.",
        evidence_ids: dynamic.map((r) => r.evidence),
        related_entity_ids: [m.id],
        requires_human_clarification: false,
        status: "unresolved",
      });
    const unmounted = new Map<string, number>();
    for (const route of express.routes) {
      if (route.path === undefined) continue;
      const prefixes = reachable.get(`${m.id}\0${route.receiver}`);
      if (!prefixes) {
        unmounted.set(route.receiver, (unmounted.get(route.receiver) ?? 0) + 1);
        continue;
      }
      const viaParameter = express.receivers.find((r) => r.local === route.receiver)?.kind === "parameter";
      for (const prefix of prefixes) {
        const pattern = normalizeRoutePath(joinPrefix(prefix, route.path));
        const id = `api:${route.method}:${pattern}`;
        apis.add(id);
        if (
          add({
            id,
            kind: "api",
            name: `${route.method} ${pattern}`,
            project_boundary: m.project_boundary,
            module_id: m.id,
            method: route.method,
            route_pattern: pattern,
            middleware: route.middleware,
            ...(route.handler ? { handler: route.handler } : {}),
            status: viaParameter ? "inferred" : "source_verified",
            ...(viaParameter
              ? {
                  confidence_rationale:
                    "registered on an application passed in as a parameter; the caller is not traced",
                }
              : {}),
            origin: "source",
            evidence_ids: [route.evidence],
          } as Entity)
        )
          relate("EXPOSES", m.id, id, [route.evidence], viaParameter ? "inferred" : "source_verified");
      }
    }
    for (const [receiver, count] of unmounted)
      out.coverage.push({
        area: m.path,
        status: "analyzed",
        reason: `router ${receiver} is never mounted on an application; its ${count} route(s) are not part of the API`,
      });
  }

  // ---------------------------------------------------------------- Next.js
  for (const boundary of boundaries.filter((b) => b.frameworks.some((f) => f.name === "nextjs"))) {
    const ns = boundary.path === "" ? "app" : boundary.path.slice(boundary.path.lastIndexOf("/") + 1);
    for (const m of modules.values()) {
      if (m.project_boundary !== boundary.id) continue;
      const rel = (boundary.path === "" ? m.path : m.path.slice(boundary.path.length + 1)).replace(/^src\//, "");
      const appRoute =
        /^app\/(.*?)\/?(page|route)\.[cm]?[jt]sx?$/.exec(rel) ?? /^app\/(page|route)\.[cm]?[jt]sx?$/.exec(rel);
      const pagesRoute = /^pages\/(.*)\.[cm]?[jt]sx?$/.exec(rel);
      if (appRoute) {
        const segments = (appRoute.length === 3 ? appRoute[1]! : "")
          .split("/")
          .filter((s) => s !== "" && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
        const path = normalizeRoutePath(`/${segments.join("/")}`);
        const kind = appRoute.length === 3 ? appRoute[2] : appRoute[1];
        if (kind === "page") addPage(`page:${ns}:${path}`, path, m, m.evidence_ids);
        else
          for (const method of NEXT_METHODS.filter((x) => m.exports?.includes(x)))
            addApi(`api:${method}:${path}`, method, path, m);
      } else if (pagesRoute && !/(^|\/)_(app|document|error)$/.test(pagesRoute[1]!)) {
        const path = normalizeRoutePath(`/${pagesRoute[1]!.replace(/(^|\/)index$/, "")}`);
        if (path.startsWith("/api")) addApi(`api:ANY:${path}`, "ANY", path, m);
        else addPage(`page:${ns}:${path}`, path, m, m.evidence_ids);
      }
    }
  }
  function addApi(id: string, method: string, path: string, m: ModuleFacts) {
    apis.add(id);
    if (
      add({
        id,
        kind: "api",
        name: `${method} ${path}`,
        project_boundary: m.project_boundary,
        module_id: m.id,
        method,
        route_pattern: path,
        status: "source_verified",
        origin: "source",
        evidence_ids: m.evidence_ids,
      } as Entity)
    )
      relate("EXPOSES", m.id, id, m.evidence_ids);
  }

  // ---------------------------------------------------------------- React Router pages
  const pages: Array<{ id: string; ns: string; path: string; module: string; component?: string; evidence: string[] }> =
    [];
  for (const m of modules.values()) {
    if (!m.react_router) continue;
    const key = m.id.slice("module:".length).split(":").pop()!;
    const boundary = boundaries.find((b) => b.id === m.project_boundary);
    const ns = key.includes(".")
      ? key.slice(0, key.indexOf("."))
      : boundary && boundary.path !== ""
        ? boundary.path.slice(boundary.path.lastIndexOf("/") + 1)
        : "app";
    for (const route of m.react_router.routes) {
      const path = normalizeRoutePath(route.path);
      const id = `page:${ns}:${path}`;
      addPage(id, path, m, [route.evidence]);
      pages.push({
        id,
        ns,
        path,
        module: m.id,
        ...(route.component ? { component: route.component } : {}),
        evidence: [route.evidence],
      });
    }
  }
  function addPage(id: string, path: string, m: ModuleFacts, evidence: string[]) {
    add({
      id,
      kind: "page",
      name: path,
      project_boundary: m.project_boundary,
      route_pattern: path,
      status: "source_verified",
      origin: "source",
      evidence_ids: evidence,
    } as Entity);
  }

  // Forms, fields and navigation of the component each page renders.
  const pageIds = new Set(pages.map((p) => p.id));
  for (const page of pages) {
    if (!page.component) continue;
    const target = resolve(page.module, page.component);
    const component = target && modules.get(target.module)?.components?.find((c) => c.name === target.name);
    if (!component) continue;
    const boundary = modules.get(target!.module)!.project_boundary;
    for (const form of component.forms) {
      const formId = `form:${page.ns}:${page.path}#${form.key}`;
      const fieldIds = form.fields.map((f) => `${formId.replace(/^form:/, "field:")}.${f.name}`);
      const endpoint = form.submits
        .map((s) => `api:${s.method}:${normalizeRoutePath(s.url)}`)
        .find((id) => apis.has(id));
      add({
        id: formId,
        kind: "form",
        name: form.key,
        project_boundary: boundary,
        page_id: page.id,
        inputs: fieldIds,
        ...(endpoint ? { submits_to: endpoint } : {}),
        status: "source_verified",
        origin: "source",
        evidence_ids: [form.evidence],
      } as Entity);
      relate("CONTAINS", page.id, formId, [form.evidence]);
      form.fields.forEach((field, i) => {
        add({
          id: fieldIds[i]!,
          kind: "field",
          name: field.name,
          project_boundary: boundary,
          form_id: formId,
          constraints: fieldConstraints(field.constraints),
          attributes: field.constraints,
          status: "source_verified",
          origin: "source",
          evidence_ids: [form.evidence],
        } as Entity);
        relate("CONTAINS", formId, fieldIds[i]!, [form.evidence]);
      });
      if (endpoint) relate("SUBMITS_TO", formId, endpoint, [form.evidence]);
      for (const request of form.submits) {
        const id = `api:${request.method}:${normalizeRoutePath(request.url)}`;
        if (apis.has(id) || !request.url.startsWith("/")) continue;
        out.gaps.push({
          id: `gap:endpoint:${request.method}:${normalizeRoutePath(request.url)}`,
          type: "missing_evidence",
          description: `Form ${form.key} on ${page.path} sends ${request.method} ${request.url}, which no analyzed route defines.`,
          impact:
            "The workflow stops at the request; the server side is outside the analyzed code or registered dynamically.",
          evidence_ids: [form.evidence],
          related_entity_ids: [formId],
          requires_human_clarification: false,
          status: "unresolved",
        });
      }
    }
    for (const request of component.requests ?? []) {
      const path = normalizeRoutePath(request.url);
      const endpoint = [...apis].find((id) => {
        const [, method, pattern] = /^api:([^:]+):(.*)$/.exec(id)!;
        return (method === request.method || method === "ANY" || method === "ALL") && matchesPattern(pattern!, path);
      });
      if (endpoint) relate("CONSUMES", page.id, endpoint, [request.evidence]);
    }
    for (const nav of component.navigations) {
      const to = `page:${page.ns}:${normalizeRoutePath(nav.to)}`;
      const match = pageIds.has(to)
        ? to
        : pages.find((p) => p.ns === page.ns && matchesPattern(p.path, normalizeRoutePath(nav.to)))?.id;
      if (match && match !== page.id) relate("NAVIGATES_TO", page.id, match, [nav.evidence]);
    }
  }
  const uniqueGaps = new Map(out.gaps.map((g) => [g.id, g]));
  out.gaps = [...uniqueGaps.values()];
  out.relationships = [...new Map(out.relationships.map((r) => [r.id, r])).values()];
  return out;
}

function joinPrefix(prefix: string, path: string): string {
  if (prefix === "" || prefix === "/") return path;
  return `${prefix.replace(/\/$/, "")}/${path.replace(/^\//, "")}`.replace(/\/$/, "") || "/";
}

function matchesPattern(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((s, i) => (s.startsWith("{") && s.endsWith("}")) || s === b[i]);
}

function fieldConstraints(raw: Record<string, string | number | boolean>): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (raw.required === true) c.required = true;
  if (typeof raw.pattern === "string") c.pattern = raw.pattern;
  if (typeof raw.minLength === "number") c.min_length = raw.minLength;
  if (typeof raw.maxLength === "number") c.max_length = raw.maxLength;
  if (typeof raw.min === "number") c.min = raw.min;
  if (typeof raw.max === "number") c.max = raw.max;
  if (typeof raw.type === "string") c.input_type = raw.type;
  return c;
}
