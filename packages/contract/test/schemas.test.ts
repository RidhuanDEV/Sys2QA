import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ajv2020 } from "ajv/dist/2020.js";
import {
  CONTRACT_SCHEMA_NAMES,
  createContractAjv,
  loadContractSchemas,
  schemaId,
  type ContractSchemaName,
} from "../src/index.js";

const validFixtureDir = fileURLToPath(new URL("../../../fixtures/contract/valid/", import.meta.url));

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);
const fixture = (name: string): Json => JSON.parse(readFileSync(`${validFixtureDir}${name}.json`, "utf8")) as Json;

let ajv: Ajv2020;
const validate = (schema: ContractSchemaName, document: unknown) => {
  const fn = ajv.getSchema(schemaId(schema));
  if (!fn) throw new Error(`schema not registered: ${schema}`);
  const ok = fn(document) as boolean;
  return { ok, errors: fn.errors ?? [] };
};
const expectInvalid = (schema: ContractSchemaName, document: unknown) => {
  expect(validate(schema, document).ok).toBe(false);
};

beforeAll(() => {
  ajv = createContractAjv();
});

describe("contract schemas [@req CON-001] [@req CON-008] [@req CON-027]", () => {
  it("every schema loads with the expected $id and compiles in strict mode", () => {
    const schemas = loadContractSchemas();
    expect([...schemas.keys()]).toEqual([...CONTRACT_SCHEMA_NAMES]);
    for (const name of CONTRACT_SCHEMA_NAMES) {
      expect(() => ajv.getSchema(schemaId(name))).not.toThrow();
    }
  });
});

describe("valid fixtures [@req CON-002] [@req CON-003] [@req CON-004] [@req CON-020] [@req CON-026]", () => {
  const files = readdirSync(validFixtureDir).filter((f) => f.endsWith(".json"));

  it.each(files)("%s validates against its schema", (file) => {
    const schema = file.split(".")[0] as ContractSchemaName;
    expect(CONTRACT_SCHEMA_NAMES).toContain(schema);
    const result = validate(schema, JSON.parse(readFileSync(`${validFixtureDir}${file}`, "utf8")));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("schemas without a valid fixture are exactly the known backlog (IMP-005 closes it)", () => {
    const covered = new Set(files.map((f) => f.split(".")[0]));
    const missing = CONTRACT_SCHEMA_NAMES.filter((n) => n !== "common" && !covered.has(n));
    expect(missing).toEqual(["diff-report", "analysis-response", "test-plan", "manual-test-pack"]);
  });
});

describe("structural rules enforced by the schemas", () => {
  it("rejects production environments [@req SEC-009]", () => {
    const m = fixture("package-manifest.mode-b");
    (m.observed_environments as Json[])[0]!.classification = "production";
    expectInvalid("package-manifest", m);
  });

  it("ties repository presence to the evidence profile [@req CON-020] [@req CON-025]", () => {
    const b = fixture("package-manifest.mode-b");
    b.repository = clone(fixture("package-manifest.mode-a").repository);
    expectInvalid("package-manifest", b);

    const a = fixture("package-manifest.mode-a");
    a.repository = null;
    expectInvalid("package-manifest", a);
  });

  it("requires observed environments when runtime evidence is available [@req CON-021]", () => {
    const b = fixture("package-manifest.mode-b");
    delete b.observed_environments;
    expectInvalid("package-manifest", b);
  });

  it("requires previous_package from version 2 on [@req CON-002]", () => {
    const a = fixture("package-manifest.mode-a");
    delete a.previous_package;
    expectInvalid("package-manifest", a);
  });

  it("rejects dirty git revisions without a dirty fingerprint [@req CON-006]", () => {
    const a = fixture("package-manifest.mode-a");
    const revision = (a.repository as Json).revision as Json;
    revision.worktree_dirty = true;
    expectInvalid("package-manifest", a);
    revision.dirty_fingerprint = `sha256:${"a".repeat(64)}`;
    expect(validate("package-manifest", a).ok).toBe(true);
  });

  it("rejects artifact paths that escape the package [@req SEC-001]", () => {
    for (const path of ["../outside.json", "/etc/passwd", "docs/../../x.md", "C:/x.json"]) {
      const a = fixture("package-manifest.mode-a");
      (a.artifacts as Json[])[0]!.path = path;
      expectInvalid("package-manifest", a);
    }
  });

  it("requires a rationale for inferred entities and a gap for unresolved ones [@req SAA-FR-010]", () => {
    const sm = fixture("system-model.registration");
    const role = (sm.entities as Json[]).find((e) => e.kind === "actor_role")!;
    delete role.confidence_rationale;
    expectInvalid("system-model", sm);

    const sm2 = fixture("system-model.registration");
    const module = (sm2.entities as Json[])[0]!;
    module.status = "unresolved";
    module.evidence_ids = [];
    expectInvalid("system-model", sm2);
    module.gap_ids = ["gap:email-delivery"];
    expect(validate("system-model", sm2).ok).toBe(true);
  });

  it("keeps workflow discovery status consistent with unresolved hops [@req CON-024]", () => {
    const sm = fixture("system-model.registration");
    const wf = (sm.workflows as Json[])[0]!;
    wf.discovery_status = "reconstructed";
    expectInvalid("system-model", sm);

    const sm2 = fixture("system-model.registration");
    (sm2.workflows as Json[])[0]!.unresolved_hops = [];
    expectInvalid("system-model", sm2);
  });

  it("requires source location for source evidence and environment for runtime evidence [@req CON-004] [@req CON-021]", () => {
    const ev = fixture("evidence-index.registration");
    delete ((ev.evidence as Json[])[0] as Json).range;
    expectInvalid("evidence-index", ev);

    const ev2 = fixture("evidence-index.registration");
    delete ((ev2.evidence as Json[])[2] as Json).environment_id;
    expectInvalid("evidence-index", ev2);
  });

  it("derives the oracle class from the expected-result basis [@req QAA-FR-041] [@req CON-005]", () => {
    const sc = fixture("scenario.nib-12-digits");
    const expected = ((sc.steps as Json[])[2] as Json).expected_result as Json;
    expected.oracle_class = "intended";
    expectInvalid("scenario", sc);

    const sc2 = fixture("scenario.nib-12-digits");
    const expected2 = ((sc2.steps as Json[])[2] as Json).expected_result as Json;
    delete expected2.saa_status;
    expectInvalid("scenario", sc2);

    const sc3 = fixture("scenario.nib-12-digits");
    const expected3 = ((sc3.steps as Json[])[2] as Json).expected_result as Json;
    expected3.basis = "observed";
    expected3.oracle_class = "observed";
    expect(validate("scenario", sc3).ok).toBe(true);
  });

  it("requires the literal language of text-based locators [@req LOC-010]", () => {
    const sc = fixture("scenario.nib-12-digits");
    const target = (((sc.steps as Json[])[1] as Json).automation as Json).target as Json;
    delete target.literal_language;
    expectInvalid("scenario", sc);
  });

  it("requires a reason for needs_clarification scenarios [@req QAA-FR-034]", () => {
    const sc = fixture("scenario.nib-12-digits");
    delete sc.status_reason;
    expectInvalid("scenario", sc);
  });

  it("requires a configured environment for automated approvals [@req QAA-FR-052] [@req QAA-FR-112]", () => {
    const ap = fixture("approval.manual");
    ap.mode = "automated";
    expectInvalid("approval", ap);
  });

  it("labels manual results as tester-reported and keeps automated runs on configured environments [@req QAA-FR-086]", () => {
    const run = fixture("run-result.manual");
    ((run.cases as Json[])[0] as Json).reported_by = "executor";
    expectInvalid("run-result", run);

    const run2 = fixture("run-result.manual");
    run2.kind = "automated";
    ((run2.cases as Json[])[0] as Json).reported_by = "executor";
    ((run2.cases as Json[])[0] as Json).failure_category = "assertion_failure";
    expectInvalid("run-result", run2);
  });

  it("has no aggregate score in readiness assessments [@req CON-028]", () => {
    const ra = fixture("readiness-assessment.mode-a");
    ra.score = 0.8;
    expectInvalid("readiness-assessment", ra);
  });

  it("states counts only within the examined scope [@req SAA-FR-045]", () => {
    const cr = fixture("completeness-report.f1");
    cr.count_scope = "system_total";
    expectInvalid("completeness-report", cr);
  });
});
