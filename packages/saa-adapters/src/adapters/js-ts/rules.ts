import ts from "typescript";

/**
 * Rule facts of one module (IMP-112): validation schemas declared with zod and transition tables. Only literal values
 * are recorded (numbers, patterns, messages); a bound given by a module constant is resolved when the constant is a
 * literal. Nothing is evaluated.
 */
export interface RuleFacts {
  validation_schemas?: ValidationSchema[];
  transition_tables?: TransitionTable[];
}

export interface ValidationSchema {
  /** The variable holding the schema. */
  name: string;
  library: "zod";
  fields: Array<{
    name: string;
    /** `string`, `number`, `boolean`, `date`, `enum`, `array`, `object` or `unknown`. */
    base: string;
    checks: Array<{ kind: string; value?: number | string; message?: string }>;
    optional: boolean;
    /** The field's source text, shortened, for the reader. */
    text: string;
    line: number;
    evidence: string;
  }>;
  line: number;
  evidence: string;
}

export interface TransitionTable {
  name: string;
  /** The key type when annotated (`Record<OrderStatus, OrderStatus[]>` → `OrderStatus`). */
  type?: string;
  states: string[];
  transitions: Array<{ from: string; to: string }>;
  /** Module functions that read the table: the guards that allow or refuse a transition. */
  guards: string[];
  line: number;
  evidence: string;
}

type Evidence = (node: ts.Node) => string;
type RangeOf = (node: ts.Node) => { start_line: number };

const BASES = new Set(["string", "number", "boolean", "date", "enum", "nativeEnum", "array", "object", "bigint"]);
const CHECKS = new Set([
  "min",
  "max",
  "length",
  "regex",
  "email",
  "url",
  "uuid",
  "int",
  "positive",
  "nonnegative",
  "negative",
  "nonpositive",
  "gt",
  "gte",
  "lt",
  "lte",
  "startsWith",
  "endsWith",
  "includes",
]);

export function ruleFacts(source: ts.SourceFile, evidence: Evidence, rangeOf: RangeOf): RuleFacts {
  const constants = new Map<string, ts.Expression>();
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) constants.set(d.name.text, d.initializer);
  // `depth` bounds constant chains, including cycles (`const A = B; const B = A`).
  const value = (node: ts.Expression | undefined, depth = 0): number | string | undefined => {
    if (!node) return undefined;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    )
      return -Number(node.operand.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isRegularExpressionLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) {
      const init = constants.get(node.text);
      return init && depth < 8 ? value(init, depth + 1) : undefined;
    }
    return undefined;
  };
  const message = (node: ts.Expression | undefined): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isObjectLiteralExpression(node))
      for (const p of node.properties)
        if (ts.isPropertyAssignment(p) && p.name.getText(source) === "message") return message(p.initializer);
    return undefined;
  };

  /** `z.string().min(12).regex(/x/)` → base and checks, innermost first; undefined when not a zod chain. */
  const chain = (
    node: ts.Expression,
  ): Omit<ValidationSchema["fields"][number], "name" | "text" | "line" | "evidence"> | undefined => {
    const calls: ts.CallExpression[] = [];
    let e: ts.Expression = node;
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      calls.unshift(e);
      e = e.expression.expression;
    }
    if (!ts.isIdentifier(e) || e.text !== "z" || calls.length === 0) return undefined;
    const [head, ...rest] = calls;
    const base = (head!.expression as ts.PropertyAccessExpression).name.text;
    const checks: ValidationSchema["fields"][number]["checks"] = [];
    let optional = false;
    for (const call of rest) {
      const name = (call.expression as ts.PropertyAccessExpression).name.text;
      if (name === "optional" || name === "nullish" || name === "nullable") optional = true;
      if (!CHECKS.has(name)) continue;
      const v = value(call.arguments[0]);
      const m = message(
        name === "regex" || name === "min" || name === "max" || name === "length"
          ? call.arguments[1]
          : call.arguments[0],
      );
      checks.push({
        kind: name,
        ...(v !== undefined && typeof v !== "object" ? { value: v } : {}),
        ...(m ? { message: m } : {}),
      });
    }
    return { base: BASES.has(base) ? base : "unknown", checks, optional };
  };

  const schemas: ValidationSchema[] = [];
  const tables: TransitionTable[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      // const xSchema = z.object({ ... }) — possibly followed by .strict(), .refine(...) and the like.
      let init: ts.Expression = d.initializer;
      while (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        !(ts.isIdentifier(init.expression.expression) && init.expression.expression.text === "z")
      )
        init = init.expression.expression;
      if (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        ts.isIdentifier(init.expression.expression) &&
        init.expression.expression.text === "z" &&
        init.expression.name.text === "object" &&
        init.arguments[0] &&
        ts.isObjectLiteralExpression(init.arguments[0])
      ) {
        const fields: ValidationSchema["fields"] = [];
        for (const p of init.arguments[0].properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          const parsed = chain(p.initializer);
          if (!parsed) continue;
          fields.push({
            name: p.name.getText(source).replace(/^["']|["']$/g, ""),
            ...parsed,
            text: p.initializer.getText(source).slice(0, 200),
            line: rangeOf(p).start_line,
            evidence: evidence(p),
          });
        }
        schemas.push({ name: d.name.text, library: "zod", fields, line: rangeOf(d).start_line, evidence: evidence(d) });
        continue;
      }
      // const TRANSITIONS = { A: ["B"], B: [] }: every value lists states that are themselves keys.
      if (ts.isObjectLiteralExpression(d.initializer)) {
        const entries: Array<[string, string[]]> = [];
        let closed = true;
        for (const p of d.initializer.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isArrayLiteralExpression(p.initializer)) {
            closed = false;
            break;
          }
          const targets = p.initializer.elements.map((x) => (ts.isStringLiteral(x) ? x.text : undefined));
          if (targets.some((t) => t === undefined)) {
            closed = false;
            break;
          }
          entries.push([p.name.getText(source).replace(/^["']|["']$/g, ""), targets as string[]]);
        }
        const keys = new Set(entries.map(([k]) => k));
        if (
          !closed ||
          entries.length < 2 ||
          !entries.some(([, t]) => t.length > 0) ||
          !entries.every(([, t]) => t.every((x) => keys.has(x)))
        )
          continue;
        const name = d.name.text;
        const guards = new Set<string>();
        for (const s of source.statements) {
          const fn = ts.isFunctionDeclaration(s) && s.name ? s : undefined;
          const arrow =
            ts.isVariableStatement(s) &&
            s.declarationList.declarations.find(
              (x) =>
                ts.isIdentifier(x.name) &&
                x.initializer &&
                (ts.isArrowFunction(x.initializer) || ts.isFunctionExpression(x.initializer)),
            );
          const body = fn?.body ?? (arrow ? arrow.initializer : undefined);
          const fnName = fn?.name?.text ?? (arrow ? (arrow.name as ts.Identifier).text : undefined);
          if (!body || !fnName) continue;
          let uses = false;
          const find = (n: ts.Node): void => {
            if (ts.isIdentifier(n) && n.text === name) uses = true;
            if (!uses) ts.forEachChild(n, find);
          };
          find(body);
          if (uses) guards.add(fnName);
        }
        const type =
          d.type &&
          ts.isTypeReferenceNode(d.type) &&
          d.type.typeArguments?.[0] &&
          ts.isTypeReferenceNode(d.type.typeArguments[0])
            ? d.type.typeArguments[0].typeName.getText(source)
            : undefined;
        tables.push({
          name,
          ...(type ? { type } : {}),
          states: entries.map(([k]) => k),
          transitions: entries.flatMap(([from, to]) => to.map((t) => ({ from, to: t }))),
          guards: [...guards].sort(),
          line: rangeOf(d).start_line,
          evidence: evidence(d),
        });
      }
    }
  }
  const facts: RuleFacts = {};
  if (schemas.length > 0) facts.validation_schemas = schemas;
  if (tables.length > 0) facts.transition_tables = tables;
  return facts;
}
