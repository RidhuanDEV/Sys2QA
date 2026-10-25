import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetFor, RootSandbox, scanInventory } from "../src/index.js";

const DIRECTORIES = 500;
const FILES_PER_DIRECTORY = 200;
const TOTAL = DIRECTORIES * FILES_PER_DIRECTORY;

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sys2qa-100k-"));
  for (let d = 0; d < DIRECTORIES; d++) {
    const dir = join(root, `pkg${String(d).padStart(3, "0")}`, "src");
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_DIRECTORY; f++) writeFileSync(join(dir, `m${f}.ts`), "export {};\n");
  }
}, 600_000);
afterAll(() => rmSync(root, { recursive: true, force: true }), 600_000);

describe("100k-file inventory [@req NFR-002] [@req SAA-FR-001]", () => {
  it("streams 100k files within the standard budget without holding the inventory in memory", async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    let count = 0;
    let peak = 0;
    const summary = await scanInventory(await RootSandbox.open([root]), { budget: budgetFor("standard") }, () => {
      count++;
      if (count % 10_000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - heapBefore);
    });
    expect(count).toBe(TOTAL);
    expect(summary).toMatchObject({ status: "complete", counts: { included: TOTAL } });
    expect(summary.duration_ms).toBeLessThan(budgetFor("standard").max_minutes * 60_000);
    // Entries are handed to the sink and dropped. Measured on Linux: about 2 MB of heap growth while streaming,
    // about 24 MB when a sink retains every entry.
    expect(peak).toBeLessThan(16 * 1024 ** 2);
  }, 600_000);
});
