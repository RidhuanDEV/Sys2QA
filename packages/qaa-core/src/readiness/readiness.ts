import type { ContractIssue, Gap, Workflow } from "@sys2qa/contract";
import type { PackageQuery } from "@sys2qa/system-model";

export type Readiness = "ready" | "ready_with_gaps" | "review_only" | "blocked";
export type Freshness = "current" | "mismatched" | "stale" | "unverifiable";
export type Activity = "scenario_design" | "manual_preparation" | "automated_execution";

const ORDER: Readiness[] = ["ready", "ready_with_gaps", "review_only", "blocked"];
const worst = (a: Readiness, b: Readiness): Readiness => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/** Coverage categories of the contract (common schema `coverage_category`), all listed on the readiness screen. */
export const COVERAGE_CATEGORIES = [
  "modules",
  "routes_pages",
  "roles_permissions",
  "business_rules",
  "workflows",
  "state_transitions",
  "api_contracts",
  "data_model",
  "integrations",
  "error_paths",
] as const;

export interface RevisionValue {
  kind: string;
  value: string;
}

export interface FreshnessInput {
  /** The package's revision (`repository.revision`), or null for a runtime-only package. */
  packageRevision: RevisionValue | null;
  /** Deployed revisions of a runtime package's observed environments (null when unknown). */
  deployedRevisions: Array<string | null>;
  /** The project baseline from a local read-only checkout, when one is registered and readable (QAA-FR-003). */
  checkoutRevision?: RevisionValue;
  /** Versions of the same package ID in the project that are newer than this one. */
  newerVersions: number[];
}

export interface FreshnessResult {
  freshness: Freshness;
  /** `PKG_REVISION_MISMATCH` or `PKG_REVISION_UNVERIFIABLE` when the result needs the user's attention. */
  code?: "PKG_REVISION_MISMATCH" | "PKG_REVISION_UNVERIFIABLE";
  baseline: { source: "checkout" | "package" | "none"; revision: RevisionValue | null };
  reason: string;
}

/**
 * Package freshness (PRD §13.9, QAA-FR-014). Source evidence is compared with the project baseline: a registered local
 * checkout when there is one, otherwise the latest imported package itself (each new package is a new baseline,
 * PRD W5). Runtime evidence is `unverifiable` while the deployed revision is unknown. A newer version of the same
 * package makes an older one `stale`. A mismatch does not mean the documentation is wrong; it is shown.
 */
export function packageFreshness(input: FreshnessInput): FreshnessResult {
  if (input.newerVersions.length > 0)
    return {
      freshness: "stale",
      baseline: { source: "package", revision: null },
      reason: `a newer version of this package exists (version ${Math.max(...input.newerVersions)})`,
    };
  if (input.packageRevision) {
    if (input.checkoutRevision) {
      const same =
        input.checkoutRevision.kind === input.packageRevision.kind &&
        input.checkoutRevision.value === input.packageRevision.value;
      return same
        ? {
            freshness: "current",
            baseline: { source: "checkout", revision: input.checkoutRevision },
            reason: "the package revision equals the local checkout",
          }
        : {
            freshness: "mismatched",
            code: "PKG_REVISION_MISMATCH",
            baseline: { source: "checkout", revision: input.checkoutRevision },
            reason: "the package was analyzed at a different revision than the local checkout",
          };
    }
    return {
      freshness: "current",
      baseline: { source: "package", revision: input.packageRevision },
      reason: "no local checkout is registered; the latest package is the baseline",
    };
  }
  const known = input.deployedRevisions.filter((r): r is string => r !== null);
  if (known.length === 0 || known.length < input.deployedRevisions.length)
    return {
      freshness: "unverifiable",
      code: "PKG_REVISION_UNVERIFIABLE",
      baseline: { source: "none", revision: null },
      reason: "the deployed revision of the observed environment is unknown",
    };
  return {
    freshness: "current",
    baseline: { source: "package", revision: { kind: "deployed", value: known[0]! } },
    reason: "the observed environment states its deployed revision",
  };
}

export interface MaterialityOverride {
  gap_id: string;
  material: boolean;
  reason: string;
  by: string;
  at: string;
}

export interface EnvironmentState {
  classification: "development" | "staging" | "production";
  state: "configured" | "validated" | "unreachable" | "disabled";
}

export interface ReadinessInput {
  assessmentId: string;
  assessedAt: string;
  packageRef: { package_id: string; package_version: number };
  manifest: Record<string, unknown>;
  /** The structured model; absent for a Markdown-only package (CON-016). */
  model?: PackageQuery;
  /** Warnings and info from the package's validation. */
  issues: ReadonlyArray<Pick<ContractIssue, "code" | "severity">>;
  freshness: FreshnessResult;
  /** Selected workflows; all workflows of the catalog when absent. */
  scope?: string[];
  environment?: EnvironmentState;
  /** A person confirmed that the target runs this working tree (OD-04). */
  baselineConfirmed: boolean;
  overrides: MaterialityOverride[];
}

/** How a gap affects a selected flow. */
export type GapEffect = "material" | "contradiction" | "limitation";

export interface FlowReadiness {
  workflow_id: string;
  readiness: Readiness;
  gaps: Array<{ gap_id: string; effect: GapEffect; overridden: boolean }>;
}

/** A finding QAA records about a package. QAA's own gaps use `qgap:` IDs and never SAA's namespace (CON-013). */
export interface QaaGap {
  id: string;
  type: "category_not_reported" | "low_confidence_claim" | "newer_minor_version" | "markdown_only";
  description: string;
  related: string[];
}

export interface ReadinessResult {
  /** The contract document (`readiness-assessment`), three dimensions, no aggregate score (CON-028). */
  assessment: {
    schema_version: string;
    assessment_id: string;
    package_refs: Array<{ package_id: string; package_version: number }>;
    execution_status: string;
    coverage: Record<string, string>;
    activities: Record<Activity, { readiness: Readiness; reasons: string[] }>;
    freshness: Freshness;
    materiality_overrides: MaterialityOverride[];
    assessed_at: string;
  };
  flows: FlowReadiness[];
  categories: Array<{ category: string; value: string }>;
  findings: QaaGap[];
}

/** Entities on a workflow's path: entry points and steps, the rules that validate them, the roles that guard them. */
function pathOf(model: PackageQuery, workflow: Workflow): Set<string> {
  const path = new Set<string>([...workflow.entry_point_ids, ...workflow.steps.map((s) => s.entity_id)]);
  for (const id of [...path]) {
    for (const r of model.related(id, "in", "VALIDATES")) path.add(r.from);
    for (const type of ["AUTHORIZES_WITH", "AUTHENTICATES_WITH"])
      for (const r of model.related(id, "out", type)) path.add(r.to);
  }
  return path;
}

/**
 * How each open gap affects one flow (PRD §13.9 materiality): a gap touches a flow when it is one of its unresolved
 * hops or names an entity on its path. A contradiction there allows review only; an external boundary, or something
 * the package's kind of evidence cannot observe, is a limitation flagged on the flow's scenarios; any other gap there
 * (missing evidence, unsupported construct, ambiguity) is material and blocks the flow. A person's override (audited) makes a gap material or not.
 */
function effectsOn(
  model: PackageQuery,
  workflow: Workflow,
  gaps: Gap[],
  overrides: Map<string, MaterialityOverride>,
): FlowReadiness["gaps"] {
  const path = pathOf(model, workflow);
  const hops = new Set(workflow.unresolved_hops.map((h) => h.gap_id).filter((g): g is string => Boolean(g)));
  const out: FlowReadiness["gaps"] = [];
  for (const gap of gaps) {
    const touches = hops.has(gap.id) || (gap.related_entity_ids ?? []).some((id) => path.has(id));
    if (!touches) continue;
    // External boundaries and what the package's kind of evidence cannot observe are limitations, never a downgrade
    // for evidence the package does not claim (CON-022).
    const natural: GapEffect =
      gap.type === "contradiction"
        ? "contradiction"
        : gap.type === "external_boundary" || gap.type === "unobservable"
          ? "limitation"
          : "material";
    const override = overrides.get(gap.id);
    const effect: GapEffect = override ? (override.material ? "material" : "limitation") : natural;
    out.push({ gap_id: gap.id, effect, overridden: override !== undefined });
  }
  return out;
}

/**
 * Readiness per QA activity (PRD §13.9, CON-022, QAA-FR-013/018): computed separately for scenario design, manual
 * preparation and automated execution, and never lowered for evidence the package does not claim (a runtime package
 * is not penalized for lacking source, a source package not for lacking an environment). Material gaps block the
 * affected flows only; when every selected flow is blocked, the activity is blocked.
 */
export function assessReadiness(input: ReadinessInput): ReadinessResult {
  const analysis = (input.manifest.analysis ?? {}) as { status?: string };
  const status = analysis.status ?? "completed";
  const issueCodes = new Set(input.issues.map((i) => i.code));
  const coverageSummary = (input.manifest.coverage_summary ?? {}) as Record<string, string>;
  const findings: QaaGap[] = [];
  const reasons: string[] = [];
  let base: Readiness = "ready";
  const lower = (to: Readiness, reason: string) => {
    base = worst(base, to);
    reasons.push(reason);
  };

  // Package-level conditions (§13.9 table).
  if (status === "failed" || status === "cancelled") lower("blocked", `The analysis ${status}.`);
  if (status === "partial") lower("review_only", "The analysis is partial.");
  if (input.freshness.freshness === "mismatched" || input.freshness.freshness === "stale")
    lower("review_only", `Freshness is ${input.freshness.freshness}: ${input.freshness.reason}.`);
  if (issueCodes.has("PKG_MARKDOWN_ONLY")) {
    lower("review_only", "Only Markdown documentation is available (fallback import).");
    findings.push({
      id: `qgap:markdown-only:${input.packageRef.package_id}`,
      type: "markdown_only",
      description: "The package has no structured artifacts; anything taken from its Markdown is inferred by QAA.",
      related: [],
    });
  }
  if (issueCodes.has("PKG_DIRTY_OR_NON_GIT") && !input.baselineConfirmed)
    lower(
      "review_only",
      "The package comes from a dirty or non-Git working tree; a person must confirm that the target runs it (OD-04).",
    );
  if (status === "completed_with_limitations") lower("ready_with_gaps", "The analysis completed with limitations.");
  if (issueCodes.has("PKG_MINOR_NEWER"))
    findings.push({
      id: `qgap:newer-minor:${input.packageRef.package_id}`,
      type: "newer_minor_version",
      description: "The package uses a newer contract minor version; fields QAA does not know are kept but not used.",
      related: [],
    });

  // Category coverage (QAA-FR-013): every category is listed; one the package does not report is a QAA finding.
  const categories = COVERAGE_CATEGORIES.map((category) => ({
    category,
    value: coverageSummary[category] ?? "not_reported",
  }));
  for (const c of categories) {
    if (c.value === "not_reported")
      findings.push({
        id: `qgap:category-not-reported:${c.category}`,
        type: "category_not_reported",
        description: `The package does not report its ${c.category} coverage.`,
        related: [],
      });
  }
  const thin = categories.filter((c) => c.value === "partial" || c.value === "absent");
  if (thin.length > 0)
    lower(
      "ready_with_gaps",
      `Coverage is partial or absent for ${thin.map((c) => `${c.category} (${c.value})`).join(", ")}.`,
    );

  // Flows and materiality.
  const overrides = new Map(input.overrides.map((o) => [o.gap_id, o]));
  const flows: FlowReadiness[] = [];
  if (input.model) {
    const model = input.model;
    const open = model.unknowns().gaps;
    const selected = model
      .workflows()
      .filter((w) => w.discovery_status !== "excluded" && (!input.scope || input.scope.includes(w.id)));
    for (const workflow of selected) {
      const gaps = effectsOn(model, workflow, open, overrides);
      let readiness: Readiness = "ready";
      if (gaps.some((g) => g.effect === "limitation")) readiness = "ready_with_gaps";
      if (gaps.some((g) => g.effect === "contradiction")) readiness = "review_only";
      if (gaps.some((g) => g.effect === "material")) readiness = "blocked";
      flows.push({ workflow_id: workflow.id, readiness, gaps });
    }
    const touching = new Set(flows.flatMap((f) => f.gaps.map((g) => g.gap_id)));
    if (open.some((g) => !touching.has(g.id))) lower("ready_with_gaps", "Open gaps lie outside the selected flows.");
    const blocked = flows.filter((f) => f.readiness === "blocked");
    if (flows.length > 0 && blocked.length === flows.length)
      lower("blocked", "Every selected flow has a material gap.");
    else if (blocked.length > 0)
      lower("ready_with_gaps", `${blocked.length} of ${flows.length} selected flows are blocked by material gaps.`);
    if (flows.some((f) => f.readiness === "review_only"))
      lower("review_only", "A selected flow has a material contradiction between documentation and code.");
    else if (flows.some((f) => f.readiness === "ready_with_gaps"))
      lower(
        "ready_with_gaps",
        "Selected flows have limitations (an external boundary or what the evidence cannot observe); their scenarios carry them.",
      );

    // Low-confidence claims (QAA-FR-018) are QAA findings; they never change the package's statuses.
    for (const claim of model.lowConfidenceClaims().slice(0, 200))
      findings.push({
        id: `qgap:low-confidence:${claim.id}`,
        type: "low_confidence_claim",
        description: `Claim ${claim.id} is ${claim.status}; it is not used as an expected result without review.`,
        related: [claim.subject_entity_id],
      });
  }

  const design = { readiness: base, reasons: [...reasons] };
  // Automated execution additionally needs a configured, reachable, non-production environment (§13.9).
  let execution: Readiness = base;
  const executionReasons = [...reasons];
  const lowerExecution = (to: Readiness, reason: string) => {
    execution = worst(execution, to);
    executionReasons.push(reason);
  };
  if (!input.environment) lowerExecution("blocked", "No environment configured.");
  else if (input.environment.classification === "production")
    lowerExecution("blocked", "The environment is classified as production.");
  else if (input.environment.state !== "validated")
    lowerExecution("blocked", `The environment is ${input.environment.state}, not validated as reachable.`);
  if (input.freshness.freshness === "unverifiable" && !input.baselineConfirmed)
    lowerExecution("review_only", "The deployed revision is unknown; execution needs a baseline confirmation.");

  const coverage: Record<string, string> = {};
  for (const c of categories) if (c.value !== "not_reported") coverage[c.category] = c.value;
  return {
    assessment: {
      schema_version: "1.0.0",
      assessment_id: input.assessmentId,
      package_refs: [input.packageRef],
      execution_status: status,
      coverage,
      activities: {
        scenario_design: design,
        manual_preparation: { readiness: base, reasons: [...reasons] },
        automated_execution: { readiness: execution, reasons: executionReasons },
      },
      freshness: input.freshness.freshness,
      materiality_overrides: input.overrides,
      assessed_at: input.assessedAt,
    },
    flows,
    categories,
    findings,
  };
}
