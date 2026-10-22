import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";

/** Contract release version (Contract Specification §10). */
export const CONTRACT_VERSION = "1.0.0";

export const SCHEMA_BASE_URI = "https://sys2qa.dev/schemas/";

/** Every canonical schema in /schemas (Contract Specification §2 plus shared definitions). */
export const CONTRACT_SCHEMA_NAMES = [
  "common",
  "package-manifest",
  "system-model",
  "evidence-index",
  "diff-report",
  "correlation-report",
  "analysis-request",
  "analysis-response",
  "completeness-report",
  "readiness-assessment",
  "test-plan",
  "scenario",
  "approval",
  "manual-test-pack",
  "run-result",
  "defect",
  "adapter-protocol",
  "error",
] as const;

export type ContractSchemaName = (typeof CONTRACT_SCHEMA_NAMES)[number];

export type JsonSchemaDocument = { $id: string; [keyword: string]: unknown };

export function schemaId(name: ContractSchemaName): string {
  return `${SCHEMA_BASE_URI}${name}/1.0.json`;
}

/** The repository-level /schemas directory, which is the canonical source (ADR-003). */
export function defaultSchemaDirectory(): string {
  return fileURLToPath(new URL("../../../schemas/", import.meta.url));
}

export function loadContractSchemas(
  directory: string = defaultSchemaDirectory(),
): Map<ContractSchemaName, JsonSchemaDocument> {
  const schemas = new Map<ContractSchemaName, JsonSchemaDocument>();
  for (const name of CONTRACT_SCHEMA_NAMES) {
    const document = JSON.parse(readFileSync(`${directory}/${name}.schema.json`, "utf8")) as JsonSchemaDocument;
    if (document.$id !== schemaId(name)) {
      throw new Error(`Schema ${name} has $id ${String(document.$id)}; expected ${schemaId(name)}`);
    }
    schemas.set(name, document);
  }
  return schemas;
}

// ajv-formats is CommonJS (`module.exports = plugin; exports.default = plugin`). Under NodeNext the
// namespace's `default` is module.exports, so `.default.default` is the plugin in both types and runtime.
const addFormats = ajvFormats.default.default;

/**
 * Ajv instance holding every contract schema.
 * strict mode is on; `strictRequired` is off because `required` inside if/then branches
 * is idiomatic JSON Schema, and union types such as ["string","null"] are allowed.
 */
export function createContractAjv(
  schemas: Map<ContractSchemaName, JsonSchemaDocument> = loadContractSchemas(),
): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  for (const document of schemas.values()) ajv.addSchema(document);
  return ajv;
}
