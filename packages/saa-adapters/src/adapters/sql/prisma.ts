/** Prisma schema reader (IMP-108): datasource provider, enums and models with fields, relations and table mapping. */

export interface PrismaField {
  name: string;
  type: string;
  list: boolean;
  optional: boolean;
  id: boolean;
  unique: boolean;
  default?: string;
  /** Database column name from `@map`, when it differs. */
  column?: string;
  relation?: { fields: string[]; references: string[]; name?: string };
  updated_at?: true;
  line: number;
}

export interface PrismaModel {
  name: string;
  /** Table name from `@@map`, else the model name (Prisma's default). */
  table: string;
  mapped: boolean;
  fields: PrismaField[];
  ids: string[][];
  uniques: string[][];
  line: number;
  end_line: number;
}

export interface PrismaSchema {
  provider?: string;
  enums: Array<{ name: string; values: string[]; line: number; end_line: number }>;
  models: PrismaModel[];
  /** Blocks or lines that could not be read. */
  unreadable: Array<{ line: number; reason: string }>;
}

const SCALARS = new Set([
  "String",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
  "Unsupported",
]);

export function isPrismaScalar(type: string): boolean {
  return SCALARS.has(type);
}

function listArgument(attribute: string, key: string): string[] | undefined {
  const m = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(attribute);
  return m
    ? m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : undefined;
}

function stringArgument(text: string): string | undefined {
  return /\(\s*(?:name\s*:\s*)?"([^"]*)"/.exec(text)?.[1];
}

/** Balanced argument text of the first `@name(` in `text`. */
function argumentsOf(text: string, name: string): string | undefined {
  const start = text.indexOf(`${name}(`);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start + name.length; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(start + name.length + 1, i);
  }
  return undefined;
}

export function parsePrisma(text: string): PrismaSchema {
  const schema: PrismaSchema = { enums: [], models: [], unreadable: [] };
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, ""));
  let i = 0;
  while (i < lines.length) {
    const header = /^\s*(model|enum|datasource|generator|view|type)\s+(\w+)\s*\{\s*$/.exec(lines[i]!);
    if (!header) {
      if (lines[i]!.trim() !== "" && !/^\s*}\s*$/.test(lines[i]!))
        schema.unreadable.push({ line: i + 1, reason: "line outside a block" });
      i++;
      continue;
    }
    const [, kind, name] = header;
    const start = i;
    const body: Array<{ text: string; line: number }> = [];
    i++;
    while (i < lines.length && !/^\s*}\s*$/.test(lines[i]!)) {
      if (lines[i]!.trim() !== "") body.push({ text: lines[i]!.trim(), line: i + 1 });
      i++;
    }
    const end = i + 1;
    i++;
    if (kind === "datasource") {
      const provider = body.map((b) => /^provider\s*=\s*"([^"]+)"/.exec(b.text)?.[1]).find((x) => x);
      if (provider) schema.provider = provider;
    } else if (kind === "enum") {
      schema.enums.push({
        name: name!,
        values: body.map((b) => b.text.split(/\s+/)[0]!).filter((v) => /^\w+$/.test(v)),
        line: start + 1,
        end_line: end,
      });
    } else if (kind === "model") {
      const model: PrismaModel = {
        name: name!,
        table: name!,
        mapped: false,
        fields: [],
        ids: [],
        uniques: [],
        line: start + 1,
        end_line: end,
      };
      for (const { text: row, line } of body) {
        if (row.startsWith("@@")) {
          const map = row.startsWith("@@map") ? stringArgument(row) : undefined;
          if (map) {
            model.table = map;
            model.mapped = true;
          }
          if (row.startsWith("@@id"))
            model.ids.push(
              listArgument(row, "fields") ??
                /\[([^\]]*)\]/
                  .exec(row)?.[1]
                  ?.split(",")
                  .map((s) => s.trim()) ??
                [],
            );
          if (row.startsWith("@@unique"))
            model.uniques.push(
              listArgument(row, "fields") ??
                /\[([^\]]*)\]/
                  .exec(row)?.[1]
                  ?.split(",")
                  .map((s) => s.trim()) ??
                [],
            );
          continue;
        }
        const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(row);
        if (!m) {
          schema.unreadable.push({ line, reason: `field not understood in model ${name}` });
          continue;
        }
        const [, fieldName, type, list, optional, attributes] = m;
        const field: PrismaField = {
          name: fieldName!,
          type: type!,
          list: list !== undefined,
          optional: optional !== undefined,
          id: /@id\b/.test(attributes!),
          unique: /@unique\b/.test(attributes!),
          line,
        };
        const def = argumentsOf(attributes!, "@default");
        if (def !== undefined) field.default = def;
        const column = /@map\(\s*"([^"]+)"\s*\)/.exec(attributes!)?.[1];
        if (column) field.column = column;
        const relation = argumentsOf(attributes!, "@relation");
        if (relation !== undefined) {
          const relationName = /^\s*"([^"]+)"/.exec(relation)?.[1] ?? /name\s*:\s*"([^"]+)"/.exec(relation)?.[1];
          field.relation = {
            fields: listArgument(relation, "fields") ?? [],
            references: listArgument(relation, "references") ?? [],
            ...(relationName ? { name: relationName } : {}),
          };
        }
        if (/@updatedAt\b/.test(attributes!)) field.updated_at = true;
        model.fields.push(field);
      }
      schema.models.push(model);
    }
  }
  return schema;
}
