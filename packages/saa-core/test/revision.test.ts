import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  budgetFor,
  contentFingerprint,
  identifyRevision,
  RootSandbox,
  sanitizeRemote,
  scanInventory,
  type InventoryEntry,
} from "../src/index.js";

let base: string;
let repo: string;

/** Git with a fixed identity and no user, system or line-ending configuration, so every platform behaves alike. */
function gitCli(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.autocrlf=false", ...args],
    {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(base, "empty-gitconfig") },
      encoding: "utf8",
    },
  ).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

async function identify(root = repo) {
  const sandbox = await RootSandbox.open([root]);
  const included: InventoryEntry[] = [];
  await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
    if (e.status === "included") included.push(e);
  });
  return identifyRevision(sandbox, 0, included);
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    const info = statSync(path);
    out.push(`${path.slice(root.length)}|${info.size}|${info.mtimeMs}`);
    if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(root);
  return out.sort();
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-revision-"));
  repo = join(base, "repo");
  mkdirSync(repo);
  writeFileSync(join(base, "empty-gitconfig"), "");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function commitFixture(): string {
  gitCli("init", "-q", "-b", "main");
  write("src/app.ts", "export const app = 1;\n");
  write("README.md", "# Fixture\n");
  write(".gitignore", "*.log\n");
  gitCli("add", "-A");
  gitCli("commit", "-q", "--no-gpg-sign", "-m", "initial");
  gitCli(
    "remote",
    "add",
    "origin",
    "https://deploy:ghp_FAKE0123456789abcdefghijklmnopqrstuv@git.example.com/acme/portal.git",
  );
  return gitCli("rev-parse", "HEAD");
}

describe("revision identity [@req QAA-FR-004] [@req CON-006]", () => {
  it("identifies a clean checkout by its commit, branch and credential-free remote, without writing", async () => {
    const head = commitFixture();
    const before = snapshot(repo);
    // Stat drift without a content change: a refreshing status would rewrite .git/index.
    utimesSync(join(repo, "src/app.ts"), new Date(2030, 0, 1), new Date(2030, 0, 1));
    const drifted = snapshot(repo);
    const identity = await identify();
    expect(identity).toEqual({
      provider: "git",
      revision: { kind: "git_commit", value: head, worktree_dirty: false },
      identity: "https://git.example.com/acme/portal.git",
      branch_hint: "main",
      changed_paths: 0,
      labels: [],
    });
    expect(snapshot(repo)).toEqual(drifted);
    expect(drifted).not.toEqual(before);
  });

  it("labels a dirty worktree with the base commit and a fingerprint of the changes (OD-04)", async () => {
    const head = commitFixture();
    write("debug.log", "ignored, so not a change\n");
    expect((await identify()).revision).toMatchObject({ worktree_dirty: false });

    write("src/app.ts", "export const app = 2;\n");
    const dirty = await identify();
    expect(dirty).toMatchObject({
      provider: "git",
      revision: {
        kind: "git_commit",
        value: head,
        worktree_dirty: true,
        dirty_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      changed_paths: 1,
      labels: ["dirty_worktree"],
    });
    expect((await identify()).revision).toEqual(dirty.revision);

    write("src/app.ts", "export const app = 3;\n");
    const other = await identify();
    expect(other.revision).not.toEqual(dirty.revision);

    write("src/new.ts", "export {};\n");
    rmSync(join(repo, "README.md"));
    expect(await identify()).toMatchObject({ changed_paths: 3, labels: ["dirty_worktree"] });

    gitCli("add", "-A");
    gitCli("commit", "-q", "--no-gpg-sign", "-m", "second");
    expect((await identify()).revision).toEqual({
      kind: "git_commit",
      value: gitCli("rev-parse", "HEAD"),
      worktree_dirty: false,
    });
  });

  it("counts a staged-only change as dirty", async () => {
    commitFixture();
    write("src/app.ts", "export const app = 2;\n");
    gitCli("add", "src/app.ts");
    write("src/app.ts", "export const app = 1;\n");
    expect(await identify()).toMatchObject({ changed_paths: 1, labels: ["dirty_worktree"] });
  });

  it("falls back to a labeled content fingerprint without Git, without commits, or with metadata outside the root", async () => {
    write("src/app.ts", "export const app = 1;\n");
    const plain = await identify();
    expect(plain).toMatchObject({
      provider: "filesystem",
      revision: { kind: "content_fingerprint", value: expect.stringMatching(/^[0-9a-f]{64}$/) },
      labels: ["non_git"],
    });
    expect((await identify()).revision).toEqual(plain.revision);
    write("src/app.ts", "export const app = 2;\n");
    expect((await identify()).revision).not.toEqual(plain.revision);

    gitCli("init", "-q", "-b", "main");
    expect(await identify()).toMatchObject({ provider: "filesystem", labels: ["git_no_commits"] });

    rmSync(join(repo, ".git"), { recursive: true, force: true });
    writeFileSync(join(repo, ".git"), `gitdir: ${join(base, "elsewhere", ".git")}\n`);
    mkdirSync(join(base, "elsewhere", ".git"), { recursive: true });
    expect(await identify()).toMatchObject({ provider: "filesystem", labels: ["git_metadata_outside_root"] });
  });

  it("does not claim a SHA-1 commit for a repository in another object format", async () => {
    commitFixture();
    gitCli("config", "extensions.objectformat", "sha256");
    expect(await identify()).toMatchObject({ provider: "filesystem", labels: ["git_unsupported_object_format"] });
  });

  it("fingerprints content by path and bytes, independent of input order", async () => {
    write("a.ts", "a");
    write("b.ts", "b");
    const sandbox = await RootSandbox.open([repo]);
    const one = await contentFingerprint(sandbox, [
      { root: 0, path: "a.ts" },
      { root: 0, path: "b.ts" },
    ]);
    const two = await contentFingerprint(sandbox, [
      { root: 0, path: "b.ts" },
      { root: 0, path: "a.ts" },
    ]);
    expect(one).toEqual(two);
    expect(await contentFingerprint(sandbox, [{ root: 0, path: "a.ts" }])).not.toEqual(one);
  });

  it("strips credentials, queries and fragments from remotes, and drops a remote that still looks secret", () => {
    expect(sanitizeRemote("https://user:pass@example.com/a/b.git?token=x#frag")).toBe("https://example.com/a/b.git");
    expect(sanitizeRemote("git@github.com:acme/portal.git")).toBe("git@github.com:acme/portal.git");
    expect(sanitizeRemote("ssh://git@example.com:2222/acme/portal.git")).toBe("ssh://example.com:2222/acme/portal.git");
    expect(sanitizeRemote("ghp_FAKE0123456789abcdefghijklmnopqrstuv@example.com:a/b.git")).toBeUndefined();
    expect(sanitizeRemote("  ")).toBeUndefined();
  });
});
