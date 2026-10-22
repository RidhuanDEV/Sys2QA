import type { ErrorObject } from "ajv";
import type { Ajv2020 } from "ajv/dist/2020.js";
import { createContractAjv, schemaId, type ContractSchemaName } from "../schemas.js";
import { issue, type ContractIssue, type ErrorCode, type RuleId } from "./errors.js";

let cachedAjv: Ajv2020 | undefined;

/** Shared Ajv instance; schemas are compiled once per process. */
export function contractAjv(): Ajv2020 {
  cachedAjv ??= createContractAjv();
  return cachedAjv;
}

export function schemaIssues(
  name: ContractSchemaName,
  document: unknown,
  code: ErrorCode,
  artifact?: string,
): ContractIssue[] {
  const validate = contractAjv().getSchema(schemaId(name));
  if (!validate) throw new Error(`Contract schema not registered: ${name}`);
  if (validate(document)) return [];
  return (validate.errors ?? [])
    .filter((e) => e.keyword !== "if")
    .map((e) => fromAjvError(e, code, artifact, schemaRule(name, e)));
}

/**
 * Semantic rules that the schemas enforce structurally. Ajv reports schema paths relative to the
 * referenced definition, so the instance path disambiguates which definition fired.
 */
const SCHEMA_ENFORCED_RULES: ReadonlyArray<{
  schema: ContractSchemaName;
  instance: RegExp;
  schemaPath: string;
  rule: RuleId;
}> = [
  { schema: "system-model", instance: /^\/workflows\/\d+\//, schemaPath: "#/allOf/0/", rule: "CR-040" },
  { schema: "system-model", instance: /^\/workflows\/\d+\//, schemaPath: "#/allOf/1/", rule: "CR-041" },
  {
    schema: "completeness-report",
    instance: /^\/count_scope$/,
    schemaPath: "#/properties/count_scope/",
    rule: "CR-043",
  },
];

function schemaRule(name: ContractSchemaName, error: ErrorObject): RuleId | undefined {
  return SCHEMA_ENFORCED_RULES.find(
    (r) => r.schema === name && r.instance.test(error.instancePath) && error.schemaPath.startsWith(r.schemaPath),
  )?.rule;
}

function fromAjvError(error: ErrorObject, code: ErrorCode, artifact?: string, rule?: RuleId): ContractIssue {
  const pointer = error.instancePath === "" ? "/" : error.instancePath;
  const extra: Omit<ContractIssue, "code" | "severity" | "message"> = {
    json_pointer: pointer,
    details: { keyword: error.keyword, params: error.params, schema_path: error.schemaPath },
  };
  if (artifact !== undefined) extra.artifact = artifact;
  if (rule !== undefined) extra.rule = rule;
  return issue(code, `${pointer} ${error.message ?? "is invalid"}`, extra);
}

// ---- defensive JSON access (validators run on untrusted, possibly schema-invalid input) ----
export type JsonObject = Record<string, unknown>;
export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
export const asObject = (v: unknown): JsonObject => (isObject(v) ? v : {});
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const asStrings = (v: unknown): string[] => asArray(v).filter((x): x is string => typeof x === "string");

/** Escapes a token for use in a JSON Pointer (RFC 6901). */
export const ptr = (...tokens: Array<string | number>): string =>
  "/" + tokens.map((t) => String(t).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export function majorOf(version: unknown): number | undefined {
  const m = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  return m ? Number(m[1]) : undefined;
}
export function minorOf(version: unknown): number | undefined {
  const m = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  return m ? Number(m[2]) : undefined;
}
