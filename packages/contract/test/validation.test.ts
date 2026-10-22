import { describe, expect, it } from "vitest";
import {
  checkDefectTransition,
  checkExecutionAllowed,
  DEFECT_TRANSITIONS,
  deriveOracleClass,
  detectSecrets,
  ERROR_CATALOG,
  objectivePermitsBasis,
  redactSecrets,
  revisionKey,
  toErrorObject,
  validateDocument,
  validateScenario,
  type ErrorCode,
  type ExecutionRequest,
} from "../src/index.js";
import { validDoc, type Json } from "./helpers.js";

describe("oracle derivation [@req QAA-FR-041] [@req CON-005]", () => {
  it.each([
    ["requirement_backed", undefined, false, "intended"],
    ["user_confirmed", undefined, false, "intended"],
    ["source_supported", undefined, false, "implemented"],
    ["observed", undefined, false, "observed"],
    ["inferred", undefined, false, "none"],
    ["unresolved", undefined, false, "none"],
    ["saa_documented", "source_verified", false, "implemented"],
    ["saa_documented", "test_verified", false, "implemented"],
    ["saa_documented", "runtime_observed", false, "observed"],
    ["saa_documented", "human_asserted", true, "intended"],
    ["saa_documented", "human_asserted", false, "none"],
    ["saa_documented", "stale", false, "none"],
  ] as const)("%s/%s (requirement level %s) → %s", (basis, status, requirementLevel, oracle) => {
    expect(deriveOracleClass(basis, status, requirementLevel)).toBe(oracle);
  });

  it("only requirement-backed bases support requirement conformance [@req QAA-FR-111]", () => {
    expect(objectivePermitsBasis("requirement_conformance", "saa_documented", "source_verified")).toBe(false);
    expect(objectivePermitsBasis("requirement_conformance", "observed")).toBe(false);
    expect(objectivePermitsBasis("requirement_conformance", "user_confirmed")).toBe(true);
    expect(objectivePermitsBasis("characterization", "observed")).toBe(true);
    expect(objectivePermitsBasis("implementation_conformance", "observed")).toBe(false);
    expect(objectivePermitsBasis("exploratory", "unresolved")).toBe(true);
  });
});

describe("scenario validation [@req QAA-FR-033] [@req QAA-FR-034] [@req QAA-FR-111]", () => {
  it("accepts the canonical scenario", () => {
    expect(validateScenario(validDoc("scenario.nib-12-digits")).issues).toEqual([]);
  });

  it("reports the specific SCN code instead of a generic schema error", () => {
    const sc = validDoc("scenario.nib-12-digits");
    const er = ((sc.steps as Json[])[2] as Json).expected_result as Json;
    er.oracle_class = "intended";
    const result = validateScenario(sc);
    expect(result.issues.map((i) => i.code)).toEqual(["SCN_ORACLE_INCONSISTENT"]);
  });

  it("still reports unrelated schema problems", () => {
    const sc = validDoc("scenario.nib-12-digits");
    sc.priority = "urgent";
    expect(validateScenario(sc).issues.map((i) => i.code)).toEqual(["CONTRACT_SCHEMA_INVALID"]);
  });
});

describe("secret detection [@req SEC-004] [@req CON-017]", () => {
  it.each([
    ["aws_access_key_id", "key=AKIAIOSFODNN7EXAMPLE"],
    ["private_key_block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["github_token", `token ghp_${"a".repeat(36)}`],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["credential_assignment", 'password = "hunter2hunter2"'],
    ["bearer_token", "Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0"],
  ])("detects %s", (detector, text) => {
    expect(detectSecrets(text).map((f) => f.detector)).toContain(detector);
  });

  it.each([
    "password: REDACTED",
    "api_key = secretref:applicant",
    "token: <your token here>",
    "client_secret=${CLIENT_SECRET}",
    "sha256:" + "0".repeat(64),
    "page:web:/registrasi",
  ])("does not flag %s", (text) => {
    expect(detectSecrets(text)).toEqual([]);
  });
});

describe("secret redaction [@req SEC-004]", () => {
  it("replaces each secret with its detector name and masks a private key through its END marker", () => {
    const body = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun";
    const input = `key=AKIAIOSFODNN7EXAMPLE\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\ntail`;
    const { text, findings } = redactSecrets(input);
    expect(text).toBe("key=[REDACTED:aws_access_key_id]\n[REDACTED:private_key_block]\ntail");
    expect(findings.map((f) => f.detector).sort()).toEqual(["aws_access_key_id", "private_key_block"]);
  });

  it("masks an unterminated private key to the end of the text and leaves clean text unchanged", () => {
    expect(redactSecrets("-----BEGIN PRIVATE KEY-----\nabc").text).toBe("[REDACTED:private_key_block]");
    expect(redactSecrets("page:web:/registrasi").text).toBe("page:web:/registrasi");
  });
});

describe("revision keys [@req CON-006] [@req CON-021]", () => {
  it("formats every revision kind", () => {
    expect(revisionKey({ kind: "git_commit", value: "a".repeat(40), worktree_dirty: false })).toBe("a".repeat(40));
    expect(
      revisionKey({
        kind: "git_commit",
        value: "a".repeat(40),
        worktree_dirty: true,
        dirty_fingerprint: `sha256:${"b".repeat(64)}`,
      }),
    ).toBe(`${"a".repeat(40)}+sha256:${"b".repeat(64)}`);
    expect(
      revisionKey({
        kind: "observation_window",
        environment_id: "env:x",
        observed_from: "2026-01-01T00:00:00Z",
        observed_to: "2026-01-01T01:00:00Z",
      }),
    ).toBe("env:x@2026-01-01T00:00:00Z/2026-01-01T01:00:00Z");
  });
});

describe("execution gate [@req QAA-FR-054] [@req QAA-FR-057] [@req SEC-010]", () => {
  const request = (): ExecutionRequest => {
    const scenario = validDoc("scenario.nib-12-digits");
    scenario.status = "approved";
    delete scenario.status_reason;
    const approval = validDoc("approval.manual");
    return {
      scenario,
      approval,
      mode: "manual",
      baseline: structuredClone(scenario.baseline),
      declared_environment_id: approval.declared_environment_id,
      scope_policy_version: 1,
      test_data_profile: "default",
    } as unknown as ExecutionRequest;
  };

  it("allows the exact, active, matching approval", () => {
    expect(checkExecutionAllowed(request())).toEqual([]);
  });

  it("refuses without an approval, and refuses automated runs on a manual approval", () => {
    const r = request();
    delete r.approval;
    expect(checkExecutionAllowed(r).map((i) => i.code)).toEqual(["APPROVAL_REQUIRED"]);
    const r2 = request();
    r2.mode = "automated";
    r2.environment_id = "env:acme-staging";
    expect(checkExecutionAllowed(r2).map((i) => i.code)).toContain("APPROVAL_MISMATCH");
  });

  it("allows a state-changing scenario only with acknowledgment and cleanup", () => {
    const r = request();
    r.scenario.state_changing = true;
    r.approval!.state_changing_ack = true;
    expect(checkExecutionAllowed(r).map((i) => i.rule)).toEqual(["CR-056"]);
    r.scenario.cleanup = [{ language: "en", value: "Delete the created registration." }];
    expect(checkExecutionAllowed(r)).toEqual([]);
  });

  it("refuses stale scenarios until revalidated [@req QAA-FR-047]", () => {
    const r = request();
    r.scenario.freshness = "potentially_stale";
    expect(checkExecutionAllowed(r).map((i) => i.code)).toEqual(["APPROVAL_REQUIRED"]);
  });
});

describe("defect lifecycle [@req QAA-FR-088]", () => {
  it("allows the documented path to closure", () => {
    const path = ["new", "triaged", "confirmed", "fixed", "ready_for_retest", "closed"] as const;
    for (let i = 1; i < path.length; i++)
      expect(checkDefectTransition(path[i - 1]!, path[i]!, { retest_passed: true })).toEqual([]);
  });

  it("has terminal states and requires context", () => {
    expect(DEFECT_TRANSITIONS.rejected).toEqual([]);
    expect(checkDefectTransition("triaged", "rejected")).toHaveLength(1);
    expect(checkDefectTransition("triaged", "rejected", { reason: "Works as designed." })).toEqual([]);
    expect(checkDefectTransition("triaged", "duplicate")).toHaveLength(1);
  });
});

describe("error catalog [@req OBS-003] [@req LOC-002] [@req NFR-010]", () => {
  it.each(Object.keys(ERROR_CATALOG) as ErrorCode[])("%s renders a schema-valid error object in en and id", (code) => {
    for (const language of ["en", "id"] as const) {
      const error = toErrorObject(
        { code, severity: ERROR_CATALOG[code].severity, message: "diagnostic", json_pointer: "/x", rule: "CR-001" },
        language,
      );
      expect(validateDocument("error", error).issues).toEqual([]);
      expect(error.message.language).toBe(language);
      expect(error.remediation.value.length).toBeGreaterThan(10);
    }
  });
});
