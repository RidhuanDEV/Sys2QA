import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { CONTRACT_VERSION, validatePackage } from "@sys2qa/contract";
import {
  checkHealth,
  collectMetrics,
  OPERATION_LEVELS,
  PERMISSION_LEVELS,
  renderPrometheus,
  type Operation as PolicyOperation,
} from "@sys2qa/platform";
import { runDoctor } from "./doctor.js";
import { serviceError } from "./errors.js";
import { defineOperation, type Operation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const LEVELS = PERMISSION_LEVELS.filter((l) => l !== "L5");

export const PRODUCT_VERSION = "0.0.0";

const systemInfo = defineOperation<Record<string, never>, unknown>({
  name: "system.info",
  title: "System information",
  description: "Versions, supported languages, model provider disclosure and administrator settings.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  run: ({ host }) => ({
    product: "sys2qa",
    version: PRODUCT_VERSION,
    contract_version: CONTRACT_VERSION,
    locales: host.glossary.locales(),
    glossaries: host.glossary.locales().map((l) => host.glossary.reference(l)),
    llm: host.llm.disclosure(),
    settings: host.projects.settings(),
  }),
});

const projectCreate = defineOperation<{ name: string; languages?: string[] }, unknown>({
  name: "project.create",
  title: "Create a project",
  description: "Creates a project. Nothing about the system is asked; evidence is added afterwards (SYS-002).",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
      languages: { type: "array", minItems: 1, items: { type: "string", pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" } },
    },
  },
  run: ({ host, caller }, input) =>
    host.projects.createProject({
      name: input.name,
      ...(input.languages ? { languages: input.languages } : {}),
      actor: caller.actor,
    }),
});

const projectList = defineOperation<Record<string, never>, unknown>({
  name: "project.list",
  title: "List projects",
  description: "Lists projects with their starting mode.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  run: ({ host }) =>
    (host.state.db.prepare("SELECT id FROM projects ORDER BY created_at, id").all() as Array<{ id: string }>).map(
      (r) => ({
        ...host.projects.getProject(r.id),
        evidence_mode: host.projects.evidenceMode(r.id),
      }),
    ),
});

const projectGet = defineOperation<{ project_id: string }, unknown>({
  name: "project.get",
  title: "Show a project",
  description: "A project with its evidence sources and starting mode.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["project_id"], properties: { project_id: ID } },
  run: ({ host }, input) => ({
    ...host.projects.getProject(input.project_id),
    evidence_mode: host.projects.evidenceMode(input.project_id),
    sources: host.projects.listEvidenceSources(input.project_id),
  }),
});

const projectAddSource = defineOperation<
  { project_id: string; kind: "source_root" | "environment" | "package"; ref: string },
  unknown
>({
  name: "project.add_source",
  title: "Add evidence",
  description: "Adds a local source directory, an environment URL or a package to a project (SYS-001).",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "kind", "ref"],
    properties: {
      project_id: ID,
      kind: { enum: ["source_root", "environment", "package"] },
      ref: { type: "string", minLength: 1, maxLength: 4096 },
    },
  },
  run: ({ host }, input) => {
    if (input.kind !== "environment" && !isAbsolute(input.ref))
      throw serviceError("INPUT_INVALID", "local paths must be absolute", { field: "ref" });
    return host.projects.addEvidenceSource(input.project_id, input.kind, input.ref);
  },
});

const projectDeclare = defineOperation<
  {
    source_id: string;
    declared_by: string;
    operation_level: (typeof LEVELS)[number];
    source_roots?: string[];
    allow_state_changing_tests?: boolean;
    prohibitions?: Record<string, string[]>;
  },
  unknown
>({
  name: "project.declare",
  title: "Record an authorization declaration",
  description:
    "Records who declares, what is in scope, the operation level and prohibitions (SEC-005). Self-declared; not verified (MD-3).",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "declared_by", "operation_level"],
    properties: {
      source_id: ID,
      declared_by: { type: "string", minLength: 1, maxLength: 200 },
      operation_level: { enum: LEVELS },
      source_roots: { type: "array", items: { type: "string", minLength: 1 } },
      allow_state_changing_tests: { type: "boolean" },
      prohibitions: {
        type: "object",
        additionalProperties: false,
        properties: {
          paths: { type: "array", items: { type: "string" } },
          url_prefixes: { type: "array", items: { type: "string" } },
          operations: { type: "array", items: { enum: Object.keys(OPERATION_LEVELS) } },
          notes: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  run: ({ host }, input) =>
    host.projects.declare(input.source_id, {
      declaredBy: input.declared_by,
      operationLevel: input.operation_level as Exclude<(typeof LEVELS)[number], never>,
      ...(input.source_roots ? { sourceRoots: input.source_roots } : {}),
      ...(input.allow_state_changing_tests !== undefined
        ? { allowStateChangingTests: input.allow_state_changing_tests }
        : {}),
      ...(input.prohibitions ? { prohibitions: input.prohibitions as never } : {}),
    }),
});

const projectConfigureEnvironment = defineOperation<
  {
    source_id: string;
    base_url: string;
    classification: "development" | "staging" | "production";
    allowed_hosts: string[];
    path_prefixes?: string[];
    local_owner_mode?: boolean;
  },
  unknown
>({
  name: "project.configure_environment",
  title: "Configure an environment",
  description:
    "Sets the base URL, classification, allowed hosts and path scope of an environment (QAA-FR-002). Requires a declaration.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "base_url", "classification", "allowed_hosts"],
    properties: {
      source_id: ID,
      base_url: { type: "string", minLength: 8, maxLength: 2048 },
      classification: { enum: ["development", "staging", "production"] },
      allowed_hosts: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 260 } },
      path_prefixes: { type: "array", minItems: 1, items: { type: "string", pattern: "^/" } },
      local_owner_mode: { type: "boolean" },
    },
  },
  run: ({ host, caller }, input) =>
    host.projects.configureEnvironment(
      input.source_id,
      {
        baseUrl: input.base_url,
        classification: input.classification,
        allowedHosts: input.allowed_hosts,
        ...(input.path_prefixes ? { pathPrefixes: input.path_prefixes } : {}),
        ...(input.local_owner_mode !== undefined ? { localOwnerMode: input.local_owner_mode } : {}),
      },
      caller.actor,
    ),
});

const policyCheck = defineOperation<
  { source_id: string; operation: PolicyOperation; target_path?: string; target_url?: string },
  unknown
>({
  name: "policy.check",
  title: "Check an operation against policy",
  description: "Returns the policy decision for an operation on an evidence source, without performing it.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "operation"],
    properties: {
      source_id: ID,
      operation: { enum: Object.keys(OPERATION_LEVELS) },
      target_path: { type: "string" },
      target_url: { type: "string" },
    },
  },
  run: ({ host }, input) => {
    const target =
      input.target_path !== undefined
        ? { kind: "path" as const, path: input.target_path }
        : input.target_url !== undefined
          ? { kind: "url" as const, url: input.target_url }
          : undefined;
    return host.projects.authorize(input.source_id, input.operation, target);
  },
});

const systemMetrics = defineOperation<{ format?: "json" | "prometheus" }, unknown>({
  name: "system.metrics",
  title: "Metrics",
  description:
    "Queue depth, job outcomes and durations, stuck jobs, worker crashes, model usage and resource use (OBS-001, QAA-FR-103).",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, properties: { format: { enum: ["json", "prometheus"] } } },
  run: ({ host }, input) => {
    const metrics = collectMetrics({
      db: host.state.db,
      jobs: host.jobs,
      now: host.now,
      stateDbPath: join(host.home, "state.db"),
    });
    return input.format === "prometheus" ? { format: "prometheus", text: renderPrometheus(metrics) } : metrics;
  },
});

const systemHealth = defineOperation<Record<string, never>, unknown>({
  name: "system.health",
  title: "Health",
  description: "State integrity, schema version, audit chain, stuck jobs and disk space (OBS-004).",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  run: ({ host }) => checkHealth({ db: host.state.db, jobs: host.jobs, now: host.now, home: host.home }),
});

const systemSetSetting = defineOperation<
  { key: "l4_enabled" | "local_owner_mode_enabled" | "telemetry_enabled"; value: boolean },
  unknown
>({
  name: "system.set_setting",
  title: "Change an administrator setting",
  description:
    "Turns repository code execution (L4), local owner mode or anonymous aggregate telemetry on or off. All are off by default. Telemetry sends only counts and versions, never source, secrets, paths, IDs or knowledge-base content (OBS-005). Every change is audited.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: {
      key: { enum: ["l4_enabled", "local_owner_mode_enabled", "telemetry_enabled"] },
      value: { type: "boolean" },
    },
  },
  run: ({ host, caller }, input) => host.projects.setSetting(input.key, input.value, caller.actor),
});

const systemConfig = defineOperation<Record<string, never>, unknown>({
  name: "system.config",
  title: "Effective configuration",
  description:
    "The effective configuration, where each setting came from, and what the model provider receives (SEC-018).",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  run: ({ host }) => ({
    file: host.config.file,
    config: host.config.config,
    sources: host.config.sources,
    llm_disclosure: host.llm.disclosure(),
  }),
});

const systemDoctor = defineOperation<Record<string, never>, unknown>({
  name: "system.doctor",
  title: "Check prerequisites",
  description:
    "Node.js, SQLite driver, home directory, disk space, Git, configuration, model provider, browser runtime and container runtime (NFR-007).",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  run: ({ host }) => runDoctor({ home: host.home }),
});

const secretPut = defineOperation<{ project_id: string; name: string; value: string }, unknown>({
  name: "secret.put",
  title: "Store a credential",
  description:
    "Stores a credential in the secret store and returns its `secretref:` reference; the value is never stored in state, logs or packages (SEC-011). Not available through MCP.",
  level: "none",
  effect: "write",
  interfaces: ["cli", "api", "test"],
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "name", "value"],
    properties: {
      project_id: ID,
      name: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
      value: { type: "string", minLength: 1, maxLength: 65536 },
    },
  },
  run: async ({ host, caller }, input) =>
    (await host.secrets()).put(input.project_id, input.name, input.value, caller.actor),
});

const secretList = defineOperation<{ project_id: string }, unknown>({
  name: "secret.list",
  title: "List credential references",
  description: "References and names of a project's credentials; never values.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["project_id"], properties: { project_id: ID } },
  run: ({ host }, input) =>
    host.state.db
      .prepare("SELECT ref, name, backend, created_at FROM secret_refs WHERE project_id = ? ORDER BY name")
      .all(input.project_id),
});

const secretRemove = defineOperation<{ ref: string }, unknown>({
  name: "secret.remove",
  title: "Remove a credential",
  description: "Deletes a credential from the secret store; audited.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["ref"],
    properties: { ref: { type: "string", pattern: "^secretref:" } },
  },
  run: async ({ host, caller }, input) => {
    await (await host.secrets()).remove(input.ref, caller.actor);
    return { removed: input.ref };
  },
});

const MAX_PACKAGE_FILES = 10_000;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

const packageValidate = defineOperation<{ path: string }, unknown>({
  name: "package.validate",
  title: "Validate a Documentation Package",
  description: "Runs the contract's package validation (PRD §13.10) on a package directory and reports every finding.",
  level: "L0",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
  },
  run: (_context, input) => {
    if (!isAbsolute(input.path))
      throw serviceError("INPUT_INVALID", "the package path must be absolute", { field: "path" });
    const files = new Map<string, Uint8Array>();
    let bytes = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        // Symbolic links are never followed inside a package (SEC-001); the file is simply absent and reported as missing.
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(path);
        else {
          bytes += stat.size;
          if (files.size >= MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES)
            throw serviceError(
              "INPUT_INVALID",
              `the package exceeds ${MAX_PACKAGE_FILES} files or ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`,
            );
          files.set(relative(input.path, path).split("\\").join("/"), new Uint8Array(readFileSync(path)));
        }
      }
    };
    try {
      walk(input.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw serviceError("NOT_FOUND", "no package directory at the given path", { field: "path" });
      throw error;
    }
    const result = validatePackage({ files });
    return { ok: result.ok, stage: result.stage, markdown_only: result.markdownOnly, issues: result.issues };
  },
});

export const OPERATIONS: ReadonlyArray<Operation<never, unknown>> = [
  systemInfo,
  systemMetrics,
  systemHealth,
  systemSetSetting,
  systemConfig,
  systemDoctor,
  secretPut,
  secretList,
  secretRemove,
  projectCreate,
  projectList,
  projectGet,
  projectAddSource,
  projectDeclare,
  projectConfigureEnvironment,
  policyCheck,
  packageValidate,
] as ReadonlyArray<Operation<never, unknown>>;
