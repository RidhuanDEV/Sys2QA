export interface Requirement {
  id: string;
  priority: string;
  status: string;
}
export interface Gate {
  label: string;
  order: number;
}
export interface Tag {
  id: string;
  file: string;
  line: number;
}
export interface Outcome {
  passed: number;
  failed: number;
  skipped: number;
}
export interface ReportRow extends Requirement {
  gate: string;
  gateOrder: number;
  tagged: boolean;
  outcome: Outcome | undefined;
  covered: boolean;
  manual: string | undefined;
}
export interface Report {
  rows: ReportRow[];
  unknownTags: Tag[];
  blockers: ReportRow[];
  resultsUsed: boolean;
}

export const REQUIREMENT_ID: RegExp;
export const MANUAL_EVIDENCE: Record<string, string>;
export function parseRequirements(prd: string): Map<string, Requirement>;
export function parseContractRules(spec: string): Set<string>;
export function parseGateOwnership(plan: string): Map<string, Gate>;
export function scanTags(repoRoot: string, roots: string[]): Tag[];
export function outcomesFromResults(results: unknown): Map<string, Outcome>;
export function buildReport(input: {
  requirements: Map<string, Requirement>;
  contractRules: Set<string>;
  gateOwner: Map<string, Gate>;
  tags: Tag[];
  outcomes: Map<string, Outcome> | undefined;
}): Report;
export function renderReport(report: Report, generatedAt: string): string;
