import ignore from "ignore";

/** One `.gitignore`-syntax rule set and the directory it applies to (`""` is the root). */
export interface RuleSet {
  base: string;
  rules: ignore.Ignore;
}

export type IgnoreVerdict = { ignored: false } | { ignored: true; pattern: string };

export function ruleSet(base: string, patterns: string | readonly string[]): RuleSet {
  return { base, rules: ignore().add(patterns as string | string[]) };
}

/**
 * Evaluates a path against nested `.gitignore` rule sets as Git does: the deepest rule set that has a matching rule
 * (positive or negated) decides; otherwise the next one up. `sets` is ordered from the root down. A directory path
 * must end with `/` so that directory-only patterns (`build/`) apply.
 */
export function evaluate(sets: readonly RuleSet[], path: string): IgnoreVerdict {
  for (let i = sets.length - 1; i >= 0; i--) {
    const set = sets[i]!;
    const rel = set.base === "" ? path : path.slice(set.base.length + 1);
    const result = set.rules.test(rel);
    if (result.ignored) return { ignored: true, pattern: result.rule?.pattern ?? "" };
    if (result.unignored) return { ignored: false };
  }
  return { ignored: false };
}
