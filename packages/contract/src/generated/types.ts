/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: /schemas/*.schema.json (canonical contract, ADR-003).
 * Regenerate with: pnpm schemas:types
 */

/**
 * JSON-RPC 2.0 messages between the adapter host and analyzer adapters over stdio (ADR-009).
 */
export type AdapterMessage = AdapterRequest | AdapterResponse | AdapterNotification;
export type AdapterRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: "initialize" | "analyze" | "cancel";
  params: {};
};
export type AdapterResponse = {
  [k: string]: unknown;
} & {
  jsonrpc: "2.0";
  id: number | string;
  result?: {};
  error?: RpcError;
};
/**
 * BCP 47 language tag.
 *
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "language_tag".
 */
export type LanguageTag = string;
/**
 * Semantic or operational ID: <kind>:<local-id> (PRD §13.4).
 *
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "semver".
 */
export type Semver = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "revision".
 */
export type Revision = GitCommitRevision | ContentFingerprintRevision | ObservationWindowRevision;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;
/**
 * RFC 3339 UTC timestamp with Z suffix.
 *
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * SAA response to an analysis request.
 */
export type AnalysisResponse = {
  contract: "sys2qa.analysis-response";
  schema_version: Semver;
  request_id: Id;
  outcome: "answered" | "partial" | "rejected";
  reason?: string;
  result_package?: PackageRef;
  responded_at: Timestamp;
};
/**
 * Approval of one scenario version bound to a full baseline (QAA-FR-052, CR-055).
 */
export type Approval = {
  schema_version: Semver;
  approval_id: UlidId;
  scenario_id: Id;
  scenario_version: number;
  baseline: Baseline;
  environment_id?: Id;
  declared_environment_id?: Id;
  scope_policy_version: number;
  test_data_profile: string;
  mode: "manual" | "automated";
  state_changing_ack?: boolean;
  approver: string;
  approved_at: Timestamp;
  state: ApprovalState;
};
/**
 * Operational record ID: <kind>:<ULID>.
 *
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "ulid_id".
 */
export type UlidId = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "approval_state".
 */
export type ApprovalState = "active" | "suspended" | "invalidated" | "superseded" | "revoked";
/**
 * Repository-relative POSIX path; never absolute, never containing '..'.
 *
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "repo_path".
 */
export type RepoPath = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "url".
 */
export type Url = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "secret_ref".
 */
export type SecretRef = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "fixture_ref".
 */
export type FixtureRef = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "artifact_id".
 */
export type ArtifactId = string;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "source_revision".
 */
export type SourceRevision = GitCommitRevision | ContentFingerprintRevision;
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "producer_name".
 */
export type ProducerName = "SAA" | "QAA";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "analysis_status".
 */
export type AnalysisStatus = "completed" | "completed_with_limitations" | "partial" | "failed" | "cancelled";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "claim_status".
 */
export type ClaimStatus =
  | "source_verified"
  | "runtime_observed"
  | "test_verified"
  | "inferred"
  | "contradicted"
  | "unresolved"
  | "stale"
  | "human_asserted";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "expected_result_basis".
 */
export type ExpectedResultBasis =
  | "requirement_backed"
  | "user_confirmed"
  | "saa_documented"
  | "source_supported"
  | "observed"
  | "inferred"
  | "unresolved";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "oracle_class".
 */
export type OracleClass = "intended" | "implemented" | "observed" | "none";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "qa_objective".
 */
export type QaObjective = "characterization" | "implementation_conformance" | "requirement_conformance" | "exploratory";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "discovery_status".
 */
export type DiscoveryStatus =
  "reconstructed" | "partially_reconstructed" | "known_not_traceable" | "excluded" | "not_observed";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "workflow_completion".
 */
export type WorkflowCompletion = "complete_within_static_scope" | "partial" | "runtime_observed_for_run" | "unresolved";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "workflow_category".
 */
export type WorkflowCategory =
  | "user_interface"
  | "api"
  | "business_process"
  | "data_lifecycle"
  | "async_processing"
  | "scheduled_processing"
  | "integration"
  | "auth"
  | "error_recovery"
  | "cross_component";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "coverage_value".
 */
export type CoverageValue = "complete" | "partial" | "absent" | "not_applicable" | "unsupported" | "unobservable";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "coverage_category".
 */
export type CoverageCategory =
  | "modules"
  | "routes_pages"
  | "roles_permissions"
  | "business_rules"
  | "workflows"
  | "state_transitions"
  | "api_contracts"
  | "data_model"
  | "integrations"
  | "error_paths";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "readiness".
 */
export type Readiness = "ready" | "ready_with_gaps" | "review_only" | "blocked";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "package_freshness".
 */
export type PackageFreshness = "current" | "mismatched" | "stale" | "unverifiable";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "scenario_status".
 */
export type ScenarioStatus =
  "draft" | "needs_clarification" | "pending_review" | "approved" | "rejected" | "deferred" | "superseded";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "scenario_freshness".
 */
export type ScenarioFreshness = "current" | "potentially_stale" | "stale";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "run_state".
 */
export type RunState =
  "created" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "blocked" | "abandoned";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "case_outcome".
 */
export type CaseOutcome = "passed" | "failed" | "blocked" | "inconclusive" | "not_run" | "skipped";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "failure_category".
 */
export type FailureCategory =
  | "assertion_failure"
  | "navigation_error"
  | "timeout"
  | "blocked_request"
  | "out_of_scope_blocked"
  | "unsupported_step"
  | "test_data_error"
  | "cleanup_failure"
  | "runner_failure"
  | "environment_unavailable"
  | "credential_failure";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "defect_state".
 */
export type DefectState =
  | "new"
  | "triaged"
  | "confirmed"
  | "rejected"
  | "duplicate"
  | "needs_info"
  | "fixed"
  | "ready_for_retest"
  | "closed"
  | "reopened";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "severity".
 */
export type Severity = "critical" | "major" | "minor" | "trivial";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "priority".
 */
export type Priority = "high" | "medium" | "low";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "entity_kind".
 */
export type EntityKind =
  | "system"
  | "project"
  | "module"
  | "file"
  | "function"
  | "class"
  | "page"
  | "route"
  | "form"
  | "field"
  | "api"
  | "schema"
  | "table"
  | "column"
  | "orm_model"
  | "actor_role"
  | "permission"
  | "workflow"
  | "business_rule"
  | "state_machine"
  | "entity"
  | "integration"
  | "job"
  | "queue_topic"
  | "config_key"
  | "deployment_unit"
  | "secret_ref"
  | "test"
  | "requirement";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "relationship_type".
 */
export type RelationshipType =
  | "CONTAINS"
  | "IMPORTS"
  | "CALLS"
  | "REFERENCES"
  | "EXPOSES"
  | "CONSUMES"
  | "READS_FROM"
  | "WRITES_TO"
  | "PUBLISHES"
  | "SUBSCRIBES_TO"
  | "AUTHENTICATES_WITH"
  | "AUTHORIZES_WITH"
  | "VALIDATES"
  | "CONFIGURED_BY"
  | "DEPLOYED_AS"
  | "TESTS"
  | "USES_SCHEMA"
  | "DEPENDS_ON"
  | "TRIGGERS"
  | "SENDS_TO"
  | "NAVIGATES_TO"
  | "SUBMITS_TO"
  | "TRANSITIONS_TO"
  | "SATISFIES";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "evidence_source_type".
 */
export type EvidenceSourceType =
  | "source_code"
  | "configuration"
  | "schema"
  | "migration"
  | "manifest"
  | "test_definition"
  | "documentation"
  | "git_history"
  | "runtime_observation"
  | "test_result"
  | "human_annotation"
  | "requirement_document";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "runtime_subtype".
 */
export type RuntimeSubtype = "page" | "navigation" | "form" | "validation_message" | "state_message" | "access_outcome";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "evidence_availability".
 */
export type EvidenceAvailability = "available" | "partial" | "unavailable";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "revision_correspondence".
 */
export type RevisionCorrespondence = "user_confirmed" | "observed" | "unconfirmed" | "not_applicable";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "permission_level".
 */
export type PermissionLevel = "L0" | "L1" | "L2" | "L2r" | "L3" | "L4";
/**
 * Production is never a valid target (SEC-009).
 *
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "environment_classification".
 */
export type EnvironmentClassification = "development" | "staging";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "automation_action".
 */
export type AutomationAction = "navigate" | "click" | "fill" | "select" | "check" | "uncheck";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "assertion_type".
 */
export type AssertionType = "visible" | "hidden" | "text" | "value" | "url" | "enabled" | "disabled";
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "stop_reason_code".
 */
export type StopReasonCode =
  | "dynamic_registration"
  | "reflection_or_di_unresolved"
  | "external_service"
  | "missing_repository"
  | "unsupported_construct"
  | "config_unavailable"
  | "budget_exhausted"
  | "not_observable_at_runtime"
  | "submission_requires_approval"
  | "auth_required"
  | "out_of_scope";
/**
 * Mode C correlation between an SAA package and a QAA package (QAA-FR-115, CON-026).
 */
export type CorrelationReport = {
  contract: "sys2qa.correlation-report";
  schema_version: Semver;
  report_id: Id;
  saa_package: PackageRef;
  qaa_package: PackageRef;
  revision_correspondence: RevisionCorrespondence;
  links: CorrelationLink[];
  unmatched: Unmatched;
  discrepancies: Discrepancy[];
  generated_at: Timestamp;
};
/**
 * Defect record with severity, priority and lifecycle state (QAA-FR-088, PRD §15.12).
 */
export type Defect = {
  schema_version: Semver;
  defect_id: UlidId;
  title: LangText;
  description?: LangText;
  severity: Severity;
  priority: Priority;
  state: DefectState;
  suspected_type: "product_defect" | "test_defect" | "unknown";
  links: DefectLinks;
  baseline: Baseline;
  environment: RunEnvironment;
  duplicate_of?: UlidId;
  created_at: Timestamp;
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "run_environment".
 */
export type RunEnvironment = ConfiguredEnvironmentRef | DeclaredEnvironmentRef;
/**
 * This interface was referenced by `EvidenceIndex`'s JSON-Schema
 * via the `definition` "evidence".
 */
export type Evidence = {
  id: Id;
  source_type: EvidenceSourceType;
  captured_at: Timestamp;
  extractor: Extractor;
  path?: RepoPath;
  range?: SourceRange;
  file_fingerprint?: Sha256;
  subtype?: RuntimeSubtype;
  environment_id?: Id;
  url?: Url;
  observed_at?: Timestamp;
  credential_profile_role?: string;
  submission?: "none" | "read_only" | "approved_test";
  screenshot_digest?: Sha256;
  excerpt?: string;
  excerpt_digest?: Sha256;
  excerpt_policy: "short_excerpt" | "digest_only" | "none";
  annotator?: string;
  test_ref?: string;
};
export type Extractor = {
  [k: string]: unknown;
} & {
  adapter?: string;
  component?: string;
  version: Semver;
  method: string;
};
/**
 * One immutable-once-approved scenario version (PRD §15.10, Contract Specification §6.1).
 */
export type Scenario = {
  schema_version: Semver;
  scenario_id: Id;
  display_key: string;
  version: number;
  content_language: LanguageTag;
  title: LangText;
  feature_ref: Id;
  /**
   * @minItems 1
   */
  test_condition_ids: [Id, ...Id[]];
  category: string;
  qa_objective: QaObjective;
  /**
   * @minItems 1
   */
  test_techniques: [TechniqueUse, ...TechniqueUse[]];
  priority: Priority;
  risk: ScenarioRisk;
  /**
   * @minItems 1
   */
  execution_modes: ["manual" | "automated", ...("manual" | "automated")[]];
  execution_classification: "manual_only" | "automation_candidate" | "automation_ready" | "both";
  state_changing: boolean;
  preconditions: Precondition[];
  test_data: TestDatum[];
  /**
   * @minItems 1
   */
  steps: [ScenarioStep, ...ScenarioStep[]];
  cleanup: LangText[];
  irreversible_ack?: boolean;
  assumptions: LangText[];
  open_gaps: Id[];
  baseline: Baseline;
  freshness: ScenarioFreshness;
  status: ScenarioStatus;
  status_reason?: string;
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "locator_target".
 */
export type LocatorTarget = {
  kind: "route" | "label" | "role" | "text" | "test_id";
  value?: string;
  role?: string;
  name?: string;
  literal_language?: LanguageTag;
  source_ref?: Id;
};
/**
 * oracle_class is derived from basis (CR-052). Non-requirement-level human_asserted maps to oracle 'none' (conservative).
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "expected_result".
 */
export type ExpectedResult = {
  description: LangText;
  assertions: Assertion[];
  basis: ExpectedResultBasis;
  saa_status?: ClaimStatus;
  requirement_level?: boolean;
  oracle_class: OracleClass;
  trace: ExpectedResultTrace;
};
/**
 * Documentation Package manifest (PRD §13.3, Contract Specification §3).
 */
export type PackageManifest = {
  contract: "sys2qa.documentation-package";
  package_schema_version: Semver;
  package_id: Id;
  package_version: number;
  previous_package?: PreviousPackage;
  producer: Producer;
  project: ProjectRef;
  evidence_profile: EvidenceProfile;
  repository: RepositoryIdentity | null;
  /**
   * @minItems 1
   */
  observed_environments?: [ObservedEnvironment, ...ObservedEnvironment[]];
  analysis: AnalysisInfo;
  generated_at: Timestamp;
  languages: PackageLanguages;
  coverage_summary: CoverageSummary;
  redaction: RedactionPolicy;
  /**
   * @minItems 1
   */
  artifacts: [ArtifactEntry, ...ArtifactEntry[]];
};
export type ArtifactEntry = {
  id: ArtifactId;
  role:
    | "system_model"
    | "evidence_index"
    | "diff_report"
    | "completeness_report"
    | "correlation_report"
    | "executive_summary"
    | "system_context"
    | "architecture"
    | "project_inventory"
    | "components"
    | "workflow_catalog"
    | "workflows"
    | "routes_and_pages"
    | "roles_and_permissions"
    | "business_rules"
    | "observed_behavior"
    | "api_contracts"
    | "data_model"
    | "integrations_events"
    | "configuration_deployment"
    | "tests_coverage"
    | "dependencies_impact"
    | "risks_contradictions"
    | "unknowns"
    | "asset";
  path: RepoPath;
  media_type: string;
  sha256: Sha256;
  schema_version?: Semver;
  language?: LanguageTag;
  translation_of?: ArtifactId;
  machine_translated?: boolean;
  required?: boolean;
} & {
  id: ArtifactId;
  role:
    | "system_model"
    | "evidence_index"
    | "diff_report"
    | "completeness_report"
    | "correlation_report"
    | "executive_summary"
    | "system_context"
    | "architecture"
    | "project_inventory"
    | "components"
    | "workflow_catalog"
    | "workflows"
    | "routes_and_pages"
    | "roles_and_permissions"
    | "business_rules"
    | "observed_behavior"
    | "api_contracts"
    | "data_model"
    | "integrations_events"
    | "configuration_deployment"
    | "tests_coverage"
    | "dependencies_impact"
    | "risks_contradictions"
    | "unknowns"
    | "asset";
  path: RepoPath;
  media_type: string;
  sha256: Sha256;
  schema_version?: Semver;
  language?: LanguageTag;
  translation_of?: ArtifactId;
  machine_translated?: boolean;
  required?: boolean;
};
/**
 * Manual or automated run with case and step results (Contract Specification §6.3). Manual results are always tester-reported.
 */
export type RunResult = {
  schema_version: Semver;
  run_id: UlidId;
  kind: "manual" | "automated";
  state: RunState;
  environment: RunEnvironment;
  baseline: Baseline;
  started_at: Timestamp;
  finished_at?: Timestamp;
  browser?: string;
  viewport?: string;
  locale?: LanguageTag;
  timezone?: string;
  cases: CaseResult[];
};
export type CaseResult = {
  scenario_id: Id;
  version: number;
  approval_id: UlidId;
  outcome: CaseOutcome;
  failure_category?: FailureCategory;
  cleanup_outcome?: "not_needed" | "succeeded" | "failed" | "skipped";
  reported_by: "tester" | "executor";
  /**
   * @minItems 1
   */
  steps: [StepResult, ...StepResult[]];
  defect_ids?: Id[];
  reason?: string;
};
/**
 * System-model node. Kind-specific fields are listed as optional properties; unknown fields are preserved (minor-version tolerance).
 *
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "entity".
 */
export type Entity = {
  id: Id;
  kind: EntityKind;
  name: string;
  project_boundary?: Id;
  status: ClaimStatus;
  origin: "source" | "runtime" | "annotation";
  evidence_ids: Id[];
  claim_ids?: Id[];
  gap_ids?: Id[];
  contradiction_ids?: Id[];
  description?: LangText;
  confidence_rationale?: string;
  route_pattern?: string;
  module_id?: Id;
  access_preconditions?: Id[];
  method?: string;
  handler_id?: Id;
  page_id?: Id;
  submits_to?: Id;
  form_id?: Id;
  label_literal?: LabelLiteral;
  constraints?: FieldConstraints;
  statement?: string;
  technical_rule?: string;
  business_intent?: string | null;
  inputs?: Id[];
  expected_behavior?: {};
  boundaries?: {}[];
  subject?: Id;
  /**
   * @minItems 1
   */
  states?: [string, ...string[]];
  transitions?: StateTransition[];
  invalid_transitions_known?: KnownInvalidTransition[];
  permissions?: Id[];
};
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "workflow".
 */
export type Workflow = {
  id: Id;
  name: string;
  category: WorkflowCategory;
  origin: "source" | "runtime";
  discovery_status: DiscoveryStatus;
  actor?: Id;
  entry_point_ids: Id[];
  component_trace_ids: Id[];
  steps: WorkflowStep[];
  branches: WorkflowBranch[];
  unresolved_hops: UnresolvedHop[];
  completion: WorkflowCompletion;
  deepened: boolean;
  rank?: number;
  status: ClaimStatus;
  evidence_ids?: Id[];
};
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "claim".
 */
export type Claim = {
  id: Id;
  text: LangText;
  status: ClaimStatus;
  subject_entity_id: Id;
  relationship_ids?: Id[];
  evidence_ids: Id[];
  gap_ids?: Id[];
  scope: "static_analysis" | "runtime_observation" | "test_run" | "annotation";
  caveats: string[];
  last_validated_revision: string;
  confidence_rationale?: string;
};

/**
 * Synthetic root used only for type generation. Not a contract document.
 */
export interface Sys2QaContractDocuments {
  adapterProtocol?: AdapterMessage;
  analysisRequest?: AnalysisRequest;
  analysisResponse?: AnalysisResponse;
  approval?: Approval;
  common?: Sys2QaCommon;
  completenessReport?: CompletenessReport;
  correlationReport?: CorrelationReport;
  defect?: Defect;
  diffReport?: DiffReport;
  error?: Sys2QaError;
  evidenceIndex?: EvidenceIndex;
  manualTestPack?: ManualTestPack;
  packageManifest?: PackageManifest;
  readinessAssessment?: ReadinessAssessment;
  runResult?: RunResult;
  scenario?: Scenario;
  systemModel?: SystemModel;
  testPlan?: TestPlan;
}
export interface RpcError {
  code: number;
  message: string;
  data?: Sys2QaError;
}
/**
 * Machine-readable error used by every interface (OBS-003, Contract Specification §9).
 */
export interface Sys2QaError {
  code: string;
  severity: "error" | "warning" | "info";
  message: LangText;
  artifact_id?: string;
  json_pointer?: string;
  remediation: LangText;
  details?: {};
}
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "lang_text".
 */
export interface LangText {
  language: LanguageTag;
  value: string;
}
export interface AdapterNotification {
  jsonrpc: "2.0";
  method: "progress";
  params: ProgressParams;
}
export interface ProgressParams {
  run_id: Id;
  files_done: number;
  files_total: number;
}
/**
 * Bounded QAA → SAA follow-up investigation request (PRD §13.12, CON-015).
 */
export interface AnalysisRequest {
  contract: "sys2qa.analysis-request";
  schema_version: Semver;
  request_id: Id;
  system_id: Id;
  base_package: PackageRef;
  revision: Revision;
  environment_id?: Id | null;
  /**
   * @minItems 1
   */
  subject_ids: [Id, ...Id[]];
  question: string;
  trigger: RequestTrigger;
  budget: RequestBudget;
  max_permission_level: "L0" | "L1";
  requested_by: string;
  created_at: Timestamp;
}
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "package_ref".
 */
export interface PackageRef {
  package_id: Id;
  package_version: number;
}
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "git_commit_revision".
 */
export interface GitCommitRevision {
  kind: "git_commit";
  value: string;
  worktree_dirty: boolean;
  dirty_fingerprint?: Sha256;
}
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "content_fingerprint_revision".
 */
export interface ContentFingerprintRevision {
  kind: "content_fingerprint";
  value: Sha256;
}
/**
 * This interface was referenced by `Sys2QaCommon`'s JSON-Schema
 * via the `definition` "observation_window_revision".
 */
export interface ObservationWindowRevision {
  kind: "observation_window";
  environment_id: Id;
  observed_from: Timestamp;
  observed_to: Timestamp;
}
export interface RequestTrigger {
  type: "test_failure" | "contradiction" | "gap" | "user";
  ref?: string;
}
export interface RequestBudget {
  max_files: number;
  max_minutes: number;
  max_llm_tokens?: number;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "baseline".
 */
export interface Baseline {
  /**
   * @minItems 1
   */
  packages: [PackageRef, ...PackageRef[]];
  revision: Revision;
  correlation_report_id?: Id;
}
/**
 * Shared definitions for every Sys2QA contract schema (Contract Specification §1, §7).
 */
export interface Sys2QaCommon {
  [k: string]: unknown;
}
/**
 * What a producer examined, found, could not resolve and could not reach (SAA-FR-045, QAA-FR-114). Counts are always within the examined scope (CR-043).
 */
export interface CompletenessReport {
  schema_version: Semver;
  producer: ProducerName;
  run_id: Id;
  count_scope: "within_examined_scope";
  examined: ExaminedScope;
  constructs: ConstructCounts;
  entry_points_found: number;
  workflows_by_status: WorkflowsByStatus;
  unresolved_workflow_ids: Id[];
  unavailable_adapters: UnavailableAdapter[];
  excluded: ExcludedArea[];
  unexplored: UnexploredArea[];
  forms_not_submitted?: FormNotSubmitted[];
  improvement_suggestions: ImprovementSuggestion[];
}
export interface ExaminedScope {
  roots?: string[];
  boundaries?: Id[];
  hosts?: string[];
  paths?: string[];
}
export interface ConstructCounts {
  analyzed: number;
  partial: number;
  unsupported: number;
}
export interface WorkflowsByStatus {
  [k: string]: number;
}
export interface UnavailableAdapter {
  adapter: string;
  reason: string;
}
export interface ExcludedArea {
  area: string;
  reason: string;
}
export interface UnexploredArea {
  area: string;
  reason: string;
}
export interface FormNotSubmitted {
  form_id: Id;
  reason: "submission_requires_approval" | "login_form" | "state_changing" | "read_only_not_enabled";
}
export interface ImprovementSuggestion {
  evidence_kind:
    "source" | "runtime" | "requirement" | "credentials" | "environment" | "adapter" | "read_only_submissions";
  description: string;
  would_improve?: Id[];
}
export interface CorrelationLink {
  observed_id: Id;
  source_id: Id;
  rationale: string;
  confidence: "high" | "medium" | "low";
}
export interface Unmatched {
  observed: Id[];
  source: Id[];
}
export interface Discrepancy {
  id: Id;
  type: "route_unreachable" | "constraint_mismatch" | "unmatched_page" | "behavior_mismatch" | "other";
  observed_ids: Id[];
  source_ids: Id[];
  description: string;
  possibly_version_related: boolean;
  gap_id?: Id;
}
export interface DefectLinks {
  scenario_id: Id;
  scenario_version: number;
  run_id: UlidId;
  step_id?: string;
  evidence_refs: string[];
}
export interface ConfiguredEnvironmentRef {
  environment_id: Id;
}
export interface DeclaredEnvironmentRef {
  declared: DeclaredEnvironment;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "declared_environment".
 */
export interface DeclaredEnvironment {
  name: string;
  url?: Url;
  version?: string;
}
/**
 * Model diff between two package versions (SAA-FR-038, CON-014).
 */
export interface DiffReport {
  schema_version: Semver;
  base: PackageRef;
  target: PackageRef;
  request_id?: Id;
  entities: EntityChanges;
  renamed: Rename[];
  claims: ClaimChanges;
}
export interface EntityChanges {
  added: EntityChange[];
  changed: EntityChange[];
  removed: EntityChange[];
}
/**
 * This interface was referenced by `DiffReport`'s JSON-Schema
 * via the `definition` "entity_change".
 */
export interface EntityChange {
  id: Id;
  kind?: EntityKind;
  summary?: string;
}
export interface Rename {
  from: Id;
  to: Id;
  confidence: "high" | "medium" | "low";
  rationale: string;
}
export interface ClaimChanges {
  newly_stale: Id[];
  contradicted: Id[];
  changed: Id[];
}
/**
 * Evidence records referenced by claims and entities (Contract Specification §5).
 */
export interface EvidenceIndex {
  schema_version: Semver;
  revision: Revision;
  evidence: Evidence[];
}
export interface SourceRange {
  start_line: number;
  end_line: number;
  start_col?: number;
  end_col?: number;
}
/**
 * Approved scenarios packaged for manual execution without a configured environment (QAA-FR-112).
 */
export interface ManualTestPack {
  contract: "sys2qa.manual-test-pack";
  schema_version: Semver;
  pack_id: UlidId;
  created_at: Timestamp;
  content_language: LanguageTag;
  glossary_version: Semver;
  /**
   * @minItems 1
   */
  scenarios: [Scenario, ...Scenario[]];
  /**
   * @minItems 1
   */
  approval_ids: [UlidId, ...UlidId[]];
  result_template: ResultTemplate;
}
export interface TechniqueUse {
  id:
    | "equivalence_partitioning"
    | "boundary_value_analysis"
    | "decision_table"
    | "state_transition"
    | "use_case"
    | "negative"
    | "error_guessing"
    | "exploratory_charter"
    | "role_matrix";
  rationale: string;
}
export interface ScenarioRisk {
  impact: number;
  likelihood: number;
  exposure: string[];
  score: number;
  score_override_reason?: string;
  rationale: string;
}
export interface Precondition {
  id: string;
  text: LangText;
  credential_profile_ref?: SecretRef;
}
export interface TestDatum {
  name: string;
  value_ref: FixtureRef | SecretRef;
  sensitivity: "non_secret" | "secret";
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "step".
 */
export interface ScenarioStep {
  step_id: string;
  instruction: LangText;
  automation?: StepAutomation;
  expected_result: ExpectedResult | null;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "automation".
 */
export interface StepAutomation {
  action: AutomationAction;
  target: LocatorTarget;
  value_ref?: FixtureRef | SecretRef;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "assertion".
 */
export interface Assertion {
  type: AssertionType;
  target?: LocatorTarget;
  operator?: "equals" | "contains" | "matches";
  value?: string;
}
export interface ExpectedResultTrace {
  saa_ids: Id[];
  evidence_ids: Id[];
  requirement_ids: Id[];
}
export interface ResultTemplate {
  schema: "https://sys2qa.dev/schemas/run-result/1.0.json";
  instructions: LangText;
}
export interface PreviousPackage {
  package_version: number;
  revision: string;
}
export interface Producer {
  name: ProducerName;
  version: Semver;
  component?: string;
  adapters?: AdapterInfo[];
}
export interface AdapterInfo {
  id: string;
  version: Semver;
  support_level: number;
}
export interface ProjectRef {
  system_id: Id;
  name: string;
}
export interface EvidenceProfile {
  source_analysis: EvidenceAvailability;
  runtime_observation: EvidenceAvailability;
  documentation_import: EvidenceAvailability;
  revision_correspondence: RevisionCorrespondence;
  cannot_establish: string[];
}
export interface RepositoryIdentity {
  provider: "git" | "filesystem";
  identity: string;
  identity_source: "local_git_remote" | "user_supplied";
  revision: SourceRevision;
  branch_hint?: string;
}
export interface ObservedEnvironment {
  environment_id: Id;
  base_url: Url;
  classification: EnvironmentClassification;
  observed_from: Timestamp;
  observed_to: Timestamp;
  target_app_locale: LanguageTag;
  deployed_revision: DeployedRevision;
  permission_level_max: "L2" | "L2r";
  read_only_submissions: boolean;
}
export interface DeployedRevision {
  value: string | null;
  source: "declared" | "observed" | "unknown";
}
export interface AnalysisInfo {
  run_id: Id;
  profile?: "overview" | "standard" | "deep";
  status: AnalysisStatus;
  permission_level_max: PermissionLevel;
  optional_actions_executed: OptionalAction[];
  started_at: Timestamp;
  finished_at: Timestamp;
  scope: AnalysisScope;
  limitations: string[];
}
export interface OptionalAction {
  action: string;
  approved_by: string;
  approved_at: Timestamp;
}
export interface AnalysisScope {
  roots?: string[];
  excluded?: string[];
  hosts?: string[];
  paths?: string[];
}
export interface PackageLanguages {
  /**
   * @minItems 1
   */
  documentation: [LanguageTag, ...LanguageTag[]];
  default: LanguageTag;
  machine_text: LanguageTag;
}
export interface CoverageSummary {
  [k: string]: CoverageValue;
}
export interface RedactionPolicy {
  secrets: "redacted";
  excerpts: "short_excerpts" | "digest_only" | "none";
  max_excerpt_chars: number;
}
/**
 * Three separate status dimensions (CON-028): execution status, coverage, and readiness per QA activity (CON-022). No aggregate score.
 */
export interface ReadinessAssessment {
  schema_version: Semver;
  assessment_id: Id;
  /**
   * @minItems 1
   */
  package_refs: [PackageRef, ...PackageRef[]];
  execution_status: AnalysisStatus;
  coverage: AssessedCoverage;
  activities: ActivityReadinessSet;
  freshness: PackageFreshness;
  materiality_overrides: MaterialityOverride[];
  assessed_at: Timestamp;
}
export interface AssessedCoverage {
  [k: string]: CoverageValue;
}
export interface ActivityReadinessSet {
  scenario_design: ActivityReadiness;
  manual_preparation: ActivityReadiness;
  automated_execution: ActivityReadiness;
}
/**
 * This interface was referenced by `ReadinessAssessment`'s JSON-Schema
 * via the `definition` "activity_readiness".
 */
export interface ActivityReadiness {
  readiness: Readiness;
  reasons: string[];
}
export interface MaterialityOverride {
  gap_id: Id;
  material: boolean;
  reason: string;
  by: string;
  at: Timestamp;
}
export interface StepResult {
  step_id: string;
  status: "pass" | "fail" | "blocked" | "not_applicable" | "not_run";
  expected?: string;
  actual?: string;
  assertion_results?: AssertionResult[];
  evidence_refs?: string[];
  notes?: string;
}
export interface AssertionResult {
  type: AssertionType;
  expected: string;
  actual: string;
  outcome: "passed" | "failed" | "error";
  elapsed_ms?: number;
}
/**
 * Contract view of the SKB (SAA) or the observed model (QAA) for one revision or observation window (Contract Specification §4).
 */
export interface SystemModel {
  schema_version: Semver;
  system_id: Id;
  producer: ProducerName;
  revision: Revision;
  analysis_run_id: Id;
  machine_text_language: LanguageTag;
  entities: Entity[];
  relationships: Relationship[];
  component_traces: ComponentTrace[];
  workflows: Workflow[];
  claims: Claim[];
  gaps: Gap[];
  coverage: CoverageItem[];
}
export interface LabelLiteral {
  value: string;
  language: LanguageTag;
  source: "source_code" | "runtime_observation";
}
export interface FieldConstraints {
  required?: boolean;
  pattern?: string;
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  input_type?: string;
}
export interface StateTransition {
  from: string;
  to: string;
  trigger?: Id;
  guard?: Id;
  status: ClaimStatus;
  evidence_ids: Id[];
}
export interface KnownInvalidTransition {
  from: string;
  to: string;
  status: ClaimStatus;
  evidence_ids: Id[];
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "relationship".
 */
export interface Relationship {
  id: Id;
  type: RelationshipType;
  from: Id;
  to: Id;
  status: ClaimStatus;
  evidence_ids: Id[];
  confidence_rationale?: string;
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "component_trace".
 */
export interface ComponentTrace {
  id: Id;
  entry_point_id: Id;
  relationship_ids: Id[];
  stopped_at: TraceStop[];
  status: ClaimStatus;
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "trace_stop".
 */
export interface TraceStop {
  entity_id?: Id;
  reason_code: StopReasonCode;
  gap_id: Id;
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "workflow_step".
 */
export interface WorkflowStep {
  id: Id;
  order: number;
  entity_id: Id;
  action: string;
  validations?: Id[];
  reads?: Id[];
  writes?: Id[];
  side_effects?: Id[];
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "workflow_branch".
 */
export interface WorkflowBranch {
  from_step: Id;
  condition: string;
  outcome: string;
  status: ClaimStatus;
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "unresolved_hop".
 */
export interface UnresolvedHop {
  after_step?: Id;
  reason_code: StopReasonCode;
  gap_id?: Id;
  description?: string;
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "gap".
 */
export interface Gap {
  id: Id;
  type: "contradiction" | "external_boundary" | "missing_evidence" | "unsupported" | "unobservable" | "ambiguity";
  description: string;
  impact?: string;
  evidence_ids?: Id[];
  related_entity_ids?: Id[];
  requires_human_clarification: boolean;
  status: "unresolved" | "resolved";
}
/**
 * This interface was referenced by `SystemModel`'s JSON-Schema
 * via the `definition` "coverage_item".
 */
export interface CoverageItem {
  area: string;
  status: "analyzed" | "partial" | "skipped" | "failed" | "unsupported" | "excluded";
  reason?: string;
}
/**
 * QAA test plan (QAA-FR-030).
 */
export interface TestPlan {
  schema_version: Semver;
  plan_id: Id;
  content_language: LanguageTag;
  baseline: Baseline;
  /**
   * @minItems 1
   */
  objectives: [LangText, ...LangText[]];
  /**
   * @minItems 1
   */
  qa_objectives: [QaObjective, ...QaObjective[]];
  scope: PlanScope;
  risks: PlanRisk[];
  /**
   * @minItems 1
   */
  test_basis: [TestBasisRef, ...TestBasisRef[]];
  assumptions: LangText[];
  /**
   * @minItems 1
   */
  exit_criteria: [LangText, ...LangText[]];
  evidence_profile_summary?: string;
}
export interface PlanScope {
  in_scope: Id[];
  out_of_scope: Id[];
  exclusions_reason?: string;
}
export interface PlanRisk {
  id: Id;
  description: LangText;
  impact: number;
  likelihood: number;
  exposure?: string[];
  rationale: string;
}
export interface TestBasisRef {
  kind: "package" | "requirement" | "user_confirmed_rule" | "source_check" | "observation" | "prior_result";
  ref: string;
}
