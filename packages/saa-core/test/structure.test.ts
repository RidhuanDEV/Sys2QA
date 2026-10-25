import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema, type Entity } from "@sys2qa/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import {
  analyzeStructure,
  budgetFor,
  detectStack,
  findCycles,
  composeWorkflows,
  deepenWorkflow,
  linkRules,
  outcomeOf,
  rulesOfField,
  normalizeRoutePath,
  RootSandbox,
  scheduleLabel,
  scanInventory,
  type InventoryEntry,
} from "../src/index.js";

const fixture = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const F1 = fixture("benchmarks/F1-repository-only/repo/");
const F4 = fixture("benchmarks/F4-incomplete-evidence/repo/");
const MONOREPO = fixture("saa/monorepo/repo/");
const NEXTJS = fixture("saa/nextjs/repo/");
const CONFIG = fixture("saa/config/repo/");
const ENTITY = { $ref: "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/entity" };
const RELATIONSHIP = { $ref: "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/relationship" };

let base: string;
let entry: string;
let sqlEntry: string;
let configEntry: string;
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-structure-"));
  entry = await bundleAdapter({
    entry: fileURLToPath(new URL("../../saa-adapters/src/adapters/js-ts/main.ts", import.meta.url)),
    outfile: join(base, "bundle", "js-ts.mjs"),
  });
  sqlEntry = await bundleAdapter({
    entry: fileURLToPath(new URL("../../saa-adapters/src/adapters/sql/main.ts", import.meta.url)),
    outfile: join(base, "bundle", "sql.mjs"),
  });
  configEntry = await bundleAdapter({
    entry: fileURLToPath(new URL("../../saa-adapters/src/adapters/config/main.ts", import.meta.url)),
    outfile: join(base, "bundle", "config.mjs"),
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
    adapters: [
      { id: "js-ts", entry },
      { id: "sql", entry: sqlEntry },
      { id: "config", entry: configEntry },
    ],
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
    expect(result.adapters.map((a) => a.adapter_id)).toEqual(["js-ts", "sql", "config"]);
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

describe("data model [@req SAA-FR-008]", () => {
  it("matches F1's data-model ground truth with declared mappings, keys, checks and enum values", async () => {
    const truth = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "entities.json"), "utf8")) as {
      entities: Array<{ id: string; kind: string }>;
    };
    const result = await analyze(F1);
    const expected = truth.entities
      .filter((e) => e.kind === "entity" || e.kind === "table")
      .map((e) => e.id)
      .sort();
    const produced = result.entities
      .filter((e) => e.kind === "entity" || e.kind === "table")
      .map((e) => e.id)
      .sort();
    expect(produced).toEqual(expected);
    const byId = new Map(result.entities.map((e) => [e.id, e]));
    expect(byId.get("entity:order")).toMatchObject({ status: "source_verified", name: "Order" });
    expect(byId.get("orm_model:Order")).toMatchObject({ mapping: "declared_default_name", table_id: "table:Order" });
    expect(byId.get("column:Order.amount")).toMatchObject({
      checks: [`"amount" BETWEEN 1 AND 10000`],
      constraints: { required: true },
    });
    expect(byId.get("column:Order.status")).toMatchObject({
      default: "'DRAFT'",
      enum_type: "OrderStatus",
      allowed_values: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "SHIPPED"],
    });
    expect(byId.get("column:User.nib")).toMatchObject({ unique: true, data_type: "CHAR(13)" });
    const rel = result.relationships.map((r) => `${r.type} ${r.from} ${r.to} ${r.status}`);
    expect(rel).toEqual(
      expect.arrayContaining([
        "USES_SCHEMA entity:user table:User source_verified",
        "REFERENCES table:Order table:User source_verified",
        "REFERENCES table:PasswordResetToken table:User source_verified",
        "REFERENCES entity:order entity:user source_verified",
      ]),
    );
    for (const e of result.entities) expect(validateJsonSchema(ENTITY, e).errors, e.id).toEqual([]);
    for (const r of result.relationships) expect(validateJsonSchema(RELATIONSHIP, r).errors, r.id).toEqual([]);
  }, 60_000);

  it("applies migrations in order and infers an entity for a table no ORM model declares", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sys2qa-migrations-"));
    try {
      mkdirSync(join(dir, "db", "migrations"), { recursive: true });
      const write = (name: string, sql: string) => writeFileSync(join(dir, "db", "migrations", name), sql);
      write(
        "2_add_status.sql",
        "ALTER TABLE invoices ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN';\nALTER TABLE invoices RENAME COLUMN total TO amount;\n",
      );
      write(
        "10_drop_legacy.sql",
        "DROP TABLE legacy_invoices;\nALTER TABLE invoices ADD CONSTRAINT amount_ok CHECK (amount > 0);\n",
      );
      write(
        "1_init.sql",
        "CREATE TABLE invoices (id INT PRIMARY KEY, total INT);\nCREATE TABLE legacy_invoices (id INT);\n",
      );
      const result = await analyze(dir);
      const ids = result.entities
        .filter((e) => ["table", "column", "entity"].includes(e.kind))
        .map((e) => e.id)
        .sort();
      expect(ids).toEqual([
        "column:invoices.amount",
        "column:invoices.id",
        "column:invoices.status",
        "entity:invoices",
        "table:invoices",
      ]);
      expect(result.entities.find((e) => e.id === "table:invoices")).toMatchObject({ checks: ["amount > 0"] });
      expect(result.entities.find((e) => e.id === "entity:invoices")).toMatchObject({
        status: "inferred",
        confidence_rationale: expect.stringContaining("no ORM model"),
      });
      expect(result.coverage).toContainEqual({
        area: "db/migrations/10_drop_legacy.sql",
        status: "analyzed",
        reason: "table legacy_invoices is dropped by a later migration and is not modeled",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("configuration and deployment [@req SAA-FR-020] [@req SEC-002]", () => {
  it("extracts F1's configuration keys from code by name, never their fallback values", async () => {
    const result = await analyze(F1);
    const keys = result.entities.filter((e) => e.kind === "config_key");
    expect(keys.map((k) => k.id)).toEqual([
      "config_key:AWS_ACCESS_KEY_ID",
      "config_key:EMAIL_API_URL",
      "config_key:NODE_ENV",
      "config_key:PORT",
      "config_key:REPORT_PLUGINS",
    ]);
    expect(keys.find((k) => k.name === "AWS_ACCESS_KEY_ID")).toMatchObject({
      sources: ["code"],
      read_with_default: true,
      documented: false,
    });
    expect(JSON.stringify(result)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(
      result.relationships.some(
        (r) => r.type === "CONFIGURED_BY" && r.from === "module:server.config" && r.to === "config_key:PORT",
      ),
    ).toBe(true);
    expect(result.coverage).toContainEqual({
      area: "package.json",
      status: "analyzed",
      reason: 'script "postinstall" would run on package installation; Sys2QA records it and never runs it',
    });
  }, 60_000);

  it("models deployment units and joins keys from templates, Compose, Dockerfiles, CI and code", async () => {
    const result = await analyze(CONFIG);
    const byId = new Map(result.entities.map((e) => [e.id, e]));
    expect(byId.get("config_key:DATABASE_URL")).toMatchObject({
      sources: ["ci", "code", "compose", "env_template"],
      documented: true,
    });
    expect(byId.get("config_key:FEATURE_REPORTS")).toMatchObject({ read_with_default: true, documented: true });
    expect(byId.get("deployment_unit:compose:api")).toMatchObject({ unit_type: "compose_service", builds: true });
    expect(byId.get("deployment_unit:docker:Dockerfile")).toMatchObject({
      base_images: ["node:22-alpine"],
      exposed_ports: ["8080"],
    });
    expect(byId.get("deployment_unit:ci:.github/workflows/ci.yml#test")).toMatchObject({
      unit_type: "ci_job",
      triggers: ["push", "pull_request"],
    });
    expect(byId.get("secret_ref:DEPLOY_TOKEN")).toMatchObject({ kind: "secret_ref" });
    const rel = result.relationships.map((r) => `${r.type} ${r.from} ${r.to}`);
    expect(rel).toEqual(
      expect.arrayContaining([
        "DEPENDS_ON deployment_unit:compose:api deployment_unit:compose:db",
        "CONFIGURED_BY deployment_unit:compose:api config_key:DB_PASSWORD",
        "AUTHENTICATES_WITH deployment_unit:ci:.github/workflows/ci.yml#test secret_ref:DEPLOY_TOKEN",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("s3cr3t-db-pa55word-fixture");
    for (const e of result.entities) expect(validateJsonSchema(ENTITY, e).errors, e.id).toEqual([]);
    for (const r of result.relationships) expect(validateJsonSchema(RELATIONSHIP, r).errors, r.id).toEqual([]);
  }, 60_000);
});

describe("component traces [@req SAA-FR-009] [@req SAA-FR-041]", () => {
  it("traces every F1 entry point and stops exactly where the ground truth says", async () => {
    const truth = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "workflows.json"), "utf8")) as {
      workflows: Array<{
        entry_point: string;
        steps: string[];
        stop_points: Array<{ after: string | null; reason_code: string }>;
      }>;
    };
    const gapsTruth = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "gaps.json"), "utf8")) as {
      gaps: Array<{ key: string; type: string; related: string[] }>;
    };
    const result = await analyze(F1);
    const traces = new Map(result.component_traces.map((t) => [t.entry_point_id, t]));
    const relationships = new Map(result.relationships.map((r) => [r.id, r]));
    const edges = (entry: string) =>
      traces
        .get(entry)!
        .relationship_ids.map(
          (id) => `${relationships.get(id)!.type} ${relationships.get(id)!.from} ${relationships.get(id)!.to}`,
        );

    // Every entry point of the ground truth has a trace.
    for (const w of truth.workflows) expect(traces.has(w.entry_point), w.entry_point).toBe(true);
    // Stops: each expected stop is on the trace of the step it follows; API traces stop nowhere else.
    const expectedStops = new Map<string, string[]>();
    for (const w of truth.workflows)
      for (const stop of w.stop_points)
        expectedStops.set(stop.after!, [...(expectedStops.get(stop.after!) ?? []), stop.reason_code]);
    for (const trace of result.component_traces.filter((t) => t.entry_point_id.startsWith("api:"))) {
      const expected = [...new Set(expectedStops.get(trace.entry_point_id) ?? [])].sort();
      expect(trace.stopped_at.map((s) => s.reason_code).sort(), trace.entry_point_id).toEqual(expected);
    }
    // The external boundary is the email provider, and its gap is the ground truth's email-delivery gap.
    const email = gapsTruth.gaps.find((g) => g.key === "email-delivery")!;
    const stop = traces.get("api:POST:/api/auth/register")!.stopped_at[0]!;
    expect(stop.entity_id).toBe(email.related[0]);
    expect(result.gaps.find((g) => g.id === stop.gap_id)).toMatchObject({
      type: email.type,
      related_entity_ids: email.related,
    });
    expect(edges("api:POST:/api/auth/register")).toEqual(
      expect.arrayContaining([
        "WRITES_TO api:POST:/api/auth/register entity:user",
        "CALLS api:POST:/api/auth/register function:server.email.sendEmail",
        "SENDS_TO function:server.email.sendEmail integration:email.provider",
      ]),
    );
    // The nightly job writes the entities the ground truth lists.
    const job = truth.workflows.find((w) => w.entry_point.startsWith("job:"))!;
    expect(edges(job.entry_point).sort()).toEqual(
      job.steps
        .slice(1)
        .map((e) => `WRITES_TO ${job.entry_point} ${e}`)
        .sort(),
    );
    expect(result.entities.find((e) => e.id === job.entry_point)).toMatchObject({ kind: "job", schedule: "0 3 * * *" });
    // Pages reach their endpoints through forms or requests.
    expect(edges("page:web:/orders/{id}")).toContain(
      "CONSUMES page:web:/orders/{id} api:POST:/api/orders/{id}/decision",
    );
    expect(edges("page:web:/register")).toContain("SUBMITS_TO form:web:/register#register api:POST:/api/auth/register");
    const TRACE = { $ref: "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/component_trace" };
    for (const t of result.component_traces) expect(validateJsonSchema(TRACE, t).errors, t.id).toEqual([]);
    for (const r of result.relationships) expect(validateJsonSchema(RELATIONSHIP, r).errors, r.id).toEqual([]);
  }, 60_000);

  it("labels cron schedules for job IDs", () => {
    expect(scheduleLabel("0 3 * * *")).toBe("nightly");
    expect(scheduleLabel("30 14 * * *")).toBe("daily");
    expect(scheduleLabel("0 9 * * 1")).toBe("weekly");
    expect(scheduleLabel("15 * * * *")).toBe("hourly");
    expect(scheduleLabel("*/5 * * * *")).toBe("scheduled");
    expect(scheduleLabel("0 0 2 * * *")).toBe("nightly");
  });
});

describe("workflow catalog [@req SAA-FR-040] [@req SAA-FR-046]", () => {
  const WORKFLOW = { $ref: "https://sys2qa.dev/schemas/system-model/1.0.json#/$defs/workflow" };
  type Truth = {
    workflows: Array<{ key: string; category: string; entry_point: string; steps: string[] }>;
  };
  const truthOf = (root: string) =>
    JSON.parse(readFileSync(join(root, "..", "ground-truth", "workflows.json"), "utf8")) as Truth;
  const steps = (w: { steps: Array<{ entity_id: string }> }) => w.steps.map((s) => s.entity_id);

  it("discovers every F1 workflow without names, with the ground truth's category and stops", async () => {
    const result = await analyze(F1);
    const { catalog } = result;
    expect(catalog.count_scope).toBe("within_examined_scope");
    const byEntry = new Map(catalog.workflows.map((w) => [w.entry_point_ids[0], w]));
    for (const expected of truthOf(F1).workflows) {
      const w = byEntry.get(expected.entry_point)!;
      expect(w, expected.key).toBeDefined();
      expect(w.category, expected.key).toBe(expected.category);
      expect(steps(w), expected.key).toEqual(
        expect.arrayContaining(expected.steps.filter((s) => !s.startsWith("state_machine:"))),
      );
    }
    expect(steps(byEntry.get("page:web:/register")!)).toEqual([
      "page:web:/register",
      "form:web:/register#register",
      "api:POST:/api/auth/register",
    ]);
    expect(steps(byEntry.get("job:cleanup.nightly")!)).toEqual([
      "job:cleanup.nightly",
      "entity:password_reset_token",
      "entity:order",
    ]);
    // A stop inside the endpoint's trace is an unresolved hop after the endpoint's step.
    const register = byEntry.get("page:web:/register")!;
    expect(register.discovery_status).toBe("partially_reconstructed");
    expect(register.unresolved_hops).toEqual([
      expect.objectContaining({
        after_step: "step:page:web:/register#3",
        reason_code: "external_service",
        gap_id: "gap:external:email.provider",
      }),
    ]);
    expect(register.steps[2]).toMatchObject({ writes: ["entity:user"], side_effects: ["integration:email.provider"] });
    expect(byEntry.get("page:web:/login")!.discovery_status).toBe("reconstructed");
    // The endpoint no page calls is listed as an API workflow; the dead legacy router is not.
    expect(byEntry.get("api:GET:/api/orders/{id}")?.category).toBe("api");
    expect([...byEntry.keys()].some((id) => id!.includes("legacy"))).toBe(false);
    // Ranked 1..n, grouped by boundary, area and category, nothing dropped.
    expect(catalog.workflows.map((w) => w.rank)).toEqual(catalog.workflows.map((_, i) => i + 1));
    expect(catalog.groups.flatMap((g) => g.workflow_ids).sort()).toEqual(catalog.workflows.map((w) => w.id).sort());
    expect(catalog.groups).toContainEqual(
      expect.objectContaining({
        area: "server/jobs",
        category: "scheduled_processing",
        workflow_ids: ["workflow:job:cleanup.nightly"],
      }),
    );
    for (const w of catalog.workflows) expect(validateJsonSchema(WORKFLOW, w).errors, w.id).toEqual([]);
  }, 60_000);

  it("stops honestly where F4's evidence ends", async () => {
    const result = await analyze(F4);
    const byEntry = new Map(result.catalog.workflows.map((w) => [w.entry_point_ids[0], w]));
    const backend = "integration:api.shop.internal.example";
    const checkout = byEntry.get("page:app:/cart")!;
    expect(steps(checkout)).toEqual(["page:app:/cart", "form:app:/cart#checkout", backend]);
    expect(checkout.unresolved_hops).toEqual([
      expect.objectContaining({ after_step: "step:page:app:/cart#3", reason_code: "missing_repository" }),
    ]);
    // The loyalty page exists only when run-time configuration enables it: the hop comes before the page.
    const loyalty = byEntry.get("page:app:/loyalty")!;
    expect(loyalty.unresolved_hops.map((h) => [h.after_step, h.reason_code])).toEqual([
      [undefined, "config_unavailable"],
      ["step:page:app:/loyalty#2", "missing_repository"],
    ]);
    expect(result.gaps.find((g) => g.id === loyalty.unresolved_hops[0]!.gap_id)?.related_entity_ids).toEqual([
      "config_key:loyaltyProgram",
      "page:app:/loyalty",
    ]);
    // The consumer of orders.placed is elsewhere: known to exist, not traceable (CR-042), and never described.
    const fulfillment = byEntry.get("queue_topic:orders.placed")!;
    expect(fulfillment).toMatchObject({
      discovery_status: "known_not_traceable",
      component_trace_ids: [],
      completion: "unresolved",
      status: "unresolved",
    });
    expect(fulfillment.evidence_ids!.length).toBeGreaterThan(0);
    expect(result.relationships.some((r) => r.type === "WRITES_TO")).toBe(false);
    for (const w of result.catalog.workflows) expect(validateJsonSchema(WORKFLOW, w).errors, w.id).toEqual([]);
  }, 60_000);

  it("marks workflows beyond the budget as not deepened and deepens one on demand", async () => {
    const result = await analyze(F1);
    const catalog = composeWorkflows(result, { maxDeepened: 2 });
    expect(catalog.workflows).toHaveLength(result.catalog.workflows.length);
    expect(catalog.workflows.filter((w) => w.deepened)).toHaveLength(2);
    const register = catalog.workflows.find((w) => w.id === "workflow:page:web:/register")!;
    expect(catalog.not_deepened).toContain(register.id);
    expect(register).toMatchObject({ deepened: false, discovery_status: "partially_reconstructed" });
    expect(register.unresolved_hops).toEqual([expect.objectContaining({ reason_code: "budget_exhausted" })]);
    expect(register.steps[2]!.writes).toBeUndefined();
    const deeper = deepenWorkflow(result, { maxDeepened: 2 }, register.id);
    const deepened = deeper.workflows.find((w) => w.id === register.id)!;
    expect(deepened).toEqual(result.catalog.workflows.find((w) => w.id === register.id));
    expect(deeper.not_deepened).not.toContain(register.id);
    for (const w of catalog.workflows) expect(validateJsonSchema(WORKFLOW, w).errors, w.id).toEqual([]);
  }, 60_000);
});

describe("rules, roles, state machines and branches [@req SAA-FR-030] [@req SAA-FR-032] [@req SAA-FR-033] [@req SAA-FR-034]", () => {
  it("matches F1's rule, role and state ground truth", async () => {
    const truth = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "entities.json"), "utf8")) as {
      entities: Array<{ id: string; kind: string }>;
    };
    const result = await analyze(F1);
    const byId = new Map(result.entities.map((e) => [e.id, e as unknown as Record<string, unknown>]));
    for (const expected of truth.entities.filter((e) =>
      ["business_rule", "actor_role", "state_machine"].includes(e.kind),
    ))
      expect(byId.get(expected.id)?.kind, expected.id).toBe(expected.kind);
    for (const e of result.entities) expect(validateJsonSchema(ENTITY, e).errors, e.id).toEqual([]);
    for (const r of result.relationships) expect(validateJsonSchema(RELATIONSHIP, r).errors, r.id).toEqual([]);

    // Business rules: technical rule from code, no invented intent, inputs from the forms, the violation answer.
    expect(byId.get("business_rule:registration.nib_13_digits")).toMatchObject({
      statement: "nib must be exactly 13 digits.",
      business_intent: null,
      inputs: ["field:web:/register#register.nib"],
      expected_behavior: { on_violation: "HTTP 422" },
      boundaries: [{ field: "nib", min_length: 13, max_length: 13 }],
    });
    // The shared password rule applies to registration and to the reset confirmation.
    const validates = (rule: string) =>
      result.relationships
        .filter((r) => r.type === "VALIDATES" && r.from === rule)
        .map((r) => r.to)
        .sort();
    expect(validates("business_rule:registration.password_min_12_characters")).toEqual([
      "api:POST:/api/auth/password-reset/confirm",
      "api:POST:/api/auth/register",
    ]);
    // The amount rule is enforced twice: by the schema and by the database CHECK.
    const amount = byId.get("business_rule:order.amount_1_to_10000")!;
    expect(amount.technical_rule).toMatch(/database CHECK \("amount" BETWEEN 1 AND 10000\)/);
    expect((amount.evidence_ids as string[]).length).toBeGreaterThanOrEqual(3);

    // Roles and checks.
    const authz = result.relationships.filter((r) => r.type === "AUTHORIZES_WITH").map((r) => `${r.from} ${r.to}`);
    expect(authz.sort()).toEqual([
      "api:GET:/api/admin/users actor_role:admin",
      "api:POST:/api/orders/{id}/decision actor_role:admin",
    ]);
    expect(result.relationships).toContainEqual(
      expect.objectContaining({
        type: "AUTHENTICATES_WITH",
        from: "api:POST:/api/orders",
        to: "function:server.auth.requireSession",
      }),
    );

    // The order state machine, its guard and known invalid transitions.
    const machine = byId.get("state_machine:order.status")!;
    expect(machine).toMatchObject({
      subject: "entity:order",
      states: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "SHIPPED"],
    });
    expect(
      (machine.transitions as Array<{ from: string; to: string; guard: string }>).map((t) => `${t.from}>${t.to}`),
    ).toEqual(["DRAFT>SUBMITTED", "SUBMITTED>APPROVED", "SUBMITTED>REJECTED", "APPROVED>SHIPPED"]);
    expect(machine.invalid_transitions_known).toContainEqual(
      expect.objectContaining({ from: "REJECTED", to: "APPROVED" }),
    );
    expect(result.gaps.some((g) => g.id.startsWith("gap:state-machine:") || g.id === "gap:authorization")).toBe(false);
  }, 60_000);

  it("gives every F1 workflow the ground truth's branches and steps, and labels completion", async () => {
    const truth = JSON.parse(readFileSync(join(F1, "..", "ground-truth", "workflows.json"), "utf8")) as {
      workflows: Array<{
        key: string;
        entry_point: string;
        steps: string[];
        branches: Array<{ from: string; outcome: string }>;
      }>;
    };
    const { catalog } = await analyze(F1);
    const byEntry = new Map(catalog.workflows.map((w) => [w.entry_point_ids[0], w]));
    for (const expected of truth.workflows) {
      const w = byEntry.get(expected.entry_point)!;
      const entityOf = new Map(w.steps.map((s) => [s.id, s.entity_id]));
      expect(
        w.steps.map((s) => s.entity_id),
        expected.key,
      ).toEqual(expect.arrayContaining(expected.steps));
      for (const b of expected.branches)
        expect(
          w.branches.some((x) => entityOf.get(x.from_step) === b.from && x.outcome === b.outcome),
          `${expected.key}: ${b.from} → ${b.outcome}`,
        ).toBe(true);
      expect(w.completion, expected.key).toBe("complete_within_static_scope");
    }
    const register = byEntry.get("page:web:/register")!;
    expect(register.steps[1]!.validations).toEqual([
      "business_rule:registration.email_email_format",
      "business_rule:registration.nib_13_digits",
      "business_rule:registration.password_min_12_characters",
    ]);
  }, 60_000);

  it("records gaps where checks or state models are missing", () => {
    const api = {
      id: "api:POST:/x",
      kind: "api",
      name: "POST /x",
      project_boundary: "project:.",
      status: "source_verified",
      origin: "source",
      evidence_ids: ["evidence:a"],
    } as Entity;
    const table = {
      id: "table:Ticket",
      kind: "table",
      name: "Ticket",
      status: "source_verified",
      origin: "source",
      evidence_ids: ["evidence:b"],
    } as Entity;
    const column = {
      id: "column:Ticket.status",
      kind: "column",
      name: "status",
      project_boundary: "project:.",
      table_id: "table:Ticket",
      status: "source_verified",
      origin: "source",
      evidence_ids: ["evidence:c"],
    } as unknown as Entity;
    const links = linkRules(
      { entities: [], relationships: [], evidence: [], coverage: [] },
      { entities: [api, table, column], relationships: [] },
      new Map([["api:POST:/x", { responses: [], validates: [], middleware: [] }]]),
    );
    expect(links.gaps.map((g) => [g.id, g.type])).toEqual([
      ["gap:authorization", "unsupported"],
      ["gap:state-machine:ticket", "missing_evidence"],
    ]);
  });

  it("derives rule keys and outcome codes deterministically", () => {
    const field = (name: string, base: string, checks: Array<{ kind: string; value?: number | string }>) => ({
      name,
      base,
      checks,
      optional: false,
      text: "z…",
      evidence: "evidence:x",
    });
    expect(rulesOfField(field("nib", "string", [{ kind: "regex", value: "/^\\d{16}$/" }])).map((r) => r.key)).toEqual([
      "nib_16_digits",
    ]);
    expect(rulesOfField(field("code", "string", [{ kind: "regex", value: "/^[A-Z]+$/" }])).map((r) => r.key)).toEqual([
      "code_pattern",
    ]);
    expect(
      rulesOfField(
        field("name", "string", [
          { kind: "min", value: 2 },
          { kind: "max", value: 50 },
        ]),
      ).map((r) => r.key),
    ).toEqual(["name_2_to_50_characters"]);
    expect(rulesOfField(field("qty", "number", [{ kind: "int" }, { kind: "positive" }])).map((r) => r.key)).toEqual([
      "qty_min_1",
    ]);
    expect(
      rulesOfField(field("mail", "string", [{ kind: "email" }, { kind: "min", value: 1 }])).map((r) => r.key),
    ).toEqual(["mail_email_format", "mail_required"]);
    expect([400, 401, 403, 404, 409, 422, 503].map((s) => outcomeOf(s))).toEqual([
      "bad_request",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "validation_error",
      "server_error",
    ]);
    expect(outcomeOf(400, "invalid or expired token")).toBe("invalid_token");
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
