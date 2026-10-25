import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  budgetFor,
  classifyFile,
  evaluate,
  RootSandbox,
  ruleSet,
  scanInventory,
  type InventoryEntry,
  type InventoryOptions,
} from "../src/index.js";

const F1 = fileURLToPath(new URL("../../../fixtures/benchmarks/F1-repository-only/repo/", import.meta.url));
const budget = budgetFor("standard");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sys2qa-intake-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tree(files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

async function inventory(root: string, options: Partial<InventoryOptions> = {}) {
  const entries: InventoryEntry[] = [];
  const summary = await scanInventory(await RootSandbox.open([root]), { budget, ...options }, (e) => {
    entries.push(e);
  });
  const byPath = new Map(entries.map((e) => [e.path, e]));
  return { entries, summary, byPath };
}

/** Path, size and modification time of every file and directory: the filesystem diff of SAA-FR-004. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    const info = statSync(path);
    out.push(`${path}|${info.size}|${info.mtimeMs}`);
    if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(root);
  return out.sort();
}

describe("file classification [@req SAA-FR-001]", () => {
  it("classifies by path: languages, manifests, lockfiles, tests, generated and binary files", () => {
    expect(classifyFile("src/server/app.ts")).toEqual({ category: "source", language: "typescript" });
    expect(classifyFile("test/validation.test.ts")).toEqual({ category: "test", language: "typescript" });
    expect(classifyFile("package.json")).toEqual({ category: "manifest", language: "json", manifest: true });
    expect(classifyFile("services/api/Api.csproj")).toMatchObject({ category: "manifest", manifest: true });
    expect(classifyFile("pnpm-lock.yaml")).toEqual({ category: "lockfile", language: "yaml" });
    expect(classifyFile("migrations/001_init.sql")).toEqual({ category: "source", language: "sql" });
    expect(classifyFile("README.md")).toEqual({ category: "documentation", language: "markdown" });
    expect(classifyFile("public/app.min.js")).toEqual({ category: "generated", language: "javascript" });
    expect(classifyFile("assets/logo.PNG")).toEqual({ category: "binary" });
    expect(classifyFile(".env.example")).toEqual({ category: "config", language: "dotenv" });
    expect(classifyFile("deploy/Dockerfile")).toEqual({ category: "manifest", language: "dockerfile", manifest: true });
    expect(classifyFile("api.Dockerfile")).toEqual({ category: "manifest", language: "dockerfile", manifest: true });
    expect(classifyFile("LICENSE")).toEqual({ category: "other" });
  });
});

describe("ignore rules", () => {
  it("lets the deepest .gitignore with a matching rule decide, including negations", () => {
    const sets = [ruleSet("", ["*.log", "build/", "!keep.log"]), ruleSet("pkg", ["!debug.log", "secret.txt"])];
    expect(evaluate(sets, "a.log")).toEqual({ ignored: true, pattern: "*.log" });
    expect(evaluate(sets, "keep.log")).toEqual({ ignored: false });
    expect(evaluate(sets, "pkg/debug.log")).toEqual({ ignored: false });
    expect(evaluate(sets, "pkg/other.log")).toEqual({ ignored: true, pattern: "*.log" });
    expect(evaluate(sets, "pkg/secret.txt")).toEqual({ ignored: true, pattern: "secret.txt" });
    expect(evaluate(sets, "build/")).toEqual({ ignored: true, pattern: "build/" });
    expect(evaluate(sets, "build")).toEqual({ ignored: false });
  });
});

describe("streaming inventory [@req SAA-FR-001] [@req SAA-FR-004] [@req NFR-002]", () => {
  it("inventories the F1 repository: manifests, languages, the excluded generated client, and nothing written", async () => {
    const before = snapshot(F1);
    const { summary, byPath, entries } = await inventory(F1);
    expect(snapshot(F1)).toEqual(before);
    expect(summary).toMatchObject({ status: "complete", stopped_by: [], unvisited: [], vcs: [] });
    expect(summary.manifests).toEqual([{ root: 0, path: "package.json" }]);
    expect(byPath.get("src/generated")).toMatchObject({ status: "excluded", reason: "generated", type: "directory" });
    expect(byPath.get("src/server/app.ts")).toMatchObject({
      status: "included",
      category: "source",
      size: expect.any(Number),
    });
    expect(byPath.get("prisma/schema.prisma")).toMatchObject({ status: "included", language: "prisma" });
    expect(byPath.get("test/validation.test.ts")).toMatchObject({ category: "test" });
    expect(summary.by_language).toMatchObject({ typescript: expect.any(Number), sql: 2, prisma: 1, json: 1 });
    expect(entries.some((e) => e.path.startsWith("src/generated/"))).toBe(false);
    // Deterministic order: a second run emits the same sequence.
    expect((await inventory(F1)).entries).toEqual(entries);
  });

  it("applies user exclusions, default exclusions, nested .gitignore files and .git/info/exclude, each with its reason", async () => {
    tree({
      ".gitignore": "*.log\ntmp/\n",
      ".git/info/exclude": "local-notes.md\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "app.log": "x",
      "local-notes.md": "x",
      "tmp/a.ts": "x",
      "node_modules/x/index.js": "x",
      "packages/web/.gitignore": "!keep.log\n",
      "packages/web/keep.log": "x",
      "packages/web/src/main.ts": "x",
      "packages/web/dist/main.js": "x",
      "docs/internal/plan.md": "x",
      "img/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "big.json": "x".repeat(2000),
    });
    const { summary, byPath } = await inventory(dir, {
      exclude: ["docs/internal/"],
      budget: { ...budget, max_file_bytes: 1000 },
    });
    expect(summary.vcs).toEqual([{ root: 0, kind: "git" }]);
    expect(byPath.get(".git")).toMatchObject({ status: "excluded", reason: "default_exclusion", category: "vcs" });
    expect(byPath.get("node_modules")).toMatchObject({ reason: "default_exclusion", category: "dependency" });
    expect(byPath.get("packages/web/dist")).toMatchObject({ reason: "default_exclusion", category: "build_output" });
    expect(byPath.get("app.log")).toMatchObject({ status: "excluded", reason: "ignored_by_gitignore", rule: "*.log" });
    expect(byPath.get("tmp")).toMatchObject({ status: "excluded", reason: "ignored_by_gitignore", rule: "tmp/" });
    expect(byPath.get("local-notes.md")).toMatchObject({ reason: "ignored_by_gitignore" });
    expect(byPath.get("packages/web/keep.log")).toMatchObject({ status: "included" });
    expect(byPath.get("docs/internal")).toMatchObject({ status: "excluded", reason: "excluded_by_user" });
    expect(byPath.get("img/logo.png")).toMatchObject({ status: "excluded", reason: "binary" });
    expect(byPath.get("big.json")).toMatchObject({ status: "skipped", reason: "too_large", size: 2000 });
    expect(byPath.get("packages/web/src/main.ts")).toMatchObject({ status: "included" });
    expect(summary.status).toBe("complete");

    const plain = await inventory(dir, { defaultExclusions: false, gitignore: false });
    expect(plain.byPath.get("node_modules/x/index.js")).toMatchObject({ status: "included" });
    expect(plain.byPath.get("app.log")).toMatchObject({ status: "included" });
  });

  it("a .gitignore cannot re-include what the user excluded", async () => {
    tree({ ".gitignore": "!secret/\n!secret/**\n", "secret/a.ts": "x", "b.ts": "x" });
    const { byPath } = await inventory(dir, { exclude: ["secret/"] });
    expect(byPath.get("secret")).toMatchObject({ status: "excluded", reason: "excluded_by_user" });
    expect(byPath.has("secret/a.ts")).toBe(false);
  });

  it("ends partial with the unvisited scope listed when the file, byte or depth budget is exhausted [@req SAA-FR-039]", async () => {
    tree({ "a/1.ts": "x", "a/2.ts": "x", "b/3.ts": "x", "c/d/e/4.ts": "x", "z.ts": "x" });
    const files = await inventory(dir, { budget: { ...budget, max_files: 2 } });
    expect(files.summary).toMatchObject({ status: "partial", stopped_by: ["max_files"], counts: { included: 2 } });
    // The root listing is processed first (z.ts), then a/ until the budget runs out.
    expect(files.summary.unvisited).toEqual(["0:a/2.ts", "0:b", "0:c"]);

    const bytes = await inventory(dir, { budget: { ...budget, max_total_bytes: 1 } });
    expect(bytes.summary).toMatchObject({
      status: "partial",
      stopped_by: ["max_total_bytes"],
      counts: { included: 1 },
    });

    const depth = await inventory(dir, { budget: { ...budget, max_depth: 2 } });
    expect(depth.summary).toMatchObject({ status: "partial", stopped_by: ["max_depth"] });
    expect(depth.byPath.get("c/d/e")).toMatchObject({ status: "skipped", reason: "depth_budget" });
    expect(depth.summary.unvisited).toEqual(["0:c/d/e"]);
    // Everything outside the too-deep directory was still inventoried.
    expect(depth.byPath.get("z.ts")).toMatchObject({ status: "included" });
  });

  it("stops at the time budget and on cancellation", async () => {
    tree({ "a.ts": "x", "b.ts": "x" });
    let t = 0;
    const timed = await inventory(dir, { now: () => (t += 6 * 60_000), budget: { ...budget, max_minutes: 10 } });
    expect(timed.summary).toMatchObject({ status: "partial", stopped_by: ["max_minutes"] });
    expect(timed.summary.unvisited.length).toBeGreaterThan(0);

    const controller = new AbortController();
    const entries: InventoryEntry[] = [];
    const summary = await scanInventory(await RootSandbox.open([dir]), { budget, signal: controller.signal }, (e) => {
      entries.push(e);
      controller.abort();
    });
    expect(summary).toMatchObject({ status: "cancelled", unvisited: ["0:b.ts"] });
    expect(entries).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "skips FIFOs without opening them, and reports unreadable directories",
    async () => {
      tree({ "a.ts": "x" });
      execFileSync("mkfifo", [join(dir, "pipe")]);
      const { byPath } = await inventory(dir);
      expect(byPath.get("pipe")).toMatchObject({ type: "other", status: "skipped", reason: "special_file" });
      const sandbox = await RootSandbox.open([dir]);
      await expect(sandbox.readText(await sandbox.resolve(0, "pipe"), 100)).rejects.toMatchObject({
        reason: "not_regular_file",
      });
    },
  );

  it("inventories several roots, each entry tagged with its root", async () => {
    const other = mkdtempSync(join(tmpdir(), "sys2qa-intake-b-"));
    try {
      tree({ "a.ts": "x" });
      writeFileSync(join(other, "b.py"), "x");
      const entries: InventoryEntry[] = [];
      const summary = await scanInventory(await RootSandbox.open([dir, other]), { budget }, (e) => {
        entries.push(e);
      });
      expect(entries.map((e) => [e.root, e.path])).toEqual([
        [0, "a.ts"],
        [1, "b.py"],
      ]);
      expect(summary.by_language).toEqual({ typescript: 1, python: 1 });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
