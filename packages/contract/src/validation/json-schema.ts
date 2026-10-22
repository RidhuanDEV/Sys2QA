import type { ValidateFunction } from "ajv";
import { contractAjv } from "./shared.js";

export interface JsonSchemaResult {
  ok: boolean;
  /** `<json pointer> <message>` per problem; never the offending values. */
  errors: string[];
}

const compiled = new WeakMap<object, ValidateFunction>();

/**
 * Validates data against an ad-hoc JSON Schema (2020-12) with the contract's validator configuration, e.g. the output
 * schema of an LLM call (ADR-008: LLM output is always schema-validated). Contract schemas may be referenced by `$id`.
 * Schemas are compiled once per schema object.
 */
export function validateJsonSchema(schema: object, data: unknown): JsonSchemaResult {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = contractAjv().compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(data)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`),
  };
}
