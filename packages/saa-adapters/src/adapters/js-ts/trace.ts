import ts from "typescript";

/**
 * Tracing facts of one module (IMP-110). A unit is a piece of code an entry point runs: a top-level function
 * (`fn:<name>`) or an inline route handler or job callback (`at:<offset>`). For each unit the adapter records which
 * imported or module-level functions it calls, which Prisma models it reads or writes, which outbound requests it makes
 * and which imports it computes at run time. The host follows calls across modules; nothing is evaluated here.
 */
export interface TraceFacts {
  units?: Unit[];
  jobs?: Array<{ expression: string; unit: string; line: number; evidence: string }>;
}

export interface Unit {
  key: string;
  calls: Array<{ name: string; line: number; evidence: string }>;
  data: Array<{ model: string; op: string; access: "read" | "write"; line: number; evidence: string }>;
  outbound: Array<{ target: string; literal: boolean; line: number; evidence: string }>;
  dynamic_imports: Array<{ line: number; evidence: string }>;
}

type Evidence = (node: ts.Node) => string;
type RangeOf = (node: ts.Node) => { start_line: number };

const PRISMA_READS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const PRISMA_WRITES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);
const HTTP_CLIENTS = new Set(["fetch", "axios", "got", "ky"]);
const CRON = /^(\S+\s+){4,5}\S+$/;

/** The key a function-valued node gets when it is not a named top-level function. */
export function positionKey(node: ts.Node, source: ts.SourceFile): string {
  return `at:${node.getStart(source)}`;
}

function isFunction(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

export function traceFacts(source: ts.SourceFile, evidence: Evidence, rangeOf: RangeOf): TraceFacts {
  // Names a unit may call and the host can follow: imports and module-level functions.
  const followable = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) followable.add(clause.name.text);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
      if (named && ts.isNamedImports(named)) for (const e of named.elements) followable.add(e.name.text);
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) followable.add(statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name) && isFunction(d.initializer)) followable.add(d.name.text);
  }

  const units: Unit[] = [];
  const jobs: NonNullable<TraceFacts["jobs"]> = [];
  const unitOf = (key: string, body: ts.Node) => {
    const unit: Unit = { key, calls: [], data: [], outbound: [], dynamic_imports: [] };
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const line = rangeOf(node).start_line;
        const httpClient =
          (ts.isIdentifier(callee) && HTTP_CLIENTS.has(callee.text) && !followable.has(callee.text)) ||
          /^(axios|got|ky)\.(get|post|put|patch|delete|request)$/.test(callee.getText(source));
        if (httpClient) {
          const arg = node.arguments[0];
          const text =
            arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
          // A path relative to the application's own origin is an internal request, not an outbound one.
          const relative = (text ?? (arg && ts.isTemplateExpression(arg) ? arg.head.text : "")).startsWith("/");
          if (!relative)
            unit.outbound.push({
              target: text ?? arg?.getText(source).slice(0, 120) ?? "<none>",
              literal: text !== undefined,
              line,
              evidence: evidence(node),
            });
        } else if (ts.isIdentifier(callee) && followable.has(callee.text)) {
          unit.calls.push({ name: callee.text, line, evidence: evidence(node) });
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text)
        ) {
          unit.calls.push({ name: `${callee.expression.text}.${callee.name.text}`, line, evidence: evidence(node) });
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isPropertyAccessExpression(callee.expression) &&
          ts.isIdentifier(callee.expression.expression) &&
          (PRISMA_READS.has(callee.name.text) || PRISMA_WRITES.has(callee.name.text))
        ) {
          unit.data.push({
            model: callee.expression.name.text,
            op: callee.name.text,
            access: PRISMA_WRITES.has(callee.name.text) ? "write" : "read",
            line,
            evidence: evidence(node),
          });
        } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (arg && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg))
            unit.dynamic_imports.push({ line, evidence: evidence(node) });
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    units.push(unit);
  };

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      unitOf(`fn:${statement.name.text}`, statement.body);
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name) && isFunction(d.initializer)) unitOf(`fn:${d.name.text}`, d.initializer.body);
  }
  // Inline route handlers and job callbacks: the last function argument of `.get(...)`, `.post(...)`, `schedule(...)`.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const last = node.arguments[node.arguments.length - 1];
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : "";
      const first = node.arguments[0]!;
      const expression =
        ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first) ? first.text : undefined;
      if (isFunction(last)) {
        const key = positionKey(last, source);
        if (name === "schedule" && expression !== undefined && CRON.test(expression.trim())) {
          unitOf(key, last.body);
          jobs.push({
            expression: expression.trim(),
            unit: key,
            line: rangeOf(node).start_line,
            evidence: evidence(node),
          });
        } else if (["get", "post", "put", "patch", "delete", "options", "head", "all"].includes(name))
          unitOf(key, last.body);
      }
    }
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === "CronJob" &&
      node.arguments &&
      node.arguments.length >= 2
    ) {
      const first = node.arguments[0]!;
      const callback = node.arguments[1];
      if ((ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && isFunction(callback)) {
        const key = positionKey(callback, source);
        unitOf(key, callback.body);
        jobs.push({
          expression: first.text.trim(),
          unit: key,
          line: rangeOf(node).start_line,
          evidence: evidence(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const facts: TraceFacts = {};
  const useful = units.filter(
    (u) => u.calls.length + u.data.length + u.outbound.length + u.dynamic_imports.length > 0 || u.key.startsWith("at:"),
  );
  if (useful.length > 0) facts.units = useful;
  if (jobs.length > 0) facts.jobs = jobs;
  return facts;
}
