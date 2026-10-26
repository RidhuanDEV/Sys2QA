import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  appendAudit,
  indexSkbRun,
  localIdPart,
  projectDirectory,
  queryEntities,
  queryWorkflows,
  readSkbManifest,
  runDirectory,
  sweepSkbRuns,
} from "@sys2qa/platform";
import {
  analyzeStructure,
  budgetFor,
  completenessReport,
  composeWorkflows,
  defaultPackagesDirectory,
  deepenWorkflow,
  detectStack,
  exportPackage,
  identifyRevision,
  loadSkbView,
  persistSkbRun,
  renderDocumentation,
  repositoryBlock,
  RootSandbox,
  scanInventory,
  supportFromAdapters,
  type AnalysisProfile,
  type InventoryEntry,
  type RevisionIdentity,
  type SkbView,
} from "@sys2qa/saa-core";
import { serviceError, ServiceError, SERVICE_ERRORS } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const PATH = { type: "string", minLength: 1, maxLength: 4096 } as const;

interface RunRow {
  id: string;
  project_id: string;
  status: string;
  artifact_path: string | null;
  revision_json: string | null;
  coverage_json: string | null;
  created_at: string;
  updated_at: string;
}

function runRow(host: Host, runId: string): RunRow {
  const row = host.state.db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!row)
    throw new ServiceError(
      "RUN_NOT_FOUND",
      "not_found",
      `no analysis run ${runId}`,
      SERVICE_ERRORS.RUN_NOT_FOUND!.remediation,
    );
  return row;
}

/** The SKB directory of a finished run; a run that has none (failed, or still running) is reported as such. */
function skbOf(host: Host, runId: string): string {
  const row = runRow(host, runId);
  if (!row.artifact_path || !readSkbManifest(row.artifact_path))
    throw serviceError("CONFLICT", `analysis run ${runId} has no stored result (status ${row.status})`);
  return row.artifact_path;
}

const saaStart = defineOperation<{ name: string; root: string; languages?: string[] }, unknown>({
  name: "saa.start",
  title: "Start analyzing a repository",
  description:
    "Guided start (SAA-FR-014): creates a project for a local repository path and registers it as a source root. Nothing about the system is asked. Analysis needs a scoped authorization declaration for the root first; the result lists the next commands.",
  level: "none",
  effect: "write",
  paths: (input) => [input.root],
  input: {
    type: "object",
    additionalProperties: false,
    required: ["name", "root"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      root: PATH,
      languages: { type: "array", minItems: 1, items: { type: "string", pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" } },
    },
  },
  run: ({ host, caller }, input) => {
    if (!isAbsolute(input.root))
      throw serviceError("INPUT_INVALID", "the repository path must be absolute", { field: "root" });
    if (!existsSync(input.root))
      throw serviceError("NOT_FOUND", "no directory at the repository path", { field: "root" });
    const project = host.projects.createProject({
      name: input.name,
      ...(input.languages ? { languages: input.languages } : {}),
      actor: caller.actor,
    });
    const source = host.projects.addEvidenceSource(project.id, "source_root", input.root);
    return {
      project,
      source,
      next: [
        `declare ${source.id} --level L1 --by <your name>   (authorize read-only analysis of ${input.root})`,
        `analyze ${source.id}`,
      ],
    };
  },
});

const saaAnalyze = defineOperation<{ source_id: string; profile?: AnalysisProfile }, unknown>({
  name: "saa.analyze",
  title: "Analyze a repository",
  description:
    "Runs a read-only static analysis of a declared source root (L1: no repository code is executed): inventory, stack, structure, traces, workflow catalog, rules, cross-validation and completeness report. The result is stored as an SKB run and indexed; workflows need no names (SAA-FR-040).",
  level: "L1",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id"],
    properties: { source_id: ID, profile: { enum: ["overview", "standard", "deep"] } },
  },
  run: async ({ host, caller }, input) => {
    const source = host.projects.getEvidenceSource(input.source_id);
    if (source.kind !== "source_root")
      throw serviceError("INPUT_INVALID", "only a source root can be analyzed", { field: "source_id" });
    const decision = host.projects.authorize(source.id, "static_read", { kind: "path", path: source.ref });
    if (!decision.allowed) {
      // No declaration at all is its own, more actionable refusal; anything else keeps the policy's code.
      const code =
        decision.reason === "no_declaration"
          ? "DECLARATION_REQUIRED"
          : SERVICE_ERRORS[decision.code]
            ? decision.code
            : "SCOPE_DENIED";
      throw new ServiceError(
        code,
        "denied",
        `analysis of ${source.ref} is not authorized (${decision.reason})`,
        SERVICE_ERRORS[code]!.remediation,
      );
    }
    const adapters = host.adapters();
    if (adapters.length === 0)
      throw new ServiceError(
        "ADAPTERS_UNAVAILABLE",
        "unavailable",
        "no analyzer adapter is built",
        SERVICE_ERRORS.ADAPTERS_UNAVAILABLE!.remediation,
      );
    const profile = input.profile ?? "standard";
    const runId = host.newId("run");
    const at = () => host.now().toISOString();
    const projectId = source.project_id;
    host.state.transaction(() => {
      host.state.db
        .prepare(
          "INSERT INTO analysis_runs (id, project_id, producer, status, created_at, updated_at) VALUES (?, ?, 'SAA', 'running', ?, ?)",
        )
        .run(runId, projectId, at(), at());
      appendAudit(
        host.state.db,
        {
          projectId,
          actor: caller.actor,
          action: "run.started",
          target: runId,
          details: { producer: "SAA", source_id: source.id, profile },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    try {
      const sandbox = await RootSandbox.open([source.ref], { logger: host.logger });
      const inventory: InventoryEntry[] = [];
      await scanInventory(sandbox, { budget: budgetFor(profile) }, (e) => {
        inventory.push(e);
      });
      const included = inventory.filter((e) => e.status === "included");
      const boundaries = (await detectStack(sandbox, included)).boundaries;
      const identity = await identifyRevision(sandbox, 0, included);
      const projectDir = projectDirectory(host.home, projectId);
      const structure = await analyzeStructure({
        sandbox,
        included,
        boundaries,
        adapters,
        scratch: join(host.home, "tmp", localIdPart(runId)),
        runId,
        revision: identity.revision.value,
        cache: { dir: join(projectDir, "cache", "adapters") },
      });
      // The stack report again, now with the support levels the adapters declared.
      const stack = await detectStack(
        sandbox,
        included,
        supportFromAdapters({ adapters: structure.adapters, failures: [] }),
      );
      const completeness = completenessReport({ runId, roots: [source.ref], inventory, boundaries, structure });
      const dir = runDirectory(host.home, projectId, runId);
      const { manifest } = persistSkbRun(dir, {
        runId,
        revision: identity.revision,
        structure,
        completeness,
        stack,
        profile,
      });
      indexSkbRun(host.state.db, dir, manifest);
      const status =
        structure.gaps.some((g) => g.status === "unresolved") ||
        structure.coverage.some((c) => c.status !== "analyzed") ||
        completeness.unavailable_adapters.length > 0
          ? "completed_with_limitations"
          : "completed";
      host.state.db
        .prepare(
          "UPDATE analysis_runs SET status = ?, artifact_path = ?, revision_json = ?, coverage_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, dir, JSON.stringify(identity), JSON.stringify(completeness.constructs), at(), runId);
      // Retention: the newest five runs, plus every run an exported package came from (Data Model §8).
      const protectedRuns = new Set(
        (
          host.state.db.prepare("SELECT path FROM packages WHERE project_id = ?").all(projectId) as Array<{
            path: string;
          }>
        )
          .map((p) => {
            try {
              return (
                JSON.parse(readFileSync(join(p.path, "manifest.json"), "utf8")) as { analysis?: { run_id?: string } }
              ).analysis?.run_id;
            } catch {
              return undefined;
            }
          })
          .filter((id): id is string => id !== undefined),
      );
      sweepSkbRuns(join(projectDir, "skb"), { keep: 5, protect: protectedRuns });
      return {
        run_id: runId,
        status,
        revision: identity.revision,
        count_scope: "within_examined_scope",
        workflows_by_status: completeness.workflows_by_status,
        entry_points_found: completeness.entry_points_found,
        gaps: structure.gaps.length,
        unavailable_adapters: completeness.unavailable_adapters,
        cache: structure.cache,
        next: [`workflows list ${runId}`, `export ${runId}`],
      };
    } catch (error) {
      host.state.db.prepare("UPDATE analysis_runs SET status = 'failed', updated_at = ? WHERE id = ?").run(at(), runId);
      throw error;
    }
  },
});

const saaStatus = defineOperation<{ project_id: string }, unknown>({
  name: "saa.status",
  title: "Analysis status",
  description:
    "The project's analysis runs, newest first, with status, revision and coverage counts, and its exported packages.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["project_id"], properties: { project_id: ID } },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const runs = (
      host.state.db
        .prepare(
          "SELECT * FROM analysis_runs WHERE project_id = ? AND producer = 'SAA' ORDER BY created_at DESC, id DESC",
        )
        .all(project.id) as RunRow[]
    ).map((r) => ({
      run_id: r.id,
      status: r.status,
      started_at: r.created_at,
      updated_at: r.updated_at,
      revision: r.revision_json ? (JSON.parse(r.revision_json) as RevisionIdentity).revision : null,
      constructs: r.coverage_json ? (JSON.parse(r.coverage_json) as unknown) : null,
      stored: r.artifact_path !== null && readSkbManifest(r.artifact_path) !== undefined,
    }));
    const packages = host.state.db
      .prepare(
        "SELECT package_id, version, path, created_at FROM packages WHERE project_id = ? ORDER BY package_id, version",
      )
      .all(project.id);
    return { project, runs, packages };
  },
});

const workflowsList = defineOperation<{ run_id: string; category?: string }, unknown>({
  name: "saa.workflows.list",
  title: "List discovered workflows",
  description:
    "The workflow catalog of an analysis run in rank order, with category, discovery status and completion; counts are within the examined scope (SAA-FR-040, SAA-FR-046).",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: { run_id: ID, category: { type: "string", minLength: 1, maxLength: 64 } },
  },
  run: ({ host }, input) => {
    skbOf(host, input.run_id);
    const workflows = queryWorkflows(host.state.db, input.run_id).filter(
      (w) => input.category === undefined || w.category === input.category,
    );
    return { run_id: input.run_id, count_scope: "within_examined_scope", workflows };
  },
});

const workflowsShow = defineOperation<{ run_id: string; workflow_id: string; language?: "en" | "id" }, unknown>({
  name: "saa.workflows.show",
  title: "Show a workflow",
  description:
    "One discovered workflow: steps, branches, unresolved hops, traces, and its rendered document in the chosen language.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id", "workflow_id"],
    properties: { run_id: ID, workflow_id: ID, language: { enum: ["en", "id"] } },
  },
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    const workflow = view.workflows.find((w) => w.id === input.workflow_id);
    if (!workflow) throw serviceError("NOT_FOUND", `no workflow ${input.workflow_id} in run ${input.run_id}`);
    const doc = renderDocumentation(view, { languages: [input.language ?? "en"] }).find(
      (d) => d.workflow_id === workflow.id,
    );
    return { workflow, document: doc?.markdown ?? null };
  },
});

const saaTrace = defineOperation<{ run_id: string; workflow_id: string; deepen?: boolean }, unknown>({
  name: "saa.trace",
  title: "Trace a workflow",
  description:
    "The component traces behind a discovered workflow, with their stop points; with `deepen`, the workflow is reconstructed in full even when it was ranked below the run's deepening budget (SAA-FR-009, SAA-FR-046).",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id", "workflow_id"],
    properties: { run_id: ID, workflow_id: ID, deepen: { type: "boolean" } },
  },
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    if (!view.workflows.some((w) => w.id === input.workflow_id))
      throw serviceError("NOT_FOUND", `no workflow ${input.workflow_id} in run ${input.run_id}`);
    const catalogInput = {
      entities: view.entities,
      relationships: view.relationships,
      component_traces: view.component_traces,
      gaps: view.gaps,
      evidence: view.evidence,
    };
    const catalog = input.deepen
      ? deepenWorkflow(catalogInput, {}, input.workflow_id)
      : composeWorkflows(catalogInput, {});
    const workflow = catalog.workflows.find((w) => w.id === input.workflow_id)!;
    const traces = view.component_traces.filter((t) => workflow.component_trace_ids.includes(t.id));
    const relationships = new Map(view.relationships.map((r) => [r.id, r]));
    return {
      workflow,
      traces: traces.map((t) => ({
        id: t.id,
        entry_point_id: t.entry_point_id,
        steps: t.relationship_ids
          .map((id) => relationships.get(id))
          .filter((r) => r !== undefined)
          .map((r) => ({ type: r.type, from: r.from, to: r.to })),
        stopped_at: t.stopped_at,
      })),
    };
  },
});

const saaExport = defineOperation<{ run_id: string; output_dir?: string; allow_in_repository?: boolean }, unknown>({
  name: "saa.export",
  title: "Export a Documentation Package",
  description:
    "Exports an analysis run as a validated, immutable Documentation Package (SAA-FR-029): by default under the Sys2QA home, never inside the analyzed repository unless allowed (SAA-FR-036). The first export returns a warning about what the package reveals (SEC-016).",
  level: "none",
  effect: "write",
  paths: (input) => [input.output_dir],
  input: {
    type: "object",
    additionalProperties: false,
    required: ["run_id"],
    properties: { run_id: ID, output_dir: PATH, allow_in_repository: { type: "boolean" } },
  },
  run: ({ host, caller }, input) => {
    const row = runRow(host, input.run_id);
    const skbDir = skbOf(host, input.run_id);
    if (input.output_dir !== undefined && !isAbsolute(input.output_dir))
      throw serviceError("INPUT_INVALID", "the output directory must be absolute", { field: "output_dir" });
    const project = host.projects.getProject(row.project_id);
    const roots = host.projects
      .listEvidenceSources(project.id)
      .filter((s) => s.kind === "source_root")
      .map((s) => s.ref);
    const slug =
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "project";
    const packageId = `pkg:${slug}-${localIdPart(project.id).slice(-6).toLowerCase()}`;
    const last = host.state.db.prepare("SELECT MAX(version) AS v FROM packages WHERE package_id = ?").get(packageId) as
      { v: number | null } | undefined;
    const identity = JSON.parse(row.revision_json ?? "null") as RevisionIdentity;
    const outputDir = input.output_dir ?? defaultPackagesDirectory(host.home, localIdPart(project.id));
    // The exporter creates the directory only after its refusal checks: a refused export writes nothing.
    const completeness = loadSkbView(skbDir).completeness;
    const result = exportPackage({
      skbDir,
      outputDir,
      analyzedRoots: roots,
      ...(input.allow_in_repository ? { allowInRepository: true } : {}),
      packageId,
      packageVersion: (last?.v ?? 0) + 1,
      project: { system_id: `system:${slug}`, name: project.name },
      repository: repositoryBlock(identity, `local/${slug}`),
      analysis: {
        started_at: row.created_at.replace(/\.\d{3}Z$/, "Z"),
        finished_at: row.updated_at.replace(/\.\d{3}Z$/, "Z"),
        scope: { roots: ["."], excluded: (completeness?.excluded ?? []).map((e) => e.area).slice(0, 200) },
      },
      warningMarker: join(host.home, "export-warning-shown"),
      now: host.now,
    });
    if (result.status === "refused")
      throw new ServiceError("EXPORT_REFUSED", "conflict", result.message, SERVICE_ERRORS.EXPORT_REFUSED!.remediation, {
        reason: result.reason,
      });
    if (result.status === "invalid")
      throw new ServiceError(
        "PACKAGE_INVALID",
        "internal",
        "the package failed contract validation and was not published",
        SERVICE_ERRORS.PACKAGE_INVALID!.remediation,
        {
          issues: result.issues.slice(0, 20).map((i) => ({ code: i.code, rule: i.rule, message: i.message })),
        },
      );
    const manifestSha = `sha256:${createHash("sha256")
      .update(readFileSync(join(result.path, "manifest.json")))
      .digest("hex")}`;
    host.state.transaction(() => {
      host.state.db
        .prepare(
          "INSERT INTO packages (package_id, version, project_id, producer, path, manifest_sha256, created_at, updated_at) VALUES (?, ?, ?, 'SAA', ?, ?, ?, ?)",
        )
        .run(
          packageId,
          (last?.v ?? 0) + 1,
          project.id,
          result.path,
          manifestSha,
          host.now().toISOString(),
          host.now().toISOString(),
        );
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "export.created",
          target: `${packageId}@${(last?.v ?? 0) + 1}`,
          details: { run_id: input.run_id },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return {
      package_id: packageId,
      version: (last?.v ?? 0) + 1,
      path: result.path,
      manifest_sha256: manifestSha,
      ...(result.warning ? { warning: result.warning } : {}),
      notes: result.issues.filter((i) => i.severity !== "error").map((i) => i.message),
    };
  },
});

// ---------------------------------------------------------------- query tools (SAA §4.4, SAA-FR-015/017)

const RUN = { type: "object", additionalProperties: false, required: ["run_id"], properties: { run_id: ID } } as const;
const withRun = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  required: ["run_id", ...required],
  properties: { run_id: ID, ...properties },
});
const relsOf = (view: SkbView, id: string) => ({
  outgoing: view.relationships.filter((r) => r.from === id).map((r) => ({ type: r.type, to: r.to, status: r.status })),
  incoming: view.relationships
    .filter((r) => r.to === id)
    .map((r) => ({ type: r.type, from: r.from, status: r.status })),
});

const saaOverview = defineOperation<{ run_id: string }, unknown>({
  name: "saa.overview",
  title: "System overview",
  description:
    "What an analysis run found within the examined scope: boundaries, entity counts by kind, evidence profile, workflows by status, the best-ranked workflows and the open questions.",
  level: "none",
  effect: "read",
  input: RUN,
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    const counts: Record<string, number> = {};
    for (const e of view.entities) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return {
      run_id: input.run_id,
      count_scope: "within_examined_scope",
      revision: view.manifest.revision,
      boundaries: (view.stack?.boundaries ?? []).map((b) => ({
        id: b.id,
        kind: b.kind,
        frameworks: b.frameworks.map((f) => f.name),
      })),
      entities_by_kind: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      evidence_profile: { source_analysis: "available", runtime_observation: "unavailable" },
      workflows_by_status: view.completeness?.workflows_by_status ?? {},
      top_workflows: view.workflows
        .slice(0, 10)
        .map((w) => ({ id: w.id, category: w.category, discovery_status: w.discovery_status })),
      open_questions: view.gaps.filter((g) => g.requires_human_clarification).map((g) => g.id),
    };
  },
});

const saaSearch = defineOperation<{ run_id: string; query: string; kind?: string; limit?: number }, unknown>({
  name: "saa.search",
  title: "Search the system model",
  description: "Full-text search over entity names and descriptions of an analysis run, optionally one kind.",
  level: "none",
  effect: "read",
  input: withRun(
    {
      query: { type: "string", minLength: 1, maxLength: 200 },
      kind: { type: "string", pattern: "^[a-z][a-z_]{1,40}$" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    ["query"],
  ),
  run: ({ host }, input) => {
    skbOf(host, input.run_id);
    return {
      run_id: input.run_id,
      results: queryEntities(host.state.db, {
        run_id: input.run_id,
        text: input.query,
        ...(input.kind ? { kind: input.kind } : {}),
        limit: input.limit ?? 50,
      }),
    };
  },
});

const saaEntity = defineOperation<{ run_id: string; entity_id: string }, unknown>({
  name: "saa.entity",
  title: "Get an entity",
  description: "One entity of the system model with its relationships in both directions and the claims about it.",
  level: "none",
  effect: "read",
  input: withRun({ entity_id: ID }, ["entity_id"]),
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    const entity = view.entities.find((e) => e.id === input.entity_id);
    if (!entity) throw serviceError("NOT_FOUND", `no entity ${input.entity_id} in run ${input.run_id}`);
    return { entity, ...relsOf(view, entity.id), claims: view.claims.filter((c) => c.subject_entity_id === entity.id) };
  },
});

const saaEvidence = defineOperation<{ run_id: string; id: string }, unknown>({
  name: "saa.evidence",
  title: "Get evidence",
  description:
    "The evidence records an entity, relationship, claim, workflow or gap cites: source type, path and line range, file fingerprint and digest (excerpts are never stored).",
  level: "none",
  effect: "read",
  input: withRun({ id: ID }, ["id"]),
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    const subject =
      view.entities.find((e) => e.id === input.id) ??
      view.relationships.find((r) => r.id === input.id) ??
      view.claims.find((c) => c.id === input.id) ??
      view.workflows.find((w) => w.id === input.id) ??
      view.gaps.find((g) => g.id === input.id);
    if (!subject) throw serviceError("NOT_FOUND", `no record ${input.id} in run ${input.run_id}`);
    const ids = new Set((subject as { evidence_ids?: string[] }).evidence_ids ?? []);
    return {
      id: input.id,
      status: (subject as { status?: string }).status ?? null,
      evidence: view.evidence.filter((e) => ids.has(e.id)),
    };
  },
});

const saaApiContracts = defineOperation<{ run_id: string; api_id?: string }, unknown>({
  name: "saa.api_contracts",
  title: "API contracts",
  description: "Endpoints with their authentication and authorization checks, validating rules and error responses.",
  level: "none",
  effect: "read",
  input: withRun({ api_id: ID }),
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    const apis = view.entities.filter((e) => e.kind === "api" && (input.api_id === undefined || e.id === input.api_id));
    if (input.api_id && apis.length === 0) throw serviceError("NOT_FOUND", `no endpoint ${input.api_id}`);
    const to = (id: string, type: string) =>
      view.relationships.filter((r) => r.from === id && r.type === type).map((r) => r.to);
    return {
      run_id: input.run_id,
      endpoints: apis.map((a) => ({
        id: a.id,
        authenticates_with: to(a.id, "AUTHENTICATES_WITH"),
        authorizes_with: to(a.id, "AUTHORIZES_WITH"),
        validated_by: view.relationships.filter((r) => r.to === a.id && r.type === "VALIDATES").map((r) => r.from),
        error_responses: (a as { error_responses?: unknown[] }).error_responses ?? [],
        reads: to(a.id, "READS_FROM"),
        writes: to(a.id, "WRITES_TO"),
      })),
    };
  },
});

const saaDataModel = defineOperation<{ run_id: string }, unknown>({
  name: "saa.data_model",
  title: "Data model",
  description:
    "Tables, columns with constraints, domain entities, state machines and which code reads and writes them.",
  level: "none",
  effect: "read",
  input: RUN,
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    const of = (kind: string) => view.entities.filter((e) => e.kind === kind);
    return {
      run_id: input.run_id,
      tables: of("table").map((t) => t.id),
      columns: of("column"),
      entities: of("entity").map((e) => ({ id: e.id, ...relsOf(view, e.id) })),
      state_machines: of("state_machine"),
    };
  },
});

const saaDependencies = defineOperation<
  { run_id: string; entity_id: string; direction?: "out" | "in"; depth?: number },
  unknown
>({
  name: "saa.dependencies",
  title: "Dependencies and impact",
  description:
    "Modules and functions an entity depends on (`out`) or that depend on it (`in`, impact), following imports and calls up to a bounded depth.",
  level: "none",
  effect: "read",
  input: withRun(
    { entity_id: ID, direction: { enum: ["out", "in"] }, depth: { type: "integer", minimum: 1, maximum: 5 } },
    ["entity_id"],
  ),
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    if (!view.entities.some((e) => e.id === input.entity_id))
      throw serviceError("NOT_FOUND", `no entity ${input.entity_id}`);
    const out = (input.direction ?? "out") === "out";
    const edges = view.relationships.filter((r) => r.type === "IMPORTS" || r.type === "CALLS");
    const levels: Array<{ depth: number; ids: string[] }> = [];
    const seen = new Set([input.entity_id]);
    let frontier = [input.entity_id];
    for (let depth = 1; depth <= (input.depth ?? 1) && frontier.length > 0; depth++) {
      const next = [
        ...new Set(edges.filter((r) => frontier.includes(out ? r.from : r.to)).map((r) => (out ? r.to : r.from))),
      ]
        .filter((id) => !seen.has(id))
        .sort();
      next.forEach((id) => seen.add(id));
      if (next.length > 0) levels.push({ depth, ids: next });
      frontier = next;
    }
    return { entity_id: input.entity_id, direction: out ? "out" : "in", levels };
  },
});

const saaTestsFor = defineOperation<{ run_id: string; entity_id: string }, unknown>({
  name: "saa.tests_for",
  title: "Tests for an entity",
  description:
    "Test definitions that exercise an entity (and, for an endpoint, the rules that validate it). Test definitions show intent; no test result is examined.",
  level: "none",
  effect: "read",
  input: withRun({ entity_id: ID }, ["entity_id"]),
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    if (!view.entities.some((e) => e.id === input.entity_id))
      throw serviceError("NOT_FOUND", `no entity ${input.entity_id}`);
    const targets = new Set([
      input.entity_id,
      ...view.relationships.filter((r) => r.type === "VALIDATES" && r.to === input.entity_id).map((r) => r.from),
    ]);
    return {
      entity_id: input.entity_id,
      execution_status: "not_run",
      tests: view.relationships
        .filter((r) => r.type === "TESTS" && targets.has(r.to))
        .map((r) => ({ test: r.from, exercises: r.to, status: r.status })),
    };
  },
});

const saaUnknowns = defineOperation<{ run_id: string }, unknown>({
  name: "saa.unknowns",
  title: "Unknowns and contradictions",
  description:
    "What the run could not establish: open gaps by type, contradictions between documentation and code, questions needing a person, and the evidence that would help.",
  level: "none",
  effect: "read",
  input: RUN,
  run: ({ host }, input) => {
    const view = loadSkbView(skbOf(host, input.run_id));
    const open = view.gaps.filter((g) => g.status === "unresolved");
    return {
      run_id: input.run_id,
      gaps: open.map((g) => ({
        id: g.id,
        type: g.type,
        description: g.description,
        related: g.related_entity_ids ?? [],
      })),
      contradictions: open.filter((g) => g.type === "contradiction").map((g) => g.id),
      questions: open.filter((g) => g.requires_human_clarification).map((g) => g.id),
      improvement_suggestions: view.completeness?.improvement_suggestions ?? [],
    };
  },
});

export const SAA_OPERATIONS = [
  saaStart,
  saaAnalyze,
  saaStatus,
  workflowsList,
  workflowsShow,
  saaTrace,
  saaExport,
  saaOverview,
  saaSearch,
  saaEntity,
  saaEvidence,
  saaApiContracts,
  saaDataModel,
  saaDependencies,
  saaTestsFor,
  saaUnknowns,
];
