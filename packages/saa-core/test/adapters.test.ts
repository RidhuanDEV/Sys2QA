import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import { adapterMatrixText, describeAdapters, supportFromAdapters } from "../src/index.js";

let base: string;
let entry: string;
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-describe-"));
  entry = await bundleAdapter({
    entry: fileURLToPath(new URL("../../saa-adapters/test/fixtures/test-adapter.ts", import.meta.url)),
    outfile: join(base, "bundle", "test-adapter.mjs"),
  });
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("adapter inventory [@req SAA-FR-047] [@req SAA-FR-003]", () => {
  it("collects declared matrices, lists unavailable adapters, and feeds support levels to the stack report", async () => {
    const inventory = await describeAdapters(join(base, "work"), [
      { id: "test-adapter", entry, args: ["normal"] },
      { id: "test-adapter", entry, args: ["v2"] },
      { id: "sql", entry: join(base, "nowhere.mjs"), built: false },
    ]);
    expect(inventory.adapters.map((a) => a.adapter_id)).toEqual(["test-adapter"]);
    expect(inventory.failures).toEqual([
      { id: "test-adapter", code: "ADAPTER_INCOMPATIBLE", message: expect.any(String) },
      { id: "sql", code: "ADAPTER_NOT_BUILT", message: expect.stringContaining("pnpm build:adapters") },
    ]);
    const support = supportFromAdapters(inventory);
    expect([support.language("typescript"), support.framework("express"), support.framework("nextjs")]).toEqual([
      "analyzed",
      "analyzed",
      "unsupported",
    ]);
    expect(adapterMatrixText(inventory)).toContain("sql: unavailable (ADAPTER_NOT_BUILT");
  });

  it("reports an installation without adapters", async () => {
    expect(await describeAdapters(join(base, "work"), [])).toEqual({ adapters: [], failures: [] });
  });
});
