import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import type { CoverageItem, Entity, Evidence, Relationship } from "@sys2qa/contract";
import type { AnalyzeResult } from "../../protocol.js";

export const ADAPTER_ID = "js-ts";
export const ADAPTER_VERSION = "0.1.0";
const METHOD = "typescript-ast";

/** Extensions the adapter parses, with the TypeScript script kind for each. */
const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS,
  ".d.ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** NodeNext style: `./x.js` in TypeScript source names `./x.ts`. */
const JS_TO_TS: Readonly<Record<string, string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[a-z]+$/i;
const BUILTINS = new Set(builtinModules);

export interface FileInput {
  /** Root-relative path with `/` separators. */
  path: string;
  /** `sha256:<hex>` of the content. */
  sha256: string;
  text: string;
}

export interface ExtractContext {
  /** Root-relative directory of the project boundary the batch belongs to (`""` for the root). */
  boundaryPath: string;
  /** Whether a root-relative path is a file. */
  exists(path: string): boolean;
  capturedAt: string;
}

/** One import of a module, kept on the module entity so the host can link references across batches. */
export interface ImportRecord {
  specifier: string;
  /** Target module ID: a module of this boundary, `module:pkg:<name>` or `module:node:<name>`; absent if unresolved. */
  target?: string;
  /** Names imported (`default`, `*` for a namespace import). */
  names: string[];
  type_only: boolean;
  kind: "static" | "re_export" | "dynamic" | "require";
  line: number;
}

/** `project:.` → `""`; `project:apps/web` → `apps/web`; `project:root1/apps/web` → `apps/web` (the cwd is that root). */
export function boundaryPathOf(rootId: string): string {
  const local = rootId.startsWith("project:") ? rootId.slice("project:".length) : rootId;
  const path = local.replace(/^root\d+\//, "");
  return path === "." || path === "root" ? "" : path.replace(/^\.\//, "");
}

/**
 * Module key (Data Model §3): the path inside the boundary, without a leading `src/`, without the extension and
 * without a trailing `/index`, with `.` separators. `src/server/plugins/index.ts` → `server.plugins`.
 */
export function moduleKey(boundaryPath: string, path: string): string {
  let rel = boundaryPath === "" ? path : path.slice(boundaryPath.length + 1);
  rel = rel.replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
  if (rel.startsWith("src/")) rel = rel.slice(4);
  if (rel.endsWith("/index")) rel = rel.slice(0, -"/index".length);
  return rel.split("/").join(".");
}

export function moduleId(boundaryPath: string, path: string): string {
  const key = moduleKey(boundaryPath, path);
  return boundaryPath === "" ? `module:${key}` : `module:${boundaryPath}:${key}`;
}

function symbolId(kind: "function" | "class", boundaryPath: string, path: string, name: string): string {
  const key = `${moduleKey(boundaryPath, path)}.${name}`;
  return boundaryPath === "" ? `${kind}:${key}` : `${kind}:${boundaryPath}:${key}`;
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Structural extraction for one batch (SAA-FR-005): one `module` entity per file, its top-level functions and classes,
 * `CONTAINS` and `IMPORTS` relationships, and evidence for each with a digest instead of source text (CR-060).
 * Syntax errors make a file `partial`, with the first diagnostics in the coverage reason; the tolerant parser still
 * yields what it recovered. References between modules are linked by the host once every batch is in.
 */
export function extractFiles(files: readonly FileInput[], context: ExtractContext): AnalyzeResult {
  const out: AnalyzeResult = { entities: [], relationships: [], evidence: [], coverage: [] };
  const seen = new Set<string>();
  const addEntity = (entity: Entity) => {
    if (seen.has(entity.id)) return;
    seen.add(entity.id);
    out.entities.push(entity);
  };
  const parsed = files
    .filter((f) => SCRIPT_KINDS[extension(f.path)] !== undefined)
    .map((f) => ({
      file: f,
      source: ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension(f.path)]),
    }));
  for (const f of files)
    if (SCRIPT_KINDS[extension(f.path)] === undefined)
      out.coverage.push({ area: f.path, status: "unsupported", reason: "not a JavaScript or TypeScript file" });
  const diagnostics = syntaxDiagnostics(parsed.map((p) => p.source));

  for (const { file, source } of parsed) {
    const sourceType = TEST_FILE.test(file.path) ? "test_definition" : "source_code";
    const evidence = (range: { start_line: number; end_line: number }, digestOf: string): string => {
      const id = `evidence:${hash16(sourceType, file.path, `${range.start_line}-${range.end_line}`, file.sha256, ADAPTER_ID, ADAPTER_VERSION, METHOD)}`;
      if (!out.evidence.some((e) => e.id === id))
        out.evidence.push({
          id,
          source_type: sourceType,
          captured_at: context.capturedAt,
          extractor: { adapter: ADAPTER_ID, version: ADAPTER_VERSION, method: METHOD },
          path: file.path,
          range,
          file_fingerprint: file.sha256,
          excerpt_policy: "digest_only",
          excerpt_digest: sha256(digestOf),
        } as Evidence);
      return id;
    };
    const rangeOf = (node: ts.Node) => ({
      start_line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      end_line: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
    });
    const boundary = context.boundaryPath === "" ? "project:." : `project:${context.boundaryPath}`;
    const id = moduleId(context.boundaryPath, file.path);
    const imports: ImportRecord[] = [];
    const unresolved: string[] = [];
    const lineCount = source.getLineAndCharacterOfPosition(source.getEnd()).line + 1;
    const moduleEvidence = evidence({ start_line: 1, end_line: lineCount }, file.text);
    const exported: string[] = [];

    const addImport = (record: Omit<ImportRecord, "target">, node: ts.Node) => {
      const target = resolveSpecifier(file.path, record.specifier, context);
      if (target === ASSET) {
        imports.push(record); // JSON, CSS and other non-code files: recorded, not a module edge
        return;
      }
      imports.push(target === undefined ? record : { ...record, target });
      if (target === undefined) {
        unresolved.push(`${record.specifier} (line ${record.line})`);
        return;
      }
      if (target.startsWith("module:pkg:") || target.startsWith("module:node:"))
        addEntity({
          id: target,
          kind: "module",
          name: target.slice(target.indexOf(":", 7) + 1),
          // A package is shared; it is attributed to the first boundary that imports it.
          project_boundary: boundary,
          status: "source_verified",
          origin: "source",
          evidence_ids: [evidence(rangeOf(node), node.getText(source))],
          external: true,
        } as Entity);
      out.relationships.push(relationship("IMPORTS", id, target, evidence(rangeOf(node), node.getText(source))));
    };

    for (const statement of source.statements) {
      const line = rangeOf(statement).start_line;
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        addImport(
          {
            specifier: statement.moduleSpecifier.text,
            names: importedNames(statement.importClause),
            type_only: statement.importClause?.isTypeOnly ?? false,
            kind: "static",
            line,
          },
          statement,
        );
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        addImport(
          {
            specifier: statement.moduleSpecifier.text,
            names:
              statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
                : ["*"],
            type_only: statement.isTypeOnly,
            kind: "re_export",
            line,
          },
          statement,
        );
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteral(statement.moduleReference.expression)
      ) {
        addImport(
          {
            specifier: statement.moduleReference.expression.text,
            names: ["*"],
            type_only: statement.isTypeOnly,
            kind: "require",
            line,
          },
          statement,
        );
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
        const name = statement.name?.text ?? (isDefault ? "default" : undefined);
        if (name === undefined) continue;
        const kind = ts.isFunctionDeclaration(statement) ? "function" : "class";
        addSymbol(kind, name, statement, isExported ? (isDefault ? ["default", name] : [name]) : []);
      } else if (ts.isVariableStatement(statement)) {
        const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          if (!ts.isIdentifier(declaration.name)) continue;
          if (isExported) exported.push(declaration.name.text);
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
            addSymbol("function", declaration.name.text, declaration, isExported ? [declaration.name.text] : []);
        }
      } else if (ts.isExportAssignment(statement)) {
        exported.push("default");
      }
    }
    // require("x") and import("x") anywhere in the file.
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if ((isRequire || isDynamic) && node.arguments.length > 0) {
          const arg = node.arguments[0]!;
          const line = rangeOf(node).start_line;
          if (ts.isStringLiteralLike(arg))
            addImport(
              { specifier: arg.text, names: ["*"], type_only: false, kind: isRequire ? "require" : "dynamic", line },
              node,
            );
          else unresolved.push(`${isRequire ? "require" : "import"}(<computed>) (line ${line})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    function addSymbol(kind: "function" | "class", name: string, node: ts.Node, exportNames: string[]) {
      const symbol = symbolId(kind, context.boundaryPath, file.path, name);
      exported.push(...exportNames);
      addEntity({
        id: symbol,
        kind,
        name,
        project_boundary: boundary,
        module_id: id,
        status: "source_verified",
        origin: "source",
        evidence_ids: [evidence(rangeOf(node), node.getText(source))],
        exported: exportNames.length > 0,
        export_names: exportNames,
      } as Entity);
      out.relationships.push(relationship("CONTAINS", id, symbol, evidence(rangeOf(node), node.getText(source))));
    }

    addEntity({
      id,
      kind: "module",
      name: file.path,
      project_boundary: boundary,
      status: "source_verified",
      origin: "source",
      evidence_ids: [moduleEvidence],
      path: file.path,
      language: /\.(ts|tsx|mts|cts)$/.test(file.path) ? "typescript" : "javascript",
      exports: [...new Set(exported)].sort(),
      imports,
    } as Entity);

    const errors = diagnostics.get(file.path) ?? [];
    const notes = [
      ...errors.slice(0, 3).map((d) => `syntax error at line ${d.line}: ${d.message}`),
      ...(unresolved.length > 0 ? [`unresolved imports: ${unresolved.slice(0, 5).join(", ")}`] : []),
    ];
    const item: CoverageItem = {
      area: file.path,
      status: errors.length > 0 || unresolved.length > 0 ? "partial" : "analyzed",
    };
    if (notes.length > 0) item.reason = notes.join("; ");
    out.coverage.push(item);
  }
  return out;
}

function relationship(type: Relationship["type"], from: string, to: string, evidenceId: string): Relationship {
  return {
    id: `relationship:${hash16(type, from, to)}`,
    type,
    from,
    to,
    status: "source_verified",
    evidence_ids: [evidenceId],
  };
}

/** A relative import of an existing file that is not code (JSON, CSS, images). */
export const ASSET = "asset";

/** Resolves a specifier to a module ID: relative paths to files of the root, bare names to packages. */
export function resolveSpecifier(fromPath: string, specifier: string, context: ExtractContext): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    if (specifier.startsWith("/")) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    if (base.startsWith("../") || base === "..") return undefined; // outside the root
    const ext = extension(base);
    const stem = ext === "" ? base : base.slice(0, -ext.length);
    const candidates = [
      ...(JS_TO_TS[ext] ?? []).map((e) => stem + e),
      ...(ext !== "" && SCRIPT_KINDS[ext] !== undefined ? [base] : []),
      ...SOURCE_EXTENSIONS.map((e) => base + e),
      `${base}.d.ts`,
      ...SOURCE_EXTENSIONS.map((e) => `${base}/index${e}`),
      `${base}/index.d.ts`,
    ];
    const found = candidates.find((c) => context.exists(c));
    if (found === undefined)
      return ext !== "" && SCRIPT_KINDS[ext] === undefined && context.exists(base) ? ASSET : undefined;
    if (context.boundaryPath !== "" && !found.startsWith(`${context.boundaryPath}/`)) return undefined; // another boundary
    return moduleId(context.boundaryPath, found);
  }
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (specifier.startsWith("node:") || BUILTINS.has(bare.split("/")[0]!)) return `module:node:${bare.split("/")[0]}`;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return name === "" ? undefined : `module:pkg:${name}`;
}

function importedNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return []; // side-effect import
  const names: string[] = [];
  if (clause.name) names.push("default");
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
  if (bindings && ts.isNamedImports(bindings))
    for (const e of bindings.elements) names.push((e.propertyName ?? e.name).text);
  return names;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.endsWith(".d.ts")) return ".d.ts";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Syntax diagnostics per file from one program over the batch, without type checking or module resolution. */
function syntaxDiagnostics(sources: ts.SourceFile[]): Map<string, Array<{ line: number; message: string }>> {
  const byName = new Map(sources.map((s) => [s.fileName, s]));
  const program = ts.createProgram({
    rootNames: [...byName.keys()],
    options: { noResolve: true, noLib: true, allowJs: true, noEmit: true, types: [] },
    host: {
      getSourceFile: (name) => byName.get(name),
      getDefaultLibFileName: () => "lib.d.ts",
      writeFile: () => undefined,
      getCurrentDirectory: () => "",
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (name) => byName.has(name),
      readFile: () => undefined,
      getDirectories: () => [],
    },
  });
  const result = new Map<string, Array<{ line: number; message: string }>>();
  for (const source of sources) {
    const list = program.getSyntacticDiagnostics(source).map((d) => ({
      line: d.start === undefined ? 1 : source.getLineAndCharacterOfPosition(d.start).line + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    }));
    if (list.length > 0) result.set(source.fileName, list);
  }
  return result;
}
