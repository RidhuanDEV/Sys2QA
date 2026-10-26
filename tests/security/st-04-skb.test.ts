import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runDirectory } from "../../packages/platform/src/index.js";
import {
  analyzeStructure,
  budgetFor,
  completenessReport,
  detectStack,
  loadSkbView,
  persistSkbRun,
  renderDocumentation,
  RootSandbox,
  scanInventory,
  type InventoryEntry,
} from "../../packages/saa-core/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";
import { INJECTION_REPO, scanText } from "./harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo/", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "sys2qa-st04-skb-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("ST-04 secret leakage: SKB partitions, the adapter cache and rendered documents [@req SEC-004] [@req SAA-FR-012] [@req SAA-FR-013]", () => {
  it("no SKB file, cache file or rendered document contains a planted secret", async () => {
    const adapters = await bundleSaaAdapters(join(work, "adapters"));
    const home = join(work, "home");
    const documents: Array<[string, string]> = [];
    for (const [i, root] of [INJECTION_REPO, F1].entries()) {
      const sandbox = await RootSandbox.open([root]);
      const inventory: InventoryEntry[] = [];
      await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
        inventory.push(e);
      });
      const included = inventory.filter((e) => e.status === "included");
      const stack = await detectStack(sandbox, included);
      const runId = `run:01JST04SKB${i}`;
      const structure = await analyzeStructure({
        sandbox,
        included,
        boundaries: stack.boundaries,
        adapters,
        scratch: join(work, `scratch${i}`),
        runId,
        revision: "0".repeat(40),
        cache: { dir: join(home, "projects", "01JPROJECTST04", "cache", "adapters") },
      });
      const completeness = completenessReport({
        runId,
        roots: ["repo"],
        inventory,
        boundaries: stack.boundaries,
        structure,
      });
      const dir = runDirectory(home, "project:01JPROJECTST04", runId);
      persistSkbRun(dir, {
        runId,
        revision: { kind: "git_commit", value: "0".repeat(40), worktree_dirty: false },
        structure,
        completeness,
        stack,
      });
      for (const doc of renderDocumentation(loadSkbView(dir))) documents.push([doc.path, doc.markdown]);
    }
    const files = filesUnder(home);
    expect(files.some((f) => f.endsWith("manifest.json"))).toBe(true);
    expect(files.some((f) => f.includes(join("cache", "adapters")))).toBe(true);
    const leaks = files.flatMap((f) => scanText(readFileSync(f, "utf8"), f));
    expect(leaks).toEqual([]);
    expect(documents.length).toBeGreaterThan(40);
    expect(documents.flatMap(([path, text]) => scanText(text, path))).toEqual([]);
    // The files holding planted secrets were analyzed and stored (as facts and digests), not skipped.
    const stored = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(stored).toContain("src/registration.ts");
    expect(stored).toContain("src/server/config.ts");
  }, 120_000);
});
