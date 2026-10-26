import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CONTRACT_VERSION, validatePackage, type ContractIssue, type Gap } from "@sys2qa/contract";
import { canonicalJson, syncDirectory, writeFileAtomic } from "@sys2qa/platform";
import { renderDocumentation, type RenderOptions } from "../docs/render.js";
import { loadSkbView, type SkbView } from "../docs/view.js";
import type { RevisionIdentity } from "../intake/revision.js";

export const SAA_VERSION = "0.1.0";

/** Categories of the coverage summary (contract `coverage_category`) and the entity kinds that evidence each. */
const COVERAGE: Record<string, (v: SkbView) => boolean> = {
  modules: (v) => v.entities.some((e) => e.kind === "module"),
  routes_pages: (v) => v.entities.some((e) => e.kind === "page" || e.kind === "api"),
  roles_permissions: (v) => v.entities.some((e) => e.kind === "actor_role" || e.kind === "permission"),
  business_rules: (v) => v.entities.some((e) => e.kind === "business_rule"),
  workflows: (v) => v.workflows.length > 0,
  state_transitions: (v) => v.entities.some((e) => e.kind === "state_machine"),
  api_contracts: (v) => v.entities.some((e) => e.kind === "api"),
  data_model: (v) => v.entities.some((e) => e.kind === "table" || e.kind === "entity"),
  integrations: (v) => v.entities.some((e) => e.kind === "integration" || e.kind === "queue_topic"),
  error_paths: (v) => v.workflows.some((w) => w.branches.length > 0),
};

export interface ExportOptions {
  /** The SKB run to export (`<home>/projects/<project>/skb/<run>/`). */
  skbDir: string;
  /** Directory packages are written under: `<outputDir>/<package>/<version>/`. */
  outputDir: string;
  /** The analyzed roots; output inside one is refused unless `allowInRepository` (SAA-FR-036). */
  analyzedRoots: readonly string[];
  allowInRepository?: boolean;
  /** `pkg:<name>`. */
  packageId: string;
  packageVersion: number;
  /** The version this one follows: its number and analyzed revision (commit or fingerprint). */
  previous?: { package_version: number; revision: string };
  project: { system_id: string; name: string };
  /** Repository identity and revision (IMP-102), or null for a plain directory. */
  repository: Record<string, unknown> | null;
  analysis: { started_at: string; finished_at: string; scope: { roots: string[]; excluded: string[] } };
  documentation?: RenderOptions;
  /**
   * A marker file recording that the user has seen the export warning (SEC-016). When it is missing, the result
   * carries the warning and the marker is written.
   */
  warningMarker?: string;
  now?: () => Date;
}

export type ExportResult =
  | {
      status: "exported";
      path: string;
      manifest: Record<string, unknown>;
      warning?: ExportWarning;
      issues: ContractIssue[];
    }
  | {
      status: "refused";
      reason: "output_inside_analyzed_root" | "package_version_exists" | "previous_package_unknown";
      message: string;
    }
  | { status: "invalid"; issues: ContractIssue[] };

export interface ExportWarning {
  en: string;
  id: string;
}

/** SEC-016: what a Documentation Package reveals, shown on the first export. */
export const EXPORT_WARNING: ExportWarning = {
  en: "This package describes the system's internal structure (modules, endpoints, data model, roles, integrations and gaps). Share it only with people allowed to see that topology. Secrets are redacted and excerpts are digests only.",
  id: "Paket ini menjelaskan struktur internal sistem (modul, endpoint, model data, peran, integrasi, dan gap). Bagikan hanya kepada orang yang boleh melihat topologi tersebut. Rahasia diredaksi dan kutipan hanya berupa digest.",
};

const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** True when `inner` is `outer` or below it, after resolving links on the existing part of `inner`. */
function isInside(inner: string, outer: string): boolean {
  const real = (p: string) => {
    let current = resolve(p);
    const rest: string[] = [];
    while (!existsSync(current)) {
      rest.unshift(current.slice(dirname(current).length + 1));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return join(realpathSync(current), ...rest);
  };
  const rel = relative(real(outer), real(inner));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

function filesOf(dir: string, base = dir): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) for (const [k, v] of filesOf(path, base)) files.set(k, v);
    else files.set(relative(base, path).split(sep).join("/"), new Uint8Array(readFileSync(path)));
  }
  return files;
}

/**
 * Exports a Documentation Package from one SKB run (IMP-117, SAA-FR-029, SAA-FR-036, SEC-016, PRD §13): the system
 * model, evidence index, completeness report and the rendered documents are written to a staging directory with
 * their checksums in the manifest, the staged bytes are validated with the contract library (`validatePackage`, the
 * conformance suite both producers share), and only a valid package is moved into place in one rename. A package
 * version is never overwritten, output inside an analyzed root is refused unless explicitly allowed, and the first
 * export carries a warning about what the package reveals.
 */
export function exportPackage(options: ExportOptions): ExportResult {
  const now = options.now ?? (() => new Date());
  const local = options.packageId.replace(/^pkg:/, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(local)) throw new Error(`invalid package ID ${options.packageId}`);
  if (!Number.isInteger(options.packageVersion) || options.packageVersion < 1)
    throw new Error("invalid package version");
  if (!options.allowInRepository && options.analyzedRoots.some((root) => isInside(options.outputDir, root)))
    return {
      status: "refused",
      reason: "output_inside_analyzed_root",
      message: `${options.outputDir} is inside an analyzed root; choose an output directory outside the repository or allow in-repository output explicitly.`,
    };
  const target = join(options.outputDir, local, String(options.packageVersion));
  if (existsSync(target))
    return {
      status: "refused",
      reason: "package_version_exists",
      message: `${options.packageId} version ${options.packageVersion} already exists; packages are immutable, export a new version.`,
    };

  // A later version names the one before it (contract: previous_package); found in the output directory unless given.
  let previous = options.previous;
  if (!previous && options.packageVersion > 1) {
    const versions = existsSync(join(options.outputDir, local))
      ? readdirSync(join(options.outputDir, local))
          .filter((n) => /^\d+$/.test(n) && Number(n) < options.packageVersion)
          .map(Number)
          .sort((a, b) => b - a)
      : [];
    const found = versions
      .map((v) => join(options.outputDir, local, String(v), "manifest.json"))
      .find((p) => existsSync(p));
    if (!found)
      return {
        status: "refused",
        reason: "previous_package_unknown",
        message: `${options.packageId} version ${options.packageVersion} needs its previous version; export version 1 first or name the previous package.`,
      };
    const prior = JSON.parse(readFileSync(found, "utf8")) as {
      package_version: number;
      repository?: { revision?: { value?: string } } | null;
    };
    previous = { package_version: prior.package_version, revision: prior.repository?.revision?.value ?? "unknown" };
  }

  const view = loadSkbView(options.skbDir);
  const revision = view.manifest.revision;
  const generatedAt = now()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  // Coverage summary; a category with nothing found is `absent` and explained by a gap (CR-030).
  const coverageSummary: Record<string, string> = {};
  const gaps: Gap[] = [...view.gaps];
  // Modules are complete only when every file was analyzed and no inventoried language lacked an adapter.
  const partialFiles =
    view.coverage.some((c) => c.status !== "analyzed") || (view.completeness?.unavailable_adapters.length ?? 0) > 0;
  for (const [category, present] of Object.entries(COVERAGE)) {
    if (present(view)) coverageSummary[category] = category === "modules" && !partialFiles ? "complete" : "partial";
    else {
      coverageSummary[category] = "absent";
      gaps.push({
        id: `gap:coverage:${category}`,
        type: "missing_evidence",
        description: `Nothing of category ${category} was found within the examined scope; it may be absent, outside the scope, or beyond the available analyzers.`,
        requires_human_clarification: false,
        status: "unresolved",
        coverage_category: category as NonNullable<Gap["coverage_category"]>,
      });
    }
  }

  const systemModel = {
    schema_version: CONTRACT_VERSION,
    system_id: options.project.system_id,
    producer: "SAA",
    revision,
    analysis_run_id: view.manifest.run_id,
    machine_text_language: "en",
    entities: view.entities,
    relationships: view.relationships,
    component_traces: view.component_traces,
    workflows: view.workflows,
    claims: view.claims,
    gaps,
    coverage: view.coverage,
  };
  const evidenceIndex = { schema_version: CONTRACT_VERSION, revision, evidence: view.evidence };
  const completeness = view.completeness;
  const documents = renderDocumentation(view, options.documentation);
  const languages = [...new Set(documents.map((d) => d.language))];

  const staging = join(options.outputDir, `.staging-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    const artifacts: Array<Record<string, unknown>> = [];
    const put = (path: string, text: string, entry: Record<string, unknown>) => {
      const full = join(staging, ...path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileAtomic(full, text);
      artifacts.push({ ...entry, path, sha256: sha256(text) });
    };
    const json = (value: unknown) => `${canonicalJson(value)}\n`;
    put("system-model.json", json(systemModel), {
      id: "system-model",
      role: "system_model",
      media_type: "application/json",
      schema_version: CONTRACT_VERSION,
      required: true,
    });
    put("evidence-index.json", json(evidenceIndex), {
      id: "evidence-index",
      role: "evidence_index",
      media_type: "application/json",
      schema_version: CONTRACT_VERSION,
      required: true,
    });
    if (completeness)
      put("completeness-report.json", json(completeness), {
        id: "completeness-report",
        role: "completeness_report",
        media_type: "application/json",
        schema_version: CONTRACT_VERSION,
      });
    const docId = (path: string) =>
      `doc-${path
        .replace(/^docs\//, "")
        .replace(/\.md$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`.slice(0, 128);
    for (const doc of documents)
      put(doc.path, doc.markdown, {
        id: docId(doc.path),
        role: doc.role,
        media_type: "text/markdown",
        language: doc.language,
        ...(doc.language !== "en" && languages.includes("en")
          ? { translation_of: docId(doc.path.replace(/^docs\/[^/]+\//, "docs/en/")), machine_translated: false }
          : {}),
      });

    const status =
      gaps.some((g) => g.status === "unresolved") || view.coverage.some((c) => c.status !== "analyzed")
        ? "completed_with_limitations"
        : "completed";
    const manifest = {
      contract: "sys2qa.documentation-package",
      package_schema_version: CONTRACT_VERSION,
      package_id: options.packageId,
      package_version: options.packageVersion,
      ...(previous ? { previous_package: previous } : {}),
      producer: {
        name: "SAA",
        version: SAA_VERSION,
        adapters: (view.run?.adapters ?? []).map((a) => ({
          id: a.id,
          version: a.version,
          support_level: a.support_level ?? 2,
        })),
      },
      project: options.project,
      evidence_profile: {
        source_analysis: "available",
        runtime_observation: "unavailable",
        documentation_import: "unavailable",
        revision_correspondence: "not_applicable",
        cannot_establish: [
          "Behavior of any running environment",
          "The deployed configuration",
          "What external providers do with requests",
        ],
      },
      repository: options.repository,
      analysis: {
        run_id: view.manifest.run_id,
        profile: view.run?.profile ?? "standard",
        status,
        permission_level_max: "L0",
        optional_actions_executed: [],
        started_at: options.analysis.started_at,
        finished_at: options.analysis.finished_at,
        scope: options.analysis.scope,
        limitations: (completeness?.unavailable_adapters ?? []).map((u) => `${u.adapter}: ${u.reason}`),
      },
      generated_at: generatedAt,
      languages: {
        documentation: languages,
        default: languages.includes("en") ? "en" : languages[0],
        machine_text: "en",
      },
      coverage_summary: coverageSummary,
      redaction: { secrets: "redacted", excerpts: "digest_only", max_excerpt_chars: 0 },
      artifacts: artifacts.sort((a, b) => String(a.path).localeCompare(String(b.path))),
    };
    writeFileAtomic(join(staging, "manifest.json"), json(manifest));

    // Validate the bytes as written, exactly as a consumer would read them.
    const validation = validatePackage({ files: filesOf(staging) });
    if (!validation.ok || validation.stage !== "complete") {
      rmSync(staging, { recursive: true, force: true });
      return { status: "invalid", issues: validation.issues };
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
    syncDirectory(dirname(target));

    let warning: ExportWarning | undefined;
    if (options.warningMarker && !existsSync(options.warningMarker)) {
      warning = EXPORT_WARNING;
      mkdirSync(dirname(options.warningMarker), { recursive: true });
      writeFileSync(options.warningMarker, `${generatedAt}\n`);
    }
    return { status: "exported", path: target, manifest, issues: validation.issues, ...(warning ? { warning } : {}) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The manifest's repository block from the revision identity (IMP-102): the local Git remote when there is one,
 * otherwise the identity the user gave the project (PRD §13.8).
 */
export function repositoryBlock(identity: RevisionIdentity, userIdentity: string): Record<string, unknown> {
  return {
    provider: identity.provider,
    identity: identity.identity ?? userIdentity,
    identity_source: identity.identity ? "local_git_remote" : "user_supplied",
    revision: identity.revision,
    ...(identity.branch_hint ? { branch_hint: identity.branch_hint } : {}),
  };
}

/** The default export location: inside the Sys2QA home, never inside an analyzed repository (SAA-FR-036). */
export function defaultPackagesDirectory(home: string, projectDirectoryName: string): string {
  return join(home, "projects", projectDirectoryName, "packages");
}
