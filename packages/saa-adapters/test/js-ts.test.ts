import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "@sys2qa/contract";
import {
  boundaryPathOf,
  extractFiles,
  moduleId,
  moduleKey,
  resolveSpecifier,
  type ExtractContext,
} from "../src/adapters/js-ts/extract.js";

const RESULT = { $ref: "https://sys2qa.dev/schemas/adapter-protocol/1.0.json#/$defs/analyze_result" };
const SHA = `sha256:${"a".repeat(64)}`;
const context = (files: string[], boundaryPath = ""): ExtractContext => ({
  boundaryPath,
  exists: (p) => files.includes(p),
  capturedAt: "2026-10-25T00:00:00Z",
});

describe("js-ts module identity [@req SAA-FR-005]", () => {
  it("derives module IDs from the path inside the boundary", () => {
    expect(moduleKey("", "src/server/plugins/index.ts")).toBe("server.plugins");
    expect(moduleId("", "src/server/app.ts")).toBe("module:server.app");
    expect(moduleId("apps/web", "apps/web/src/main.tsx")).toBe("module:apps/web:main");
    expect(moduleKey("", "types/global.d.ts")).toBe("types.global");
    expect(boundaryPathOf("project:.")).toBe("");
    expect(boundaryPathOf("project:apps/web")).toBe("apps/web");
    expect(boundaryPathOf("project:root1/apps/web")).toBe("apps/web");
  });

  it("resolves relative, NodeNext .js, index, package, builtin and asset imports", () => {
    const ctx = context(["src/a.ts", "src/lib/index.ts", "src/data.json"]);
    expect(resolveSpecifier("src/b.ts", "./a.js", ctx)).toBe("module:a");
    expect(resolveSpecifier("src/b.ts", "./a", ctx)).toBe("module:a");
    expect(resolveSpecifier("src/b.ts", "./lib", ctx)).toBe("module:lib");
    expect(resolveSpecifier("src/b.ts", "./data.json", ctx)).toBe("asset");
    expect(resolveSpecifier("src/b.ts", "./missing", ctx)).toBeUndefined();
    expect(resolveSpecifier("src/b.ts", "../../outside", ctx)).toBeUndefined();
    expect(resolveSpecifier("src/b.ts", "express", ctx)).toBe("module:pkg:express");
    expect(resolveSpecifier("src/b.ts", "@acme/shared/x", ctx)).toBe("module:pkg:@acme/shared");
    expect(resolveSpecifier("src/b.ts", "node:fs", ctx)).toBe("module:node:fs");
    expect(resolveSpecifier("src/b.ts", "path", ctx)).toBe("module:node:path");
  });
});

describe("js-ts extraction [@req SAA-FR-005]", () => {
  const files = [
    {
      path: "src/a.ts",
      sha256: SHA,
      text: [
        'import express from "express";',
        'import { helper, type Shape } from "./b.js";',
        'export * from "./b.js";',
        "export function start() { return helper(); }",
        "class Internal {}",
        "export const handler = async () => 1;",
        "const plugin = await import(name);",
        "",
      ].join("\n"),
    },
    { path: "src/b.ts", sha256: SHA, text: "export function helper() {}\nexport interface Shape {}\n" },
    { path: "src/broken.ts", sha256: SHA, text: "export function f( {\n" },
    { path: "README.md", sha256: SHA, text: "# x" },
  ];
  const result = extractFiles(files, context(files.map((f) => f.path)));

  it("emits contract-valid modules, symbols, imports and digest-only evidence", () => {
    expect(validateJsonSchema(RESULT, result)).toEqual({ ok: true, errors: [] });
    const ids = result.entities.map((e) => e.id).sort();
    expect(ids).toEqual(
      expect.arrayContaining([
        "module:a",
        "module:b",
        "module:broken",
        "module:pkg:express",
        "function:a.start",
        "function:a.handler",
        "class:a.Internal",
        "function:b.helper",
      ]),
    );
    expect(result.entities.find((e) => e.id === "class:a.Internal")).toMatchObject({ exported: false });
    expect(result.entities.find((e) => e.id === "function:a.start")).toMatchObject({
      exported: true,
      module_id: "module:a",
      project_boundary: "project:.",
    });
    const types = result.relationships.map((r) => `${r.type} ${r.from} ${r.to}`);
    expect(types).toEqual(
      expect.arrayContaining([
        "IMPORTS module:a module:pkg:express",
        "IMPORTS module:a module:b",
        "CONTAINS module:a function:a.start",
      ]),
    );
    expect(result.evidence.every((e) => e.excerpt_policy === "digest_only" && !("excerpt" in e))).toBe(true);
    const moduleA = result.entities.find((e) => e.id === "module:a") as unknown as {
      imports: Array<{ names: string[]; kind: string }>;
    };
    expect(moduleA.imports.find((i) => i.kind === "static" && i.names.includes("helper"))?.names).toEqual([
      "helper",
      "Shape",
    ]);
  });

  it("records syntax errors, computed imports and unsupported files as coverage", () => {
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        { area: "README.md", status: "unsupported", reason: "not a JavaScript or TypeScript file" },
        { area: "src/b.ts", status: "analyzed" },
        expect.objectContaining({
          area: "src/broken.ts",
          status: "partial",
          reason: expect.stringMatching(/^syntax error at line \d+: /),
        }),
        expect.objectContaining({
          area: "src/a.ts",
          status: "partial",
          reason: expect.stringContaining("import(<computed>)"),
        }),
      ]),
    );
    // The tolerant parser still recovered the broken file's function.
    expect(result.entities.some((e) => e.id === "function:broken.f")).toBe(true);
  });

  it("is deterministic", () => {
    expect(extractFiles(files, context(files.map((f) => f.path)))).toEqual(result);
  });
});

describe("js-ts trace facts [@req SAA-FR-009]", () => {
  const source = [
    'import { send } from "./mail.js";',
    'import * as db from "./db.js";',
    'import cron from "node-cron";',
    "export async function notify(id: string) {",
    "  await prisma.user.findUnique({ where: { id } });",
    "  await prisma.order.update({ where: { id }, data: {} });",
    "  await send(id);",
    "  await db.audit(id);",
    '  await fetch("https://api.example.test/v1");',
    "  await fetch(`/api/orders/${id}`);",
    "  await import(`./plugins/${id}.js`);",
    "}",
    'router.post("/x", async (req, res) => { await notify(req.body.id); });',
    'cron.schedule("0 3 * * *", async () => { await prisma.token.deleteMany({}); });',
  ].join("\n");
  const files = [{ path: "src/jobs.ts", sha256: SHA, text: source }];
  const module = extractFiles(files, context(["src/jobs.ts", "src/mail.ts", "src/db.ts"])).entities.find(
    (e) => e.id === "module:jobs",
  ) as unknown as {
    units: Array<{
      key: string;
      calls: Array<{ name: string }>;
      data: unknown[];
      outbound: unknown[];
      dynamic_imports: unknown[];
    }>;
    jobs: Array<{ expression: string; unit: string }>;
  };

  it("records calls, Prisma access, outbound requests and computed imports per unit", () => {
    const notify = module.units.find((u) => u.key === "fn:notify")!;
    expect(notify.calls.map((c) => c.name)).toEqual(["send", "db.audit"]);
    expect(notify.data).toEqual([
      expect.objectContaining({ model: "user", op: "findUnique", access: "read" }),
      expect.objectContaining({ model: "order", op: "update", access: "write" }),
    ]);
    // Only the absolute URL is outbound; a path on the application's own origin is not.
    expect(notify.outbound).toEqual([
      expect.objectContaining({ target: "https://api.example.test/v1", literal: true }),
    ]);
    expect(notify.dynamic_imports).toHaveLength(1);
    const handler = module.units.find((u) => u.key.startsWith("at:") && u.calls.some((c) => c.name === "notify"));
    expect(handler).toBeDefined();
  });

  it("records cron jobs with their callback unit", () => {
    expect(module.jobs).toEqual([expect.objectContaining({ expression: "0 3 * * *" })]);
    const unit = module.units.find((u) => u.key === module.jobs[0]!.unit)!;
    expect(unit.data).toEqual([expect.objectContaining({ model: "token", op: "deleteMany", access: "write" })]);
  });
});

describe("js-ts discovery facts [@req SAA-FR-040]", () => {
  const moduleOf = (path: string, text: string, id: string) =>
    extractFiles([{ path, sha256: SHA, text }], context([path])).entities.find((e) => e.id === id) as unknown as Record<
      string,
      never
    >;

  it("records routes registered under a run-time condition, with the value they test", () => {
    const main = moduleOf(
      "src/main.tsx",
      [
        'import { createBrowserRouter } from "react-router-dom";',
        "const router = createBrowserRouter([",
        '  { path: "/cart", element: <Cart /> },',
        '  ...(config.loyaltyProgram ? [{ path: "/loyalty", element: <Loyalty /> }] : []),',
        '  ...(!flags.beta && [{ path: "/beta", element: <Beta /> }]),',
        "]);",
      ].join("\n"),
      "module:main",
    ) as unknown as { react_router: { routes: Array<{ path: string; condition?: { text: string; key?: string } }> } };
    expect(main.react_router.routes.map((r) => [r.path, r.condition?.key])).toEqual([
      ["/cart", undefined],
      ["/loyalty", "loyaltyProgram"],
      ["/beta", "beta"],
    ]);
    expect(main.react_router.routes[1]!.condition!.text).toBe("config.loyaltyProgram");
  });

  it("names a computed backend by the host of its default base URL and records message topics", () => {
    const client = moduleOf(
      "src/client.ts",
      [
        'const API = import.meta.env.VITE_API_URL ?? "https://API.Shop.example/v1";',
        "export async function api(path: string, body: unknown) {",
        '  return fetch(`${API}${path}`, { method: "POST", body: JSON.stringify({ topic: "orders.placed", body }) });',
        "}",
        'export function listen(consumer: { subscribe(o: object): void }) { consumer.subscribe({ topic: "orders.paid" }); }',
      ].join("\n"),
      "module:client",
    ) as unknown as { units: Array<{ key: string; outbound: unknown[]; topics?: unknown[] }> };
    const api = client.units.find((u) => u.key === "fn:api")!;
    expect(api.outbound).toEqual([expect.objectContaining({ literal: false, base_host: "api.shop.example" })]);
    expect(api.topics).toEqual([expect.objectContaining({ name: "orders.placed", role: "publish" })]);
    expect(client.units.find((u) => u.key === "fn:listen")!.topics).toEqual([
      expect.objectContaining({ name: "orders.paid", role: "subscribe" }),
    ]);
  });
});
