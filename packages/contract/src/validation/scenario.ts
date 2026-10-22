import type { ClaimStatus, ExpectedResultBasis, QaObjective } from "../generated/types.js";
import { issue, result, type ContractIssue, type ValidationResult } from "./errors.js";
import { deriveOracleClass, objectivePermitsBasis } from "./oracle.js";
import { asArray, asObject, asString, ptr, schemaIssues } from "./shared.js";

const REVIEW_STATES = new Set(["pending_review", "approved"]);
const NON_DOCUMENTED_SAA_STATUSES = new Set(["inferred", "contradicted", "unresolved"]);

/**
 * Scenario validation: semantic rules CR-050–CR-054 first, so that the specific SCN_* code is reported;
 * then the schema, minus errors at locations already explained by a semantic finding.
 */
export function validateScenario(document: unknown): ValidationResult {
  const scenario = asObject(document);
  const semantic: ContractIssue[] = [];
  const status = asString(scenario.status);
  const inReview = status !== undefined && REVIEW_STATES.has(status);
  const objective = asString(scenario.qa_objective) as QaObjective | undefined;
  const automationReady = scenario.execution_classification === "automation_ready";
  const add = (
    code: ContractIssue["code"],
    rule: NonNullable<ContractIssue["rule"]>,
    pointer: string,
    message: string,
  ) => semantic.push(issue(code, message, { rule, artifact: "scenario", json_pointer: pointer }));

  asArray(scenario.steps).forEach((rawStep, i) => {
    const step = asObject(rawStep);
    if (automationReady && step.automation === undefined)
      add(
        "SCN_NOT_AUTOMATABLE",
        "CR-051",
        ptr("steps", i, "automation"),
        `step ${String(step.step_id)} has no automation action`,
      );
    const expected = step.expected_result;
    if (expected === null || expected === undefined) return;
    const er = asObject(expected);
    const pointer = ptr("steps", i, "expected_result");
    const basis = asString(er.basis) as ExpectedResultBasis | undefined;
    const saaStatus = asString(er.saa_status) as ClaimStatus | undefined;
    const requirementLevel = er.requirement_level === true;
    if (basis === undefined) return; // schema reports the missing basis
    const derived = deriveOracleClass(basis, saaStatus, requirementLevel);
    if (er.oracle_class !== derived)
      add(
        "SCN_ORACLE_INCONSISTENT",
        "CR-052",
        `${pointer}/oracle_class`,
        `oracle_class must be ${derived} for basis ${basis}${saaStatus ? `/${saaStatus}` : ""}`,
      );
    if (basis === "saa_documented") {
      if (saaStatus === undefined)
        add("SCN_BASIS_INVALID", "CR-053", `${pointer}/saa_status`, "saa_documented results must state saa_status");
      else if (NON_DOCUMENTED_SAA_STATUSES.has(saaStatus))
        add(
          "SCN_BASIS_INVALID",
          "CR-053",
          `${pointer}/basis`,
          `an SAA claim with status ${saaStatus} maps to basis ${saaStatus === "inferred" ? "inferred" : "unresolved"}, not saa_documented`,
        );
      else if (saaStatus === "stale" && inReview)
        add(
          "SCN_BASIS_INVALID",
          "CR-053",
          `${pointer}/saa_status`,
          "stale SAA claims cannot back a scenario in review or approved",
        );
    }
    if (basis === "unresolved" && inReview)
      add(
        "SCN_BASIS_INVALID",
        "CR-054",
        `${pointer}/basis`,
        "unresolved expected results cannot be in review or approved",
      );
    if (inReview && objective && !objectivePermitsBasis(objective, basis, saaStatus, requirementLevel)) {
      add(
        "SCN_OBJECTIVE_INCONSISTENT",
        "CR-050",
        `${pointer}/basis`,
        `qa_objective ${objective} cannot rely on basis ${basis}${saaStatus ? `/${saaStatus}` : ""}`,
      );
    }
    if (automationReady && derived === "none")
      add(
        "SCN_NOT_AUTOMATABLE",
        "CR-051",
        `${pointer}/oracle_class`,
        "automation_ready scenarios need an oracle for every expected result",
      );
  });
  if (automationReady && !asArray(scenario.execution_modes).includes("automated")) {
    add(
      "SCN_NOT_AUTOMATABLE",
      "CR-051",
      "/execution_modes",
      "automation_ready scenarios must include the automated execution mode",
    );
  }

  const explained = semantic
    .map((s) => s.json_pointer ?? "")
    .map((p) => p.replace(/\/(oracle_class|saa_status|basis|automation)$/, ""));
  const structural = schemaIssues("scenario", document, "CONTRACT_SCHEMA_INVALID", "scenario").filter(
    (s) =>
      !explained.some((p) => p !== "" && (s.json_pointer ?? "").startsWith(p)) &&
      !(
        automationReady &&
        /^\/(steps|execution_modes)\b/.test(s.json_pointer ?? "") &&
        semantic.some((x) => x.rule === "CR-051")
      ),
  );
  return result([...semantic, ...structural]);
}
