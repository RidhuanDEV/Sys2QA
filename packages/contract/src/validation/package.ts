import { createHash } from "node:crypto";
import type { ContractSchemaName } from "../schemas.js";
import { issue, result, type ContractIssue, type ValidationResult } from "./errors.js";
import {
  consistencyIssues,
  evidenceStrengthIssues,
  manifestProfileIssues,
  referenceIssues,
  type PackageDocuments,
} from "./model-rules.js";
import { detectSecrets } from "./secrets.js";
import {
  asArray,
  asObject,
  asString,
  isObject,
  majorOf,
  minorOf,
  ptr,
  schemaIssues,
  type JsonObject,
} from "./shared.js";

/** A package as exchanged between producer and consumer: POSIX-relative path → bytes. Reading directories or archives is the importer's job. */
export interface PackageInput {
  files: ReadonlyMap<string, Uint8Array>;
}

export interface PackageValidationOptions {
  /** Contract major version the consumer supports (Contract Specification §10). */
  supportedMajor?: number;
  /** Minor version the consumer was built with; newer minors produce PKG_MINOR_NEWER (info). */
  knownMinor?: number;
}

/** Validation stages in PRD §13.10 order. Validation stops after the first stage that reports an error. */
export type PackageStage =
  | "manifest"
  | "analysis"
  | "artifacts"
  | "artifact_schemas"
  | "secrets"
  | "consistency"
  | "references"
  | "evidence_strength"
  | "complete";

export interface PackageValidationResult extends ValidationResult {
  /** Stage at which validation stopped ("complete" when every stage ran). */
  stage: PackageStage;
  /** True when the package has Markdown but no structured artifacts (fallback import, CON-016). */
  markdownOnly: boolean;
  documents?: PackageDocuments;
}

const ROLE_SCHEMAS: Readonly<Record<string, ContractSchemaName>> = {
  system_model: "system-model",
  evidence_index: "evidence-index",
  diff_report: "diff-report",
  completeness_report: "completeness-report",
  correlation_report: "correlation-report",
};
const REQUIRED_ROLES = ["system_model", "evidence_index"] as const;

const decoder = new TextDecoder("utf-8", { fatal: false });
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function validatePackage(input: PackageInput, options: PackageValidationOptions = {}): PackageValidationResult {
  const supportedMajor = options.supportedMajor ?? 1;
  const knownMinor = options.knownMinor ?? 0;
  const issues: ContractIssue[] = [];
  let markdownOnly = false;
  const done = (stage: PackageStage, documents?: PackageDocuments): PackageValidationResult => {
    const out: PackageValidationResult = { ...result(issues), stage, markdownOnly };
    if (documents) out.documents = documents;
    return out;
  };
  const hasErrors = () => issues.some((i) => i.severity === "error");
  const versionCheck = (version: unknown, artifact: string, pointer: string) => {
    const major = majorOf(version);
    if (major !== undefined && major !== supportedMajor) {
      issues.push(
        issue(
          "PKG_SCHEMA_UNSUPPORTED_MAJOR",
          `${artifact} uses contract major ${major}; supported major is ${supportedMajor}`,
          { artifact, json_pointer: pointer, details: { version, supported_major: supportedMajor } },
        ),
      );
    } else if (major !== undefined && (minorOf(version) ?? 0) > knownMinor) {
      issues.push(
        issue("PKG_MINOR_NEWER", `${artifact} uses a newer minor contract version ${String(version)}`, {
          artifact,
          json_pointer: pointer,
        }),
      );
    }
  };

  // 1. manifest ----------------------------------------------------------------
  const manifestBytes = input.files.get("manifest.json");
  if (!manifestBytes) {
    issues.push(issue("PKG_MANIFEST_INVALID", "manifest.json is missing", { artifact: "manifest", json_pointer: "/" }));
    return done("manifest");
  }
  const manifestJson = parseJson(manifestBytes);
  if (!isObject(manifestJson)) {
    issues.push(
      issue("PKG_MANIFEST_INVALID", "manifest.json is not a JSON object", { artifact: "manifest", json_pointer: "/" }),
    );
    return done("manifest");
  }
  const manifest = manifestJson;
  versionCheck(manifest.package_schema_version, "manifest", "/package_schema_version");
  if (hasErrors()) return done("manifest");
  issues.push(...manifestProfileIssues(manifest));
  if (hasErrors()) return done("manifest");
  issues.push(...schemaIssues("package-manifest", manifest, "PKG_MANIFEST_INVALID", "manifest"));
  if (hasErrors()) return done("manifest");

  // 2. analysis status -----------------------------------------------------------
  const status = asObject(manifest.analysis).status;
  if (status === "failed" || status === "cancelled") {
    issues.push(
      issue("PKG_ANALYSIS_FAILED", `analysis status is ${status}`, {
        artifact: "manifest",
        json_pointer: "/analysis/status",
      }),
    );
    return done("analysis");
  }
  if (status === "partial")
    issues.push(
      issue("PKG_ANALYSIS_PARTIAL", "analysis status is partial", {
        artifact: "manifest",
        json_pointer: "/analysis/status",
      }),
    );

  // 3. artifacts: presence, checksums, unlisted files ----------------------------
  const artifacts = asArray(manifest.artifacts).map(asObject);
  const listed = new Set<string>(["manifest.json"]);
  artifacts.forEach((a, i) => {
    const path = asString(a.path) ?? "";
    listed.add(path);
    const bytes = input.files.get(path);
    if (!bytes) {
      issues.push(
        issue("PKG_ARTIFACT_MISSING", `artifact ${String(a.id)} (${path}) is listed but missing`, {
          artifact: asString(a.id) ?? path,
          json_pointer: ptr("artifacts", i),
        }),
      );
    } else if (sha256(bytes) !== a.sha256) {
      issues.push(
        issue("PKG_CHECKSUM_MISMATCH", `artifact ${String(a.id)} does not match its sha256`, {
          artifact: asString(a.id) ?? path,
          json_pointer: ptr("artifacts", i, "sha256"),
        }),
      );
    }
  });
  const roles = new Set(artifacts.map((a) => asString(a.role)));
  const hasMarkdown = artifacts.some((a) => a.media_type === "text/markdown");
  if (!roles.has("system_model") && !roles.has("evidence_index") && hasMarkdown) {
    markdownOnly = true;
    issues.push(
      issue("PKG_MARKDOWN_ONLY", "package has documentation but no structured artifacts", {
        artifact: "manifest",
        json_pointer: "/artifacts",
      }),
    );
  } else {
    for (const role of REQUIRED_ROLES) {
      if (!roles.has(role))
        issues.push(
          issue("PKG_ARTIFACT_MISSING", `required artifact role ${role} is missing`, {
            artifact: "manifest",
            json_pointer: "/artifacts",
            details: { role },
          }),
        );
    }
    if (!hasMarkdown)
      issues.push(
        issue("PKG_ARTIFACT_MISSING", "at least one Markdown documentation artifact is required", {
          artifact: "manifest",
          json_pointer: "/artifacts",
          details: { role: "documentation" },
        }),
      );
  }
  for (const path of [...input.files.keys()].sort()) {
    if (!listed.has(path))
      issues.push(issue("PKG_UNLISTED_FILE", `file ${path} is not listed in the manifest`, { details: { path } }));
  }
  if (hasErrors() || markdownOnly) return done("artifacts");

  // 4. structured artifacts: parse, version, schema --------------------------------
  const parsed = new Map<string, JsonObject>();
  for (const role of Object.keys(ROLE_SCHEMAS)) {
    const matches = artifacts.filter((a) => a.role === role);
    if (matches.length > 1)
      issues.push(
        issue("PKG_ARTIFACT_INVALID", `more than one artifact has role ${role}`, {
          artifact: "manifest",
          json_pointer: "/artifacts",
        }),
      );
    const entry = matches[0];
    if (!entry) continue;
    const id = asString(entry.id) ?? role;
    const document = parseJson(input.files.get(asString(entry.path) ?? "") ?? new Uint8Array());
    if (!isObject(document)) {
      issues.push(
        issue("PKG_ARTIFACT_INVALID", `artifact ${id} is not a JSON object`, { artifact: id, json_pointer: "/" }),
      );
      continue;
    }
    versionCheck(entry.schema_version, id, ptr("artifacts", artifacts.indexOf(entry), "schema_version"));
    versionCheck(document.schema_version, id, "/schema_version");
    issues.push(...schemaIssues(ROLE_SCHEMAS[role] as ContractSchemaName, document, "PKG_ARTIFACT_INVALID", id));
    parsed.set(role, document);
  }
  if (hasErrors()) return done("artifact_schemas");

  // 5. secrets and excerpt policy (CR-060) ------------------------------------------
  scanSecrets(input, artifacts, issues);
  const redaction = asObject(manifest.redaction);
  const maxExcerpt = typeof redaction.max_excerpt_chars === "number" ? redaction.max_excerpt_chars : Infinity;
  asArray(parsed.get("evidence_index")?.evidence)
    .map(asObject)
    .forEach((e, i) => {
      const excerpt = asString(e.excerpt);
      if (excerpt === undefined) return;
      if (redaction.excerpts !== "short_excerpts" || excerpt.length > maxExcerpt) {
        issues.push(
          issue(
            "PKG_SECRET_SUSPECTED",
            `evidence ${String(e.id)} excerpt violates the redaction policy (${String(redaction.excerpts)}, max ${String(redaction.max_excerpt_chars)} chars)`,
            { rule: "CR-060", artifact: "evidence-index", json_pointer: ptr("evidence", i, "excerpt") },
          ),
        );
      }
    });
  if (hasErrors()) return done("secrets");

  const documents: PackageDocuments = {
    manifest,
    model: parsed.get("system_model") as JsonObject,
    evidenceIndex: parsed.get("evidence_index") as JsonObject,
  };
  const completeness = parsed.get("completeness_report");
  const diff = parsed.get("diff_report");
  if (completeness) documents.completeness = completeness;
  if (diff) documents.diff = diff;

  // 6. consistency (CR-011, CR-020, CR-021) -------------------------------------------
  issues.push(...consistencyIssues(documents));
  if (hasErrors()) return done("consistency", documents);

  // 7. references (CR-010) ----------------------------------------------------------
  const references = referenceIssues(documents);
  issues.push(...references.issues);
  if (hasErrors()) return done("references", documents);

  // 8. evidence strength (CR-001, CR-002, CR-030, CR-042) ------------------------------
  issues.push(...evidenceStrengthIssues(documents, references.index));
  if (hasErrors()) return done("evidence_strength", documents);

  // warnings that do not block import
  const revision = asObject(asObject(manifest.repository).revision);
  if (revision.kind === "content_fingerprint" || revision.worktree_dirty === true) {
    issues.push(
      issue("PKG_DIRTY_OR_NON_GIT", "package was analyzed from a dirty worktree or a non-Git source", {
        artifact: "manifest",
        json_pointer: "/repository/revision",
      }),
    );
  }
  return done("complete", documents);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

function scanSecrets(input: PackageInput, artifacts: JsonObject[], issues: ContractIssue[]): void {
  const report = (artifact: string, pointer: string, detector: string) =>
    issues.push(
      issue("PKG_SECRET_SUSPECTED", `possible ${detector} in ${artifact} at ${pointer}`, {
        rule: "CR-060",
        artifact,
        json_pointer: pointer,
        details: { detector },
      }),
    );
  const targets: Array<{ id: string; path: string }> = [
    { id: "manifest", path: "manifest.json" },
    ...artifacts.map((a) => ({ id: asString(a.id) ?? "", path: asString(a.path) ?? "" })),
  ];
  for (const { id, path } of targets) {
    const bytes = input.files.get(path);
    if (!bytes) continue;
    const text = decoder.decode(bytes);
    if (path.endsWith(".json")) {
      walkStrings(parseJson(bytes), "", (pointer, value) => {
        for (const finding of detectSecrets(value)) report(id, pointer || "/", finding.detector);
      });
    } else {
      for (const finding of detectSecrets(text)) {
        const line = text.slice(0, finding.index).split("\n").length;
        report(id, `line ${line}`, finding.detector);
      }
    }
  }
}

function walkStrings(value: unknown, pointer: string, visit: (pointer: string, value: string) => void): void {
  if (typeof value === "string") visit(pointer, value);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${pointer}/${i}`, visit));
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      walkStrings(k, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, visit);
      walkStrings(v, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, visit);
    }
  }
}
