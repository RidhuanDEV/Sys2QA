import type { DefectState } from "../generated/types.js";
import { issue, type ContractIssue } from "./errors.js";

/** Allowed defect transitions (PRD §15.12, Contract Specification §6.4, CR-070). */
export const DEFECT_TRANSITIONS: Readonly<Record<DefectState, readonly DefectState[]>> = {
  new: ["triaged"],
  triaged: ["confirmed", "rejected", "duplicate", "needs_info"],
  needs_info: ["triaged"],
  confirmed: ["fixed"],
  fixed: ["ready_for_retest"],
  ready_for_retest: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["triaged"],
  rejected: [],
  duplicate: [],
};

export interface DefectTransitionContext {
  /** A retest on a recorded baseline passed (required for closing unless a reason is given). */
  retest_passed?: boolean;
  reason?: string;
  duplicate_of?: string;
}

export function checkDefectTransition(
  from: DefectState,
  to: DefectState,
  context: DefectTransitionContext = {},
): ContractIssue[] {
  const invalid = (message: string) => [
    issue("DEFECT_TRANSITION_INVALID", message, {
      rule: "CR-070",
      artifact: "defect",
      json_pointer: "/state",
      details: { from, to },
    }),
  ];
  if (!DEFECT_TRANSITIONS[from].includes(to)) return invalid(`defect cannot move from ${from} to ${to}`);
  const hasReason = typeof context.reason === "string" && context.reason.trim() !== "";
  if (to === "closed" && context.retest_passed !== true && !hasReason)
    return invalid("closing a defect needs a passing retest or a recorded reason");
  if (to === "rejected" && !hasReason) return invalid("rejecting a defect needs a recorded reason");
  if (to === "duplicate" && !context.duplicate_of) return invalid("marking a defect duplicate needs duplicate_of");
  return [];
}
