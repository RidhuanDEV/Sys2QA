import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLogger, memorySink, Redactor } from "../../packages/platform/src/index.js";
import {
  budgetFor,
  identifyRevision,
  readForAnalysis,
  RootSandbox,
  scanInventory,
  type InventoryEntry,
} from "../../packages/saa-core/src/index.js";
import { INJECTION_REPO, scanText } from "./harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo/", import.meta.url));

describe("ST-04 secret leakage: Gate 1 intake outputs [@req SEC-004] [@req SAA-FR-018]", () => {
  it("inventory, analysis reads, secret locations, revision identity and logs contain no planted secret", async () => {
    const log = memorySink();
    const outputs: Array<[string, unknown]> = [];
    let withheld = 0;
    let redactedFiles = 0;
    for (const root of [INJECTION_REPO, F1]) {
      const sandbox = await RootSandbox.open([root], {
        logger: createLogger({ sink: log, redactor: new Redactor(), level: "debug" }),
      });
      const included: InventoryEntry[] = [];
      const summary = await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
        outputs.push([`inventory ${e.path}`, e]);
        if (e.status === "included") included.push(e);
      });
      outputs.push(["summary", summary]);
      for (const entry of included) {
        const read = await readForAnalysis(sandbox, entry, 1024 * 1024);
        outputs.push([`read ${entry.path}`, read]);
        if (read.kind === "withheld") withheld++;
        if (read.kind === "text" && read.secrets.length > 0) redactedFiles++;
      }
      outputs.push(["revision", await identifyRevision(sandbox, 0, included)]);
    }
    for (const line of log.lines) outputs.push(["log", line]);

    const leaks = outputs.flatMap(([where, value]) => scanText(JSON.stringify(value), where));
    expect(leaks).toEqual([]);
    // The fixtures did hold secrets: one withheld .env file, and source files whose secrets were redacted.
    expect(withheld).toBe(1);
    expect(redactedFiles).toBeGreaterThanOrEqual(2);
  });

  it("the raw content of the same files does contain planted secrets (detector check)", async () => {
    const sandbox = await RootSandbox.open([INJECTION_REPO]);
    const raw = await sandbox.readText(await sandbox.resolve(0, "src/registration.ts"), 1024 * 1024);
    expect(raw.kind).toBe("text");
    expect(scanText(JSON.stringify(raw), "raw").map((l) => l.secret)).toEqual(
      expect.arrayContaining(["aws_access_key_id", "env_db_password"]),
    );
  });
});
