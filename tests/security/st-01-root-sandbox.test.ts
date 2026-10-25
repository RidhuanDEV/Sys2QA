import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, memorySink, Redactor } from "../../packages/platform/src/index.js";
import { budgetFor, RootSandbox, scanInventory, type InventoryEntry } from "../../packages/saa-core/src/index.js";

let base: string;
let repo: string;
let outside: string;
let log: ReturnType<typeof memorySink>;
/** Links this platform could create (Windows needs privileges for file symlinks; junctions always work). */
const created = new Set<string>();

function link(target: string, name: string, type: "file" | "dir"): void {
  try {
    symlinkSync(target, join(repo, name), type === "dir" && process.platform === "win32" ? "junction" : type);
    created.add(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
}

async function sandbox(): Promise<RootSandbox> {
  return RootSandbox.open([repo], { logger: createLogger({ sink: log, redactor: new Redactor() }) });
}

function denials(): Array<{ path: string; reason: string }> {
  return log.lines
    .map((l) => JSON.parse(l) as { event: string; path: string; reason: string })
    .filter((l) => l.event === "sandbox.denied")
    .map(({ path, reason }) => ({ path, reason }));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-st01-"));
  repo = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(outside, "secret.txt"), "SYS2QA_OUTSIDE_CONTENT\n");
  // If the sandbox followed the symlinked .gitignore below, every .ts file would be excluded.
  writeFileSync(join(outside, "ignore"), "*.ts\n");
  log = memorySink();
  created.clear();
  link(join(outside, "secret.txt"), "link-file", "file");
  link(outside, "link-dir", "dir");
  link(join(outside, "ignore"), ".gitignore", "file");
  link(join(repo, "src"), "inner-link", "dir");
  link(join(base, "missing"), "broken", "file");
  if (process.platform !== "win32") link("/etc", "etc", "dir");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("ST-01 root sandbox [@req SEC-001]", () => {
  it("refuses traversal, absolute, drive, UNC and NUL paths before touching the filesystem", async () => {
    const box = await sandbox();
    const cases: Array<[string, string]> = [
      ["../outside/secret.txt", "parent_traversal"],
      ["src/../../outside/secret.txt", "parent_traversal"],
      ["src\\..\\..\\outside\\secret.txt", "parent_traversal"],
      [join(outside, "secret.txt"), "absolute_path"],
      ["/etc/passwd", "absolute_path"],
      ["C:\\Windows\\win.ini", "absolute_path"],
      ["C:secret.txt", "absolute_path"],
      ["\\\\server\\share\\file", "absolute_path"],
      ["src/a.ts\0.png", "invalid_path"],
    ];
    for (const [path, reason] of cases)
      await expect(box.resolve(0, path), path).rejects.toMatchObject({ code: "SANDBOX_DENIED", reason });
    expect(denials()).toEqual(cases.map(([path, reason]) => ({ path, reason })));
  });

  it("refuses symlinks and junctions that leave the root, and reads nothing through them", async () => {
    const box = await sandbox();
    const escaping = ["link-file", "link-dir", "link-dir/secret.txt", "etc", "etc/passwd", ".gitignore"].filter((p) =>
      created.has(p.split("/")[0]!),
    );
    expect(escaping.length).toBeGreaterThan(0);
    for (const path of escaping)
      await expect(box.resolve(0, path), path).rejects.toMatchObject({ reason: "symlink_outside_root" });
    if (created.has("inner-link"))
      expect(await box.resolve(0, "inner-link/a.ts")).toMatchObject({ path: "inner-link/a.ts" });
    // The log names the requested path only, never the target outside the root.
    expect(log.lines.join("\n")).not.toContain(outside);
  });

  it("inventories the hostile repository without leaving the root", async () => {
    const entries: InventoryEntry[] = [];
    const summary = await scanInventory(await sandbox(), { budget: budgetFor("standard") }, (e) => {
      entries.push(e);
    });
    const byPath = new Map(entries.map((e) => [e.path, e]));
    for (const name of ["link-file", "link-dir", "etc", ".gitignore"].filter((n) => created.has(n)))
      expect(byPath.get(name), name).toMatchObject({
        type: "symlink",
        status: "excluded",
        reason: "symlink_outside_root",
      });
    if (created.has("inner-link"))
      expect(byPath.get("inner-link")).toMatchObject({ status: "skipped", reason: "symlink_not_followed" });
    if (created.has("broken"))
      expect(byPath.get("broken")).toMatchObject({ status: "skipped", reason: "broken_symlink" });
    // The escaping .gitignore was not read: the source file is still included.
    expect(byPath.get("src/a.ts")).toMatchObject({ status: "included" });
    expect(entries.every((e) => !e.path.includes("secret") && !e.path.startsWith("etc/"))).toBe(true);
    expect(summary.by_reason.symlink_outside_root).toBe(
      ["link-file", "link-dir", "etc", ".gitignore"].filter((n) => created.has(n)).length,
    );
    expect(denials().length).toBeGreaterThanOrEqual(summary.by_reason.symlink_outside_root ?? 0);
  });

  it("refuses a root that does not exist or is not a directory", async () => {
    await expect(RootSandbox.open([join(base, "nope")])).rejects.toMatchObject({ code: "ROOT_INVALID" });
    await expect(RootSandbox.open([join(repo, "src", "a.ts")])).rejects.toMatchObject({ code: "ROOT_INVALID" });
    await expect(RootSandbox.open([])).rejects.toMatchObject({ code: "ROOT_INVALID" });
  });
});
