import childProcess from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetFor, RootSandbox, scanInventory, type InventoryEntry } from "../../packages/saa-core/src/index.js";
import { findSentinels, INJECTION_REPO } from "./harness/index.js";

const SPAWNING = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

/**
 * Process-spawn monitor: replaces every `child_process` entry point (CommonJS object and, through
 * `syncBuiltinESMExports`, the ESM named exports) with a recorder that refuses to start anything.
 */
function monitorSpawns(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const target = childProcess as unknown as Record<string, unknown>;
  const original = Object.fromEntries(SPAWNING.map((name) => [name, target[name]]));
  for (const name of SPAWNING)
    target[name] = (...args: unknown[]) => {
      calls.push(`${name} ${String(args[0])}`);
      throw new Error(`ST-02: ${name} called during analysis`);
    };
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      Object.assign(target, original);
      syncBuiltinESMExports();
    },
  };
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

let repo: string;
beforeEach(() => {
  repo = join(mkdtempSync(join(tmpdir(), "sys2qa-st02-")), "repo");
  cpSync(INJECTION_REPO, repo, { recursive: true });
});
afterEach(() => rmSync(join(repo, ".."), { recursive: true, force: true }));

describe("ST-02 no execution [@req SEC-002] [@req SAA-FR-004]", () => {
  it("inventories and reads a repository with install hooks, test files and a Makefile without running any of it", async () => {
    const before = snapshot(repo);
    const monitor = monitorSpawns();
    const entries: InventoryEntry[] = [];
    let texts = 0;
    try {
      const sandbox = await RootSandbox.open([repo]);
      await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
        entries.push(e);
      });
      // The parse stage reads every included file through the sandbox; reading never executes.
      for (const e of entries.filter((x) => x.status === "included")) {
        const read = await sandbox.readText(await sandbox.resolve(e.root, e.path), 1024 * 1024);
        if (read.kind === "text") texts++;
      }
    } finally {
      monitor.restore();
    }
    expect(entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(["package.json", "Makefile", "test/registration.test.mjs", "src/registration.ts"]),
    );
    expect(texts).toBe(entries.filter((e) => e.status === "included").length);
    expect(monitor.calls).toEqual([]);
    expect(findSentinels([repo, process.cwd()])).toEqual([]);
    expect(snapshot(repo)).toEqual(before);
  });

  it("the spawn monitor sees a process started through the ESM named export (detector check)", async () => {
    const monitor = monitorSpawns();
    try {
      const { spawnSync } = await import("node:child_process");
      expect(() => spawnSync(process.execPath, ["-e", "0"])).toThrow(/ST-02/);
    } finally {
      monitor.restore();
    }
    expect(monitor.calls).toEqual([`spawnSync ${process.execPath}`]);
  });
});
