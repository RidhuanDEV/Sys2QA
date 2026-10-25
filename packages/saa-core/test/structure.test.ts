import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "@sys2qa/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import {
  analyzeStructure,
  budgetFor,
  detectStack,
  findCycles,
  RootSandbox,
  scanInventory,
  type InventoryEntry,
} from "../src/index.js";

const fixture = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const F1 = fixture("benchmarks/F1-repository-only/repo/");
const MONOREPO = fixture("saa/monorepo/repo/");
const ENTITY = { $ref: "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/entity" };
const RELATIONSHIP = { $ref: "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/relationship" };

let base: string;
let entry: string;
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-structure-"));
  entry = await bundleAdapter({
    entry: fileURLToPath(new URL("../../saa-adapters/src/adapters/js-ts/main.ts", import.meta.url)),
    outfile: join(base, "bundle", "js-ts.mjs"),
  });
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function analyze(root: string) {
  const sandbox = await RootSandbox.open([root]);
  const included: InventoryEntry[] = [];
  await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
    if (e.status === "included") included.push(e);
  });
  const stack = await detectStack(sandbox, included);
  return analyzeStructure({
    sandbox,
    included,
    boundaries: stack.boundaries,
    adapters: [{ id: "js-ts", entry }],
    scratch: join(base, "scratch"),
    runId: "run:01JSTRUCTURE",
    batchSize: 5,
  });
}

describe("structural extraction through the js-ts adapter [@req SAA-FR-005] [@req SAA-FR-006]", () => {
  it("matches F1's structural ground truth and links references across batches", async () => {
    const truth = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "entities.json"), "utf8")) as {
      entities: Array<{ id: string; kind: string }>;
    };
    const result = await analyze(F1);
    const ids = new Set(result.entities.map((e) => e.id));
    for (const expected of truth.entities.filter((e) => e.kind === "module"))
      expect(ids, expected.id).toContain(expected.id);
    expect(result.adapters.map((a) => a.adapter_id)).toEqual(["js-ts"]);
    expect(result.failed_batches).toEqual([]);
    // Every fact is contract-valid.
    for (const e of result.entities) expect(validateJsonSchema(ENTITY, e).errors, e.id).toEqual([]);
    for (const r of result.relationships) expect(validateJsonSchema(RELATIONSHIP, r).errors, r.id).toEqual([]);
    // The generated Prisma client is excluded, so importing it is reported, not invented.
    expect(ids.has("module:generated")).toBe(false);
    expect(result.graph.unanalyzed_targets).toContainEqual({ from: "module:server.db", to: "module:generated" });
    // Batches of five: references from app.ts to modules in other batches are still linked.
    expect(result.relationships.filter((r) => r.type === "REFERENCES").length).toBeGreaterThan(0);
    expect(result.graph.edges.length).toBeGreaterThan(0);
    expect(result.coverage.filter((c) => c.status === "failed")).toEqual([]);
  }, 60_000);

  it("keeps monorepo boundaries apart and derives boundary dependencies from workspace imports", async () => {
    const result = await analyze(MONOREPO);
    expect(result.entities.find((e) => e.id === "module:apps/web:main")).toMatchObject({
      project_boundary: "project:apps/web",
    });
    expect(result.entities.find((e) => e.id === "module:apps/api:server")).toMatchObject({
      project_boundary: "project:apps/api",
    });
    expect(result.graph.projects).toEqual([
      { from: "project:apps/api", to: "project:packages/shared", packages: ["@acme/shared"] },
      { from: "project:apps/web", to: "project:packages/shared", packages: ["@acme/shared"] },
    ]);
    expect(
      result.relationships
        .filter((r) => r.type === "DEPENDS_ON")
        .map((r) => `${r.from} -> ${r.to}`)
        .sort(),
    ).toEqual(["project:apps/api -> project:packages/shared", "project:apps/web -> project:packages/shared"]);
    // Python is not sent to the js-ts adapter.
    expect(result.coverage.some((c) => c.area.endsWith(".py"))).toBe(false);
  }, 60_000);
});

describe("import cycles [@req SAA-FR-006]", () => {
  it("reports each cycle once, including self-imports, without walking it again", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      { from: "c", to: "d" },
      { from: "e", to: "e" },
      { from: "f", to: "a" },
    ];
    expect(findCycles(["a", "b", "c", "d", "e", "f"], edges)).toEqual([["a", "b", "c"], ["e"]]);
    // A long chain does not overflow the stack.
    const chain = Array.from({ length: 50_000 }, (_, i) => ({ from: `m${i}`, to: `m${i + 1}` }));
    expect(
      findCycles(
        chain.map((e) => e.from),
        [...chain, { from: "m50000", to: "m0" }],
      ),
    ).toHaveLength(1);
  });
});
