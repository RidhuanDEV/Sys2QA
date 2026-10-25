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
  normalizeRoutePath,
  RootSandbox,
  scanInventory,
  type InventoryEntry,
} from "../src/index.js";

const fixture = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const F1 = fixture("benchmarks/F1-repository-only/repo/");
const MONOREPO = fixture("saa/monorepo/repo/");
const NEXTJS = fixture("saa/nextjs/repo/");
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

describe("framework layer [@req SAA-FR-007] [@req SAA-FR-031]", () => {
  it("matches F1's route, page and form ground truth, and reports what it cannot see", async () => {
    const truth = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "entities.json"), "utf8")) as {
      entities: Array<{ id: string; kind: string }>;
    };
    const gaps = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "gaps.json"), "utf8")) as {
      gaps: Array<{ key: string; type: string; related: string[] }>;
    };
    const result = await analyze(F1);
    const byId = new Map(result.entities.map((e) => [e.id, e]));
    const expected = truth.entities.filter((e) => ["api", "page", "form"].includes(e.kind)).map((e) => e.id);
    expect(expected.filter((id) => !byId.has(id))).toEqual([]);
    // Nothing beyond the ground truth: the never-mounted legacy export is not an endpoint (forbidden claim).
    const produced = result.entities
      .filter((e) => ["api", "page", "form"].includes(e.kind))
      .map((e) => e.id)
      .sort();
    expect(produced).toEqual([...expected].sort());
    expect(result.coverage).toContainEqual({
      area: "src/server/legacy/export.ts",
      status: "analyzed",
      reason: "router legacyExportRouter is never mounted on an application; its 1 route(s) are not part of the API",
    });
    // The dynamic report routes are a gap on the plugins module, as the ground truth requires.
    const dynamicTruth = gaps.gaps.find((g) => g.key === "dynamic-report-routes")!;
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        type: dynamicTruth.type,
        related_entity_ids: dynamicTruth.related,
        status: "unresolved",
      }),
    );
    expect(result.entities.some((e) => e.id.startsWith("api:GET:/api/reports"))).toBe(false);
    // Forms carry their endpoint and field constraints; middleware is kept for the rules layer.
    expect(byId.get("form:web:/register#register")).toMatchObject({
      page_id: "page:web:/register",
      submits_to: "api:POST:/api/auth/register",
    });
    expect(byId.get("field:web:/register#register.nib")).toMatchObject({
      constraints: { required: true, pattern: "[0-9]{13}", max_length: 13 },
    });
    expect(byId.get("field:web:/orders/new#new-order.amount")).toMatchObject({
      constraints: { required: true, min: 1, max: 10000, input_type: "number" },
    });
    expect(byId.get("api:POST:/api/orders/{id}/decision")).toMatchObject({
      middleware: [{ name: "requireRole", args: ["ADMIN"] }],
    });
    const submits = result.relationships.filter((r) => r.type === "SUBMITS_TO").map((r) => `${r.from} -> ${r.to}`);
    expect(submits).toContain("form:web:/reset-password#reset-confirm -> api:POST:/api/auth/password-reset/confirm");
    expect(result.gaps.filter((g) => g.id.startsWith("gap:endpoint:"))).toEqual([]);
    for (const e of result.entities) expect(validateJsonSchema(ENTITY, e).errors, e.id).toEqual([]);
    for (const g of result.gaps)
      expect(
        validateJsonSchema({ $ref: "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/gap" }, g).errors,
      ).toEqual([]);
  }, 60_000);

  it("derives Next.js pages and route handlers from the app and pages directories", async () => {
    const result = await analyze(NEXTJS);
    const ids = result.entities
      .filter((e) => e.kind === "page" || e.kind === "api")
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual([
      "api:ANY:/api/health",
      "api:GET:/api/orders",
      "api:POST:/api/orders",
      "page:app:/",
      "page:app:/legacy",
      "page:app:/orders/{id}",
    ]);
  }, 60_000);

  it("normalizes route parameters of Express, React Router and Next.js alike", () => {
    expect(normalizeRoutePath("/orders/:id/")).toBe("/orders/{id}");
    expect(normalizeRoutePath("/orders/[id]")).toBe("/orders/{id}");
    expect(normalizeRoutePath("/docs/[...slug]")).toBe("/docs/{slug}");
    expect(normalizeRoutePath("/search?q=1")).toBe("/search");
    expect(normalizeRoutePath("")).toBe("/");
  });
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
