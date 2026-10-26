import type { Operation } from "./operations.js";

/**
 * Version of the operation surface that agents and the Analyst Skill build on (SAA-FR-016). It changes when an
 * operation is removed or renamed, or its permission level, effect or input changes incompatibly; adding an operation
 * does not change it. A Skill declares the version it was written for and the operations it calls.
 */
export const CAPABILITY_VERSION = 1;

export interface CapabilityRequirement {
  name: string;
  level: Operation["level"];
  effect: Operation["effect"];
}

export interface CapabilityRequirements {
  capability_version: number;
  operations: CapabilityRequirement[];
}

export interface Incompatibility {
  reason: "capability_version_mismatch" | "operation_missing" | "level_changed" | "effect_changed";
  operation?: string;
  expected: string | number;
  actual: string | number | null;
}

/**
 * What a client expects that this host does not offer through the client's interface. Every difference is reported,
 * so an agent can say which tools it cannot use instead of silently skipping them.
 */
export function checkCompatibility(
  available: ReadonlyArray<Pick<Operation, "name" | "level" | "effect">>,
  requires: CapabilityRequirements,
): Incompatibility[] {
  const issues: Incompatibility[] = [];
  if (requires.capability_version !== CAPABILITY_VERSION)
    issues.push({
      reason: "capability_version_mismatch",
      expected: requires.capability_version,
      actual: CAPABILITY_VERSION,
    });
  const byName = new Map(available.map((o) => [o.name, o]));
  for (const wanted of requires.operations) {
    const op = byName.get(wanted.name);
    if (!op) issues.push({ reason: "operation_missing", operation: wanted.name, expected: wanted.name, actual: null });
    else {
      if (op.level !== wanted.level)
        issues.push({ reason: "level_changed", operation: wanted.name, expected: wanted.level, actual: op.level });
      if (op.effect !== wanted.effect)
        issues.push({ reason: "effect_changed", operation: wanted.name, expected: wanted.effect, actual: op.effect });
    }
  }
  return issues;
}
