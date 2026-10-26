import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePackage } from "@sys2qa/contract";
import { PackageInvalidError, PackageQuery, readPackageDirectory } from "@sys2qa/system-model";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import {
  analyzeStructure,
  budgetFor,
  completenessReport,
  detectStack,
  exportPackage,
  identifyRevision,
  persistSkbRun,
  repositoryBlock,
  RootSandbox,
  scanInventory,
  type ExportOptions,
  type InventoryEntry,
} from "../src/index.js";

const fixture = (p: string) => fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url));
const F1 = fixture("benchmarks/F1-repository-only/repo/");
const F4 = fixture("benchmarks/F4-incomplete-evidence/repo/");
let base: string;
let adapters: Array<{ id: string; entry: string }>;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-export-"));
  adapters = [];
  for (const id of ["js-ts", "sql", "config", "docs"])
    adapters.push({
      id,
      entry: await bundleAdapter({
        entry: fileURLToPath(new URL(`../../saa-adapters/src/adapters/${id}/main.ts`, import.meta.url)),
        outfile: join(base, "bundle", `${id}.mjs`),
      }),
    });
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Analyzes a fixture into an SKB run and returns the export options for it. */
async function prepare(root: string, name: string, claimRevision?: string): Promise<ExportOptions> {
  const sandbox = await RootSandbox.open([root]);
  const inventory: InventoryEntry[] = [];
  await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
    inventory.push(e);
  });
  const included = inventory.filter((e) => e.status === "included");
  const stack = await detectStack(sandbox, included);
  const identity = await identifyRevision(sandbox, 0, included);
  const runId = `run:01JEXPORT${name}`;
  const structure = await analyzeStructure({
    sandbox,
    included,
    boundaries: stack.boundaries,
    adapters,
    scratch: join(base, `scratch-${name}`),
    runId,
    revision: claimRevision ?? identity.revision.value,
  });
  const completeness = completenessReport({
    runId,
    roots: ["repo"],
    inventory,
    boundaries: stack.boundaries,
    structure,
  });
  const skbDir = join(base, "skb", name);
  persistSkbRun(skbDir, { runId, revision: identity.revision, structure, completeness, stack });
  return {
    skbDir,
    outputDir: join(base, "out"),
    analyzedRoots: [root],
    packageId: `pkg:${name.toLowerCase()}`,
    packageVersion: 1,
    project: { system_id: `system:${name.toLowerCase()}`, name },
    repository: repositoryBlock(identity, `local/${name.toLowerCase()}`),
    analysis: {
      started_at: "2026-10-26T00:00:00Z",
      finished_at: "2026-10-26T00:01:00Z",
      scope: { roots: ["."], excluded: [] },
    },
    now: () => new Date("2026-10-26T00:02:00Z"),
  };
}

describe("package export [@req SAA-FR-029] [@req SAA-FR-036]", () => {
  it("exports F1 and F4 as packages that pass the conformance suite, with checksums that match", async () => {
    for (const [root, name] of [
      [F1, "F1"],
      [F4, "F4"],
    ] as const) {
      const options = await prepare(root, name);
      const result = exportPackage(options);
      expect(result.status, name).toBe("exported");
      if (result.status !== "exported") continue;
      // Read back from disk, as a consumer would.
      const files = readPackageDirectory(result.path);
      const validation = validatePackage({ files });
      expect(
        validation.issues.filter((i) => i.severity === "error"),
        name,
      ).toEqual([]);
      expect(validation.stage).toBe("complete");
      const manifest = JSON.parse(readFileSync(join(result.path, "manifest.json"), "utf8")) as {
        artifacts: Array<{ path: string; sha256: string; role: string; language?: string }>;
        evidence_profile: { source_analysis: string };
      };
      for (const a of manifest.artifacts)
        expect(`sha256:${createHash("sha256").update(files.get(a.path)!).digest("hex")}`, a.path).toBe(a.sha256);
      expect(manifest.evidence_profile.source_analysis).toBe("available");
      expect(
        manifest.artifacts
          .filter((a) => a.role === "executive_summary")
          .map((a) => a.language)
          .sort(),
      ).toEqual(["en", "id"]);
      // No staging directory is left behind.
      expect(readdirSync(options.outputDir).filter((n) => n.startsWith(".staging-"))).toEqual([]);
    }
  }, 180_000);

  it("never overwrites a package version and never publishes an invalid package", async () => {
    const options = await prepare(F4, "F4IMMUTABLE");
    expect(exportPackage(options).status).toBe("exported");
    const before = readFileSync(join(options.outputDir, "f4immutable", "1", "manifest.json"), "utf8");
    expect(exportPackage(options)).toMatchObject({ status: "refused", reason: "package_version_exists" });
    expect(readFileSync(join(options.outputDir, "f4immutable", "1", "manifest.json"), "utf8")).toBe(before);
    // Claims validated at another revision make the package invalid: nothing is published, nothing is left over.
    const stale = await prepare(F1, "F1STALE", "f".repeat(40));
    const result = exportPackage(stale);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.issues.some((i) => i.rule === "CR-011")).toBe(true);
    expect(existsSync(join(stale.outputDir, "f1stale"))).toBe(false);
    expect(readdirSync(stale.outputDir).filter((n) => n.startsWith(".staging-"))).toEqual([]);
  }, 180_000);
});

describe("local query library [@req SAA-FR-015]", () => {
  it("answers QAA's questions from an exported package", async () => {
    const options = await prepare(F1, "F1QUERY");
    const result = exportPackage(options);
    if (result.status !== "exported") throw new Error(result.status);
    const q = PackageQuery.open(result.path);
    expect(q.workflows().map((w) => w.id)).toContain("workflow:page:web:/register");
    expect(q.workflows("scheduled_processing").map((w) => w.id)).toEqual(["workflow:job:cleanup.nightly"]);
    expect(q.contracts().find((c) => c.api.id === "api:POST:/api/orders/{id}/decision")?.authorizes).toEqual([
      "actor_role:admin",
    ]);
    expect(q.rules().map((r) => r.id)).toContain("business_rule:order.amount_1_to_10000");
    expect(q.stateMachines().map((m) => m.id)).toEqual(["state_machine:order.status"]);
    expect(q.evidenceFor("business_rule:order.amount_1_to_10000").map((e) => e.source_type)).toContain("migration");
    expect(q.unknowns().questions.map((g) => g.id)).toContain(
      "gap:contradiction:registration.password_min_12_characters",
    );
    expect(q.dependencies("module:server.routes.orders")).toContain("module:server.orders.state");
    const revision = q.revision as { kind: string; value: string };
    expect(q.freshness(revision)).toBe("current");
    expect(q.freshness({ kind: revision.kind, value: "sha256:other" })).toBe("mismatched");
    expect(q.freshness()).toBe("unverifiable");
    expect(q.document("business_rules", "id")).toContain("# Aturan bisnis dan status");
    // A tampered package is refused.
    writeFileSync(join(result.path, "system-model.json"), "{}");
    expect(() => PackageQuery.open(result.path)).toThrow(PackageInvalidError);
  }, 180_000);
});
