import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeStructure,
  budgetFor,
  completenessReport,
  defaultPackagesDirectory,
  detectStack,
  EXPORT_WARNING,
  exportPackage,
  identifyRevision,
  persistSkbRun,
  repositoryBlock,
  RootSandbox,
  scanInventory,
  type ExportOptions,
  type InventoryEntry,
} from "../../packages/saa-core/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F4 = fileURLToPath(new URL("../../fixtures/benchmarks/F4-incomplete-evidence/repo/", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "sys2qa-st17-"));
let base: Omit<ExportOptions, "outputDir" | "packageVersion">;

beforeAll(async () => {
  const adapters = await bundleSaaAdapters(join(work, "adapters"));
  const sandbox = await RootSandbox.open([F4]);
  const inventory: InventoryEntry[] = [];
  await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
    inventory.push(e);
  });
  const included = inventory.filter((e) => e.status === "included");
  const stack = await detectStack(sandbox, included);
  const identity = await identifyRevision(sandbox, 0, included);
  const structure = await analyzeStructure({
    sandbox,
    included,
    boundaries: stack.boundaries,
    adapters,
    scratch: join(work, "scratch"),
    runId: "run:01JST17",
    revision: identity.revision.value,
  });
  const completeness = completenessReport({
    runId: "run:01JST17",
    roots: ["repo"],
    inventory,
    boundaries: stack.boundaries,
    structure,
  });
  const skbDir = join(work, "skb");
  persistSkbRun(skbDir, { runId: "run:01JST17", revision: identity.revision, structure, completeness, stack });
  base = {
    skbDir,
    analyzedRoots: [F4],
    packageId: "pkg:f4",
    project: { system_id: "system:f4", name: "F4" },
    repository: repositoryBlock(identity, "local/f4"),
    analysis: {
      started_at: "2026-10-26T00:00:00Z",
      finished_at: "2026-10-26T00:01:00Z",
      scope: { roots: ["."], excluded: [] },
    },
    warningMarker: join(work, "home", "export-warning-shown"),
  };
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Each export writes and fsyncs dozens of files; loaded Windows runners need more than Vitest's 5 s default. */
const EXPORT_TIMEOUT = 60_000;

describe("ST-17 output warnings and location [@req SEC-016] [@req SAA-FR-036]", () => {
  it(
    "shows the topology warning on the first export only",
    () => {
      const outputDir = join(work, "out-warning");
      const first = exportPackage({ ...base, outputDir, packageVersion: 1 });

      expect(first).toMatchObject({ status: "exported", warning: EXPORT_WARNING });
      const second = exportPackage({ ...base, outputDir, packageVersion: 2 });
      expect(second.status).toBe("exported");
      expect(second).not.toHaveProperty("warning");
      // A later version names the one before it; without one it is refused.
      if (second.status === "exported") expect(second.manifest.previous_package).toMatchObject({ package_version: 1 });
      expect(exportPackage({ ...base, outputDir: join(work, "out-empty"), packageVersion: 3 })).toMatchObject({
        status: "refused",
        reason: "previous_package_unknown",
      });
    },
    EXPORT_TIMEOUT,
  );

  it(
    "defaults outside the repository and refuses output inside an analyzed root unless allowed",
    () => {
      const home = join(work, "home");
      const dir = defaultPackagesDirectory(home, "01JPROJECTST17");
      expect(dir.startsWith(F4)).toBe(false);
      expect(exportPackage({ ...base, outputDir: dir, packageVersion: 1 }).status).toBe("exported");
      // Inside the root, directly or through a link that resolves into it.
      expect(exportPackage({ ...base, outputDir: join(F4, ".saa", "packages"), packageVersion: 1 })).toMatchObject({
        status: "refused",
        reason: "output_inside_analyzed_root",
      });
      if (process.platform !== "win32") {
        const link = join(work, "link-into-repo");
        symlinkSync(F4, link);
        expect(exportPackage({ ...base, outputDir: join(link, "docs"), packageVersion: 1 })).toMatchObject({
          status: "refused",
          reason: "output_inside_analyzed_root",
        });
      }
      // Opting in writes into a root (a copy here, so the fixture stays untouched).
      const optIn = join(work, "repo-copy");
      mkdirSync(optIn, { recursive: true });
      expect(
        exportPackage({
          ...base,
          analyzedRoots: [optIn],
          outputDir: join(optIn, ".saa"),
          packageVersion: 1,
          allowInRepository: true,
        }).status,
      ).toBe("exported");
    },
    EXPORT_TIMEOUT,
  );
});
