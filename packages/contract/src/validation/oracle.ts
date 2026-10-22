import type { ClaimStatus, ExpectedResultBasis, OracleClass, QaObjective } from "../generated/types.js";

/**
 * Oracle class derived from the expected-result basis (PRD §15.9, CR-052). This is the single
 * implementation; QAA must call it instead of choosing an oracle class itself.
 */
export function deriveOracleClass(
  basis: ExpectedResultBasis,
  saaStatus?: ClaimStatus,
  requirementLevel = false,
): OracleClass {
  switch (basis) {
    case "requirement_backed":
    case "user_confirmed":
      return "intended";
    case "source_supported":
      return "implemented";
    case "observed":
      return "observed";
    case "inferred":
    case "unresolved":
      return "none";
    case "saa_documented":
      if (saaStatus === "source_verified" || saaStatus === "test_verified") return "implemented";
      if (saaStatus === "runtime_observed") return "observed";
      if (saaStatus === "human_asserted") return requirementLevel ? "intended" : "none";
      return "none";
  }
}

/** Whether a QA objective may rely on an expected result with this basis (PRD §15.9 table, CR-050). */
export function objectivePermitsBasis(
  objective: QaObjective,
  basis: ExpectedResultBasis,
  saaStatus?: ClaimStatus,
  requirementLevel = false,
): boolean {
  switch (objective) {
    case "exploratory":
      return true;
    case "characterization":
      return (
        basis === "observed" ||
        basis === "source_supported" ||
        (basis === "saa_documented" &&
          (saaStatus === "runtime_observed" || saaStatus === "source_verified" || saaStatus === "test_verified"))
      );
    case "implementation_conformance":
      return (
        basis === "source_supported" ||
        (basis === "saa_documented" && (saaStatus === "source_verified" || saaStatus === "test_verified"))
      );
    case "requirement_conformance":
      return (
        basis === "requirement_backed" ||
        basis === "user_confirmed" ||
        (basis === "saa_documented" && saaStatus === "human_asserted" && requirementLevel)
      );
  }
}
