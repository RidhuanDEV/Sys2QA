import { basename } from "node:path";
import type { InventoryEntry } from "../intake/inventory.js";
import type { RootSandbox } from "../intake/sandbox.js";
import { readForAnalysis } from "../intake/secrets.js";

/** How deeply a language or framework is analyzed (SAA-FR-047 vocabulary). */
export type SupportLevel = "analyzed" | "scanned" | "unsupported";

/**
 * Support levels come from the adapter support matrix (IMP-105). Until an adapter declares a language or framework,
 * it is only scanned, so nothing is claimed that no adapter can deliver.
 */
export interface SupportLookup {
  language(language: string): SupportLevel;
  framework(framework: string): SupportLevel;
}

export const SCAN_ONLY: SupportLookup = { language: () => "scanned", framework: () => "unsupported" };

/**
 * `workspace_root`: a manifest that declares workspace members. `member`: declared by a workspace manifest, or the
 * only project manifest at a root. `nested`: a manifest that no workspace declares (a candidate, inferred).
 * `implicit`: files outside every manifest directory, grouped under their root (inferred).
 */
export type BoundaryKind = "workspace_root" | "member" | "nested" | "implicit";

export interface Framework {
  name: string;
  /** Version range as written in the manifest. */
  version?: string;
  /** The manifest that declares it. */
  manifest: string;
  support: SupportLevel;
}

export interface ProjectBoundary {
  /** `project:<path>` (`project:.` for a root), prefixed `root<n>/` for roots after the first. Deterministic. */
  id: string;
  name: string;
  root: number;
  /** Root-relative directory, `""` for the root. */
  path: string;
  kind: BoundaryKind;
  status: "source_verified" | "inferred";
  /** Required when `status` is `inferred` (CR-001). */
  confidence_rationale?: string;
  ecosystems: string[];
  manifests: string[];
  frameworks: Framework[];
  /** Included files per language inside this boundary (deeper boundaries excluded). */
  languages: Record<string, number>;
  files: number;
}

/** A capability that could not be applied, and what it costs the analysis (SAA-FR-020). */
export interface Limitation {
  area: string;
  status: "unsupported" | "skipped" | "failed" | "partial";
  reason: string;
  consequence: string;
  boundary?: string;
}

export interface StackReport {
  boundaries: ProjectBoundary[];
  languages: Array<{ language: string; files: number; support: SupportLevel }>;
  /** Included files of no known format, by extension (or file name), reported as unknown (SAA-FR-003). */
  unknown: Record<string, number>;
  limitations: Limitation[];
}

const MANIFEST_ECOSYSTEM: ReadonlyArray<[RegExp, string]> = [
  [/^package\.json$/, "npm"],
  [/^deno\.json$/, "deno"],
  [/^(pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|pipfile)$/, "python"],
  [/^go\.mod$/, "go"],
  [/^cargo\.toml$/, "cargo"],
  [/^pom\.xml$/, "maven"],
  [/^(build|settings)\.gradle(\.kts)?$/, "gradle"],
  [/^composer\.json$/, "composer"],
  [/^gemfile$/, "bundler"],
  [/^pubspec\.yaml$/, "pub"],
  [/\.(csproj|fsproj|vbproj)$/, "dotnet"],
];
/** Workspace and orchestration manifests: they declare members, they are not projects themselves. */
const WORKSPACE_ONLY = new Set(["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "go.work"]);

/** Frameworks recognized from npm dependencies (OD-06: depth comes from adapters, not from this list). */
const NPM_FRAMEWORKS: Readonly<Record<string, string>> = {
  express: "express",
  fastify: "fastify",
  koa: "koa",
  "@nestjs/core": "nestjs",
  "@hapi/hapi": "hapi",
  next: "nextjs",
  react: "react",
  "react-router": "react-router",
  "react-router-dom": "react-router",
  vue: "vue",
  "vue-router": "vue-router",
  nuxt: "nuxt",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  "@angular/core": "angular",
  "@remix-run/react": "remix",
  "@prisma/client": "prisma",
  prisma: "prisma",
  typeorm: "typeorm",
  sequelize: "sequelize",
  "drizzle-orm": "drizzle",
  mongoose: "mongoose",
  knex: "knex",
  "node-cron": "node-cron",
  bullmq: "bullmq",
  bull: "bull",
  kafkajs: "kafkajs",
  amqplib: "amqplib",
};
/** Frameworks recognized by name in other manifests (detected only; no adapter in the first release). */
const OTHER_FRAMEWORKS: ReadonlyArray<[string, RegExp, string]> = [
  ["python", /\bdjango\b/i, "django"],
  ["python", /\bflask\b/i, "flask"],
  ["python", /\bfastapi\b/i, "fastapi"],
  ["go", /github\.com\/gin-gonic\/gin\b/, "gin"],
  ["go", /github\.com\/labstack\/echo\b/, "echo"],
  ["maven", /spring-boot/, "spring-boot"],
  ["gradle", /spring-boot/, "spring-boot"],
  ["composer", /laravel\/framework/, "laravel"],
  ["bundler", /['"]rails['"]/, "rails"],
];

const MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * Project boundaries and the language/framework inventory (SAA-FR-002, SAA-FR-003, SAA-FR-020). Every directory with a
 * project manifest is a candidate boundary; workspace manifests (`package.json` `workspaces`, `pnpm-workspace.yaml`,
 * `lerna.json`) decide which candidates are declared members. Boundaries are never merged: each file belongs to the
 * deepest boundary that contains it. Manifests are read through `readForAnalysis`, so secrets are redacted first.
 */
export async function detectStack(
  sandbox: RootSandbox,
  included: ReadonlyArray<InventoryEntry>,
  support: SupportLookup = SCAN_ONLY,
): Promise<StackReport> {
  const limitations: Limitation[] = [];
  const rootNames = sandbox.roots.map((r) => basename(r));
  const candidates = new Map<string, Candidate>();
  const workspaceGlobs = new Map<number, Array<{ base: string; patterns: string[] }>>();

  for (const entry of included) {
    if (!entry.manifest) continue;
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const lower = name.toLowerCase();
    const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const ecosystem = MANIFEST_ECOSYSTEM.find(([pattern]) => pattern.test(lower))?.[1];
    const isWorkspaceFile = WORKSPACE_ONLY.has(lower);
    if (ecosystem === undefined && !isWorkspaceFile) continue;
    const key = `${entry.root}:${dir}`;
    const candidate = candidates.get(key) ?? newCandidate(entry.root, dir);
    candidates.set(key, candidate);
    candidate.manifests.push(entry.path);

    const read = await readForAnalysis(sandbox, entry, MANIFEST_MAX_BYTES).catch(() => undefined);
    const text = read?.kind === "text" ? read.text : undefined;
    if (text === undefined) {
      limitations.push({
        area: `manifest:${entry.path}`,
        status: "failed",
        reason: read?.kind === "too_large" ? "manifest larger than 1 MiB" : "manifest could not be read",
        consequence: "the project it describes is identified by its directory only; its dependencies are unknown",
      });
      continue;
    }
    if (ecosystem !== undefined) candidate.ecosystems.add(ecosystem);
    if (lower === "package.json") {
      let manifest: PackageJson;
      try {
        manifest = JSON.parse(text) as PackageJson;
      } catch {
        limitations.push({
          area: `manifest:${entry.path}`,
          status: "failed",
          reason: "package.json is not valid JSON",
          consequence: "the package name, workspaces and dependencies of this directory are unknown",
        });
        continue;
      }
      if (typeof manifest.name === "string" && manifest.name !== "") candidate.name ??= manifest.name;
      const members = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
      if (Array.isArray(members)) addGlobs(workspaceGlobs, entry.root, dir, members, candidate);
      for (const deps of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies])
        for (const [pkg, version] of Object.entries(deps ?? {})) {
          const framework = NPM_FRAMEWORKS[pkg];
          if (framework && !candidate.frameworks.has(framework))
            candidate.frameworks.set(framework, {
              name: framework,
              ...(typeof version === "string" ? { version } : {}),
              manifest: entry.path,
              support: support.framework(framework),
            });
        }
    } else if (lower === "pnpm-workspace.yaml") {
      addGlobs(workspaceGlobs, entry.root, dir, yamlList(text, "packages"), candidate);
    } else if (lower === "lerna.json") {
      try {
        const packages = (JSON.parse(text) as { packages?: unknown }).packages;
        if (Array.isArray(packages)) addGlobs(workspaceGlobs, entry.root, dir, packages, candidate);
      } catch {
        // An unreadable lerna.json declares nothing; package.json or pnpm-workspace.yaml may still do so.
      }
    } else if (ecosystem !== undefined) {
      for (const [eco, pattern, framework] of OTHER_FRAMEWORKS)
        if (eco === ecosystem && pattern.test(text) && !candidate.frameworks.has(framework))
          candidate.frameworks.set(framework, {
            name: framework,
            manifest: entry.path,
            support: support.framework(framework),
          });
    }
  }

  // Classify candidates.
  const declared = (c: Candidate) =>
    (workspaceGlobs.get(c.root) ?? []).some(
      ({ base, patterns }) => c.path !== base && isUnder(c.path, base) && matchesWorkspace(rel(c.path, base), patterns),
    );
  const boundaries: ProjectBoundary[] = [];
  const rootsWithProject = new Set<number>();
  for (const c of [...candidates.values()].sort(byLocation)) {
    let kind: BoundaryKind;
    let rationale: string | undefined;
    if (c.declaresWorkspace) kind = "workspace_root";
    else if (c.ecosystems.size === 0)
      continue; // a lone nx.json or turbo.json declares no project
    else if (declared(c)) kind = "member";
    else if (c.path === "" || !hasWorkspaceRoot(workspaceGlobs, c.root)) {
      // Without a workspace declaration, every manifest directory stands on its own.
      kind = c.path === "" ? "member" : "nested";
      if (kind === "nested") rationale = "manifest in a subdirectory; no workspace manifest declares project members";
    } else {
      kind = "nested";
      rationale = "manifest outside the members its workspace declares (for example a fixture or an example)";
    }
    if (c.path === "") rootsWithProject.add(c.root);
    boundaries.push(boundary(c, kind, rationale, rootNames));
  }

  // Files outside every boundary form an implicit boundary per root.
  const assignments = assign(boundaries, included);
  for (const [rootIndex, count] of assignments.orphans) {
    if (rootsWithProject.has(rootIndex)) continue;
    const implicit = boundary(
      newCandidate(rootIndex, ""),
      "implicit",
      "no project manifest at the root; its files are grouped under the root directory",
      rootNames,
    );
    boundaries.push(implicit);
    const counts = assignments.orphanLanguages.get(rootIndex) ?? {};
    implicit.languages = counts;
    implicit.files = count;
  }
  boundaries.sort(byLocation);

  // Language inventory with support levels, and unknown formats.
  const languageFiles = new Map<string, number>();
  const unknown: Record<string, number> = {};
  for (const entry of included) {
    if (entry.language) languageFiles.set(entry.language, (languageFiles.get(entry.language) ?? 0) + 1);
    else if (entry.category === "other") {
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      const dot = name.lastIndexOf(".");
      const key = dot > 0 ? name.slice(dot).toLowerCase() : name;
      unknown[key] = (unknown[key] ?? 0) + 1;
    }
  }
  const languages = [...languageFiles]
    .map(([language, files]) => ({ language, files, support: support.language(language) }))
    .sort((a, b) => b.files - a.files || (a.language < b.language ? -1 : 1));

  for (const b of boundaries) {
    for (const [language, files] of Object.entries(b.languages)) {
      const level = support.language(language);
      if (level !== "analyzed")
        limitations.push({
          area: `language:${language}`,
          boundary: b.id,
          status: level === "scanned" ? "partial" : "unsupported",
          reason: `no adapter analyzes ${language} in depth`,
          consequence: `${files} ${language} file(s) in ${b.id} are inventoried only; their entry points, calls and data access are not traced`,
        });
    }
    for (const f of b.frameworks)
      if (f.support !== "analyzed")
        limitations.push({
          area: `framework:${f.name}`,
          boundary: b.id,
          status: f.support === "scanned" ? "partial" : "unsupported",
          reason: `no adapter recognizes ${f.name} conventions`,
          consequence: `routes, handlers or models declared through ${f.name} in ${b.id} are not discovered`,
        });
  }
  return { boundaries, languages, unknown, limitations };
}

interface Candidate {
  root: number;
  path: string;
  name?: string;
  manifests: string[];
  ecosystems: Set<string>;
  frameworks: Map<string, Framework>;
  declaresWorkspace: boolean;
}

interface PackageJson {
  name?: unknown;
  workspaces?: unknown[] | { packages?: unknown[] };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

function newCandidate(root: number, path: string): Candidate {
  return { root, path, manifests: [], ecosystems: new Set(), frameworks: new Map(), declaresWorkspace: false };
}

function boundary(
  c: Candidate,
  kind: BoundaryKind,
  rationale: string | undefined,
  rootNames: readonly string[],
): ProjectBoundary {
  const local = c.path === "" ? "." : c.path;
  return {
    id: `project:${c.root === 0 ? "" : `root${c.root}/`}${local}`,
    name: c.name ?? (c.path === "" ? (rootNames[c.root] ?? ".") : c.path.slice(c.path.lastIndexOf("/") + 1)),
    root: c.root,
    path: c.path,
    kind,
    status: rationale === undefined ? "source_verified" : "inferred",
    ...(rationale === undefined ? {} : { confidence_rationale: rationale }),
    ecosystems: [...c.ecosystems].sort(),
    manifests: [...c.manifests].sort(),
    frameworks: [...c.frameworks.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    languages: {},
    files: 0,
  };
}

function assign(boundaries: ProjectBoundary[], included: ReadonlyArray<InventoryEntry>) {
  // Deepest first, so the first match is the innermost boundary.
  const ordered = [...boundaries].sort((a, b) => b.path.length - a.path.length);
  const orphans = new Map<number, number>();
  const orphanLanguages = new Map<number, Record<string, number>>();
  for (const entry of included) {
    const owner = ordered.find((b) => b.root === entry.root && isUnder(entry.path, b.path));
    if (owner) {
      owner.files++;
      if (entry.language) owner.languages[entry.language] = (owner.languages[entry.language] ?? 0) + 1;
    } else {
      orphans.set(entry.root, (orphans.get(entry.root) ?? 0) + 1);
      const counts = orphanLanguages.get(entry.root) ?? {};
      if (entry.language) counts[entry.language] = (counts[entry.language] ?? 0) + 1;
      orphanLanguages.set(entry.root, counts);
    }
  }
  return { orphans, orphanLanguages };
}

function addGlobs(
  globs: Map<number, Array<{ base: string; patterns: string[] }>>,
  root: number,
  base: string,
  patterns: unknown[],
  candidate: Candidate,
): void {
  const list = patterns.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  if (list.length === 0) return;
  candidate.declaresWorkspace = true;
  const forRoot = globs.get(root) ?? [];
  forRoot.push({ base, patterns: list });
  globs.set(root, forRoot);
}

function hasWorkspaceRoot(globs: Map<number, unknown[]>, root: number): boolean {
  return (globs.get(root)?.length ?? 0) > 0;
}

/** Items of a top-level YAML list (`key:` followed by `- item` lines), enough for `pnpm-workspace.yaml`. */
export function yamlList(text: string, key: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inside = line.replace(/#.*/, "").trim() === `${key}:`;
    else if (inside) {
      const item = /^\s+-\s*(.+?)\s*(#.*)?$/.exec(line)?.[1];
      if (item) out.push(item.replace(/^(['"])(.*)\1$/, "$2"));
    }
  }
  return out;
}

/** Workspace globs: `*` within a segment, `**` across segments, `!` excludes. Later patterns win. */
export function matchesWorkspace(path: string, patterns: readonly string[]): boolean {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw).replace(/^\.\//, "").replace(/\/+$/, "");
    const regex = new RegExp(
      `^${pattern
        .split("/")
        .map((seg) =>
          seg === "**"
            ? "(?:.*)"
            : seg
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, "[^/]*")
                .replace(/\?/g, "[^/]"),
        )
        .join("/")
        .replace(/\/\(\?:\.\*\)/g, "(?:/.*)?")}$`,
    );
    if (regex.test(path)) matched = !negated;
  }
  return matched;
}

function isUnder(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

function rel(path: string, base: string): string {
  return base === "" ? path : path.slice(base.length + 1);
}

function byLocation(a: { root: number; path: string }, b: { root: number; path: string }): number {
  return a.root - b.root || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
