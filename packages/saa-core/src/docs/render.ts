import { createHash } from "node:crypto";
import type { Entity, Gap, Relationship, Workflow } from "@sys2qa/contract";
import { DEFAULT_FILES, DOC_ROLES, MESSAGES, type DocLanguage, type DocRole, type Messages } from "./messages.js";
import type { SkbView } from "./view.js";

export interface RenderedDocument {
  role: DocRole;
  language: DocLanguage;
  /** Package-relative path: `docs/<language>/<file>`. */
  path: string;
  title: string;
  markdown: string;
  /** For `workflows` documents, the workflow they describe. */
  workflow_id?: string;
}

export interface RenderOptions {
  languages?: readonly DocLanguage[];
  /** File names per role, overriding the defaults; the role never changes (CON-011). */
  files?: Partial<Record<DocRole, string>>;
}

type Row = Array<string | number | undefined>;

const code = (value: string | number) => `\`${String(value).replace(/`/g, "'")}\``;
const cell = (value: string | number | undefined) =>
  value === undefined || value === ""
    ? "—"
    : String(value)
        .replace(/\|/g, "\\|")
        .replace(/\s*\n\s*/g, " ");
const ids = (values: readonly string[] | undefined) =>
  values && values.length > 0 ? values.map(code).join(", ") : "—";
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);

/** A stable file name for a workflow document; a short hash only when two workflows would share a name. */
function workflowFiles(workflows: readonly Workflow[]): Map<string, string> {
  const base = (id: string) =>
    id
      .replace(/^workflow:/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "workflow";
  const counts = new Map<string, number>();
  for (const w of workflows) counts.set(base(w.id), (counts.get(base(w.id)) ?? 0) + 1);
  return new Map(
    workflows.map((w) => {
      const b = base(w.id);
      const suffix = counts.get(b)! > 1 ? `-${createHash("sha256").update(w.id).digest("hex").slice(0, 6)}` : "";
      return [w.id, `${b}${suffix}.md`];
    }),
  );
}

/**
 * Renders the documentation set of PRD §12.2 from one SKB run (IMP-116, SAA-FR-013, SAA-FR-035, LOC-011), one file
 * per role and language plus one per workflow. Every document states the revision, analysis date, profile, language
 * and coverage, and cites SKB IDs. A section with nothing to show says so or lists the gaps that explain it; nothing
 * is omitted silently. Rendering is deterministic: the same SKB gives the same bytes, and the `en` and `id` versions
 * of a document carry the same IDs, codes and numbers.
 */
export function renderDocumentation(view: SkbView, options: RenderOptions = {}): RenderedDocument[] {
  const languages = options.languages ?? (["en", "id"] as const);
  const files = { ...DEFAULT_FILES, ...options.files };
  const workflowFile = workflowFiles(view.workflows);
  const out: RenderedDocument[] = [];
  for (const language of languages) {
    const L = MESSAGES[language];
    const r = new Renderer(view, L, language);
    for (const role of DOC_ROLES) {
      if (role === "workflows") {
        for (const w of view.workflows) {
          const title = L.workflowTitle(w.name);
          out.push({
            role,
            language,
            path: `docs/${language}/${files.workflows}/${workflowFile.get(w.id)}`,
            title,
            markdown: r.document(title, r.workflow(w)),
            workflow_id: w.id,
          });
        }
        continue;
      }
      const title = L.titles[role];
      const body = r.body(role, (id) => `${files.workflows}/${workflowFile.get(id)}`);
      out.push({ role, language, path: `docs/${language}/${files[role]}`, title, markdown: r.document(title, body) });
    }
  }
  return out;
}

class Renderer {
  private readonly entities: Map<string, Entity>;
  private readonly evidencePath: Map<string, string>;

  constructor(
    private readonly v: SkbView,
    private readonly L: Messages,
    private readonly language: DocLanguage,
  ) {
    this.entities = new Map(v.entities.map((e) => [e.id, e]));
    this.evidencePath = new Map(
      v.evidence.map((e) => [e.id, e.path ? `${e.path}${e.range ? `:${e.range.start_line}` : ""}` : (e.url ?? e.id)]),
    );
  }

  // ------------------------------------------------------------------ helpers
  private kind(kind: string): Entity[] {
    return this.v.entities.filter((e) => e.kind === kind).sort(byId);
  }
  private rels(type: Relationship["type"], filter: (r: Relationship) => boolean = () => true): Relationship[] {
    return this.v.relationships
      .filter((r) => r.type === type && filter(r))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  }
  private where(evidence: readonly string[] | undefined): string {
    const first = (evidence ?? []).map((id) => this.evidencePath.get(id)).find((p) => p !== undefined);
    return first ? code(first) : "—";
  }
  private machine(text: string | undefined): string {
    if (!text) return "—";
    return this.language === "en" ? text : `${text} _(${this.L.machineText})_`;
  }
  private table(headers: string[], rows: Row[]): string {
    if (rows.length === 0) return this.L.none;
    return [
      `| ${headers.join(" | ")} |`,
      `|${headers.map(() => "---").join("|")}|`,
      ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ].join("\n");
  }
  private section(title: string, body: string): string {
    return `## ${title}\n\n${body}`;
  }
  private gaps(filter: (g: Gap) => boolean): string {
    const gaps = this.v.gaps.filter(filter).sort(byId);
    const C = this.L.columns;
    return this.table(
      [C.id, C.type, C.statement],
      gaps.map((g) => [code(g.id), code(g.type), this.machine(g.description)]),
    );
  }

  document(title: string, body: string): string {
    const m = this.v.manifest;
    const revision = (m.revision as { value?: string } | undefined)?.value ?? "unknown";
    const c = this.v.completeness?.constructs ?? { analyzed: 0, partial: 0, unsupported: 0 };
    const H = this.L.header;
    return [
      `# ${title}`,
      "",
      `${H.revision} ${code(revision.slice(0, 12))} · ${H.analyzed} ${code(m.created_at.slice(0, 10))} · ${H.profile} ${code(this.v.run?.profile ?? "standard")} · ${H.language} ${code(this.language)} · ${H.run} ${code(m.run_id)}`,
      "",
      `_${this.L.scope(c.analyzed, c.partial, c.unsupported)}_`,
      "",
      body.trim(),
      "",
    ].join("\n");
  }

  body(role: Exclude<DocRole, "workflows">, link: (workflowId: string) => string): string {
    switch (role) {
      case "executive_summary":
        return this.executiveSummary(link);
      case "system_context":
        return this.systemContext();
      case "architecture":
        return this.architecture();
      case "project_inventory":
        return this.projectInventory();
      case "components":
        return this.components();
      case "workflow_catalog":
        return this.workflowCatalog(link);
      case "routes_and_pages":
        return this.routesAndPages();
      case "business_rules":
        return this.businessRules();
      case "observed_behavior":
        return this.L.text.observedBehavior;
      case "api_contracts":
        return this.apiContracts();
      case "data_model":
        return this.dataModel();
      case "roles_and_permissions":
        return this.rolesAndPermissions();
      case "integrations_events":
        return this.integrationsEvents();
      case "configuration_deployment":
        return this.configurationDeployment();
      case "tests_coverage":
        return this.testsCoverage();
      case "dependencies_impact":
        return this.dependenciesImpact();
      case "risks_contradictions":
        return this.risksContradictions();
      case "unknowns":
        return this.unknowns();
    }
  }

  // ------------------------------------------------------------------ roles
  private executiveSummary(link: (id: string) => string): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const T = this.L.text;
    const count = (kind: string) => T.countsInScope(code(kind), this.kind(kind).length);
    const summary = ["page", "api", "business_rule", "state_machine", "integration", "job"].map((k) => `- ${count(k)}`);
    summary.push(`- ${T.countsInScope(code("workflow"), this.v.workflows.length)}`);
    const comp = this.v.completeness;
    const limitations = [
      ...(comp?.unavailable_adapters ?? []).map((u) => `- ${code(u.adapter)}: ${this.machine(u.reason)}`),
      ...(this.v.catalog?.not_deepened ?? []).map((id) => `- ${code(id)}: ${T.notDeepened}`),
      `- ${T.countsInScope(code("excluded"), comp?.excluded.length ?? 0)}`,
    ];
    return [
      this.section(S.summary, summary.join("\n")),
      this.section(S.evidenceProfile, T.evidenceProfile),
      this.section(S.cannotEstablish, T.cannotEstablish),
      this.section(S.boundaries, this.boundaries()),
      this.section(
        S.keyWorkflows,
        this.table(
          [C.rank, C.id, C.category, C.discovery, C.completion],
          this.v.workflows
            .slice(0, 5)
            .map((w) => [
              w.rank,
              `[${code(w.id)}](${link(w.id)})`,
              code(w.category),
              code(w.discovery_status),
              code(w.completion),
            ]),
        ),
      ),
      this.section(
        S.completeness,
        comp
          ? this.table(
              [C.discovery, C.count],
              Object.entries(comp.workflows_by_status)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, n]) => [code(k), n]),
            )
          : this.L.notAnalyzed,
      ),
      this.section(S.limitations, limitations.join("\n")),
      this.section(
        S.highRiskUnknowns,
        this.gaps((g) => g.requires_human_clarification),
      ),
    ].join("\n\n");
  }

  private boundaries(): string {
    const C = this.L.columns;
    const stack = this.v.stack;
    if (!stack) return this.L.notAnalyzed;
    return this.table(
      [C.boundary, C.kind, C.languages, C.frameworks],
      [...stack.boundaries]
        .sort(byId)
        .map((b) => [
          code(b.id),
          code(b.kind),
          ids(Object.keys(b.languages).sort()),
          ids(b.frameworks.map((f) => f.name).sort()),
        ]),
    );
  }

  private systemContext(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    return [
      this.section(
        S.actors,
        this.table(
          [C.id, C.name],
          [...this.kind("actor_role"), ...this.kind("permission")].map((e) => [code(e.id), e.name]),
        ),
      ),
      this.section(S.applications, this.boundaries()),
      this.section(
        S.externalServices,
        this.table(
          [C.id, C.kind, C.from],
          [...this.kind("integration"), ...this.kind("queue_topic")].map((e) => [
            code(e.id),
            code(e.kind),
            ids([...new Set(this.v.relationships.filter((r) => r.to === e.id).map((r) => r.from))].sort()),
          ]),
        ),
      ),
      this.section(
        S.trustBoundaries,
        this.gaps((g) => g.type === "external_boundary"),
      ),
    ].join("\n\n");
  }

  private moduleGroups(): Map<string, Entity[]> {
    const groups = new Map<string, Entity[]>();
    for (const m of this.kind("module").filter((e) => !(e as { external?: boolean }).external)) {
      const path = (m as { path?: string }).path ?? m.id;
      const parts = path.replace(/^src\//, "").split("/");
      const group = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : ".";
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
  }

  private architecture(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const groups = this.moduleGroups();
    const groupOf = new Map<string, string>();
    for (const [g, ms] of groups) for (const m of ms) groupOf.set(m.id, g);
    const edges = new Map<string, number>();
    for (const r of this.rels("IMPORTS")) {
      const a = groupOf.get(r.from);
      const b = groupOf.get(r.to);
      if (a && b && a !== b) edges.set(`${a}\0${b}`, (edges.get(`${a}\0${b}`) ?? 0) + 1);
    }
    const node = (g: string) => `g_${g.replace(/[^A-Za-z0-9]/g, "_")}`;
    const diagram = [
      "```mermaid",
      "graph LR",
      ...[...groups.keys()].map((g) => `  ${node(g)}["${g}"]`),
      ...[...edges.keys()]
        .sort()
        .slice(0, 60)
        .map((k) => {
          const [a, b] = k.split("\0");
          return `  ${node(a!)} --> ${node(b!)}`;
        }),
      "```",
    ].join("\n");
    return [
      this.section(
        S.modules,
        this.table(
          [C.path, C.count, C.id],
          [...groups].map(([g, ms]) => [code(g), ms.length, ids(ms.slice(0, 8).map((m) => m.id))]),
        ),
      ),
      this.section(S.dependencies, this.dependencyProjects()),
      this.section(
        S.deployment,
        this.table(
          [C.id, C.name],
          this.kind("deployment_unit").map((e) => [code(e.id), e.name]),
        ),
      ),
      this.section(S.diagram, groups.size > 0 ? diagram : this.L.none),
    ].join("\n\n");
  }

  private dependencyProjects(): string {
    const C = this.L.columns;
    return this.table(
      [C.from, C.target, C.name],
      (this.v.graph?.projects ?? []).map((p) => [code(p.from), code(p.to), ids(p.packages)]),
    );
  }

  private projectInventory(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const stack = this.v.stack;
    const scripts = this.v.entities
      .filter((e) => (e as { config?: { config_kind?: string } }).config?.config_kind === "package_scripts")
      .sort(byId)
      .flatMap((e) =>
        (
          (e as unknown as { config: { scripts: Array<{ name: string; command: string; runs_on_install: boolean }> } })
            .config.scripts ?? []
        ).map((s) => [code(e.name ?? e.id), code(s.name), code(s.command), s.runs_on_install ? this.L.yes : this.L.no]),
      );
    const comp = this.v.completeness;
    return [
      this.section(
        S.stack,
        stack
          ? this.table(
              [C.languages, C.files, C.status],
              [...stack.languages]
                .sort((a, b) => a.language.localeCompare(b.language))
                .map((l) => [code(l.language), l.files, code(String(l.support))]),
            )
          : this.L.notAnalyzed,
      ),
      this.section(S.boundaries, this.boundaries()),
      this.section(
        S.entryPoints,
        this.table(
          [C.entry, C.kind],
          [...this.v.component_traces]
            .sort((a, b) => a.entry_point_id.localeCompare(b.entry_point_id))
            .map((t) => [code(t.entry_point_id), code(t.entry_point_id.split(":")[0]!)]),
        ),
      ),
      this.section(
        S.commands,
        `${this.L.text.notExecuted}\n\n${this.table([C.path, C.name, C.statement, code("runs_on_install")], scripts)}`,
      ),
      this.section(
        S.excluded,
        this.table(
          [C.path, C.reason],
          (comp?.excluded ?? []).map((x) => [code(x.area), code(x.reason)]),
        ),
      ),
      this.section(S.coverage, this.coverage()),
    ].join("\n\n");
  }

  private coverage(): string {
    const C = this.L.columns;
    const counts = new Map<string, number>();
    for (const c of this.v.coverage) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
    return this.table(
      [C.status, C.count],
      [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => [code(s), n]),
    );
  }

  private components(): string {
    const C = this.L.columns;
    const rows: Row[] = [];
    for (const [group, modules] of this.moduleGroups()) {
      const set = new Set(modules.map((m) => m.id));
      const inGroup = (id: string) => {
        const e = this.entities.get(id) as { module_id?: string; component_module_id?: string } | undefined;
        return set.has(e?.module_id ?? "") || set.has(e?.component_module_id ?? "");
      };
      const exposes = this.kind("api").filter((a) => inGroup(a.id)).length;
      const renders = this.kind("page").filter((p) => inGroup(p.id)).length;
      const writes = new Set(this.rels("WRITES_TO", (r) => inGroup(r.from) || set.has(r.from)).map((r) => r.to)).size;
      const reads = new Set(this.rels("READS_FROM", (r) => inGroup(r.from) || set.has(r.from)).map((r) => r.to)).size;
      const deps = [...new Set(this.rels("IMPORTS", (r) => set.has(r.from) && !set.has(r.to)).map((r) => r.to))].sort();
      rows.push([
        code(group),
        this.L.text.responsibility(exposes, renders, writes, reads),
        ids(deps.slice(0, 8)),
        ids(modules.slice(0, 5).map((m) => (m as { path?: string }).path ?? m.id)),
      ]);
    }
    return `${this.L.text.noOwners}\n\n${this.table([C.path, C.statement, C.target, C.files], rows)}`;
  }

  private workflowCatalog(link: (id: string) => string): string {
    const C = this.L.columns;
    const byCategory = new Map<string, Workflow[]>();
    for (const w of this.v.workflows) byCategory.set(w.category, [...(byCategory.get(w.category) ?? []), w]);
    const parts = [...byCategory]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, ws]) =>
        this.section(
          code(category),
          this.table(
            [C.rank, C.id, C.entry, C.discovery, C.completion, C.unresolved, C.deepened],
            ws.map((w) => [
              w.rank,
              `[${code(w.id)}](${link(w.id)})`,
              ids(w.entry_point_ids),
              code(w.discovery_status),
              code(w.completion),
              ids([...new Set(w.unresolved_hops.map((h) => h.reason_code))].sort()),
              w.deepened ? this.L.yes : code("not_deepened"),
            ]),
          ),
        ),
      );
    return parts.length > 0 ? parts.join("\n\n") : this.L.none;
  }

  workflow(w: Workflow): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const entityOf = new Map(w.steps.map((s) => [s.id, s.entity_id]));
    const tests = [
      ...new Set(
        w.steps
          .flatMap((s) => [...(s.validations ?? [])])
          .flatMap((rule) => this.rels("TESTS", (r) => r.to === rule).map((r) => r.from)),
      ),
    ].sort();
    return [
      `${code(w.id)} · ${code(w.category)} · ${code(w.discovery_status)} · ${code(w.completion)} · ${C.status} ${code(w.status)}${w.deepened ? "" : ` · ${code("not_deepened")}`}`,
      this.section(
        S.steps,
        this.table(
          [C.step, C.id, C.action, C.reads, C.writes, C.effects, C.validations],
          [...w.steps]
            .sort((a, b) => a.order - b.order)
            .map((s) => [
              s.order,
              code(s.entity_id),
              code(s.action),
              ids(s.reads),
              ids(s.writes),
              ids(s.side_effects),
              ids(s.validations),
            ]),
        ),
      ),
      this.section(
        S.branches,
        this.table(
          [C.from, C.condition, C.outcome, C.status],
          w.branches.map((b) => [
            code(entityOf.get(b.from_step) ?? b.from_step),
            code(b.condition),
            code(b.outcome),
            code(b.status),
          ]),
        ),
      ),
      this.section(
        S.unresolvedHops,
        this.table(
          [C.from, C.reason, C.id, C.statement],
          w.unresolved_hops.map((h) => [
            h.after_step ? code(entityOf.get(h.after_step) ?? h.after_step) : "—",
            code(h.reason_code),
            h.gap_id ? code(h.gap_id) : "—",
            this.machine(h.description),
          ]),
        ),
      ),
      this.section(S.traces, w.component_trace_ids.length > 0 ? ids(w.component_trace_ids) : this.L.none),
      this.section(S.tests, `${this.L.text.testsNotRun}\n\n${tests.length > 0 ? ids(tests) : this.L.none}`),
    ].join("\n\n");
  }

  private routesAndPages(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const access = (page: string) => {
      const apis = [
        ...this.rels("CONSUMES", (r) => r.from === page).map((r) => r.to),
        ...this.rels("CONTAINS", (r) => r.from === page).flatMap((c) =>
          this.rels("SUBMITS_TO", (r) => r.from === c.to).map((r) => r.to),
        ),
      ];
      return [
        ...new Set(apis.flatMap((a) => this.rels("AUTHORIZES_WITH", (r) => r.from === a).map((r) => r.to))),
      ].sort();
    };
    const fields = this.kind("field").map((f) => {
      const c = ((f as unknown as { constraints?: Record<string, unknown> }).constraints ?? {}) as Record<
        string,
        unknown
      >;
      return [
        code((f as { form_id?: string }).form_id ?? ""),
        code(f.name ?? f.id),
        Object.keys(c).length > 0
          ? Object.entries(c)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => code(`${k}=${String(v)}`))
              .join(", ")
          : "—",
      ];
    });
    return [
      this.section(
        S.pages,
        this.table(
          [C.id, C.path, C.condition, C.constraints],
          this.kind("page").map((p) => [
            code(p.id),
            code((p as { route_pattern?: string }).route_pattern ?? p.name ?? ""),
            (p as unknown as { condition?: string }).condition
              ? code((p as unknown as { condition: string }).condition)
              : "—",
            ids(access(p.id)),
          ]),
        ),
      ),
      this.section(
        S.forms,
        `${this.table(
          [C.id, C.target],
          this.kind("form").map((f) => [
            code(f.id),
            (f as { submits_to?: string }).submits_to ? code((f as { submits_to: string }).submits_to) : "—",
          ]),
        )}\n\n${this.table([C.from, C.name, C.constraints], fields)}`,
      ),
      this.section(
        S.navigation,
        this.table(
          [C.from, C.target],
          this.rels("NAVIGATES_TO").map((r) => [code(r.from), code(r.to)]),
        ),
      ),
    ].join("\n\n");
  }

  private businessRules(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const rules = this.kind("business_rule").map((e) => {
      const r = e as unknown as {
        statement?: string;
        technical_rule?: string;
        inputs?: string[];
        expected_behavior?: { on_violation?: string };
        contradiction_ids?: string[];
      };
      return [
        code(e.id),
        this.machine(r.statement),
        code(r.technical_rule ?? ""),
        ids(r.inputs),
        r.expected_behavior?.on_violation ? code(r.expected_behavior.on_violation) : "—",
        ids(this.rels("VALIDATES", (x) => x.from === e.id).map((x) => x.to)),
        ids(r.contradiction_ids),
        code(e.status),
      ];
    });
    const machines = this.kind("state_machine").map((e) => {
      const m = e as unknown as {
        states: string[];
        transitions?: Array<{ from: string; to: string }>;
        invalid_transitions_known?: Array<{ from: string; to: string }>;
      };
      return this.section(
        code(e.id),
        [
          `${S.states}: ${ids(m.states)}`,
          `${S.transitions}: ${ids((m.transitions ?? []).map((t) => `${t.from}->${t.to}`))}`,
          `${S.invalidTransitions}: ${ids((m.invalid_transitions_known ?? []).map((t) => `${t.from}->${t.to}`))}`,
        ].join("\n\n"),
      );
    });
    return [
      this.section(
        S.rules,
        this.table([C.id, C.statement, C.technical, C.inputs, C.violation, C.target, C.unresolved, C.status], rules),
      ),
      this.section(S.states, machines.length > 0 ? machines.join("\n\n") : this.L.none),
      this.section(
        this.L.gapsHere,
        this.gaps((g) => g.id.startsWith("gap:state-machine:") || g.type === "contradiction"),
      ),
    ].join("\n\n");
  }

  private apiContracts(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const apis = this.kind("api");
    const auth = (id: string) =>
      [
        ...this.rels("AUTHENTICATES_WITH", (r) => r.from === id),
        ...this.rels("AUTHORIZES_WITH", (r) => r.from === id),
      ].map((r) => r.to);
    const errors = apis.flatMap((a) =>
      (
        (a as { error_responses?: Array<{ status: number; outcome: string; condition: string; evidence_id: string }> })
          .error_responses ?? []
      ).map((e) => [code(a.id), e.status, code(e.outcome), code(e.condition), this.where([e.evidence_id])]),
    );
    return [
      this.section(
        S.endpoints,
        this.table(
          [C.id, S.checks, C.validations, C.path],
          apis.map((a) => [
            code(a.id),
            ids(auth(a.id)),
            ids(this.rels("VALIDATES", (r) => r.to === a.id).map((r) => r.from)),
            this.where(a.evidence_ids),
          ]),
        ),
      ),
      this.section(S.errors, this.table([C.id, C.status, C.outcome, C.condition, C.evidence], errors)),
      this.section(
        this.L.gapsHere,
        this.gaps((g) => g.id.startsWith("gap:dynamic-routes:") || g.id.startsWith("gap:endpoint:")),
      ),
    ].join("\n\n");
  }

  private dataModel(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    return [
      this.section(
        S.tables,
        this.table(
          [C.id, C.path],
          this.kind("table").map((t) => [code(t.id), this.where(t.evidence_ids)]),
        ),
      ),
      this.section(
        S.columns,
        this.table(
          [C.id, C.type, C.constraints],
          this.kind("column").map((c) => {
            const x = c as { data_type?: string; checks?: string[]; allowed_values?: string[]; primary_key?: boolean };
            return [
              code(c.id),
              x.data_type ? code(x.data_type) : "—",
              ids([
                ...(x.primary_key ? ["primary_key"] : []),
                ...(x.checks ?? []),
                ...(x.allowed_values ? [x.allowed_values.join(",")] : []),
              ]),
            ];
          }),
        ),
      ),
      this.section(
        S.entities,
        this.table(
          [C.id, C.target],
          this.kind("entity").map((e) => [
            code(e.id),
            ids(this.rels("REFERENCES", (r) => r.from === e.id).map((r) => r.to)),
          ]),
        ),
      ),
      this.section(
        S.queries,
        this.table(
          [C.from, C.type, C.target],
          [...this.rels("WRITES_TO"), ...this.rels("READS_FROM")].map((r) => [code(r.from), code(r.type), code(r.to)]),
        ),
      ),
      this.L.text.sensitivity,
    ].join("\n\n");
  }

  private rolesAndPermissions(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    return [
      this.section(
        S.roles,
        this.table(
          [C.id, C.kind, C.evidence],
          [...this.kind("actor_role"), ...this.kind("permission")].map((e) => [
            code(e.id),
            code(e.kind),
            this.where(e.evidence_ids),
          ]),
        ),
      ),
      this.section(
        S.checks,
        this.table(
          [C.from, C.type, C.target],
          [...this.rels("AUTHENTICATES_WITH"), ...this.rels("AUTHORIZES_WITH")].map((r) => [
            code(r.from),
            code(r.type),
            code(r.to),
          ]),
        ),
      ),
      this.section(
        this.L.gapsHere,
        this.gaps((g) => g.id === "gap:authorization"),
      ),
    ].join("\n\n");
  }

  private integrationsEvents(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    return [
      this.section(
        S.integrations,
        this.table(
          [C.id, C.from, C.evidence],
          this.kind("integration").map((e) => [
            code(e.id),
            ids(this.rels("SENDS_TO", (r) => r.to === e.id).map((r) => r.from)),
            this.where(e.evidence_ids),
          ]),
        ),
      ),
      this.section(
        S.topics,
        this.table(
          [C.id, C.from, C.target],
          this.kind("queue_topic").map((e) => [
            code(e.id),
            ids(this.rels("PUBLISHES", (r) => r.to === e.id).map((r) => r.from)),
            ids(this.rels("SUBSCRIBES_TO", (r) => r.to === e.id).map((r) => r.from)),
          ]),
        ),
      ),
      this.section(
        this.L.gapsHere,
        this.gaps((g) => g.type === "external_boundary" || g.id.startsWith("gap:consumer:")),
      ),
    ].join("\n\n");
  }

  private configurationDeployment(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    return [
      this.L.text.valuesRedacted,
      this.section(
        S.keys,
        this.table(
          [C.id, C.sources, C.documented, C.fallback],
          this.kind("config_key").map((k) => {
            const x = k as { sources?: string[]; documented?: boolean; read_with_default?: boolean };
            return [
              code(k.id),
              ids(x.sources),
              x.documented ? this.L.yes : this.L.no,
              x.read_with_default ? this.L.yes : this.L.no,
            ];
          }),
        ),
      ),
      this.section(
        S.units,
        this.table(
          [C.id, C.target],
          this.kind("deployment_unit").map((u) => [
            code(u.id),
            ids(this.rels("DEPENDS_ON", (r) => r.from === u.id).map((r) => r.to)),
          ]),
        ),
      ),
      this.section(
        S.secrets,
        this.table(
          [C.id, C.from],
          this.kind("secret_ref").map((s) => [
            code(s.id),
            ids(this.rels("AUTHENTICATES_WITH", (r) => r.to === s.id).map((r) => r.from)),
          ]),
        ),
      ),
    ].join("\n\n");
  }

  private testsCoverage(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const tested = new Set(this.rels("TESTS").map((r) => r.to));
    const testModules = [...new Set(this.rels("TESTS").map((r) => r.from))].sort();
    return [
      this.L.text.testsNotRun,
      this.section(
        S.testModules,
        this.table(
          [C.id, C.target],
          testModules.map((m) => [code(m), ids(this.rels("TESTS", (r) => r.from === m).map((r) => r.to))]),
        ),
      ),
      this.section(
        S.untested,
        ids(
          this.kind("business_rule")
            .filter((r) => !tested.has(r.id))
            .map((r) => r.id),
        ),
      ),
      this.section(S.coverage, this.coverage()),
    ].join("\n\n");
  }

  private dependenciesImpact(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const incoming = new Map<string, number>();
    for (const r of this.rels("IMPORTS"))
      if (this.entities.get(r.to)?.kind === "module" && !(this.entities.get(r.to) as { external?: boolean }).external)
        incoming.set(r.to, (incoming.get(r.to) ?? 0) + 1);
    const hotspots = [...incoming].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 10);
    return [
      this.section(
        S.cycles,
        this.v.graph
          ? this.table(
              [C.id],
              this.v.graph.cycles.map((c) => [ids(c)]),
            )
          : this.L.notAnalyzed,
      ),
      this.section(
        S.hotspots,
        this.table(
          [C.id, C.count],
          hotspots.map(([id, n]) => [code(id), n]),
        ),
      ),
      this.section(S.projects, this.dependencyProjects()),
      this.L.text.noChangeEvidence,
    ].join("\n\n");
  }

  private risksContradictions(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const inferred = [...this.v.entities, ...this.v.relationships].filter((r) => r.status === "inferred").length;
    return [
      this.section(
        S.contradictions,
        this.gaps((g) => g.type === "contradiction"),
      ),
      this.section(
        S.dynamic,
        this.gaps((g) => g.type === "unsupported"),
      ),
      this.section(
        S.adapters,
        this.table(
          [C.id, C.reason],
          (this.v.completeness?.unavailable_adapters ?? []).map((u) => [code(u.adapter), this.machine(u.reason)]),
        ),
      ),
      this.section(S.inferred, this.L.text.countsInScope(code("inferred"), inferred)),
    ].join("\n\n");
  }

  private unknowns(): string {
    const S = this.L.sections;
    const C = this.L.columns;
    const missing = this.v.workflows.flatMap((w) =>
      w.unresolved_hops
        .filter((h) => h.reason_code === "missing_repository")
        .map((h) => [code(w.id), h.gap_id ? code(h.gap_id) : "—"]),
    );
    return [
      this.section(
        S.questions,
        this.gaps((g) => g.requires_human_clarification),
      ),
      this.section(S.missingSources, this.table([C.id, C.reason], missing)),
      this.section(
        S.suggestions,
        this.table(
          [C.kind, C.suggestion, C.improves],
          (this.v.completeness?.improvement_suggestions ?? []).map((s) => [
            code(s.evidence_kind),
            this.machine(s.description),
            ids(s.would_improve),
          ]),
        ),
      ),
    ].join("\n\n");
  }
}
