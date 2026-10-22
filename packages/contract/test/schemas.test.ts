import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMA_NAMES,
  loadContractSchemas,
  schemaId,
  validateDocument,
  type ContractSchemaName,
} from "../src/index.js";
import { contractAjv } from "../src/validation/shared.js";
import { packageDoc, readJson, validDoc, validDocsDir, validPackagesDir, type Json } from "./helpers.js";

const clone = <T>(value: T): T => structuredClone(value);
const ROLE_SCHEMAS: Record<string, ContractSchemaName> = {
  system_model: "system-model",
  evidence_index: "evidence-index",
  diff_report: "diff-report",
  completeness_report: "completeness-report",
};
const isValid = (schema: ContractSchemaName, doc: unknown) => validateDocument(schema, doc).ok;

describe("contract schemas [@req CON-001] [@req CON-008] [@req CON-027]", () => {
  it("every schema loads with the expected $id and compiles in strict mode", () => {
    const schemas = loadContractSchemas();
    expect([...schemas.keys()]).toEqual([...CONTRACT_SCHEMA_NAMES]);
    for (const name of CONTRACT_SCHEMA_NAMES) expect(contractAjv().getSchema(schemaId(name))).toBeDefined();
  });
});

// Canonical examples: single documents plus every JSON artifact of the valid packages.
const singleDocs = readdirSync(validDocsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ label: f, schema: f.split(".")[0] as ContractSchemaName, doc: readJson(join(validDocsDir, f)) }));
const packageDocs = readdirSync(validPackagesDir).flatMap((pkg) => {
  const manifest = packageDoc(pkg, "manifest.json");
  const artifacts = (manifest.artifacts as Json[]).filter((a) => ROLE_SCHEMAS[a.role as string]);
  return [
    { label: `${pkg}/manifest.json`, schema: "package-manifest" as ContractSchemaName, doc: manifest },
    ...artifacts.map((a) => ({
      label: `${pkg}/${String(a.path)}`,
      schema: ROLE_SCHEMAS[a.role as string] as ContractSchemaName,
      doc: packageDoc(pkg, a.path as string),
    })),
  ];
});

describe("canonical examples [@req CON-002] [@req CON-003] [@req CON-004] [@req CON-020] [@req CON-026]", () => {
  it.each([...singleDocs, ...packageDocs].map((x) => [x.label, x] as const))(
    "%s validates against its schema",
    (_label, x) => {
      const result = validateDocument(x.schema, x.doc);
      expect(result.issues).toEqual([]);
    },
  );

  it("every contract schema has at least one canonical example", () => {
    const covered = new Set([...singleDocs, ...packageDocs].map((x) => x.schema));
    expect(CONTRACT_SCHEMA_NAMES.filter((n) => n !== "common" && !covered.has(n))).toEqual([]);
  });
});

describe("structural rules enforced by the schemas", () => {
  const manifestB = () => clone(packageDoc("mode-b-qaa", "manifest.json"));
  const manifestA = () => clone(packageDoc("mode-a-saa", "manifest.json"));
  const modelA = () => clone(packageDoc("mode-a-saa", "system-model.json"));

  it("rejects production environments [@req SEC-009]", () => {
    const m = manifestB();
    (m.observed_environments as Json[])[0]!.classification = "production";
    expect(isValid("package-manifest", m)).toBe(false);
  });

  it("rejects dirty git revisions without a dirty fingerprint [@req CON-006]", () => {
    const m = manifestA();
    const revision = (m.repository as Json).revision as Json;
    revision.worktree_dirty = true;
    expect(isValid("package-manifest", m)).toBe(false);
    revision.dirty_fingerprint = `sha256:${"a".repeat(64)}`;
    expect(isValid("package-manifest", m)).toBe(true);
  });

  it("rejects artifact paths that escape the package [@req SEC-001]", () => {
    for (const path of ["../outside.json", "/etc/passwd", "docs/../../x.md", "C:/x.json"]) {
      const m = manifestA();
      (m.artifacts as Json[])[0]!.path = path;
      expect(isValid("package-manifest", m)).toBe(false);
    }
  });

  it("requires a rationale for inferred entities and a gap for unresolved ones [@req SAA-FR-010]", () => {
    const sm = modelA();
    delete (sm.entities as Json[]).find((e) => e.kind === "actor_role")!.confidence_rationale;
    expect(isValid("system-model", sm)).toBe(false);

    const sm2 = modelA();
    const module = (sm2.entities as Json[])[2]!;
    module.status = "unresolved";
    module.evidence_ids = [];
    expect(isValid("system-model", sm2)).toBe(false);
    module.gap_ids = ["gap:email-delivery"];
    expect(isValid("system-model", sm2)).toBe(true);
  });

  it("requires source location for source evidence and environment for runtime evidence [@req CON-004] [@req CON-021]", () => {
    const evA = clone(packageDoc("mode-a-saa", "evidence-index.json"));
    delete ((evA.evidence as Json[])[0] as Json).range;
    expect(isValid("evidence-index", evA)).toBe(false);
    const evB = clone(packageDoc("mode-b-qaa", "evidence-index.json"));
    delete ((evB.evidence as Json[])[0] as Json).environment_id;
    expect(isValid("evidence-index", evB)).toBe(false);
  });

  it("requires the literal language of text-based locators [@req LOC-010]", () => {
    const sc = validDoc("scenario.nib-12-digits");
    delete ((((sc.steps as Json[])[1] as Json).automation as Json).target as Json).literal_language;
    expect(isValid("scenario", sc)).toBe(false);
  });

  it("requires a configured environment for automated approvals [@req QAA-FR-052] [@req QAA-FR-112]", () => {
    const ap = validDoc("approval.manual");
    ap.mode = "automated";
    expect(isValid("approval", ap)).toBe(false);
  });

  it("labels manual results as tester-reported and keeps automated runs on configured environments [@req QAA-FR-086]", () => {
    const run = validDoc("run-result.manual");
    ((run.cases as Json[])[0] as Json).reported_by = "executor";
    expect(isValid("run-result", run)).toBe(false);
    const run2 = validDoc("run-result.manual");
    run2.kind = "automated";
    Object.assign((run2.cases as Json[])[0] as Json, {
      reported_by: "executor",
      failure_category: "assertion_failure",
    });
    expect(isValid("run-result", run2)).toBe(false);
  });

  it("has no aggregate score in readiness assessments [@req CON-028]", () => {
    const ra = validDoc("readiness-assessment.mode-a");
    ra.score = 0.8;
    expect(isValid("readiness-assessment", ra)).toBe(false);
  });
});
