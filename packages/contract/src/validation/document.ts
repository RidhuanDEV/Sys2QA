import type { ContractSchemaName } from "../schemas.js";
import { result, type ValidationResult } from "./errors.js";
import { schemaIssues } from "./shared.js";

/** Structural validation of a single contract document against its schema (code CONTRACT_SCHEMA_INVALID). */
export function validateDocument(name: ContractSchemaName, document: unknown): ValidationResult {
  return result(schemaIssues(name, document, "CONTRACT_SCHEMA_INVALID"));
}
