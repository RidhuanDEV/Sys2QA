import { createHash } from "node:crypto";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { detectSecrets, type ContentFingerprintRevision, type GitCommitRevision } from "@sys2qa/contract";
import git from "isomorphic-git";
import type { InventoryEntry } from "./inventory.js";
import { RootSandbox, SandboxError } from "./sandbox.js";

/** Why a revision is not a clean commit, or why Git metadata was not used (CON-006, OD-04). */
export type RevisionLabel =
  | "dirty_worktree"
  | "non_git"
  | "git_no_commits"
  | "git_metadata_outside_root"
  | "git_metadata_unreadable"
  | "git_unsupported_object_format";

export interface RevisionIdentity {
  provider: "git" | "filesystem";
  revision: GitCommitRevision | ContentFingerprintRevision;
  /** Remote URL from local Git configuration, without credentials (PRD §13.8 `local_git_remote`). */
  identity?: string;
  branch_hint?: string;
  /** Paths whose working-tree state differs from the commit (dirty worktrees only). */
  changed_paths: number;
  labels: RevisionLabel[];
}

/** Largest Git metadata file read (pack files are read whole by isomorphic-git). */
const GIT_FILE_MAX_BYTES = 512 * 1024 ** 2;

/**
 * The identity of the analyzed source (QAA-FR-004, CON-006). Git metadata is read in-process through the sandbox
 * with isomorphic-git: no `git` binary, so no hooks, `core.fsmonitor` commands or filter drivers from a repository's
 * configuration can run (SEC-002), and no transport is configured, so nothing is fetched (SEC-017). The working tree
 * is compared with HEAD and the index read-only (`refresh: false`; every write is refused). A clean checkout yields
 * the commit; a dirty one yields the base commit plus a fingerprint of the changed paths; anything else (no Git, no
 * commits, metadata outside the root or unreadable) yields a content fingerprint over the included files, labeled.
 */
export async function identifyRevision(
  sandbox: RootSandbox,
  root: number,
  included: Iterable<Pick<InventoryEntry, "root" | "path">>,
): Promise<RevisionIdentity> {
  const labels: RevisionLabel[] = [];
  const fromGit = await gitIdentity(sandbox, root, labels);
  if (fromGit) return fromGit;
  if (labels.length === 0) labels.push("non_git");
  return {
    provider: "filesystem",
    revision: await contentFingerprint(
      sandbox,
      [...included].filter((e) => e.root === root),
    ),
    changed_paths: 0,
    labels,
  };
}

/** `sha256:` + SHA-256 over the sorted `path NUL sha256(content)` lines of the given files (PRD §13.8 `content_fingerprint`). */
export async function contentFingerprint(
  sandbox: RootSandbox,
  files: ReadonlyArray<Pick<InventoryEntry, "root" | "path">>,
): Promise<ContentFingerprintRevision> {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.root - b.root || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const { digest } = await sandbox.sha256(await sandbox.resolve(file.root, file.path));
    hash.update(`${file.root}:${file.path}\0${digest}\n`);
  }
  return { kind: "content_fingerprint", value: `sha256:${hash.digest("hex")}` };
}

/** Removes credentials from a remote URL; returns undefined when something secret-looking remains. */
export function sanitizeRemote(url: string): string | undefined {
  let clean = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
    try {
      const parsed = new URL(clean);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      clean = parsed.toString();
    } catch {
      return undefined;
    }
  }
  return clean === "" || detectSecrets(clean).length > 0 ? undefined : clean;
}

async function gitIdentity(
  sandbox: RootSandbox,
  root: number,
  labels: RevisionLabel[],
): Promise<RevisionIdentity | undefined> {
  const dir = sandbox.roots[root]!;
  const fs = readOnlyFs(sandbox, root);
  try {
    await sandbox.resolve(root, ".git");
  } catch (error) {
    if (error instanceof SandboxError && error.code === "NOT_FOUND") return undefined;
    labels.push(error instanceof SandboxError ? "git_metadata_outside_root" : "git_metadata_unreadable");
    return undefined;
  }
  try {
    const objectFormat = await git.getConfig({ fs, dir, path: "extensions.objectformat" });
    if (typeof objectFormat === "string" && objectFormat.toLowerCase() !== "sha1") {
      labels.push("git_unsupported_object_format");
      return undefined;
    }
    let head: string;
    try {
      head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    } catch (error) {
      if (fs.denied()) throw error;
      labels.push("git_no_commits");
      return undefined;
    }
    const branch = await git.currentBranch({ fs, dir, fullname: false });
    const remote = await git.getConfig({ fs, dir, path: `remote.${(await firstRemote(fs, dir)) ?? "origin"}.url` });
    const matrix = await git.statusMatrix({ fs, dir, refresh: false });
    const racy = await racilyModified(sandbox, root, fs, dir, matrix);
    if (fs.denied()) throw new Error("denied");
    const changed = matrix
      .map(([path, h, w, s]): [string, number, number, number] => (racy.has(path) ? [path, h, 2, s] : [path, h, w, s]))
      .filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));
    const revision: GitCommitRevision =
      changed.length === 0
        ? { kind: "git_commit", value: head, worktree_dirty: false }
        : {
            kind: "git_commit",
            value: head,
            worktree_dirty: true,
            dirty_fingerprint: await dirtyFingerprint(sandbox, root, changed),
          };
    const identity = typeof remote === "string" ? sanitizeRemote(remote) : undefined;
    return {
      provider: "git",
      revision,
      ...(identity === undefined ? {} : { identity }),
      ...(typeof branch === "string" ? { branch_hint: branch } : {}),
      changed_paths: changed.length,
      labels: changed.length > 0 ? ["dirty_worktree"] : [],
    };
  } catch {
    labels.push(fs.denied() ? "git_metadata_outside_root" : "git_metadata_unreadable");
    return undefined;
  }
}

/**
 * isomorphic-git trusts the index stat cache at one-second resolution, so a same-size edit made in the second the
 * index was written looks unmodified. Git calls such entries racily clean and re-reads them; so does this: every
 * clean file whose modification time is not older than the index is hashed as a blob and compared with HEAD. A
 * difference that disappears when CRLF is normalized to LF (a Windows checkout with `core.autocrlf`) is not a change.
 */
async function racilyModified(
  sandbox: RootSandbox,
  root: number,
  fs: ReadOnlyFs,
  dir: string,
  matrix: ReadonlyArray<[string, number, number, number]>,
): Promise<Set<string>> {
  let indexSecond: number;
  try {
    indexSecond = Math.floor((await lstat((await sandbox.resolve(root, ".git/index")).real)).mtimeMs / 1000);
  } catch {
    return new Set();
  }
  const suspects = new Set<string>();
  for (const [path, h, w, s] of matrix) {
    if (h !== 1 || w !== 1 || s !== 1) continue;
    const info = await fs.promises.lstat(join(dir, path)).catch(() => undefined);
    if (info && Math.floor(info.mtimeMs / 1000) >= indexSecond) suspects.add(path);
  }
  if (suspects.size === 0) return suspects;
  const ancestors = new Set<string>();
  for (const path of suspects)
    for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) ancestors.add(path.slice(0, i));
  const headOids = new Map<string, string>();
  await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: "HEAD" })],
    map: async (path, [entry]) => {
      if (path === "." || ancestors.has(path)) return true;
      if (!suspects.has(path) || !entry) return null;
      headOids.set(path, await entry.oid());
      return null;
    },
  });
  const modified = new Set<string>();
  for (const path of suspects) {
    const info = await fs.promises.lstat(join(dir, path));
    const content: Buffer = info.isSymbolicLink()
      ? Buffer.from(await fs.promises.readlink!(join(dir, path)))
      : await fs.promises.readFile(join(dir, path));
    const expected = headOids.get(path);
    if (blobOid(content) === expected) continue;
    if (
      !content.includes(0) &&
      blobOid(Buffer.from(content.toString("latin1").replace(/\r\n/g, "\n"), "latin1")) === expected
    )
      continue;
    modified.add(path);
  }
  return modified;
}

function blobOid(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

async function firstRemote(fs: ReadOnlyFs, dir: string): Promise<string | undefined> {
  const remotes = await git.listRemotes({ fs, dir });
  return remotes.find((r) => r.remote === "origin")?.remote ?? remotes[0]?.remote;
}

/** SHA-256 over the sorted `path NUL status NUL sha256(working-tree content or "-")` lines of the changed paths. */
async function dirtyFingerprint(
  sandbox: RootSandbox,
  root: number,
  changed: ReadonlyArray<[string, number, number, number]>,
): Promise<string> {
  const hash = createHash("sha256");
  for (const [path, h, w, s] of [...changed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let digest = "-";
    if (w !== 0) {
      try {
        digest = (await sandbox.sha256(await sandbox.resolve(root, path))).digest;
      } catch {
        // A changed path that is a link out of the root or not a regular file still counts by its status.
        digest = "?";
      }
    }
    hash.update(`${path}\0${h}${w}${s}\0${digest}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

type ReadOnlyFs = git.PromiseFsClient & { denied: () => boolean };

function fsError(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * The filesystem isomorphic-git sees: absolute paths are mapped back to root-relative paths and resolved through the
 * sandbox; `lstat` and `readlink` look at a link itself without following it; every write fails with `EROFS`. A path
 * the sandbox refuses is reported to isomorphic-git as missing, so it stays quiet, and `denied()` makes the caller
 * discard the result.
 */
function readOnlyFs(sandbox: RootSandbox, root: number): ReadOnlyFs {
  const base = sandbox.roots[root]!;
  let denied = false;
  const rel = (path: string) => relative(base, path).split(sep).join("/");
  const resolve = async (path: string) => {
    try {
      return await sandbox.resolve(root, rel(path));
    } catch (error) {
      if (error instanceof SandboxError && error.code === "SANDBOX_DENIED") denied = true;
      throw fsError("ENOENT", path);
    }
  };
  /** The real parent directory plus the final name, so the final component is not followed. */
  const parentOf = async (path: string) =>
    rel(path) === "" ? base : join((await resolve(dirname(path))).real, basename(path));
  const readOnly = async (path: string): Promise<never> => {
    throw fsError("EROFS", String(path));
  };
  return {
    denied: () => denied,
    promises: {
      readFile: async (path: string, options?: { encoding?: BufferEncoding } | BufferEncoding) => {
        const data = await sandbox.readFile(await resolve(path), GIT_FILE_MAX_BYTES).catch((error: unknown) => {
          if (error instanceof SandboxError) denied = true;
          throw fsError("ENOENT", path);
        });
        if (!Buffer.isBuffer(data)) throw fsError("EFBIG", path);
        const encoding = typeof options === "string" ? options : options?.encoding;
        return encoding ? data.toString(encoding) : data;
      },
      readdir: async (path: string) => readdir((await resolve(path)).real),
      stat: async (path: string) => stat((await resolve(path)).real),
      lstat: async (path: string) => lstat(await parentOf(path)),
      readlink: async (path: string) => readlink(await parentOf(path)),
      writeFile: readOnly,
      mkdir: readOnly,
      rmdir: readOnly,
      unlink: readOnly,
      symlink: readOnly,
      chmod: readOnly,
    },
  };
}
