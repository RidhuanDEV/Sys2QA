import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { CONTRACT_VERSION, validatePackage } from "@sys2qa/contract";
import { OPERATION_LEVELS, PERMISSION_LEVELS, type Operation as PolicyOperation } from "@sys2qa/platform";
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
  projectCreate,
  projectList,
  projectGet,
  projectAddSource,
  projectDeclare,
  projectConfigureEnvironment,
  policyCheck,
  packageValidate,
] as ReadonlyArray<Operation<never, unknown>>;
