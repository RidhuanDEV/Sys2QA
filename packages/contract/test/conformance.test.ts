import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDefectTransition,
  checkExecutionAllowed,
  ERROR_CATALOG,
  validateDocument,
  validatePackage,
  validateScenario,
  type ContractIssue,
  type ErrorCode,
  type ExecutionRequest,
} from "../src/index.js";
import { invalidDir, packageDoc, readJson, readPackage, validDoc, validPackagesDir, type Json } from "./helpers.js";

/** Codes detected by components other than the contract library, with the task that owns detection. */
const COMPONENT_DETECTED: Partial<Record<ErrorCode, string>> = {
  PKG_NOT_FOUND: "IMP-201 package importer",
  PKG_REVISION_MISMATCH: "IMP-202 readiness and freshness",
  PKG_REVISION_UNVERIFIABLE: "IMP-202 readiness and freshness",
  PKG_LANGUAGE_UNAVAILABLE: "IMP-201/IMP-116 language selection",
  SCOPE_DENIED: "IMP-401 scope-enforcing proxy",
  PRODUCTION_REFUSED: "IMP-006 policy engine",
  SUBMISSION_REQUIRES_APPROVAL: "IMP-403 form-interaction policy",
  JOB_CANCELLED: "IMP-008 job orchestrator",
  BUDGET_EXHAUSTED: "IMP-008 job orchestrator",
  CONTAINER_RUNTIME_MISSING: "IMP-501 container workers",
};
const RULES = [
  "CR-001",
  "CR-002",
  "CR-010",
  "CR-011",
  "CR-020",
  "CR-021",
  "CR-030",
  "CR-040",
  "CR-041",
  "CR-042",
  "CR-043",
  "CR-050",
  "CR-051",
  "CR-052",
  "CR-053",
  "CR-054",
  "CR-055",
  "CR-056",
  "CR-060",
  "CR-070",
];

interface Expected {
  kind: "package" | "scenario" | "execution" | "defect_transition";
  code: ErrorCode;
  rule?: string;
  severity: string;
  ok: boolean;
}
const cases = readdirSync(invalidDir).flatMap((code) =>
  readdirSync(join(invalidDir, code)).map((name) => ({
    id: `${code}/${name}`,
    dir: join(invalidDir, code, name),
    expected: readJson(join(invalidDir, code, name, "expected.json")) as unknown as Expected,
  })),
);

function run(kind: Expected["kind"], dir: string): { ok: boolean; issues: ContractIssue[] } {
  switch (kind) {
    case "package":
      return validatePackage({ files: readPackage(join(dir, "package")) });
    case "scenario":
      return validateScenario(readJson(join(dir, "input.json")));
    case "execution": {
      const issues = checkExecutionAllowed(readJson(join(dir, "input.json")) as unknown as ExecutionRequest);
      return { ok: !issues.some((i) => i.severity === "error"), issues };
    }
    case "defect_transition": {
      const input = readJson(join(dir, "input.json")) as { from: never; to: never; context: Json };
      const issues = checkDefectTransition(input.from, input.to, input.context);
      return { ok: issues.length === 0, issues };
    }
  }
}

describe("valid packages [@req CON-009] [@req CON-019] [@req CON-020] [@req CON-023] [@req CON-025]", () => {
  it.each(readdirSync(validPackagesDir))("%s passes every validation stage with no findings", (name) => {
    const result = validatePackage({ files: readPackage(join(validPackagesDir, name)) });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("complete");
  });
});

describe("conformance fixtures [@req CON-005] [@req CON-009] [@req CON-018] [@req CON-023] [@req CON-024] [@req CON-025]", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s produces exactly its expected code", (_id, c) => {
    const result = run(c.expected.kind, c.dir);
    const matching = result.issues.filter((i) => i.code === c.expected.code);
    expect(matching.length, JSON.stringify(result.issues, null, 2)).toBeGreaterThan(0);
    if (c.expected.rule) expect(matching.map((i) => i.rule)).toContain(c.expected.rule);
    expect(result.ok).toBe(c.expected.ok);
    // No collateral errors: the case violates one thing.
    expect(result.issues.filter((i) => i.severity === "error" && i.code !== c.expected.code)).toEqual([]);
  });

  it("every catalog code is either detected here (with a fixture) or owned by a named component", () => {
    const withFixtures = new Set(cases.map((c) => c.expected.code));
    for (const code of Object.keys(ERROR_CATALOG) as ErrorCode[]) {
      const owned = COMPONENT_DETECTED[code] !== undefined;
      expect(
        owned !== withFixtures.has(code),
        `${code}: fixture=${withFixtures.has(code)} component=${String(COMPONENT_DETECTED[code])}`,
      ).toBe(true);
    }
  });

  it("every semantic rule CR-xxx has at least one violating fixture", () => {
    const covered = new Set(cases.map((c) => c.expected.rule).filter(Boolean));
    expect(RULES.filter((r) => !covered.has(r))).toEqual([]);
  });

  it("issues never echo detected secret values [@req SEC-004]", () => {
    const secretCase = cases.find((c) => c.id === "PKG_SECRET_SUSPECTED/aws-key-in-excerpt")!;
    const result = run("package", secretCase.dir);
    expect(JSON.stringify(result.issues)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("fixture directories exist for every case", () => {
    for (const c of cases)
      expect(existsSync(join(c.dir, c.expected.kind === "package" ? "package" : "input.json"))).toBe(true);
  });
});

describe("cross-fixture consistency", () => {
  it("the correlation report references the valid packages and only IDs that exist in them [@req CON-026] [@req QAA-FR-115]", () => {
    const report = validDoc("correlation-report.f3");
    const ids = (pkg: string) =>
      new Set((packageDoc(pkg, "system-model.json").entities as Json[]).map((e) => e.id as string));
    const source = ids("mode-a-saa");
    const observed = ids("mode-b-qaa");
    for (const [ref, pkg] of [
      [report.saa_package, "mode-a-saa"],
      [report.qaa_package, "mode-b-qaa"],
    ] as const) {
      const manifest = packageDoc(pkg, "manifest.json");
      expect(ref).toEqual({ package_id: manifest.package_id, package_version: manifest.package_version });
    }
    const unmatched = report.unmatched as { observed: string[]; source: string[] };
    const links = report.links as Json[];
    const discrepancies = report.discrepancies as Json[];
    const sourceRefs = [
      ...unmatched.source,
      ...links.map((l) => l.source_id as string),
      ...discrepancies.flatMap((d) => d.source_ids as string[]),
    ];
    const observedRefs = [
      ...unmatched.observed,
      ...links.map((l) => l.observed_id as string),
      ...discrepancies.flatMap((d) => d.observed_ids as string[]),
    ];
    expect(sourceRefs.filter((id) => !source.has(id))).toEqual([]);
    expect(observedRefs.filter((id) => !observed.has(id))).toEqual([]);
  });
});

describe("document validation", () => {
  it("reports schema problems with CONTRACT_SCHEMA_INVALID and a JSON pointer", () => {
    const result = validateDocument("error", { code: "x" });
    expect(result.ok).toBe(false);
    expect(result.issues.every((i) => i.code === "CONTRACT_SCHEMA_INVALID" && typeof i.json_pointer === "string")).toBe(
      true,
    );
  });
});
