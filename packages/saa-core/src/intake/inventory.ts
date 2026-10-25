import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisBudget } from "./budgets.js";
import { classifyFile, DEFAULT_EXCLUDED_DIRECTORIES, type FileCategory } from "./classify.js";
import { evaluate, ruleSet, type RuleSet } from "./ignore-rules.js";
import { RootSandbox, SandboxError } from "./sandbox.js";
import { sensitiveFileKind, type SensitiveFileKind } from "./secrets.js";

/** Why an entry is not analyzed. Stable codes; text comes from the glossary. */
export type InventoryReason =
  | "default_exclusion"
  | "excluded_by_user"
  | "ignored_by_gitignore"
  | "generated"
  | "binary"
  | "too_large"
  | "depth_budget"
  | "symlink_not_followed"
  | "symlink_outside_root"
  | "broken_symlink"
  | "special_file"
  | "unsupported_name"
  | "permission_denied"
  | "read_error";

/**
 * `included`: in scope for analysis. `excluded`: out of scope by policy or rules. `skipped`: in scope but not analyzed
 * (limits, symlinks, special files). `unreadable`: an error prevented reading it (SAA-FR-001).
 */
export type InventoryStatus = "included" | "excluded" | "skipped" | "unreadable";

export interface InventoryEntry {
  root: number;
  /** Root-relative path with `/` separators. */
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  status: InventoryStatus;
  reason?: InventoryReason;
  /** The rule that excluded the entry, when one did. */
  rule?: string;
  category: FileCategory;
  language?: string;
  manifest?: true;
  /** Set for files whose content is withheld from analysis (IMP-103). */
  sensitive?: SensitiveFileKind;
  /** Bytes, for included and too-large files. */
  size?: number;
}

export interface InventoryOptions {
  budget: Pick<AnalysisBudget, "max_files" | "max_file_bytes" | "max_total_bytes" | "max_depth" | "max_minutes">;
  /** User exclusions in `.gitignore` syntax, relative to every root. They cannot be re-included by the repository. */
  exclude?: readonly string[];
  /** Built-in exclusions (dependencies, build output, VCS internals, generated directories). Default true. */
  defaultExclusions?: boolean;
  /** Honor `.gitignore` files and `.git/info/exclude`. Default true. */
  gitignore?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

export type InventoryStop = "max_files" | "max_total_bytes" | "max_minutes" | "max_depth";

export interface InventorySummary {
  status: "complete" | "partial" | "cancelled";
  /** Budgets that left scope unvisited. */
  stopped_by: InventoryStop[];
  roots: string[];
  counts: Record<InventoryStatus, number> & { directories: number };
  included_bytes: number;
  by_reason: Partial<Record<InventoryReason, number>>;
  by_language: Record<string, number>;
  manifests: Array<{ root: number; path: string }>;
  vcs: Array<{ root: number; kind: "git" | "hg" | "svn" }>;
  /** Directories and files not visited because of a budget or cancellation, `root:path` (at most 1000). */
  unvisited: string[];
  unvisited_truncated: number;
  duration_ms: number;
}

export type InventorySink = (entry: InventoryEntry) => void | Promise<void>;

const UNVISITED_LIMIT = 1000;
const IGNORE_FILE_MAX_BYTES = 1024 * 1024;
/** Names a later stage could not address safely: path separators of the other platform and control characters. */
// eslint-disable-next-line no-control-regex
const UNSUPPORTED_NAME = /[\\\u0000-\u001f\u007f]/;

interface PendingDirectory {
  root: number;
  path: string;
  depth: number;
  rules: RuleSet[];
}

/**
 * Streams the inventory of every root to `sink`, one entry at a time, in a deterministic order (SAA-FR-001). The walk
 * holds one directory listing at a time, never follows symlinks or junctions, resolves every directory through the
 * sandbox before listing it (SEC-001; the sandbox reports denials), reads nothing but `.gitignore` files, and never
 * starts a process (SAA-FR-004, SEC-002). Budgets and cancellation end the walk with the unvisited scope listed (SAA-FR-039).
 */
export async function scanInventory(
  sandbox: RootSandbox,
  options: InventoryOptions,
  sink: InventorySink,
): Promise<InventorySummary> {
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + options.budget.max_minutes * 60_000;
  const useDefaults = options.defaultExclusions ?? true;
  const useGitignore = options.gitignore ?? true;
  const user = options.exclude && options.exclude.length > 0 ? ruleSet("", options.exclude) : undefined;
  const summary: InventorySummary = {
    status: "complete",
    stopped_by: [],
    roots: [...sandbox.roots],
    counts: { included: 0, excluded: 0, skipped: 0, unreadable: 0, directories: 0 },
    included_bytes: 0,
    by_reason: {},
    by_language: {},
    manifests: [],
    vcs: [],
    unvisited: [],
    unvisited_truncated: 0,
    duration_ms: 0,
  };
  const unvisited = (root: number, path: string) => {
    if (summary.unvisited.length < UNVISITED_LIMIT) summary.unvisited.push(`${root}:${path === "" ? "." : path}`);
    else summary.unvisited_truncated++;
  };
  const stop = (why: InventoryStop) => {
    if (!summary.stopped_by.includes(why)) summary.stopped_by.push(why);
    if (summary.status === "complete") summary.status = "partial";
  };
  const emit = async (entry: InventoryEntry) => {
    summary.counts[entry.status]++;
    if (entry.reason) summary.by_reason[entry.reason] = (summary.by_reason[entry.reason] ?? 0) + 1;
    if (entry.status === "included") {
      summary.included_bytes += entry.size ?? 0;
      if (entry.language) summary.by_language[entry.language] = (summary.by_language[entry.language] ?? 0) + 1;
      if (entry.manifest) summary.manifests.push({ root: entry.root, path: entry.path });
    }
    await sink(entry);
  };

  // Depth-first, children in code-point order, so two runs over the same tree emit the same sequence.
  const stack: PendingDirectory[] = sandbox.roots.map((_, root) => ({ root, path: "", depth: 0, rules: [] })).reverse();
  let halted = false;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (halted) {
      unvisited(dir.root, dir.path);
      continue;
    }
    let absolute: string;
    let listing: Dirent[];
    try {
      // Resolved through the sandbox: a directory replaced by a link after it was listed must not take the walk
      // outside the root (the sandbox reports the denial).
      absolute = (await sandbox.resolve(dir.root, dir.path)).real;
      listing = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (error instanceof SandboxError && error.code === "SANDBOX_DENIED")
        await emit(entry(dir, dir.path, "directory", "excluded", "symlink_outside_root"));
      else await emit(entry(dir, dir.path, "directory", "unreadable", errorReason(error)));
      continue;
    }
    summary.counts.directories++;
    listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    let rules = dir.rules;
    if (useGitignore) {
      const extra: string[] = [];
      if (dir.path === "" && listing.some((d) => d.name === ".git" && d.isDirectory())) {
        const exclude = await readIgnoreFile(sandbox, dir.root, ".git/info/exclude");
        if (exclude !== undefined) extra.push(exclude);
      }
      if (listing.some((d) => d.name === ".gitignore" && d.isFile())) {
        const gitignore = await readIgnoreFile(sandbox, dir.root, child(dir.path, ".gitignore"));
        if (gitignore !== undefined) extra.push(gitignore);
      }
      if (extra.length > 0) rules = [...rules, ruleSet(dir.path, extra.join("\n"))];
    }
    if (dir.path === "") {
      for (const kind of ["git", "hg", "svn"] as const)
        if (listing.some((d) => d.name === `.${kind}`)) summary.vcs.push({ root: dir.root, kind });
    }

    const subdirectories: PendingDirectory[] = [];
    for (let i = 0; i < listing.length; i++) {
      const dirent = listing[i]!;
      const path = child(dir.path, dirent.name);
      const halt = options.signal?.aborted
        ? "cancelled"
        : now() > deadline
          ? "max_minutes"
          : summary.counts.included >= options.budget.max_files
            ? "max_files"
            : summary.included_bytes >= options.budget.max_total_bytes
              ? "max_total_bytes"
              : undefined;
      if (halt !== undefined) {
        if (halt === "cancelled") summary.status = "cancelled";
        else stop(halt);
        halted = true;
        for (const rest of listing.slice(i)) unvisited(dir.root, child(dir.path, rest.name));
        break;
      }

      if (UNSUPPORTED_NAME.test(dirent.name)) {
        await emit(entry(dir, path, kindOf(dirent), "skipped", "unsupported_name"));
        continue;
      }
      if (dirent.isSymbolicLink()) {
        await emit(await symlinkEntry(sandbox, dir, path));
        continue;
      }
      const isDirectory = dirent.isDirectory();
      if (!isDirectory && !dirent.isFile()) {
        await emit(entry(dir, path, "other", "skipped", "special_file"));
        continue;
      }

      const userRule = user ? evaluate([user], isDirectory ? `${path}/` : path) : { ignored: false as const };
      if (userRule.ignored) {
        await emit(withRule(entry(dir, path, kindOf(dirent), "excluded", "excluded_by_user"), userRule.pattern));
        continue;
      }
      if (isDirectory) {
        const category = useDefaults ? DEFAULT_EXCLUDED_DIRECTORIES[dirent.name] : undefined;
        if (category !== undefined) {
          await emit({
            ...entry(dir, path, "directory", "excluded", category === "generated" ? "generated" : "default_exclusion"),
            category,
          });
          continue;
        }
        const git = evaluate(rules, `${path}/`);
        if (git.ignored) {
          await emit(withRule(entry(dir, path, "directory", "excluded", "ignored_by_gitignore"), git.pattern));
          continue;
        }
        if (dir.depth + 1 > options.budget.max_depth) {
          stop("max_depth");
          await emit(entry(dir, path, "directory", "skipped", "depth_budget"));
          unvisited(dir.root, path);
          continue;
        }
        subdirectories.push({ root: dir.root, path, depth: dir.depth + 1, rules });
        continue;
      }

      const git = evaluate(rules, path);
      const classification = classifyFile(path);
      const sensitive = sensitiveFileKind(path);
      const file: InventoryEntry = {
        ...entry(dir, path, "file", "included"),
        ...classification,
        ...(sensitive === undefined ? {} : { sensitive }),
      };
      if (git.ignored) {
        await emit(withRule({ ...file, status: "excluded", reason: "ignored_by_gitignore" }, git.pattern));
        continue;
      }
      if (classification.category === "binary") {
        await emit({ ...file, status: "excluded", reason: "binary" });
        continue;
      }
      if (classification.category === "generated") {
        await emit({ ...file, status: "excluded", reason: "generated" });
        continue;
      }
      let size: number;
      try {
        size = (await lstat(join(absolute, dirent.name))).size;
      } catch (error) {
        await emit({ ...file, status: "unreadable", reason: errorReason(error) });
        continue;
      }
      if (size > options.budget.max_file_bytes) {
        await emit({ ...file, status: "skipped", reason: "too_large", size });
        continue;
      }
      await emit({ ...file, size });
    }
    for (let j = subdirectories.length - 1; j >= 0; j--) stack.push(subdirectories[j]!);
  }
  summary.duration_ms = now() - started;
  return summary;
}

function child(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

function entry(
  dir: PendingDirectory,
  path: string,
  type: InventoryEntry["type"],
  status: InventoryStatus,
  reason?: InventoryReason,
): InventoryEntry {
  const base: InventoryEntry = { root: dir.root, path, type, status, category: "other" };
  return reason === undefined ? base : { ...base, reason };
}

function withRule(e: InventoryEntry, pattern: string): InventoryEntry {
  return pattern === "" ? e : { ...e, rule: pattern };
}

function kindOf(dirent: Dirent): InventoryEntry["type"] {
  return dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : dirent.isSymbolicLink() ? "symlink" : "other";
}

function errorReason(error: unknown): InventoryReason {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" ? "permission_denied" : "read_error";
}

async function symlinkEntry(sandbox: RootSandbox, dir: PendingDirectory, path: string): Promise<InventoryEntry> {
  try {
    await sandbox.resolve(dir.root, path);
    // The target is inside the root and is inventoried at its own path; following the link would duplicate it.
    return entry(dir, path, "symlink", "skipped", "symlink_not_followed");
  } catch (error) {
    if (error instanceof SandboxError && error.code === "SANDBOX_DENIED")
      return entry(dir, path, "symlink", "excluded", "symlink_outside_root");
    if (error instanceof SandboxError && error.code === "NOT_FOUND")
      return entry(dir, path, "symlink", "skipped", "broken_symlink");
    return entry(dir, path, "symlink", "unreadable", errorReason(error));
  }
}

async function readIgnoreFile(sandbox: RootSandbox, root: number, path: string): Promise<string | undefined> {
  try {
    const read = await sandbox.readText(await sandbox.resolve(root, path), IGNORE_FILE_MAX_BYTES);
    return read.kind === "text" ? read.text : undefined;
  } catch {
    // An unreadable, escaping or non-regular ignore file is ignored; the sandbox has already logged a denial.
    return undefined;
  }
}
