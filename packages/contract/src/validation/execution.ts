import type { Approval, Baseline, Scenario } from "../generated/types.js";
import { issue, type ContractIssue } from "./errors.js";
import { deepEqual } from "./shared.js";

/** What an execution would run against (the run baseline, CR-055). */
export interface ExecutionRequest {
  scenario: Scenario;
  approval?: Approval;
  mode: "manual" | "automated";
  baseline: Baseline;
  environment_id?: string;
  declared_environment_id?: string;
  scope_policy_version: number;
  test_data_profile: string;
}

/**
 * Execution gate (CR-055, CR-056, QAA-FR-054). Returns no issues only when the exact, active approval
 * matches every binding field of the requested run. Called at enqueue time and again inside the worker.
 */
export function checkExecutionAllowed(request: ExecutionRequest): ContractIssue[] {
  const { scenario, approval } = request;
  const out: ContractIssue[] = [];
  const required = (message: string, details?: Record<string, unknown>) =>
    out.push(
      issue("APPROVAL_REQUIRED", message, { rule: "CR-055", artifact: "approval", ...(details ? { details } : {}) }),
    );

  if (scenario.status !== "approved")
    required(`scenario ${scenario.scenario_id} v${scenario.version} is ${scenario.status}, not approved`);
  if (scenario.freshness !== "current")
    required(`scenario ${scenario.scenario_id} is ${scenario.freshness}; revalidate it for the current baseline`);
  if (!approval) {
    required(`no approval for scenario ${scenario.scenario_id} v${scenario.version}`);
    return out;
  }
  if (approval.state !== "active")
    required(`approval ${approval.approval_id} is ${approval.state}`, { state: approval.state });

  const mismatched: string[] = [];
  if (approval.scenario_id !== scenario.scenario_id) mismatched.push("scenario_id");
  if (approval.scenario_version !== scenario.version) mismatched.push("scenario_version");
  if (approval.mode !== request.mode) mismatched.push("mode");
  if (!deepEqual(approval.baseline, request.baseline) || !deepEqual(scenario.baseline, request.baseline))
    mismatched.push("baseline");
  if (request.mode === "automated" || request.environment_id !== undefined) {
    if (approval.environment_id === undefined || approval.environment_id !== request.environment_id)
      mismatched.push("environment_id");
  } else if (
    (approval.declared_environment_id ?? approval.environment_id) !==
    (request.declared_environment_id ?? request.environment_id)
  ) {
    mismatched.push("declared_environment_id");
  }
  if (approval.scope_policy_version !== request.scope_policy_version) mismatched.push("scope_policy_version");
  if (approval.test_data_profile !== request.test_data_profile) mismatched.push("test_data_profile");
  if (mismatched.length > 0) {
    out.push(
      issue("APPROVAL_MISMATCH", `approval ${approval.approval_id} does not match the run: ${mismatched.join(", ")}`, {
        rule: "CR-055",
        artifact: "approval",
        details: { mismatched },
      }),
    );
  }

  if (scenario.state_changing) {
    if (approval.state_changing_ack !== true) {
      out.push(
        issue("APPROVAL_REQUIRED", "state-changing scenario approved without state_changing_ack", {
          rule: "CR-056",
          artifact: "approval",
          json_pointer: "/state_changing_ack",
        }),
      );
    }
    if (scenario.cleanup.length === 0 && scenario.irreversible_ack !== true) {
      out.push(
        issue(
          "APPROVAL_REQUIRED",
          "state-changing scenario has neither a cleanup plan nor an irreversibility acknowledgment",
          { rule: "CR-056", artifact: "scenario", json_pointer: "/cleanup" },
        ),
      );
    }
  }
  if (
    request.mode === "automated" &&
    scenario.execution_classification !== "automation_ready" &&
    scenario.execution_classification !== "both"
  ) {
    out.push(
      issue("SCN_NOT_AUTOMATABLE", `scenario is classified ${scenario.execution_classification}`, {
        rule: "CR-051",
        artifact: "scenario",
        json_pointer: "/execution_classification",
      }),
    );
  }
  return out;
}
