import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "@sys2qa/contract";
import { parseDdl, splitStatements } from "../src/adapters/sql/ddl.js";
import { extractFiles } from "../src/adapters/sql/extract.js";
import { parsePrisma } from "../src/adapters/sql/prisma.js";

const F1 = fileURLToPath(new URL("../../../fixtures/benchmarks/F1-repository-only/repo/", import.meta.url));
const RESULT = { $ref: "https://sys2qa.dev/schemas/adapter-protocol/1.0.json#/$defs/analyze_result" };

describe("DDL reader [@req SAA-FR-008]", () => {
  it("splits statements around quotes, comments and dollar-quoted bodies", () => {
    const script = [
      "-- a comment; with a semicolon",
      "CREATE TABLE a (x TEXT DEFAULT 'a;b');",
      "/* block; comment */",
      "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN; END; $body$ LANGUAGE plpgsql;",
      'INSERT INTO "we;ird" VALUES (1);',
    ].join("\n");
    const statements = splitStatements(script);
    expect(statements.map((s) => s.line)).toEqual([2, 4, 5]);
    expect(statements[1]!.text).toContain("$body$ BEGIN; END; $body$");
  });

  it("reads F1's migrations: columns, keys, defaults, references and checks", () => {
    const ddl = parseDdl(readFileSync(`${F1}migrations/001_init.sql`, "utf8"));
    expect(ddl.unreadable).toEqual([]);
    const user = ddl.operations[0]!;
    expect(user).toMatchObject({ op: "create_table", table: "User", line: 1 });
    if (user.op !== "create_table") return;
    expect(user.columns.map((c) => c.name)).toEqual(["id", "email", "passwordHash", "nib", "role", "createdAt"]);
    expect(user.columns.find((c) => c.name === "nib")).toEqual({
      name: "nib",
      type: "CHAR(13)",
      not_null: true,
      primary_key: false,
      unique: true,
      checks: [`"nib" ~ '^[0-9]{13}$'`],
    });
    expect(user.columns.find((c) => c.name === "role")).toMatchObject({ default: "'CUSTOMER'" });
    const token = ddl.operations[1]!;
    expect(token.op === "create_table" && token.columns.find((c) => c.name === "userId")?.references).toEqual({
      table: "User",
      column: "id",
    });
    const orders = parseDdl(readFileSync(`${F1}migrations/002_orders.sql`, "utf8")).operations[0]!;
    expect(orders.op === "create_table" && orders.columns.find((c) => c.name === "amount")?.checks).toEqual([
      `"amount" BETWEEN 1 AND 10000`,
    ]);
  });

  it("reads table constraints, ALTER TABLE, DROP TABLE and unique indexes across dialects", () => {
    const ddl = parseDdl(
      [
        "CREATE TABLE IF NOT EXISTS public.orders (id SERIAL, customer_id INT, total NUMERIC(10, 2),",
        "  CONSTRAINT orders_pk PRIMARY KEY (id), FOREIGN KEY (customer_id) REFERENCES customers (id), CHECK (total >= 0));",
        "CREATE TABLE `items` (`id` INT AUTO_INCREMENT PRIMARY KEY, `sku` VARCHAR(20) NOT NULL) ENGINE=InnoDB;",
        "ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'NEW', DROP COLUMN total;",
        "ALTER TABLE ONLY orders ALTER COLUMN status DROP DEFAULT;",
        "ALTER TABLE orders RENAME COLUMN status TO state;",
        "ALTER TABLE orders ADD CONSTRAINT state_ok CHECK (state IN ('NEW', 'DONE'));",
        "CREATE UNIQUE INDEX items_sku ON items (sku);",
        "DROP TABLE IF EXISTS legacy, archive CASCADE;",
        "CREATE TABLE copy AS SELECT * FROM orders;",
        "GRANT SELECT ON orders TO reporting;",
      ].join("\n"),
    );
    expect(ddl.operations.map((o) => o.op)).toEqual([
      "create_table",
      "create_table",
      "alter_table",
      "alter_table",
      "alter_table",
      "alter_table",
      "create_index",
      "drop_table",
    ]);
    const [orders, items, add, drop, rename, check, index, dropped] = ddl.operations;
    expect(orders).toMatchObject({
      table: "orders",
      constraints: [
        { kind: "primary_key", columns: ["id"], name: "orders_pk" },
        { kind: "foreign_key", columns: ["customer_id"], table: "customers", references: ["id"] },
        { kind: "check", expression: "total >= 0" },
      ],
    });
    expect(orders!.op === "create_table" && orders!.columns.find((c) => c.name === "total")?.type).toBe(
      "NUMERIC(10, 2)",
    );
    expect(items).toMatchObject({
      table: "items",
      columns: [
        { name: "id", primary_key: true },
        { name: "sku", not_null: true },
      ],
    });
    expect(add).toMatchObject({
      actions: [
        { action: "add_column", column: { name: "status", not_null: true, default: "'NEW'" } },
        { action: "drop_column", name: "total" },
      ],
    });
    expect(drop).toMatchObject({ actions: [{ action: "alter_column", name: "status", default: null }] });
    expect(rename).toMatchObject({ actions: [{ action: "rename_column", from: "status", to: "state" }] });
    expect(check).toMatchObject({
      actions: [{ action: "add_constraint", constraint: { kind: "check", name: "state_ok" } }],
    });
    expect(index).toMatchObject({ table: "items", columns: ["sku"], unique: true });
    expect(dropped).toMatchObject({ tables: ["legacy", "archive"] });
    expect(ddl.unreadable).toEqual([{ line: 10, reason: expect.stringContaining("AS SELECT") }]);
    expect(ddl.skipped).toBe(1);
  });
});

describe("Prisma reader [@req SAA-FR-008]", () => {
  it("reads F1's models, enums, relations and the datasource provider", () => {
    const schema = parsePrisma(readFileSync(`${F1}prisma/schema.prisma`, "utf8"));
    expect(schema.provider).toBe("postgresql");
    expect(schema.unreadable).toEqual([]);
    expect(schema.enums.map((e) => [e.name, e.values])).toEqual([
      ["Role", ["CUSTOMER", "ADMIN"]],
      ["OrderStatus", ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "SHIPPED"]],
    ]);
    expect(schema.models.map((m) => [m.name, m.table, m.mapped])).toEqual([
      ["User", "User", false],
      ["Order", "Order", false],
      ["PasswordResetToken", "PasswordResetToken", false],
    ]);
    const order = schema.models[1]!;
    expect(order.fields.find((f) => f.name === "customer")).toMatchObject({
      type: "User",
      relation: { fields: ["customerId"], references: ["id"] },
    });
    expect(order.fields.find((f) => f.name === "approvedBy")).toMatchObject({ optional: true });
    expect(order.fields.find((f) => f.name === "status")).toMatchObject({ type: "OrderStatus", default: "DRAFT" });
  });

  it("follows @@map and @map", () => {
    const schema = parsePrisma(
      'model LineItem {\n  id Int @id\n  orderId Int @map("order_id")\n  @@map("line_items")\n}\n',
    );
    expect(schema.models[0]).toMatchObject({
      table: "line_items",
      mapped: true,
      fields: [{ name: "id" }, { name: "orderId", column: "order_id" }],
    });
  });
});

describe("sql adapter output", () => {
  it("emits contract-valid file facts with digest-only evidence and coverage", () => {
    const files = ["migrations/001_init.sql", "migrations/002_orders.sql", "prisma/schema.prisma"].map((path) => ({
      path,
      sha256: `sha256:${"b".repeat(64)}`,
      text: readFileSync(`${F1}${path}`, "utf8"),
    }));
    const result = extractFiles([...files, { path: "README.md", sha256: files[0]!.sha256, text: "# x" }], {
      boundaryPath: "",
      capturedAt: "2026-10-25T00:00:00Z",
    });
    expect(validateJsonSchema(RESULT, result)).toEqual({ ok: true, errors: [] });
    expect(result.entities.map((e) => e.id)).toEqual([
      "file:migrations/001_init.sql",
      "file:migrations/002_orders.sql",
      "file:prisma/schema.prisma",
    ]);
    expect(result.evidence.every((e) => e.excerpt_policy === "digest_only")).toBe(true);
    expect(result.evidence.find((e) => e.path === "migrations/001_init.sql")?.source_type).toBe("migration");
    expect(result.coverage).toContainEqual({
      area: "README.md",
      status: "unsupported",
      reason: "not a SQL or Prisma file",
    });
  });
});
