import { readFileSync } from "node:fs";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import { describe, expect, it } from "vitest";
import { ALLOWED_INTERNAL, cruiseOptions, dependencyRules } from "../../scripts/dependency-rules.mjs";

const FIXTURE_ROOT = "fixtures/dependency-rules/";
/** `files`: rules each file must violate (and no others). `cycles`: groups that must each be reported once; a cycle is reported from whichever member the cruise reaches first. */
const expected = JSON.parse(readFileSync(`${FIXTURE_ROOT}expected.json`, "utf8")) as {
  files: Record<string, string[]>;
  cycles: string[][];
};

async function violationsByFile(paths: string[], root: string): Promise<Map<string, Set<string>>> {
  const { output } = await cruise(paths, {
    ...cruiseOptions,
    validate: true,
    ruleSet: { forbidden: dependencyRules(root) },
  });
  const result = output as ICruiseResult;
  const byFile = new Map<string, Set<string>>();
  for (const v of result.summary.violations) {
    const file = v.from.slice(root.length);
    const rules = byFile.get(file) ?? new Set<string>();
    rules.add(v.rule.name);
    byFile.set(file, rules);
  }
  return byFile;
}

describe("module dependency rules [@req CON-027] [@req SYS-005] [@req SEC-025]", () => {
  it("every module in the allowed-imports table exists in the repository", () => {
    for (const module of Object.keys(ALLOWED_INTERNAL)) {
      expect(() => readFileSync(`packages/${module}/package.json`)).not.toThrow();
    }
  });

  it("reports exactly the expected violations for each fixture file", async () => {
    const actual = await violationsByFile([`${FIXTURE_ROOT}apps`, `${FIXTURE_ROOT}packages`], FIXTURE_ROOT);
    for (const group of expected.cycles) {
      const reported = group.filter((file) => actual.get(file)?.delete("no-circular"));
      expect(reported, group.join(" <-> ")).toHaveLength(1);
      for (const file of group) if (actual.get(file)?.size === 0) actual.delete(file);
    }
    for (const [file, rules] of Object.entries(expected.files)) {
      expect([...(actual.get(file) ?? [])].sort(), file).toEqual([...rules].sort());
    }
    expect([...actual.keys()].filter((file) => !(file in expected.files))).toEqual([]);
  });

  it("every rule is exercised by at least one fixture", () => {
    const exercised = new Set([
      ...Object.values(expected.files).flat(),
      ...(expected.cycles.length > 0 ? ["no-circular"] : []),
    ]);
    const ruleNames = dependencyRules(FIXTURE_ROOT).map((r) => r.name ?? "(unnamed)");
    const perModuleRulesWithoutFixture = ruleNames.filter((n) => n.endsWith("-allowed-modules") && !exercised.has(n));
    // One per-module rule stands for all of them: they are generated from ALLOWED_INTERNAL by the same code.
    expect(perModuleRulesWithoutFixture.length).toBe(Object.keys(ALLOWED_INTERNAL).length - 1);
    expect(ruleNames.filter((n) => !n.endsWith("-allowed-modules") && !exercised.has(n))).toEqual([]);
  });
});
