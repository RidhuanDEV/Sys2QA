/**
 * Tolerant DDL reader (SP-1 decision, IMP-108). It splits a script into statements (quotes, identifiers, comments and
 * PostgreSQL dollar quoting aware) and reads the schema statements PostgreSQL, MySQL and SQLite share: CREATE TABLE,
 * ALTER TABLE, DROP TABLE and CREATE INDEX. Every other statement is skipped and counted; a schema statement it cannot
 * read is reported, without losing the rest of the file. Expressions (defaults, checks) are kept as text.
 */

export interface ColumnDef {
  name: string;
  type: string;
  not_null: boolean;
  primary_key: boolean;
  unique: boolean;
  default?: string;
  references?: { table: string; column?: string };
  checks: string[];
}

export type TableConstraint =
  | { kind: "primary_key"; columns: string[]; name?: string }
  | { kind: "unique"; columns: string[]; name?: string }
  | { kind: "foreign_key"; columns: string[]; table: string; references: string[]; name?: string }
  | { kind: "check"; expression: string; name?: string };

export type AlterAction =
  | { action: "add_column"; column: ColumnDef }
  | { action: "drop_column"; name: string }
  | { action: "rename_column"; from: string; to: string }
  | { action: "rename_table"; to: string }
  | { action: "add_constraint"; constraint: TableConstraint }
  | { action: "alter_column"; name: string; set_not_null?: boolean; default?: string | null; type?: string };

export type DdlOperation =
  | {
      op: "create_table";
      table: string;
      columns: ColumnDef[];
      constraints: TableConstraint[];
      line: number;
      text: string;
    }
  | { op: "alter_table"; table: string; actions: AlterAction[]; line: number; text: string }
  | { op: "drop_table"; tables: string[]; line: number; text: string }
  | { op: "create_index"; table: string; columns: string[]; unique: boolean; line: number; text: string };

export interface DdlResult {
  operations: DdlOperation[];
  /** Schema statements that could not be read, with their line. */
  unreadable: Array<{ line: number; reason: string }>;
  /** Statements that are not about the schema (INSERT, GRANT, functions, …). */
  skipped: number;
}

interface Statement {
  text: string;
  line: number;
}

/** Splits on `;` outside quotes, quoted identifiers, comments and dollar-quoted bodies; comments are dropped. */
export function splitStatements(script: string): Statement[] {
  const out: Statement[] = [];
  let current = "";
  let line = 1;
  let startLine = 1;
  let i = 0;
  const n = script.length;
  const push = () => {
    if (current.trim() !== "") out.push({ text: current.trim(), line: startLine });
    current = "";
  };
  while (i < n) {
    const c = script[i]!;
    if (current.trim() === "" && !/\s/.test(c)) startLine = line;
    if (c === "\n") line++;
    if (c === "-" && script[i + 1] === "-") {
      while (i < n && script[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && current.trim() === "") {
      while (i < n && script[i] !== "\n") i++; // MySQL line comment at statement start
      continue;
    }
    if (c === "/" && script[i + 1] === "*") {
      const end = script.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (script[k] === "\n") line++;
      i = stop;
      current += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let k = i + 1;
      while (k < n) {
        if (script[k] === close) {
          if (close !== "]" && script[k + 1] === close) {
            k += 2; // doubled quote
            continue;
          }
          break;
        }
        if (script[k] === "\\" && c === "'") k++;
        k++;
      }
      const chunk = script.slice(i, Math.min(k + 1, n));
      line += (chunk.match(/\n/g) ?? []).length;
      current += chunk;
      i = k + 1;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(script.slice(i, i + 64))?.[0];
      if (tag) {
        const end = script.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        const chunk = script.slice(i, stop);
        line += (chunk.match(/\n/g) ?? []).length;
        current += chunk;
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      push();
      i++;
      continue;
    }
    current += c;
    i++;
  }
  push();
  return out;
}

/** Tokens: quoted identifiers keep their content unquoted, strings keep their quotes, punctuation is single. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re =
    /\s+|"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|'(?:[^'\\]|\\.|'')*'|\$[A-Za-z_]*\$[\s\S]*?\$[A-Za-z_]*\$|::|<>|<=|>=|!=|[(),;]|[^\s(),;"`'[\]]+/g;
  for (const m of text.matchAll(re)) {
    if (/^\s+$/.test(m[0])) continue;
    tokens.push(
      m[1] !== undefined
        ? `\u0000${m[1].replace(/""/g, '"')}`
        : m[2] !== undefined
          ? `\u0000${m[2]}`
          : m[3] !== undefined
            ? `\u0000${m[3]}`
            : m[0],
    );
  }
  return tokens;
}

/** A token as an identifier: quoted identifiers verbatim, bare ones as written. */
function ident(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  return token.startsWith("\u0000") ? token.slice(1) : token;
}

function upper(token: string | undefined): string {
  return token === undefined || token.startsWith("\u0000") ? "" : token.toUpperCase();
}

/** `schema.table` (with or without quotes); the default schemas `public`, `main` and `dbo` are dropped. */
function qualifiedName(tokens: string[], at: number): { name: string; next: number } | undefined {
  const first = ident(tokens[at]);
  if (first === undefined || first === "(") return undefined;
  const parts = [first];
  let next = at + 1;
  // Dots arrive glued to bare tokens ("public.users", "public.") or alone between quoted parts.
  for (;;) {
    const last = parts[parts.length - 1]!;
    const t = tokens[next];
    if (last.endsWith(".") && t !== undefined) {
      parts[parts.length - 1] = last + (ident(t) ?? "");
      next++;
    } else if (t === "." && tokens[next + 1] !== undefined) {
      parts[parts.length - 1] = `${last}.${ident(tokens[next + 1]) ?? ""}`;
      next += 2;
    } else if (t !== undefined && t.startsWith(".") && !t.startsWith("\u0000")) {
      parts[parts.length - 1] = last + t;
      next++;
    } else break;
  }
  const segments = parts[0]!.split(".");
  if (segments.length === 2 && ["public", "main", "dbo"].includes(segments[0]!.toLowerCase()))
    return { name: segments[1]!, next };
  return { name: segments.join("."), next };
}

/** Splits the tokens between the outer parentheses starting at `open` into comma-separated groups. */
function groups(tokens: string[], open: number): { items: string[][]; close: number } {
  const items: string[][] = [];
  let depth = 0;
  let current: string[] = [];
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (t === ")") {
      depth--;
      if (depth === 0) {
        if (current.length > 0) items.push(current);
        return { items, close: i };
      }
    } else if (t === "," && depth === 1) {
      items.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  return { items, close: tokens.length };
}

function render(tokens: string[]): string {
  return tokens
    .map((t) => (t.startsWith("\u0000") ? `"${t.slice(1)}"` : t))
    .join(" ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .replace(/ ,/g, ",");
}

/** Text of a parenthesized expression starting at `open`, and the index after its `)`. */
function parenthesized(tokens: string[], open: number): { text: string; next: number } {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    else if (tokens[i] === ")" && --depth === 0) return { text: render(tokens.slice(open + 1, i)), next: i + 1 };
  }
  return { text: render(tokens.slice(open + 1)), next: tokens.length };
}

function columnList(tokens: string[], open: number): { names: string[]; next: number } {
  const { items, close } = groups(tokens, open);
  return { names: items.map((g) => ident(g[0]) ?? "").filter((x) => x !== ""), next: close + 1 };
}

const CONSTRAINT_STARTS = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "UNIQUE",
  "FOREIGN",
  "CHECK",
  "KEY",
  "INDEX",
  "EXCLUDE",
  "FULLTEXT",
  "SPATIAL",
]);
const COLUMN_KEYWORDS = new Set([
  "NOT",
  "NULL",
  "PRIMARY",
  "UNIQUE",
  "DEFAULT",
  "REFERENCES",
  "CHECK",
  "CONSTRAINT",
  "COLLATE",
  "GENERATED",
  "AUTO_INCREMENT",
  "AUTOINCREMENT",
  "IDENTITY",
  "ON",
  "COMMENT",
  "AS",
]);

function parseColumn(tokens: string[]): ColumnDef | undefined {
  const name = ident(tokens[0]);
  if (!name) return undefined;
  const typeTokens: string[] = [];
  let i = 1;
  let depth = 0;
  while (i < tokens.length && (depth > 0 || !COLUMN_KEYWORDS.has(upper(tokens[i])))) {
    if (tokens[i] === "(") depth++;
    if (tokens[i] === ")") depth--;
    typeTokens.push(tokens[i]!);
    i++;
  }
  const column: ColumnDef = {
    name,
    type: render(typeTokens).replace(/(\w) \(/g, "$1(") || "unknown",
    not_null: false,
    primary_key: false,
    unique: false,
    checks: [],
  };
  while (i < tokens.length) {
    const t = upper(tokens[i]);
    if (t === "NOT" && upper(tokens[i + 1]) === "NULL") {
      column.not_null = true;
      i += 2;
    } else if (t === "PRIMARY" && upper(tokens[i + 1]) === "KEY") {
      column.primary_key = true;
      column.not_null = true;
      i += 2;
    } else if (t === "UNIQUE") {
      column.unique = true;
      i++;
    } else if (t === "DEFAULT") {
      const start = i + 1;
      let end = start;
      let d = 0;
      while (end < tokens.length && (d > 0 || end === start || !COLUMN_KEYWORDS.has(upper(tokens[end])))) {
        if (tokens[end] === "(") d++;
        if (tokens[end] === ")") d--;
        end++;
      }
      column.default = render(tokens.slice(start, end));
      i = end;
    } else if (t === "REFERENCES") {
      const target = qualifiedName(tokens, i + 1);
      if (!target) break;
      i = target.next;
      let referenced: string | undefined;
      if (tokens[i] === "(") {
        const list = columnList(tokens, i);
        referenced = list.names[0];
        i = list.next;
      }
      column.references =
        referenced === undefined ? { table: target.name } : { table: target.name, column: referenced };
    } else if (t === "CHECK" && tokens[i + 1] === "(") {
      const expr = parenthesized(tokens, i + 1);
      column.checks.push(expr.text);
      i = expr.next;
    } else i++;
  }
  return column;
}

function parseTableConstraint(tokens: string[]): TableConstraint | undefined {
  let i = 0;
  let name: string | undefined;
  if (upper(tokens[0]) === "CONSTRAINT") {
    name = ident(tokens[1]);
    i = 2;
  }
  const t = upper(tokens[i]);
  const named = <T extends object>(c: T): T => (name === undefined ? c : { ...c, name });
  if (t === "PRIMARY" && upper(tokens[i + 1]) === "KEY" && tokens[i + 2] === "(")
    return named({ kind: "primary_key" as const, columns: columnList(tokens, i + 2).names });
  if (t === "UNIQUE") {
    const open = tokens.indexOf("(", i);
    if (open !== -1) return named({ kind: "unique" as const, columns: columnList(tokens, open).names });
  }
  if (t === "FOREIGN" && upper(tokens[i + 1]) === "KEY" && tokens[i + 2] === "(") {
    const local = columnList(tokens, i + 2);
    if (upper(tokens[local.next]) !== "REFERENCES") return undefined;
    const target = qualifiedName(tokens, local.next + 1);
    if (!target) return undefined;
    const remote = tokens[target.next] === "(" ? columnList(tokens, target.next).names : [];
    return named({ kind: "foreign_key" as const, columns: local.names, table: target.name, references: remote });
  }
  if (t === "CHECK" && tokens[i + 1] === "(")
    return named({ kind: "check" as const, expression: parenthesized(tokens, i + 1).text });
  return undefined;
}

export function parseDdl(script: string): DdlResult {
  const result: DdlResult = { operations: [], unreadable: [], skipped: 0 };
  for (const statement of splitStatements(script)) {
    const tokens = tokenize(statement.text);
    const head = tokens.slice(0, 6).map(upper);
    try {
      if (head[0] === "CREATE" && head.slice(1, 5).includes("TABLE")) {
        const at = tokens.findIndex((t) => upper(t) === "TABLE") + 1;
        const skip = upper(tokens[at]) === "IF" ? at + 3 : at; // IF NOT EXISTS
        const name = qualifiedName(tokens, skip);
        if (!name || tokens[name.next] !== "(") {
          result.unreadable.push({
            line: statement.line,
            reason: "CREATE TABLE without a column list (for example CREATE TABLE … AS SELECT)",
          });
          continue;
        }
        const { items } = groups(tokens, name.next);
        const columns: ColumnDef[] = [];
        const constraints: TableConstraint[] = [];
        for (const item of items) {
          if (CONSTRAINT_STARTS.has(upper(item[0]))) {
            const c = parseTableConstraint(item);
            if (c) constraints.push(c);
          } else {
            const column = parseColumn(item);
            if (column) columns.push(column);
          }
        }
        result.operations.push({
          op: "create_table",
          table: name.name,
          columns,
          constraints,
          line: statement.line,
          text: statement.text,
        });
      } else if (head[0] === "ALTER" && head[1] === "TABLE") {
        let at = 2;
        if (upper(tokens[at]) === "IF") at += 2;
        if (upper(tokens[at]) === "ONLY") at++;
        const name = qualifiedName(tokens, at);
        if (!name) throw new Error("ALTER TABLE without a table name");
        const actions: AlterAction[] = [];
        const clauses: string[][] = [[]];
        let depth = 0;
        for (const t of tokens.slice(name.next)) {
          if (t === "(") depth++;
          if (t === ")") depth--;
          if (t === "," && depth === 0) clauses.push([]);
          else clauses[clauses.length - 1]!.push(t);
        }
        for (const clause of clauses) {
          const action = parseAlterClause(clause);
          if (action) actions.push(action);
        }
        result.operations.push({
          op: "alter_table",
          table: name.name,
          actions,
          line: statement.line,
          text: statement.text,
        });
      } else if (head[0] === "DROP" && head[1] === "TABLE") {
        let at = 2;
        if (upper(tokens[at]) === "IF") at += 2;
        const tables: string[] = [];
        while (at < tokens.length) {
          const name = qualifiedName(tokens, at);
          if (!name || ["CASCADE", "RESTRICT"].includes(upper(tokens[at]))) break;
          tables.push(name.name);
          at = name.next;
          if (tokens[at] !== ",") break;
          at++;
        }
        result.operations.push({ op: "drop_table", tables, line: statement.line, text: statement.text });
      } else if (head[0] === "CREATE" && (head[1] === "INDEX" || (head[1] === "UNIQUE" && head[2] === "INDEX"))) {
        const on = tokens.findIndex((t) => upper(t) === "ON");
        if (on === -1) throw new Error("CREATE INDEX without ON");
        let at = on + 1;
        if (upper(tokens[at]) === "ONLY") at++;
        const name = qualifiedName(tokens, at);
        if (!name) throw new Error("CREATE INDEX without a table");
        let open = name.next;
        if (upper(tokens[open]) === "USING") open += 2;
        const columns = tokens[open] === "(" ? columnList(tokens, open).names : [];
        result.operations.push({
          op: "create_index",
          table: name.name,
          columns,
          unique: head[1] === "UNIQUE",
          line: statement.line,
          text: statement.text,
        });
      } else {
        result.skipped++;
      }
    } catch (error) {
      result.unreadable.push({ line: statement.line, reason: (error as Error).message });
    }
  }
  return result;
}

function parseAlterClause(clause: string[]): AlterAction | undefined {
  const t0 = upper(clause[0]);
  const t1 = upper(clause[1]);
  if (t0 === "ADD") {
    let at = 1;
    if (t1 === "COLUMN") at++;
    if (upper(clause[at]) === "IF") at += 3;
    if (CONSTRAINT_STARTS.has(upper(clause[at])) && t1 !== "COLUMN") {
      const c = parseTableConstraint(clause.slice(at));
      return c ? { action: "add_constraint", constraint: c } : undefined;
    }
    const column = parseColumn(clause.slice(at));
    return column ? { action: "add_column", column } : undefined;
  }
  if (
    t0 === "DROP" &&
    (t1 === "COLUMN" || (t1 !== "CONSTRAINT" && t1 !== "INDEX" && t1 !== "KEY" && t1 !== "PRIMARY" && t1 !== "FOREIGN"))
  ) {
    let at = t1 === "COLUMN" ? 2 : 1;
    if (upper(clause[at]) === "IF") at += 2;
    const name = ident(clause[at]);
    return name ? { action: "drop_column", name } : undefined;
  }
  if (t0 === "RENAME" && t1 === "COLUMN") {
    const from = ident(clause[2]);
    const to = ident(clause[4]);
    return from && to ? { action: "rename_column", from, to } : undefined;
  }
  if (t0 === "RENAME" && t1 === "TO") {
    const to = ident(clause[2]);
    return to ? { action: "rename_table", to } : undefined;
  }
  if (t0 === "ALTER" || t0 === "MODIFY") {
    let at = 1;
    if (upper(clause[at]) === "COLUMN") at++;
    const name = ident(clause[at]);
    if (!name) return undefined;
    const rest = clause.slice(at + 1).map(upper);
    if (rest[0] === "SET" && rest[1] === "NOT" && rest[2] === "NULL")
      return { action: "alter_column", name, set_not_null: true };
    if (rest[0] === "DROP" && rest[1] === "NOT" && rest[2] === "NULL")
      return { action: "alter_column", name, set_not_null: false };
    if (rest[0] === "SET" && rest[1] === "DEFAULT")
      return { action: "alter_column", name, default: render(clause.slice(at + 3)) };
    if (rest[0] === "DROP" && rest[1] === "DEFAULT") return { action: "alter_column", name, default: null };
    if (rest[0] === "TYPE" || (rest[0] === "SET" && rest[1] === "DATA")) {
      const typeAt = rest[0] === "TYPE" ? at + 2 : at + 4;
      return { action: "alter_column", name, type: render(clause.slice(typeAt)).replace(/(\w) \(/g, "$1(") };
    }
  }
  return undefined;
}
