import { join, isAbsolute } from "node:path";
import { ERROR_CATALOG, type ContractIssue, type ErrorCode } from "@sys2qa/contract";
import { appendAudit, localIdPart, projectDirectory, type AuditAction } from "@sys2qa/platform";
import { PackageImportError, prepareImport, storeImport, type PreparedImport } from "@sys2qa/qaa-core";
import { serviceError, ServiceError, type ErrorKind } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const PATH = { type: "string", minLength: 1, maxLength: 4096 } as const;

interface PackageRow {
  package_id: string;
  version: number;
  project_id: string;
  producer: string;
  path: string;
  manifest_sha256: string;
  imported_from_import_id: string | null;
  created_at: string;
}

const issueView = (i: ContractIssue) => ({
  code: i.code,
  severity: i.severity,
  message: i.message,
  ...(i.artifact ? { artifact: i.artifact } : {}),
  ...(i.json_pointer ? { json_pointer: i.json_pointer } : {}),
  ...(i.rule ? { rule: i.rule } : {}),
});

/** A refused package as a service error: the contract's code and remediation, the stage, and the findings. */
function refusal(error: PackageImportError): ServiceError {
  if (error.code === "PACKAGE_VERSION_CONFLICT")
    return new ServiceError(
      error.code,
      "conflict",
      error.message,
      "A package version never changes: ask the producer for a new package version, or remove the project's copy first.",
    );
  const entry = ERROR_CATALOG[error.code as ErrorCode];
  const kind: ErrorKind = error.code === "PKG_NOT_FOUND" ? "not_found" : "invalid_input";
  return new ServiceError(
    error.code,
    kind,
    error.message,
    entry ? entry.remediation[0] : "Fix the listed findings and import again.",
    { stage: error.stage, issues: error.issues.slice(0, 50).map(issueView) },
  );
}

function view(prepared: PreparedImport) {
  return {
    provenance: prepared.provenance,
    artifacts: prepared.artifacts,
    stage: prepared.stage,
    markdown_only: prepared.markdownOnly,
    issues: prepared.issues.map(issueView),
  };
}

function rowsOf(host: Host, projectId: string): PackageRow[] {
  return host.state.db
    .prepare("SELECT * FROM packages WHERE project_id = ? ORDER BY package_id, version")
    .all(projectId) as PackageRow[];
}

const packageImport = defineOperation<{ project_id: string; path: string; language?: string }, unknown>({
  name: "package.import",
  title: "Import a Documentation Package",
  description:
    "Imports a package directory or ZIP archive into a project (QAA-FR-009): hostile paths and sizes are refused, the contract validates it in the PRD §13.10 order, the original is stored byte for byte next to the package, and its provenance is kept. A package from any producer is the system model; nothing is re-analyzed.",
  level: "L0",
  effect: "write",
  paths: (input) => [input.path],
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "path"],
    properties: {
      project_id: ID,
      path: PATH,
      language: { type: "string", pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" },
    },
  },
  run: ({ host, caller }, input) => {
    if (!isAbsolute(input.path))
      throw serviceError("INPUT_INVALID", "the package path must be absolute", { field: "path" });
    const project = host.projects.getProject(input.project_id);
    const audit = (action: AuditAction, details: Record<string, unknown>) =>
      appendAudit(
        host.state.db,
        { projectId: project.id, actor: caller.actor, action, target: project.id, details },
        { redactor: host.redactor, now: host.now },
      );

    let prepared: PreparedImport;
    try {
      prepared = prepareImport(input.path, input.language ? { language: input.language } : {});
    } catch (error) {
      if (!(error instanceof PackageImportError)) throw error;
      host.state.transaction(() => audit("package.import_refused", { code: error.code, stage: error.stage }));
      throw refusal(error);
    }
    const { provenance } = prepared;
    const existing = host.state.db
      .prepare("SELECT * FROM packages WHERE project_id = ? AND package_id = ? AND version = ?")
      .get(project.id, provenance.package_id, provenance.package_version) as PackageRow | undefined;
    if (existing && existing.manifest_sha256 !== prepared.manifestSha256)
      throw refusal(
        new PackageImportError(
          "PACKAGE_VERSION_CONFLICT",
          `a different ${provenance.package_id} version ${provenance.package_version} is already in this project`,
          "complete",
          [],
        ),
      );

    const importId = host.newId("import");
    const dir = projectDirectory(host.home, project.id);
    let stored;
    try {
      stored = existing
        ? { status: "unchanged" as const, packagePath: existing.path }
        : storeImport(prepared, {
            packagesDir: join(dir, "packages"),
            importDir: join(dir, "imports", localIdPart(importId)),
          });
    } catch (error) {
      if (error instanceof PackageImportError) throw refusal(error);
      throw error;
    }
    const producer = String(provenance.producer.name ?? "");
    host.state.transaction(() => {
      if (!existing) {
        const at = host.now().toISOString();
        host.state.db
          .prepare(
            "INSERT INTO packages (package_id, version, project_id, producer, path, manifest_sha256, imported_from_import_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            provenance.package_id,
            provenance.package_version,
            project.id,
            producer,
            stored.packagePath,
            prepared.manifestSha256,
            stored.status === "imported" ? importId : null,
            at,
            at,
          );
      }
      // The stored package is the project's evidence source: a project with only a package is in Mode D (SYS-001).
      if (
        !host.projects.listEvidenceSources(project.id).some((s) => s.kind === "package" && s.ref === stored.packagePath)
      )
        host.projects.addEvidenceSource(project.id, "package", stored.packagePath);
      audit("package.imported", {
        import_id: stored.status === "imported" ? importId : null,
        status: stored.status,
        package_id: provenance.package_id,
        version: provenance.package_version,
        producer,
        manifest_sha256: prepared.manifestSha256,
        original_sha256: prepared.originalSha256,
        source_kind: prepared.source.kind,
      });
    });
    return {
      status: stored.status,
      import_id: stored.status === "imported" ? importId : null,
      package: {
        package_id: provenance.package_id,
        version: provenance.package_version,
        producer,
        path: stored.packagePath,
        manifest_sha256: prepared.manifestSha256,
      },
      original: {
        kind: prepared.source.kind,
        sha256: prepared.originalSha256,
        path: "originalPath" in stored ? (stored.originalPath ?? null) : null,
      },
      evidence_mode: host.projects.evidenceMode(project.id),
      ...view(prepared),
    };
  },
});

const packageList = defineOperation<{ project_id: string }, unknown>({
  name: "package.list",
  title: "List a project's packages",
  description: "The packages of a project, exported or imported, with producer, version, manifest checksum and origin.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["project_id"], properties: { project_id: ID } },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    return {
      project_id: project.id,
      packages: rowsOf(host, project.id).map((r) => ({
        package_id: r.package_id,
        version: r.version,
        producer: r.producer,
        path: r.path,
        manifest_sha256: r.manifest_sha256,
        origin: r.imported_from_import_id ? "imported" : "exported",
        import_id: r.imported_from_import_id,
        stored_at: r.created_at,
      })),
    };
  },
});

const packageShow = defineOperation<{ project_id: string; package_id: string; version: number }, unknown>({
  name: "package.show",
  title: "Show a package's provenance",
  description:
    "Revalidates a stored package and shows its provenance (QAA-FR-012): package, schema and producer versions, repository identity and revision, observed environments, analysis status and times, evidence profile, languages, and its artifacts by role. A stored package that no longer validates is reported, never used.",
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
    const row = rowsOf(host, project.id).find((r) => r.package_id === input.package_id && r.version === input.version);
    if (!row) throw serviceError("NOT_FOUND", `no ${input.package_id} version ${input.version} in this project`);
    let prepared: PreparedImport;
    try {
      prepared = prepareImport(row.path);
    } catch (error) {
      if (error instanceof PackageImportError) throw refusal(error);
      throw error;
    }
    if (prepared.manifestSha256 !== row.manifest_sha256)
      throw new ServiceError(
        "PKG_CHECKSUM_MISMATCH",
        "invalid_input",
        "the stored package's manifest changed after it was stored",
        ERROR_CATALOG.PKG_CHECKSUM_MISMATCH.remediation[0],
      );
    return {
      package: {
        package_id: row.package_id,
        version: row.version,
        producer: row.producer,
        path: row.path,
        manifest_sha256: row.manifest_sha256,
        origin: row.imported_from_import_id ? "imported" : "exported",
        import_id: row.imported_from_import_id,
      },
      ...view(prepared),
    };
  },
});

export const PACKAGE_OPERATIONS = [packageImport, packageList, packageShow];
