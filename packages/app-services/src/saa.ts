import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  appendAudit,
  indexSkbRun,
  localIdPart,
  projectDirectory,
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
        structure.gaps.some((g) => g.status === "unresolved") || structure.coverage.some((c) => c.status !== "analyzed")
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
    mkdirSync(outputDir, { recursive: true });
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

export const SAA_OPERATIONS = [saaStart, saaAnalyze, saaStatus, workflowsList, workflowsShow, saaTrace, saaExport];
