import type { PackageQuery } from "@sys2qa/system-model";

/**
 * Business rules on a path: rules that validate an entity on it (source evidence, `VALIDATES`), and rules on the
 * fields of a form on it (`inputs`), which is how a runtime package records a constraint it saw without claiming
 * server-side validation (CR-002).
 */
export function rulesOnPath(model: PackageQuery, path: Iterable<string>): string[] {
  const rules = new Set<string>();
  const fields = new Set<string>();
  for (const id of path) {
    for (const r of model.related(id, "in", "VALIDATES")) rules.add(r.from);
    if (model.entity(id)?.kind === "form") {
      for (const f of (model.entity(id) as { inputs?: string[] }).inputs ?? []) fields.add(f);
      for (const r of model.related(id, "out", "CONTAINS")) fields.add(r.to);
    }
  }
  for (const rule of model.byKind("business_rule"))
    if (((rule as { inputs?: string[] }).inputs ?? []).some((f) => fields.has(f))) rules.add(rule.id);
  return [...rules].sort();
}
