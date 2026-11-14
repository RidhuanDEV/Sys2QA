import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { validatePackage, type ContractIssue, type PackageStage } from "@sys2qa/contract";
import { syncDirectory, writeFileAtomic } from "@sys2qa/platform";
import { PackageQuery } from "@sys2qa/system-model";
import { DEFAULT_IMPORT_LIMITS, FileCollector, ImportRefusal, readZip, type ImportLimits } from "./archive.js";

const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** An artifact as the manifest lists it; QAA finds artifacts by role, never by file name (CON-011). */
export interface ImportedArtifact {
  id: string;
  role: string;
  path: string;
  media_type: string;
  language?: string;
  schema_version?: string;
  sha256: string;
}

/** What QAA keeps visible about where a package comes from (QAA-FR-012). */
export interface PackageProvenance {
  package_id: string;
  package_version: number;
  package_schema_version: string;
  producer: Record<string, unknown>;
  project: Record<string, unknown> | null;
  repository: Record<string, unknown> | null;
  observed_environments: unknown[] | null;
  analysis: Record<string, unknown> | null;
  generated_at: string | null;
  evidence_profile: Record<string, unknown> | null;
  languages: Record<string, unknown> | null;
  coverage_summary: Record<string, unknown> | null;
}

export interface PreparedImport {
  source: { path: string; kind: "archive" | "directory" };
  /** Every file as read (before any top-level folder is unwrapped), for the byte-for-byte original (CON-010). */
  originalFiles: ReadonlyMap<string, Uint8Array>;
  /** The archive's own bytes when the source is an archive. */
  originalArchive?: Uint8Array;
  /** sha256 of the archive, or of the sorted `path NUL sha256` lines of a directory's files. */
  originalSha256: string;
  /** The package's files, relative to its manifest. */
  files: ReadonlyMap<string, Uint8Array>;
  manifestSha256: string;
  provenance: PackageProvenance;
  artifacts: ImportedArtifact[];
  stage: PackageStage;
  markdownOnly: boolean;
  /** Warnings and info from validation and import (errors refuse the import). */
  issues: ContractIssue[];
}

/** A package the importer refuses: the contract code, the stage and the findings, never a detected secret value. */
export class PackageImportError extends Error {
  override readonly name = "PackageImportError";
  constructor(
    readonly code: string,
    message: string,
    readonly stage: PackageStage | "read",
    readonly issues: ContractIssue[],
  ) {
    super(message);
  }
}

function readDirectory(root: string, limits: ImportLimits): Map<string, Uint8Array> {
  const collector = new FileCollector(limits);
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      // A link could point anywhere on the machine: never followed (SEC-001, threat T-13).
      if (stat.isSymbolicLink()) throw new ImportRefusal("PKG_PATH_UNSAFE", "symbolic link", relative);
      if (stat.isDirectory()) walk(path, relative);
      else if (stat.isFile()) {
        collector.admit(relative, stat.size);
        collector.put(relative, new Uint8Array(readFileSync(path)));
      } else throw new ImportRefusal("PKG_PATH_UNSAFE", "not a regular file", relative);
    }
  };
  walk(root, "");
  return collector.files;
}

/** Archives often wrap the package in one folder; the manifest's folder is the package root. */
function unwrap(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.has("manifest.json")) return new Map(files);
  const tops = new Set([...files.keys()].map((k) => k.split("/")[0]!));
  const [top] = tops;
  if (tops.size !== 1 || !files.has(`${top}/manifest.json`)) return new Map(files);
  return new Map([...files].map(([k, v]) => [k.slice(top!.length + 1), v]));
}

function treeDigest(files: ReadonlyMap<string, Uint8Array>): string {
  return sha256(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => `${path}\0${sha256(bytes)}\n`)
      .join(""),
  );
}

const record = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Reads, checks and validates a Documentation Package from a directory or a ZIP archive (IMP-201, QAA-FR-009,
 * SEC-021): hostile paths and sizes are refused before anything is parsed, then the contract library validates it in
 * the PRD §13.10 order, stopping at the first error. Nothing is written; `storeImport` stores an accepted package.
 * The package is never analyzed further here: QAA uses it as the system model (QAA-FR-010).
 */
export function prepareImport(
  path: string,
  options: { limits?: ImportLimits; language?: string } = {},
): PreparedImport {
  const limits = options.limits ?? DEFAULT_IMPORT_LIMITS;
  let originalFiles: Map<string, Uint8Array>;
  let originalArchive: Uint8Array | undefined;
  let kind: "archive" | "directory";
  try {
    if (!existsSync(path)) throw new ImportRefusal("PKG_NOT_FOUND", "no file or directory at the package path");
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (lstatSync(path).isSymbolicLink()) throw new ImportRefusal("PKG_PATH_UNSAFE", "symbolic link", basename(path));
      kind = "directory";
      originalFiles = readDirectory(path, limits);
    } else if (stat.isFile()) {
      // The compressed archive is bounded too: no more than the total uncompressed limit.
      if (stat.size > limits.maxTotalBytes)
        throw new ImportRefusal("PKG_TOO_LARGE", `an archive larger than ${limits.maxTotalBytes} bytes`);
      kind = "archive";
      originalArchive = new Uint8Array(readFileSync(path));
      originalFiles = readZip(originalArchive, limits);
    } else throw new ImportRefusal("PKG_NOT_FOUND", "the package path is neither a directory nor an archive");
  } catch (error) {
    if (error instanceof ImportRefusal)
      throw new PackageImportError(error.code, error.reason, "read", [
        {
          code: error.code,
          severity: "error",
          message: error.entry ? `${error.reason}: ${error.entry}` : error.reason,
        } as ContractIssue,
      ]);
    throw new PackageImportError("PKG_NOT_FOUND", "the package could not be read", "read", []);
  }

  const files = unwrap(originalFiles);
  const validation = validatePackage({ files });
  const errors = validation.issues.filter((i) => i.severity === "error");
  if (errors.length > 0)
    throw new PackageImportError(errors[0]!.code, errors[0]!.message, validation.stage, validation.issues.slice(0, 50));

  const manifestBytes = files.get("manifest.json")!;
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
  const artifacts = ((manifest.artifacts as Array<Record<string, unknown>>) ?? []).map((a) => ({
    id: String(a.id),
    role: String(a.role),
    path: String(a.path),
    media_type: String(a.media_type),
    ...(typeof a.language === "string" ? { language: a.language } : {}),
    ...(typeof a.schema_version === "string" ? { schema_version: a.schema_version } : {}),
    sha256: String(a.sha256),
  }));
  const issues = [...validation.issues];
  // Language selection (PRD §19.4): a missing documentation language is reported, and the default is used.
  if (
    options.language &&
    artifacts.some((a) => a.media_type === "text/markdown") &&
    !artifacts.some((a) => a.media_type === "text/markdown" && a.language === options.language)
  )
    issues.push({
      code: "PKG_LANGUAGE_UNAVAILABLE",
      severity: "info",
      message: `no documentation in ${options.language}; the package's default language is used`,
      artifact: "manifest",
      json_pointer: "/languages/documentation",
    } as ContractIssue);

  return {
    source: { path, kind },
    originalFiles,
    ...(originalArchive ? { originalArchive } : {}),
    originalSha256: originalArchive ? sha256(originalArchive) : treeDigest(originalFiles),
    files,
    manifestSha256: sha256(manifestBytes),
    provenance: {
      package_id: String(manifest.package_id),
      package_version: Number(manifest.package_version),
      package_schema_version: String(manifest.package_schema_version),
      producer: record(manifest.producer) ?? {},
      project: record(manifest.project),
      repository: record(manifest.repository),
      observed_environments: Array.isArray(manifest.observed_environments) ? manifest.observed_environments : null,
      analysis: record(manifest.analysis),
      generated_at: typeof manifest.generated_at === "string" ? manifest.generated_at : null,
      evidence_profile: record(manifest.evidence_profile),
      languages: record(manifest.languages),
      coverage_summary: record(manifest.coverage_summary),
    },
    artifacts,
    stage: validation.stage,
    markdownOnly: validation.markdownOnly,
    issues,
  };
}

export interface StoredImport {
  /** `imported`: newly stored; `unchanged`: the same package version (same manifest) was already stored. */
  status: "imported" | "unchanged";
  packagePath: string;
  originalPath?: string;
}

function writeTree(dir: string, files: ReadonlyMap<string, Uint8Array>): void {
  for (const [path, bytes] of files) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileAtomic(full, bytes);
  }
}

/**
 * Stores an accepted package (Data Model §2): the original byte for byte under `imports/<import-id>/original/`
 * (CON-010), and the package's listed files under `packages/<package>/<version>/`, written to a staging directory and
 * moved into place in one rename. A package version is immutable: the same manifest again is `unchanged`; a different
 * one under the same ID and version is refused by the caller.
 */
export function storeImport(
  prepared: PreparedImport,
  target: { packagesDir: string; importDir: string },
): StoredImport {
  const local = prepared.provenance.package_id.replace(/^pkg:/, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(local))
    throw new PackageImportError("PKG_MANIFEST_INVALID", "the package ID cannot name a directory", "manifest", []);
  const packagePath = join(target.packagesDir, local, String(prepared.provenance.package_version));
  if (existsSync(join(packagePath, "manifest.json"))) {
    const existing = sha256(readFileSync(join(packagePath, "manifest.json")));
    if (existing === prepared.manifestSha256) return { status: "unchanged", packagePath };
    throw new PackageImportError(
      "PACKAGE_VERSION_CONFLICT",
      `a different ${prepared.provenance.package_id} version ${prepared.provenance.package_version} is already stored`,
      "complete",
      [],
    );
  }

  const originalPath = join(target.importDir, "original");
  mkdirSync(originalPath, { recursive: true });
  if (prepared.originalArchive)
    writeFileAtomic(join(originalPath, basename(prepared.source.path)), prepared.originalArchive);
  else writeTree(originalPath, prepared.originalFiles);
  syncDirectory(originalPath);

  // Only what the manifest lists becomes the package; unlisted files stay in the original (PKG_UNLISTED_FILE).
  const listed = new Map<string, Uint8Array>([["manifest.json", prepared.files.get("manifest.json")!]]);
  for (const a of prepared.artifacts) {
    const bytes = prepared.files.get(a.path);
    if (bytes) listed.set(a.path, bytes);
  }
  mkdirSync(dirname(packagePath), { recursive: true });
  const staging = join(dirname(packagePath), `.staging-${randomBytes(6).toString("hex")}`);
  try {
    writeTree(staging, listed);
    renameSync(staging, packagePath);
    syncDirectory(dirname(packagePath));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { status: "imported", packagePath, originalPath };
}

/** The structured model of an accepted package for queries; none for a Markdown-only package (CON-016). */
export function packageModel(prepared: PreparedImport): PackageQuery | undefined {
  return prepared.markdownOnly ? undefined : new PackageQuery(prepared.files);
}
