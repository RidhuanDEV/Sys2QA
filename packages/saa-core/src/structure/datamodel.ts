import { createHash } from "node:crypto";
import type { CoverageItem, Entity, Relationship } from "@sys2qa/contract";
import type { StructuralFacts } from "./graph.js";

// Shapes recorded on `file` entities by the sql adapter (packages/saa-adapters/src/adapters/sql/).
interface ColumnDef {
  name: string;
  type: string;
  not_null: boolean;
  primary_key: boolean;
  unique: boolean;
  default?: string;
  references?: { table: string; column?: string };
  checks: string[];
}
type Constraint =
  | { kind: "primary_key" | "unique"; columns: string[] }
  | { kind: "foreign_key"; columns: string[]; table: string; references: string[] }
  | { kind: "check"; expression: string };
type Op = { evidence: string } & (
  | { op: "create_table"; table: string; columns: ColumnDef[]; constraints: Constraint[] }
  | { op: "alter_table"; table: string; actions: AlterAction[] }
  | { op: "drop_table"; tables: string[] }
  | { op: "create_index"; table: string; columns: string[]; unique: boolean }
);
type AlterAction =
  | { action: "add_column"; column: ColumnDef }
  | { action: "drop_column"; name: string }
  | { action: "rename_column"; from: string; to: string }
  | { action: "rename_table"; to: string }
  | { action: "add_constraint"; constraint: Constraint }
  | { action: "alter_column"; name: string; set_not_null?: boolean; default?: string | null; type?: string };
interface PrismaField {
  name: string;
  type: string;
  list: boolean;
  optional: boolean;
  id: boolean;
  unique: boolean;
  default?: string;
  column?: string;
  relation?: { fields: string[]; references: string[] };
}
interface PrismaModel {
  name: string;
  table: string;
  mapped: boolean;
  fields: PrismaField[];
  evidence: string;
}
interface FileFacts {
  id: string;
  path: string;
  project_boundary: string;
  ddl?: Op[];
  prisma?: {
    provider?: string;
    models: PrismaModel[];
    enums: Array<{ name: string; values: string[]; evidence: string }>;
  };
}

interface ColumnState extends ColumnDef {
  evidence: Set<string>;
}
interface TableState {
  name: string;
  boundary: string;
  columns: Map<string, ColumnState>;
  checks: string[];
  foreignKeys: Array<{ columns: string[]; table: string; references: string[]; evidence: string }>;
  evidence: Set<string>;
}

export interface DataModelLinks {
  entities: Entity[];
  relationships: Relationship[];
  coverage: CoverageItem[];
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** `PasswordResetToken` → `password_reset_token`; `order_items` stays. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

/**
 * Builds the data model (SAA-FR-008). SQL files are applied in natural path order (`001_init.sql` before
 * `010_orders.sql`), so later migrations add, drop, rename and constrain what earlier ones created; a dropped table is
 * reported, not modeled. Prisma models give ORM models and domain entities with a declared table mapping; a table no
 * model declares still gets a domain entity, `inferred` from its name. Tables, columns and mappings are scoped to
 * their project boundary.
 */
export function linkDataModel(facts: StructuralFacts): DataModelLinks {
  const files = facts.entities
    .filter((e) => e.kind === "file" && ((e as { ddl?: unknown }).ddl || (e as { prisma?: unknown }).prisma))
    .map((e) => e as unknown as FileFacts)
    .sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  const out: DataModelLinks = { entities: [], relationships: [], coverage: [] };
  const relate = (
    type: Relationship["type"],
    from: string,
    to: string,
    evidence: string[],
    status: Relationship["status"] = "source_verified",
    rationale?: string,
  ) =>
    out.relationships.push({
      id: `relationship:${hash16(type, from, to)}`,
      type,
      from,
      to,
      status,
      evidence_ids: evidence,
      ...(rationale ? { confidence_rationale: rationale } : {}),
    } as Relationship);
  const scoped = (kind: string, boundary: string, key: string) =>
    boundary === "project:." ? `${kind}:${key}` : `${kind}:${boundary.slice("project:".length)}:${key}`;

  // ---------------------------------------------------------------- SQL: apply migrations in order
  const tables = new Map<string, TableState>(); // `${boundary}\0${lower name}`
  const keyOf = (boundary: string, name: string) => `${boundary}\0${name.toLowerCase()}`;
  const dropped: Array<{ table: string; path: string }> = [];
  for (const file of files) {
    for (const op of file.ddl ?? []) {
      if (op.op === "create_table") {
        const table: TableState = {
          name: op.table,
          boundary: file.project_boundary,
          columns: new Map(),
          checks: [],
          foreignKeys: [],
          evidence: new Set([op.evidence]),
        };
        for (const c of op.columns)
          table.columns.set(c.name.toLowerCase(), { ...c, checks: [...c.checks], evidence: new Set([op.evidence]) });
        for (const c of op.constraints) applyConstraint(table, c, op.evidence);
        tables.set(keyOf(file.project_boundary, op.table), table);
      } else if (op.op === "alter_table") {
        const key = keyOf(file.project_boundary, op.table);
        const table = tables.get(key);
        if (!table) {
          out.coverage.push({
            area: file.path,
            status: "partial",
            reason: `ALTER TABLE ${op.table}: the table is not created by any analyzed file`,
          });
          continue;
        }
        table.evidence.add(op.evidence);
        for (const a of op.actions) {
          if (a.action === "add_column")
            table.columns.set(a.column.name.toLowerCase(), {
              ...a.column,
              checks: [...a.column.checks],
              evidence: new Set([op.evidence]),
            });
          else if (a.action === "drop_column") table.columns.delete(a.name.toLowerCase());
          else if (a.action === "rename_column") {
            const column = table.columns.get(a.from.toLowerCase());
            if (column) {
              table.columns.delete(a.from.toLowerCase());
              table.columns.set(a.to.toLowerCase(), {
                ...column,
                name: a.to,
                evidence: new Set([...column.evidence, op.evidence]),
              });
            }
          } else if (a.action === "rename_table") {
            tables.delete(key);
            table.name = a.to;
            tables.set(keyOf(file.project_boundary, a.to), table);
          } else if (a.action === "add_constraint") applyConstraint(table, a.constraint, op.evidence);
          else if (a.action === "alter_column") {
            const column = table.columns.get(a.name.toLowerCase());
            if (!column) continue;
            column.evidence.add(op.evidence);
            if (a.set_not_null !== undefined) column.not_null = a.set_not_null;
            if (a.type !== undefined) column.type = a.type;
            if (a.default === null) delete column.default;
            else if (a.default !== undefined) column.default = a.default;
          }
        }
      } else if (op.op === "drop_table") {
        for (const name of op.tables) {
          if (tables.delete(keyOf(file.project_boundary, name))) dropped.push({ table: name, path: file.path });
        }
      } else if (op.op === "create_index" && op.unique && op.columns.length === 1) {
        const column = tables.get(keyOf(file.project_boundary, op.table))?.columns.get(op.columns[0]!.toLowerCase());
        if (column) {
          column.unique = true;
          column.evidence.add(op.evidence);
        }
      }
    }
  }
  for (const d of dropped)
    out.coverage.push({
      area: d.path,
      status: "analyzed",
      reason: `table ${d.table} is dropped by a later migration and is not modeled`,
    });

  // ---------------------------------------------------------------- Prisma models
  const enums = new Map<string, string[]>();
  for (const file of files)
    for (const e of file.prisma?.enums ?? []) enums.set(`${file.project_boundary}\0${e.name}`, e.values);
  const models: Array<PrismaModel & { boundary: string }> = files.flatMap((f) =>
    (f.prisma?.models ?? []).map((m) => ({ ...m, boundary: f.project_boundary })),
  );
  const modelByTable = new Map(models.map((m) => [keyOf(m.boundary, m.table), m]));
  const entityOfModel = new Map(
    models.map((m) => [`${m.boundary}\0${m.name}`, scoped("entity", m.boundary, snakeCase(m.name))]),
  );

  // Tables only Prisma declares (no SQL) are modeled from the schema.
  for (const m of models) {
    const key = keyOf(m.boundary, m.table);
    if (tables.has(key)) continue;
    const table: TableState = {
      name: m.table,
      boundary: m.boundary,
      columns: new Map(),
      checks: [],
      foreignKeys: [],
      evidence: new Set([m.evidence]),
    };
    for (const f of m.fields) {
      if (f.list || !isColumnType(f.type, m.boundary, enums, models)) continue;
      const name = f.column ?? f.name;
      table.columns.set(name.toLowerCase(), {
        name,
        type: f.type,
        not_null: !f.optional,
        primary_key: f.id,
        unique: f.unique,
        ...(f.default !== undefined ? { default: f.default } : {}),
        checks: [],
        evidence: new Set([m.evidence]),
      });
    }
    tables.set(key, table);
  }

  // ---------------------------------------------------------------- Entities and relationships
  const tableIdOf = (t: TableState) => scoped("table", t.boundary, t.name);
  for (const table of [...tables.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const tableId = tableIdOf(table);
    const tableEvidence = [...table.evidence];
    out.entities.push({
      id: tableId,
      kind: "table",
      name: table.name,
      project_boundary: table.boundary,
      checks: table.checks,
      status: "source_verified",
      origin: "source",
      evidence_ids: tableEvidence,
    } as Entity);
    const model = modelByTable.get(keyOf(table.boundary, table.name));
    for (const column of table.columns.values()) {
      const columnId = scoped("column", table.boundary, `${table.name}.${column.name}`);
      const field = model?.fields.find((f) => (f.column ?? f.name).toLowerCase() === column.name.toLowerCase());
      const values = field ? enums.get(`${table.boundary}\0${field.type}`) : undefined;
      out.entities.push({
        id: columnId,
        kind: "column",
        name: column.name,
        project_boundary: table.boundary,
        table_id: tableId,
        data_type: column.type,
        primary_key: column.primary_key,
        constraints: {
          ...(column.not_null ? { required: true } : {}),
        },
        unique: column.unique,
        ...(column.default !== undefined ? { default: column.default } : {}),
        checks: column.checks,
        ...(values ? { allowed_values: values, enum_type: field!.type } : {}),
        status: "source_verified",
        origin: "source",
        evidence_ids: [...column.evidence],
      } as Entity);
      relate("CONTAINS", tableId, columnId, [...column.evidence]);
      if (column.references) {
        const target = tables.get(keyOf(table.boundary, column.references.table));
        if (target) relate("REFERENCES", tableId, tableIdOf(target), [...column.evidence]);
      }
    }
    for (const fk of table.foreignKeys) {
      const target = tables.get(keyOf(table.boundary, fk.table));
      if (target) relate("REFERENCES", tableId, tableIdOf(target), [fk.evidence]);
    }

    // Domain entity: declared through an ORM model, otherwise inferred from the table name.
    if (model) {
      const modelId = scoped("orm_model", table.boundary, model.name);
      const entityId = entityOfModel.get(`${table.boundary}\0${model.name}`)!;
      out.entities.push(
        {
          id: modelId,
          kind: "orm_model",
          name: model.name,
          project_boundary: table.boundary,
          table_id: tableId,
          mapping: model.mapped ? "declared_map" : "declared_default_name",
          fields: model.fields.map((f) => ({ name: f.name, type: f.type, list: f.list, optional: f.optional })),
          status: "source_verified",
          origin: "source",
          evidence_ids: [model.evidence],
        } as Entity,
        {
          id: entityId,
          kind: "entity",
          name: model.name,
          project_boundary: table.boundary,
          status: "source_verified",
          origin: "source",
          evidence_ids: [model.evidence],
        } as Entity,
      );
      relate("USES_SCHEMA", modelId, tableId, [model.evidence]);
      relate("USES_SCHEMA", entityId, tableId, [model.evidence]);
      for (const f of model.fields.filter((x) => x.relation && x.relation.fields.length > 0)) {
        const target = entityOfModel.get(`${table.boundary}\0${f.type}`);
        if (target) relate("REFERENCES", entityId, target, [model.evidence]);
      }
    } else {
      const entityId = scoped("entity", table.boundary, snakeCase(table.name));
      const rationale = `derived from table ${table.name}; no ORM model declares this mapping`;
      out.entities.push({
        id: entityId,
        kind: "entity",
        name: table.name,
        project_boundary: table.boundary,
        status: "inferred",
        confidence_rationale: rationale,
        origin: "source",
        evidence_ids: tableEvidence,
      } as Entity);
      relate("USES_SCHEMA", entityId, tableId, tableEvidence, "inferred", rationale);
    }
  }
  out.relationships = [...new Map(out.relationships.map((r) => [r.id, r])).values()];
  return out;
}

function applyConstraint(table: TableState, c: Constraint, evidence: string): void {
  table.evidence.add(evidence);
  if (c.kind === "check") table.checks.push(c.expression);
  else if (c.kind === "foreign_key")
    table.foreignKeys.push({ columns: c.columns, table: c.table, references: c.references, evidence });
  else
    for (const name of c.columns) {
      const column = table.columns.get(name.toLowerCase());
      if (!column) continue;
      column.evidence.add(evidence);
      if (c.kind === "primary_key") {
        column.primary_key = true;
        column.not_null = true;
      } else if (c.columns.length === 1) column.unique = true;
    }
}

function isColumnType(
  type: string,
  boundary: string,
  enums: Map<string, string[]>,
  models: ReadonlyArray<{ name: string; boundary: string }>,
): boolean {
  if (models.some((m) => m.boundary === boundary && m.name === type)) return false; // a relation field
  return enums.has(`${boundary}\0${type}`) || /^[A-Z]/.test(type);
}
