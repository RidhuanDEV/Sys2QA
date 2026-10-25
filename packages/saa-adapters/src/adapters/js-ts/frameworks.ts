import ts from "typescript";

/**
 * Framework facts of one module (IMP-107). They are recorded on the module entity because a route, a page or a form
 * only means something once the host follows identifiers across modules: which router is mounted where, which
 * component a route renders, which endpoint a form calls. Nothing here is executed or evaluated; only literals are
 * read, and anything computed is reported as dynamic.
 */
export interface FrameworkFacts {
  /** Environment variables the module reads; names only, never a fallback value (it may be a secret). */
  env_reads?: Array<{ name: string; has_default: boolean; line: number; evidence: string }>;
  express?: ExpressFacts;
  react_router?: { routes: PageRoute[] };
  components?: ComponentFacts[];
}

export interface ExpressFacts {
  /** Variables holding an application (`express()`) or a router (`Router()`), and parameters typed as one. */
  receivers: Array<{ local: string; kind: "app" | "router" | "parameter"; exported: boolean }>;
  routes: ExpressRoute[];
  mounts: Array<{ receiver: string; prefix: string; target: string; line: number; evidence: string }>;
}

export interface ExpressRoute {
  receiver: string;
  /** Upper-case HTTP method; `ALL` for `.all()`. */
  method: string;
  /** Literal path, or absent when the path is computed (then `dynamic` holds the source text). */
  path?: string;
  dynamic?: string;
  middleware: Array<{ name: string; args: string[] }>;
  line: number;
  evidence: string;
}

export interface PageRoute {
  /** Full path with parents joined, React Router parameters as `:name`. */
  path: string;
  /** Local identifier of the rendered component. */
  component?: string;
  line: number;
  evidence: string;
}

export interface ComponentFacts {
  name: string;
  exported: boolean;
  forms: FormFacts[];
  navigations: Array<{ to: string; line: number; evidence: string }>;
}

export interface FormFacts {
  /** `id`, else `name`, else `form<n>` in document order. */
  key: string;
  fields: Array<{ name: string; constraints: Record<string, string | number | boolean> }>;
  /** Requests made by the form's submit handler: literal URL and method. */
  submits: Array<{ method: string; url: string }>;
  line: number;
  evidence: string;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const ROUTER_FACTORIES = new Set([
  "createBrowserRouter",
  "createHashRouter",
  "createMemoryRouter",
  "createStaticRouter",
]);
const FIELD_TAGS = new Set(["input", "select", "textarea"]);
const CONSTRAINT_ATTRIBUTES = [
  "type",
  "required",
  "minLength",
  "maxLength",
  "min",
  "max",
  "pattern",
  "inputMode",
  "step",
  "multiple",
];

type Evidence = (node: ts.Node) => string;
type RangeOf = (node: ts.Node) => { start_line: number };

export function frameworkFacts(source: ts.SourceFile, evidence: Evidence, rangeOf: RangeOf): FrameworkFacts {
  const facts: FrameworkFacts = {};
  const env = envReads(source, evidence, rangeOf);
  if (env.length > 0) facts.env_reads = env;
  const express = expressFacts(source, evidence, rangeOf);
  if (express) facts.express = express;
  const routes = reactRouterRoutes(source, evidence, rangeOf);
  if (routes.length > 0) facts.react_router = { routes };
  const components = componentFacts(source, evidence, rangeOf);
  if (components.length > 0) facts.components = components;
  return facts;
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function literal(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

// ---------------------------------------------------------------- Environment variables

/** `process.env.X`, `process.env["X"]`, `import.meta.env.X` and `const { X, Y } = process.env`. */
function envReads(
  source: ts.SourceFile,
  evidence: Evidence,
  rangeOf: RangeOf,
): NonNullable<FrameworkFacts["env_reads"]> {
  const reads: NonNullable<FrameworkFacts["env_reads"]> = [];
  const isEnvObject = (node: ts.Expression): boolean => {
    const text = node.getText(source).replace(/\s+/g, "");
    return text === "process.env" || text === "import.meta.env" || text === "Deno.env";
  };
  const hasDefault = (node: ts.Node): boolean => {
    const parent = node.parent;
    return (
      !!parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression))
      reads.push({
        name: node.name.text,
        has_default: hasDefault(node),
        line: rangeOf(node).start_line,
        evidence: evidence(node),
      });
    else if (ts.isElementAccessExpression(node) && isEnvObject(node.expression) && literal(node.argumentExpression))
      reads.push({
        name: literal(node.argumentExpression)!,
        has_default: hasDefault(node),
        line: rangeOf(node).start_line,
        evidence: evidence(node),
      });
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isEnvObject(node.initializer)
    )
      for (const element of node.name.elements) {
        const name = (element.propertyName ?? element.name).getText(source);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          reads.push({
            name,
            has_default: element.initializer !== undefined,
            line: rangeOf(element).start_line,
            evidence: evidence(element),
          });
      }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

// ---------------------------------------------------------------- Express

function expressFacts(source: ts.SourceFile, evidence: Evidence, rangeOf: RangeOf): ExpressFacts | undefined {
  const receivers: ExpressFacts["receivers"] = [];
  const known = new Map<string, ExpressFacts["receivers"][number]["kind"]>();
  const routes: ExpressRoute[] = [];
  const mounts: ExpressFacts["mounts"] = [];

  // Receivers: `const app = express()`, `const r = Router()` / `express.Router()`, and parameters typed Express/Router.
  const visitDeclarations = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const name = calleeName(node.initializer);
      const kind = name === "express" ? "app" : name === "Router" ? "router" : undefined;
      if (kind) {
        const statement = node.parent.parent;
        known.set(node.name.text, kind);
        receivers.push({
          local: node.name.text,
          kind,
          exported: ts.isVariableStatement(statement) && isExported(statement),
        });
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isTypeReferenceNode(node.type)) {
      const type = node.type.typeName.getText(source);
      if (/^(express\.)?(Express|Application|Router|IRouter)$/.test(type) && !known.has(node.name.text)) {
        known.set(node.name.text, "parameter");
        receivers.push({ local: node.name.text, kind: "parameter", exported: false });
      }
    }
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(source);
  if (known.size === 0) return undefined;

  const visitCalls = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const receiver = node.expression.expression.text;
      const method = node.expression.name.text;
      if (known.has(receiver) && HTTP_METHODS.has(method) && node.arguments.length >= 2) {
        const [first, ...handlers] = node.arguments;
        const path = literal(first);
        routes.push({
          receiver,
          method: method.toUpperCase(),
          ...(path === undefined ? { dynamic: first!.getText(source).slice(0, 200) } : { path }),
          middleware: handlers.slice(0, -1).flatMap((h) => middlewareOf(h, source)),
          line: rangeOf(node).start_line,
          evidence: evidence(node),
        });
      } else if (known.has(receiver) && method === "use") {
        const prefix = literal(node.arguments[0]);
        for (const arg of node.arguments.slice(prefix === undefined ? 0 : 1))
          if (ts.isIdentifier(arg))
            mounts.push({
              receiver,
              prefix: prefix ?? "",
              target: arg.text,
              line: rangeOf(node).start_line,
              evidence: evidence(node),
            });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(source);
  return { receivers, routes, mounts };
}

function middlewareOf(node: ts.Expression, source: ts.SourceFile): Array<{ name: string; args: string[] }> {
  if (ts.isIdentifier(node)) return [{ name: node.text, args: [] }];
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name) return [{ name, args: node.arguments.map((a) => literal(a) ?? a.getText(source).slice(0, 80)) }];
  }
  return []; // inline functions are handlers, not named middleware
}

// ---------------------------------------------------------------- React Router

function reactRouterRoutes(source: ts.SourceFile, evidence: Evidence, rangeOf: RangeOf): PageRoute[] {
  const routes: PageRoute[] = [];
  const fromObjects = (array: ts.ArrayLiteralExpression, parent: string) => {
    for (const element of array.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const prop = (name: string) =>
        element.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === name,
        )?.initializer;
      const own = literal(prop("path"));
      const isIndex = prop("index")?.kind === ts.SyntaxKind.TrueKeyword;
      const path = joinPath(parent, own ?? "");
      const component =
        jsxComponent(prop("element")) ??
        (prop("Component") && ts.isIdentifier(prop("Component")!)
          ? (prop("Component") as ts.Identifier).text
          : undefined);
      if (own !== undefined || isIndex)
        routes.push({
          path,
          ...(component ? { component } : {}),
          line: rangeOf(element).start_line,
          evidence: evidence(element),
        });
      const children = prop("children");
      if (children && ts.isArrayLiteralExpression(children)) fromObjects(children, path);
    }
  };
  const fromJsx = (node: ts.Node, parent: string) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (opening.tagName.getText(source) === "Route") {
        const own = attribute(opening, "path");
        const path = joinPath(parent, typeof own === "string" ? own : "");
        const element = opening.attributes.properties.find(
          (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(source) === "element",
        );
        const component =
          element?.initializer && ts.isJsxExpression(element.initializer)
            ? jsxComponent(element.initializer.expression)
            : undefined;
        if (typeof own === "string" || attribute(opening, "index") === true)
          routes.push({
            path,
            ...(component ? { component } : {}),
            line: rangeOf(node).start_line,
            evidence: evidence(node),
          });
        if (ts.isJsxElement(node)) for (const child of node.children) fromJsx(child, path);
        return;
      }
    }
    ts.forEachChild(node, (child) => fromJsx(child, parent));
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ROUTER_FACTORIES.has(calleeName(node) ?? "") &&
      node.arguments[0] &&
      ts.isArrayLiteralExpression(node.arguments[0])
    ) {
      fromObjects(node.arguments[0], "");
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (routes.length === 0) fromJsx(source, "");
  return routes;
}

function joinPath(parent: string, own: string): string {
  if (own.startsWith("/")) return own;
  const base = parent === "" ? "" : parent.replace(/\/$/, "");
  const joined = `${base}/${own}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : "/";
}

function jsxComponent(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return jsxComponent(node.expression);
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  return undefined;
}

/** Literal JSX attribute value: string, number, boolean (`required` alone is `true`); undefined when computed. */
function attribute(opening: ts.JsxOpeningLikeElement, name: string): string | number | boolean | undefined {
  const attr = opening.attributes.properties.find(
    (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name,
  );
  if (!attr) return undefined;
  const init = attr.initializer;
  if (!init) return true;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand))
      return -Number(e.operand.text);
  }
  return undefined;
}

// ---------------------------------------------------------------- Components: forms, fields, navigation

function componentFacts(source: ts.SourceFile, evidence: Evidence, rangeOf: RangeOf): ComponentFacts[] {
  const components: ComponentFacts[] = [];
  const consider = (name: string, body: ts.Node, exported: boolean) => {
    const forms: FormFacts[] = [];
    const navigations: ComponentFacts["navigations"] = [];
    const localFunctions = new Map<string, ts.Node>();
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) localFunctions.set(node.name.text, node);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        localFunctions.set(node.name.text, node.initializer);
      ts.forEachChild(node, collect);
    };
    collect(body);
    const walk = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(source);
        if (tag === "form" || tag === "Form") {
          const key = String(attribute(opening, "id") ?? attribute(opening, "name") ?? `form${forms.length + 1}`);
          const handler = submitHandler(opening, localFunctions, source);
          forms.push({
            key,
            fields: ts.isJsxElement(node) ? fieldsOf(node, source) : [],
            submits: handler ? requestsIn(handler) : [],
            line: rangeOf(node).start_line,
            evidence: evidence(node),
          });
        }
        if (tag === "Link" || tag === "NavLink" || tag === "a") {
          const to = attribute(opening, tag === "a" ? "href" : "to");
          if (typeof to === "string" && to.startsWith("/"))
            navigations.push({ to, line: rangeOf(node).start_line, evidence: evidence(node) });
        }
      }
      if (ts.isCallExpression(node) && calleeName(node) === "navigate") {
        const to = literal(node.arguments[0]);
        if (to?.startsWith("/")) navigations.push({ to, line: rangeOf(node).start_line, evidence: evidence(node) });
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    if (forms.length > 0 || navigations.length > 0) components.push({ name, exported, forms, navigations });
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && /^[A-Z]/.test(statement.name.text))
      consider(statement.name.text, statement.body, isExported(statement));
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (
          ts.isIdentifier(d.name) &&
          /^[A-Z]/.test(d.name.text) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        )
          consider(d.name.text, d.initializer, isExported(statement));
  }
  return components;
}

function fieldsOf(form: ts.JsxElement, source: ts.SourceFile): FormFacts["fields"] {
  const fields: FormFacts["fields"] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const name = attribute(opening, "name");
      if (FIELD_TAGS.has(opening.tagName.getText(source)) && typeof name === "string") {
        const constraints: Record<string, string | number | boolean> = {};
        for (const key of CONSTRAINT_ATTRIBUTES) {
          const value = attribute(opening, key);
          if (value !== undefined) constraints[key] = value;
        }
        if (opening.tagName.getText(source) !== "input") constraints.element = opening.tagName.getText(source);
        fields.push({ name, constraints });
      }
    }
    ts.forEachChild(node, walk);
  };
  for (const child of form.children) walk(child);
  return fields;
}

function submitHandler(
  opening: ts.JsxOpeningLikeElement,
  locals: Map<string, ts.Node>,
  source: ts.SourceFile,
): ts.Node | undefined {
  for (const name of ["action", "onSubmit"]) {
    const attr = opening.attributes.properties.find(
      (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(source) === name,
    );
    const e = attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
    if (!e) continue;
    if (ts.isIdentifier(e)) return locals.get(e.text);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  }
  return undefined;
}

/** `fetch("/literal", { method: "POST" })` calls inside a handler. */
function requestsIn(handler: ts.Node): FormFacts["submits"] {
  const requests: FormFacts["submits"] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === "fetch") {
      const url = literal(node.arguments[0]);
      let method = "GET";
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options))
        for (const p of options.properties)
          if (ts.isPropertyAssignment(p) && p.name.getText() === "method")
            method = (literal(p.initializer) ?? method).toUpperCase();
      if (url !== undefined) requests.push({ method, url });
    }
    ts.forEachChild(node, walk);
  };
  walk(handler);
  return requests;
}
