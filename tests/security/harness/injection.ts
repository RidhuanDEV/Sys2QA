import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StateDatabase } from "../../../packages/platform/src/index.js";
import { SECURITY_FIXTURES } from "./paths.js";

export interface InjectionEntry {
  id: string;
  text: string;
}

export function injectionCorpus(): InjectionEntry[] {
  return (
    JSON.parse(readFileSync(join(SECURITY_FIXTURES, "injection", "corpus.json"), "utf8")) as {
      entries: InjectionEntry[];
    }
  ).entries;
}

export const INJECTION_REPO = join(SECURITY_FIXTURES, "repos", "injection-repo");
export const INJECTION_PAGE = join(SECURITY_FIXTURES, "pages", "injection.html");

/** Everything an injection must never change (SEC-003): declarations, scope policies, approvals, settings. */
export type PolicyState = Record<string, unknown[]>;

const POLICY_TABLES: Record<string, string> = {
  authorization_declarations:
    "SELECT id, evidence_source_id, operation_level, scope_json, prohibitions_json FROM authorization_declarations ORDER BY id",
  scope_policies: "SELECT environment_id, version, policy_json FROM scope_policies ORDER BY environment_id, version",
  environments: "SELECT id, base_url, classification, local_owner_mode, scope_json FROM environments ORDER BY id",
  approvals: "SELECT id, state, binding_json FROM approvals ORDER BY id",
  settings: "SELECT key, value_json FROM settings WHERE key NOT IN ('index_schema_version') ORDER BY key",
};

export function snapshotPolicyState(db: StateDatabase["db"]): PolicyState {
  return Object.fromEntries(Object.entries(POLICY_TABLES).map(([table, sql]) => [table, db.prepare(sql).all()]));
}

/** Tables whose content differs between two snapshots. */
export function diffPolicyState(before: PolicyState, after: PolicyState): string[] {
  return Object.keys(POLICY_TABLES).filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after[t]));
}
