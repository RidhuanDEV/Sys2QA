import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { CONTRACT_VERSION, validatePackage, type ContractIssue } from "@sys2qa/contract";
import { canonicalJson, syncDirectory, writeFileAtomic } from "@sys2qa/platform";
import { buildObservedModel, type DiscoveryObservations, type ObservedModel } from "./observed-model.js";

export const QAA_OBSERVER_VERSION = "0.1.0";

export interface ObservedPackageOptions {
  observations: DiscoveryObservations;
  /** Packages are written under `<outputDir>/<package>/<version>/`. */
  outputDir: string;
  /** `pkg:<name>`. */
  packageId: string;
  packageVersion: number;
  project: { system_id: string; name: string };
  environment: { base_url: string; classification: "development" | "staging"; read_only_submissions: boolean };
  /** Paths the scope declares (default `/`). */
  paths?: string[];
  /** Read-only submissions that happened, with who confirmed them (manifest `optional_actions_executed`). */
  optionalActions?: Array<{ action: string; approved_by: string; approved_at: string }>;
  now?: () => Date;
}

export type ObservedPackageResult =
  | {
      status: "exported";
      path: string;
      manifest: Record<string, unknown>;
      issues: ContractIssue[];
      summary: ObservedModel["summary"];
    }
  | { status: "refused"; reason: "package_version_exists" | "previous_package_unknown"; message: string }
  | { status: "invalid"; issues: ContractIssue[] };

/** What a browser observation can never establish (manifest `evidence_profile.cannot_establish`). */
const CANNOT_ESTABLISH = [
  "Backend implementation",
  "Data model",
  "Unlinked or unreachable routes",
  "Background jobs",
  "Complete authorization logic",
  "What submitting a form does, unless it was submitted read-only",
  "Intended business requirements",
];

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const seconds = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");

function filesOf(dir: string, base = dir): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) for (const [k, v] of filesOf(full, base)) out.set(k, v);
    else out.set(relative(base, full).split(sep).join("/"), readFileSync(full));
  }
  return out;
}

type Json = Record<string, unknown>;

/**
 * The observed-behavior document (`docs/en/05c-observed-behavior.md`): counts within the declared scope, what was not
 * submitted and why, and what remains unobserved. Built only from paths, identifiers and counts, never page text.
 */
function renderObservedBehavior(built: ObservedModel, obs: DiscoveryObservations, baseUrl: string): string {
  const model = built.model as {
    entities: Array<{ id: string; kind: string }>;
    workflows: Array<{
      id: string;
      name: string;
      discovery_status: string;
      unresolved_hops: Array<{ reason_code: string }>;
    }>;
    gaps: Array<{ id: string; type: string; description: string; related_entity_ids?: string[] }>;
  };
  const completeness = built.completeness as {
    forms_not_submitted: Array<{ form_id: string; reason: string }>;
    unexplored: Array<{ area: string; reason: string }>;
    excluded: Array<{ area: string; reason: string }>;
  };
  const host = new URL(baseUrl).host;
  const lines = [
    `# Observed behavior — ${host}`,
    "",
    `Observation window ${obs.started_at} – ${obs.finished_at} · environment \`${obs.environment_id}\` · ${built.summary.statement}`,
    "",
    "## Pages",
    "",
    ...model.entities.filter((e) => e.kind === "page").map((e) => `- \`${e.id.replace(/^page:observed:/, "")}\``),
    "",
    "## Candidate workflows",
    "",
    ...model.workflows.map(
      (w) =>
        `- \`${w.id}\` — ${w.discovery_status}${w.unresolved_hops.length > 0 ? ` (stops: ${w.unresolved_hops.map((h) => h.reason_code).join(", ")})` : ""}`,
    ),
    "",
    "## Forms not submitted",
    "",
    ...(completeness.forms_not_submitted.length > 0
      ? completeness.forms_not_submitted.map((f) => `- \`${f.form_id}\` — ${f.reason.replace(/_/g, " ")}`)
      : ["None."]),
    "",
    "## Not observed",
    "",
    ...model.gaps.map((g) => `- \`${g.id}\` (${g.type}): ${g.description}`),
    ...completeness.unexplored.map((u) => `- \`${u.area}\`: ${u.reason}`),
    ...completeness.excluded.map((u) => `- \`${u.area}\`: ${u.reason}`),
    "",
    `This evidence cannot establish: ${CANNOT_ESTABLISH.join("; ").toLowerCase()}.`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Publishes the observed model of one discovery walk as a Documentation Package with producer `QAA` (QAA-FR-116):
 * `runtime_observation` available, `source_analysis` unavailable, no repository, the observed environment and its
 * window. The bytes are validated with the same contract validator as SAA packages before they are moved into place;
 * a package that fails is not published. Versions are immutable.
 */
export function exportObservedPackage(options: ObservedPackageOptions): ObservedPackageResult {
  const now = options.now ?? (() => new Date());
  const local = options.packageId.replace(/^pkg:/, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(local)) throw new Error(`invalid package ID ${options.packageId}`);
  if (!Number.isInteger(options.packageVersion) || options.packageVersion < 1)
    throw new Error("invalid package version");
  const target = join(options.outputDir, local, String(options.packageVersion));
  if (existsSync(target))
    return {
      status: "refused",
      reason: "package_version_exists",
      message: `${options.packageId} version ${options.packageVersion} already exists; packages are immutable, publish a new version.`,
    };
  let previous: { package_version: number; revision: string } | undefined;
  if (options.packageVersion > 1) {
    const found = existsSync(join(options.outputDir, local))
      ? readdirSync(join(options.outputDir, local))
          .filter((n) => /^\d+$/.test(n) && Number(n) < options.packageVersion)
          .map(Number)
          .sort((a, b) => b - a)
          .map((v) => join(options.outputDir, local, String(v), "manifest.json"))
          .find((p) => existsSync(p))
      : undefined;
    if (!found)
      return {
        status: "refused",
        reason: "previous_package_unknown",
        message: `${options.packageId} version ${options.packageVersion} needs its previous version in the output directory.`,
      };
    const prior = JSON.parse(readFileSync(found, "utf8")) as {
      package_version: number;
      observed_environments?: Array<{ environment_id: string; observed_from: string; observed_to: string }>;
    };
    const env = prior.observed_environments?.[0];
    previous = {
      package_version: prior.package_version,
      revision: env ? `${env.environment_id}@${env.observed_from}/${env.observed_to}` : "unknown",
    };
  }

  const obs = options.observations;
  const built = buildObservedModel(obs, { system_id: options.project.system_id, paths: options.paths ?? ["/"] });
  const model = built.model as { entities: Json[]; gaps: Json[]; coverage: Json[] };
  const langs = obs.pages.map((p) => p.lang).filter((l): l is string => typeof l === "string");
  const locale =
    [...new Set(langs)].sort((a, b) => langs.filter((l) => l === b).length - langs.filter((l) => l === a).length)[0] ??
    "und";
  const levelMax = options.environment.read_only_submissions ? "L2r" : "L2";
  const status =
    obs.status === "completed" || obs.status === "completed_with_limitations"
      ? obs.status
      : obs.status === "stopped"
        ? "partial"
        : "failed";
  const completeness = built.completeness as {
    examined: { hosts: string[]; paths: string[] };
    forms_not_submitted: unknown[];
    unexplored: Array<{ area: string; reason: string }>;
    excluded: Array<{ area: string; reason: string }>;
  };
  const limitations = [
    `${completeness.forms_not_submitted.length} forms recorded but not submitted`,
    ...completeness.unexplored.map((u) => `${u.area}: ${u.reason}`),
    ...completeness.excluded.map((u) => `${u.area}: ${u.reason}`),
  ].slice(0, 100);
  const coverageSummary: Record<string, string> = {
    routes_pages: "partial",
    workflows: "partial",
    roles_permissions: "unobservable",
    data_model: "unobservable",
    integrations: "unobservable",
    state_transitions: "unobservable",
    ...(model.entities.some((e) => e.kind === "business_rule") ? { business_rules: "partial" } : {}),
  };

  const generatedAt = seconds(now().toISOString());
  mkdirSync(options.outputDir, { recursive: true });
  const staging = join(options.outputDir, `.staging-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    const artifacts: Json[] = [];
    const put = (path: string, text: string, entry: Json) => {
      const full = join(staging, ...path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileAtomic(full, text);
      artifacts.push({ ...entry, path, sha256: sha256(text) });
    };
    const json = (value: unknown) => `${canonicalJson(value)}\n`;
    const contract = { media_type: "application/json", schema_version: CONTRACT_VERSION };
    put("system-model.json", json(built.model), {
      id: "system-model",
      role: "system_model",
      ...contract,
      required: true,
    });
    put("evidence-index.json", json(built.evidence_index), {
      id: "evidence-index",
      role: "evidence_index",
      ...contract,
      required: true,
    });
    put("completeness-report.json", json(built.completeness), {
      id: "completeness-report",
      role: "completeness_report",
      ...contract,
    });
    put("docs/en/05c-observed-behavior.md", renderObservedBehavior(built, obs, options.environment.base_url), {
      id: "doc-observed-behavior-en",
      role: "observed_behavior",
      media_type: "text/markdown",
      language: "en",
    });
    const manifest = {
      contract: "sys2qa.documentation-package",
      package_schema_version: CONTRACT_VERSION,
      package_id: options.packageId,
      package_version: options.packageVersion,
      ...(previous ? { previous_package: previous } : {}),
      producer: { name: "QAA", version: QAA_OBSERVER_VERSION, component: "runtime-discovery" },
      project: options.project,
      evidence_profile: {
        source_analysis: "unavailable",
        runtime_observation: "available",
        documentation_import: "unavailable",
        revision_correspondence: "not_applicable",
        cannot_establish: CANNOT_ESTABLISH,
      },
      repository: null,
      observed_environments: [
        {
          environment_id: obs.environment_id,
          base_url: options.environment.base_url,
          classification: options.environment.classification,
          observed_from: obs.started_at,
          observed_to: obs.finished_at,
          target_app_locale: locale,
          deployed_revision: { value: null, source: "unknown" },
          permission_level_max: levelMax,
          read_only_submissions: options.environment.read_only_submissions,
        },
      ],
      analysis: {
        run_id: obs.job_id,
        status,
        permission_level_max: levelMax,
        optional_actions_executed: options.optionalActions ?? [],
        started_at: obs.started_at,
        finished_at: obs.finished_at,
        scope: completeness.examined,
        limitations,
      },
      generated_at: generatedAt,
      languages: { documentation: ["en"], default: "en", machine_text: "en" },
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
    return { status: "exported", path: target, manifest, issues: validation.issues, summary: built.summary };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
