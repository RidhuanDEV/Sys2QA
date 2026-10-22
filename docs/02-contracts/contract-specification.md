# Sys2QA — Contract Specification

| Field | Value |
|---|---|
| Status | Baseline 1.0; schemas v1.0.0 authored (IMP-003); semantic validators pending (IMP-004) |
| Contract version | 1.0.0 (target) |
| Last updated | 2026-10-22 |
| Source of truth for | Field-level contract, enumerations, semantic rules (CR-xxx), error codes, versioning and governance procedure |
| Canonical machine form | `schemas/*.schema.json` (JSON Schema 2020-12, ADR-003); changelog in `schemas/CHANGELOG.md`; canonical examples in `fixtures/contract/valid/` |
| Product-level summary | PRD §13. On conflict, this document wins for fields; the PRD wins for product behavior; the conflict itself is a defect to fix in both |

The contract is everything that crosses a boundary between SAA, QAA, adapters, workers and interfaces, or leaves the system as an export. It is implemented **once**, in `packages/contract` (CON-027).

---

## 1. Conventions (apply to every schema)

| Topic | Rule |
|---|---|
| JSON | UTF-8, no BOM. Object keys `snake_case`. Unknown fields: rejected in `$defs` marked `closed`, otherwise allowed and preserved (minor-version tolerance, CON-008) |
| IDs | `<kind>:<local-id>` per PRD §13.4: `^[a-z][a-z0-9_]*:[^\s]{1,256}$`. Operational records (runs, approvals, jobs) use `<kind>:<ULID>` |
| Timestamps | RFC 3339, UTC, `Z` suffix, millisecond precision optional |
| Hashes | `sha256:<64 lowercase hex>` |
| Language tags | BCP 47 (`en`, `id`, `id-ID`); every natural-language field is an object `{ "language": "...", "value": "..." }` or carries a sibling `language` |
| Enumerations | Lowercase `snake_case` codes; never translated in data (LOC-006) |
| Paths | Repository-relative POSIX paths; never absolute; never containing `..` |
| URLs | Absolute, scope-normalized; query values of parameters on the redaction list replaced with `REDACTED` |
| Secrets | Never present. Only `secretref:<id>` references (SEC-004) |
| Versions | `schema_version` on every top-level document; semantic versioning |
| Validator configuration | Ajv 2020 with `strict: true`, `strictRequired: false` (because `required` inside `if`/`then` is idiomatic), `allowUnionTypes: true`, `allErrors: true`, plus `ajv-formats`. This configuration is part of the contract and lives only in `createContractAjv()` |

## 2. Schema catalog

| Schema file (`schemas/`) | Document | Producer | Consumer | PRD |
|---|---|---|---|---|
| `package-manifest.schema.json` | Package manifest | SAA, QAA | QAA | CON-002, CON-020 |
| `system-model.schema.json` | System model | SAA, QAA | QAA | CON-003, CON-005, CON-024 |
| `evidence-index.schema.json` | Evidence index | SAA, QAA | QAA | CON-004, CON-021 |
| `diff-report.schema.json` | Model diff | SAA, QAA | QAA | CON-014 |
| `correlation-report.schema.json` | Mode C correlation | QAA | QAA, exports | CON-026 |
| `analysis-request.schema.json` / `analysis-response.schema.json` | Follow-up | QAA / SAA | SAA / QAA | CON-015 |
| `completeness-report.schema.json` | Completeness report | SAA, QAA | QAA, UI | SAA-FR-045, QAA-FR-114 |
| `readiness-assessment.schema.json` | Readiness per activity | QAA | UI, exports | CON-022, CON-028 |
| `test-plan.schema.json` | Test plan | QAA | UI, exports | QAA-FR-030 |
| `scenario.schema.json` | Scenario version | QAA | Executor, manual runner, exports | QAA-FR-032, PRD §15.10 |
| `approval.schema.json` | Approval record | QAA | Executor | QAA-FR-052 |
| `manual-test-pack.schema.json` | Manual test pack + result template | QAA | Tester, re-import | QAA-FR-112 |
| `run-result.schema.json` | Manual and automated run results | QAA, test-runner | QAA, exports | QAA-FR-063, 083, 091 |
| `defect.schema.json` | Defect | QAA | Exports | QAA-FR-088 |
| `adapter-protocol.schema.json` | Adapter JSON-RPC messages | Host, adapters | Host, adapters | ADR-009, SAA-FR-047 |
| `error.schema.json` | Error object | All | All | OBS-003 |

`$id` convention: `https://sys2qa.dev/schemas/<name>/<major>.<minor>.json`. This is a stable identifier, not necessarily a resolvable URL; the domain is a placeholder until OD-10 package naming is finalized.

## 3. Documentation Package

### 3.1 Layout
As PRD §13.2. Validation order and error codes: PRD §13.10 and §8 here.

### 3.2 Manifest — fields

| Field | Type | Req | Rule |
|---|---|:-:|---|
| `contract` | const `sys2qa.documentation-package` | ✓ | |
| `package_schema_version` | semver | ✓ | |
| `package_id` | ID `pkg:` | ✓ | Stable across versions of the same project/producer |
| `package_version` | integer ≥ 1 | ✓ | Monotonic per `package_id` |
| `previous_package` | `{package_version, revision}` | if version > 1 | |
| `producer` | `{name: SAA\|QAA, version, component?, adapters[]?}` | ✓ | CR-020 |
| `project` | `{system_id, name}` | ✓ | |
| `evidence_profile` | object (§3.3) | ✓ | CR-021 |
| `repository` | object or `null` | ✓ | Non-null iff `source_analysis ≠ unavailable` |
| `observed_environments` | array | iff runtime available | |
| `analysis` | `{run_id, profile?, status, permission_level_max, optional_actions_executed[], started_at, finished_at, scope, limitations[]}` | ✓ | `status` ∈ analysis status enum |
| `generated_at` | timestamp | ✓ | |
| `languages` | `{documentation[], default, machine_text}` | ✓ | |
| `coverage_summary` | map category → coverage value | ✓ | CR-030 |
| `redaction` | `{secrets: redacted, excerpts, max_excerpt_chars}` | ✓ | |
| `artifacts` | array of artifact entries | ✓ | Each has `id`, `role`, `path`, `media_type`, `sha256`; JSON artifacts also `schema_version`; docs also `language` |

### 3.3 Evidence profile

| Field | Values |
|---|---|
| `source_analysis`, `runtime_observation`, `documentation_import` | `available`, `partial`, `unavailable` |
| `revision_correspondence` | `user_confirmed`, `observed`, `unconfirmed`, `not_applicable` |
| `cannot_establish` | array of machine-text strings (non-empty when any dimension is `unavailable` or `partial`) |

## 4. System model

### 4.1 Common entity fields

| Field | Req | Rule |
|---|:-:|---|
| `id`, `kind`, `name` | ✓ | `kind` ∈ entity-kind enum (§7) |
| `project_boundary` | ✓ for SAA; optional for QAA | |
| `status` | ✓ | Claim status enum; CR-001 |
| `evidence_ids` | ✓ | Non-empty unless `status` is `unresolved` (then `gap_ids` is non-empty) |
| `claim_ids`, `gap_ids`, `contradiction_ids` | | Must resolve (CR-010) |
| `description` | | Language-tagged |
| `confidence_rationale` | iff `inferred` | Non-empty string |
| `origin` | ✓ | `source` (SAA), `runtime` (QAA), `annotation` |

Kind-specific fields: as in PRD §13.5 (`route_pattern`, `constraints`, `label_literal`, `states`, `transitions`, …). These are finalized in the schema during IMP-003.

### 4.2 Relationships
`{id, type, from, to, status, evidence_ids}`. `type` ∈ relationship enum (§7). Allowed `(type, status, evidence types)` combinations: CR-002.

### 4.3 Component traces and workflows

| Record | Required fields |
|---|---|
| `component_trace` | `id`, `entry_point_id`, `relationship_ids[]`, `stopped_at[]` (each `{entity_id?, reason_code, gap_id}`), `status` |
| `workflow` | `id`, `name`, `category`, `origin`, `discovery_status`, `entry_point_ids[]`, `component_trace_ids[]`, `steps[]`, `branches[]`, `unresolved_hops[]`, `completion`, `deepened`, `status` |

`discovery_status` ∈ `reconstructed`, `partially_reconstructed`, `known_not_traceable`, `excluded`, `not_observed` (CON-024). Consistency rules: CR-040–CR-043.

`reason_code` for a stopped trace: `dynamic_registration`, `reflection_or_di_unresolved`, `external_service`, `missing_repository`, `unsupported_construct`, `config_unavailable`, `budget_exhausted`, `not_observable_at_runtime`, `submission_requires_approval`, `auth_required`, `out_of_scope`.

### 4.4 Claims, gaps, coverage
- Claim: `{id, text (lang-tagged), status, subject_entity_id, relationship_ids[], evidence_ids[], scope, caveats[], last_validated_revision, confidence_rationale?}`.
- Gap: `{id, type ∈ {contradiction, external_boundary, missing_evidence, unsupported, unobservable, ambiguity}, description, impact, evidence_ids[], requires_human_clarification, status}`.
- Coverage item: `{area, status ∈ {analyzed, partial, skipped, failed, unsupported, excluded}, reason}`.

## 5. Evidence

| Field | Req | Rule |
|---|:-:|---|
| `id`, `source_type`, `captured_at`, `extractor{adapter or component, version, method}` | ✓ | |
| `path`, `range{start_line,end_line,start_col?,end_col?}`, `file_fingerprint` | ✓ for source types | Path inside analyzed root; fingerprint matches revision |
| `subtype`, `environment_id`, `url`, `observed_at`, `credential_profile_role?`, `submission`, `screenshot_digest?` | ✓ for `runtime_observation` | `submission` ∈ `none`, `read_only`, `approved_test` (evidence captured during an approved test run; the only runtime evidence that may support `SUBMITS_TO` for a state-changing form, CR-002) |
| `excerpt` or `excerpt_digest`, `excerpt_policy` | ✓ | `excerpt` ≤ `max_excerpt_chars`; never contains secrets (CR-060) |

Source types: `source_code`, `configuration`, `schema`, `migration`, `manifest`, `test_definition`, `documentation`, `git_history`, `runtime_observation`, `test_result`, `human_annotation`, `requirement_document`.

## 6. QA documents

### 6.1 Scenario version (PRD §15.10 is the illustrative example)

| Field | Req | Rule |
|---|:-:|---|
| `scenario_id`, `version`, `display_key`, `content_language`, `title` | ✓ | `version` immutable once approved |
| `feature_ref`, `test_condition_ids[]` | ✓ | Refs resolve in the baseline package(s) or QAA store |
| `qa_objective` | ✓ | CR-050 |
| `test_techniques[]{id, rationale}` | ✓ | ≥ 1 |
| `priority`, `risk{impact, likelihood, exposure[], score, rationale}` | ✓ | `score` = `impact × likelihood` unless `score_override_reason` |
| `execution_modes[]`, `execution_classification`, `state_changing` | ✓ | CR-051 |
| `preconditions[]`, `test_data[]{name, value_ref, sensitivity}` | ✓ | `value_ref` ∈ `fixture:` or `secretref:` |
| `steps[]{step_id, instruction, automation?, expected_result?}` | ✓ | `automation.action` ∈ action enum; locators carry `literal_language` when text-based |
| `expected_result{description, assertions[], basis, saa_status?, oracle_class, trace{saa_ids[], evidence_ids[], requirement_ids[]}}` | where present | CR-052, CR-053 |
| `cleanup[]`, `assumptions[]`, `open_gaps[]` | ✓ | |
| `baseline{package refs[], revision or observation window, correlation_report_id?}` | ✓ | |
| `freshness`, `status`, `status_reason?` | ✓ | Lifecycle per PRD §18.1 |

### 6.2 Approval
`{approval_id, scenario_id, scenario_version, package_refs[], revision_ref, environment_id or declared_environment_id, scope_policy_version, test_data_profile, mode ∈ {manual, automated}, state_changing_ack?, approver, approved_at, state}`. Matching rule: CR-055.

### 6.3 Run results
- Run: `{run_id, kind ∈ {manual, automated}, scenario_versions[], approval_ids[], environment, state, started_at, finished_at, baseline}`.
- Case result: `{scenario_id, version, outcome, failure_category?, cleanup_outcome?, reported_by ∈ {tester, executor}}`.
- Step result: `{step_id, status, expected, actual, assertion_results[]{type, expected, actual, outcome, elapsed_ms}, evidence_refs[], notes?}`.
- Manual results always have `reported_by: tester` (QAA-FR-086).

### 6.4 Defect
`{defect_id, title, severity, priority, state, suspected_type ∈ {product_defect, test_defect, unknown}, links{scenario_id, version, run_id, step_id, evidence_refs[]}, baseline, environment}`. Transitions: PRD §15.12 (CR-070).

## 7. Enumerations (canonical list)

| Enumeration | Values |
|---|---|
| Analysis status | `completed`, `completed_with_limitations`, `partial`, `failed`, `cancelled` |
| Claim status | `source_verified`, `runtime_observed`, `test_verified`, `inferred`, `contradicted`, `unresolved`, `stale`, `human_asserted` |
| Expected-result basis | `requirement_backed`, `user_confirmed`, `saa_documented`, `source_supported`, `observed`, `inferred`, `unresolved` |
| Oracle class | `intended`, `implemented`, `observed`, `none` |
| QA objective | `characterization`, `implementation_conformance`, `requirement_conformance`, `exploratory` |
| Discovery status | `reconstructed`, `partially_reconstructed`, `known_not_traceable`, `excluded`, `not_observed` |
| Workflow completion | `complete_within_static_scope`, `partial`, `runtime_observed_for_run`, `unresolved` |
| Coverage value | `complete`, `partial`, `absent`, `not_applicable`, `unsupported`, `unobservable` |
| Readiness | `ready`, `ready_with_gaps`, `review_only`, `blocked` (per activity: `scenario_design`, `manual_preparation`, `automated_execution`) |
| Package freshness | `current`, `mismatched`, `stale`, `unverifiable` |
| Scenario status | `draft`, `needs_clarification`, `pending_review`, `approved`, `rejected`, `deferred`, `superseded` |
| Scenario freshness | `current`, `potentially_stale`, `stale` |
| Approval state | `active`, `suspended`, `invalidated`, `superseded`, `revoked` |
| Run state | `created`, `queued`, `running`, `paused`, `completed`, `failed`, `cancelled`, `blocked`, `abandoned` |
| Case outcome | `passed`, `failed`, `blocked`, `inconclusive`, `not_run`, `skipped` |
| Failure category | `assertion_failure`, `navigation_error`, `timeout`, `blocked_request`, `out_of_scope_blocked`, `unsupported_step`, `test_data_error`, `cleanup_failure`, `runner_failure`, `environment_unavailable`, `credential_failure` |
| Defect state | `new`, `triaged`, `confirmed`, `rejected`, `duplicate`, `needs_info`, `fixed`, `ready_for_retest`, `closed`, `reopened` |
| Severity / priority | `critical`, `major`, `minor`, `trivial` / `high`, `medium`, `low` |
| Entity kinds | `system`, `project`, `module`, `file`, `function`, `class`, `page`, `route`, `form`, `field`, `api`, `schema`, `table`, `column`, `orm_model`, `actor_role`, `permission`, `workflow`, `business_rule`, `state_machine`, `entity`, `integration`, `job`, `queue_topic`, `config_key`, `deployment_unit`, `secret_ref`, `test`, `requirement` |
| Relationship types | PRD §12.1 list (`CONTAINS` … `SATISFIES`) |
| Automation actions (MVP) | `navigate`, `click`, `fill`, `select`, `check`, `uncheck` |
| Workflow category | `user_interface`, `api`, `business_process`, `data_lifecycle`, `async_processing`, `scheduled_processing`, `integration`, `auth`, `error_recovery`, `cross_component` (PRD §11.6) |
| Coverage category | `modules`, `routes_pages`, `roles_permissions`, `business_rules`, `workflows`, `state_transitions`, `api_contracts`, `data_model`, `integrations`, `error_paths` |
| Artifact role | PRD §12.2 roles plus `system_model`, `evidence_index`, `diff_report`, `completeness_report`, `correlation_report`, `workflow_catalog`, `observed_behavior`, `asset` |
| Permission level | `L0`, `L1`, `L2`, `L2r`, `L3`, `L4` |
| Environment classification | `development`, `staging` (production is not representable, SEC-009) |
| Test technique | `equivalence_partitioning`, `boundary_value_analysis`, `decision_table`, `state_transition`, `use_case`, `negative`, `error_guessing`, `exploratory_charter`, `role_matrix` |
| Locator target kind | `route`, `label`, `role`, `text`, `test_id` (`label`, `role` and `text` require `literal_language`) |
| Assertion types (MVP) | `visible`, `hidden`, `text`, `value`, `url`, `enabled`, `disabled` |

## 8. Semantic rules (implemented only in `packages/contract`)

Each rule has a fixture that violates it and the error code it must produce.

| Rule | Statement | Error code |
|---|---|---|
| **CR-001** | A claim's or entity's `status` must be supported by its evidence types (matrix §8.1) | `PKG_CLAIM_EXCEEDS_EVIDENCE` |
| **CR-002** | Relationship types allowed by evidence type (§8.2); runtime-only evidence can never support data-flow or internal-call relationships | `PKG_CLAIM_EXCEEDS_EVIDENCE` |
| CR-010 | Every referenced ID resolves within the package, or (QAA) within the declared baseline set | `PKG_REFERENCE_BROKEN` |
| CR-011 | Every evidence record's revision or observation window matches the package's | `PKG_EVIDENCE_REVISION_MISMATCH` |
| CR-020 | `producer.name = SAA` ⇒ no `runtime_observation` evidence (except P1 L4 runs explicitly flagged); `QAA` ⇒ only `runtime_observation` evidence (plus annotations) | `PKG_EVIDENCE_PROFILE_INCONSISTENT` |
| CR-021 | `evidence_profile` agrees with the evidence present, with `repository` and with `observed_environments` | `PKG_EVIDENCE_PROFILE_INCONSISTENT` |
| CR-030 | Each coverage category valued `absent`, `unsupported` or `unobservable` has a gap record | `PKG_ARTIFACT_INVALID` |
| CR-040 | `reconstructed` ⇒ `unresolved_hops` empty and completion ≠ `unresolved` | `PKG_ARTIFACT_INVALID` |
| CR-041 | `partially_reconstructed` ⇒ ≥ 1 `unresolved_hops` entry with `reason_code` | `PKG_ARTIFACT_INVALID` |
| CR-042 | `known_not_traceable` ⇒ ≥ 1 evidence showing existence and no component trace | `PKG_ARTIFACT_INVALID` |
| CR-043 | No document may contain a system-wide workflow total; counts must be qualified "within examined scope" (field `count_scope` required) | `PKG_ARTIFACT_INVALID` |
| CR-050 | `qa_objective` is consistent with the bases of the scenario's expected results (PRD §15.9 table) | `SCN_OBJECTIVE_INCONSISTENT` |
| CR-051 | `automation_ready` ⇒ every step has a supported automation action, and no expected result has oracle `none` | `SCN_NOT_AUTOMATABLE` |
| CR-052 | `oracle_class` is derived from `basis` (PRD §15.9); it is never set independently | `SCN_ORACLE_INCONSISTENT` |
| CR-053 | `basis = saa_documented` ⇒ `saa_status` present and ∉ {`stale`, `contradicted`, `unresolved`} for `pending_review` | `SCN_BASIS_INVALID` |
| CR-054 | `pending_review` or `approved` ⇒ no expected result with basis `unresolved` | `SCN_BASIS_INVALID` |
| CR-055 | Execution allowed only if approval `active` and all binding fields equal the run baseline | `APPROVAL_MISMATCH` |
| CR-056 | `state_changing = true` ⇒ approval has `state_changing_ack` and the scenario has `cleanup` or `irreversible_ack` | `APPROVAL_REQUIRED` |
| CR-060 | No field matches the secret detectors; excerpts respect the max length | `PKG_SECRET_SUSPECTED` |
| CR-070 | Defect state transitions follow PRD §15.12 | `DEFECT_TRANSITION_INVALID` |

### 8.1 Claim status ⇐ evidence types (CR-001)

| Claim status | Requires at least one evidence of type | Additional condition |
|---|---|---|
| `source_verified` | `source_code`, `configuration`, `schema`, `migration`, `manifest` | Producer SAA; the evidence directly supports the narrow wording (reviewed in benchmarks) |
| `test_verified` | `test_result` | Records the test setup |
| `runtime_observed` | `runtime_observation` | Producer QAA (or SAA L4, P1) |
| `human_asserted` | `human_annotation` or `requirement_document` | Annotator recorded |
| `inferred` | any | `confidence_rationale` required |
| `contradicted` | ≥ 2 evidence of different origin | Linked `gap` of type `contradiction` |
| `unresolved` | none required | Linked `gap` |
| `stale` | any | `last_validated_revision` ≠ package revision |

`documentation`, `test_definition` and `git_history` evidence alone can support at most `inferred`.

### 8.2 Relationship types allowed from runtime-only evidence (CR-002)

| Allowed with `runtime_observed` | Never with `runtime_observed` |
|---|---|
| `CONTAINS` (page contains form/field), `NAVIGATES_TO`, `SUBMITS_TO` (only with `submission: read_only` or an approved test run's evidence), `EXPOSES` (a page or route is reachable) | `CALLS`, `READS_FROM`, `WRITES_TO`, `PUBLISHES`, `SUBSCRIBES_TO`, `TRIGGERS`, `SENDS_TO`, `CONFIGURED_BY`, `DEPLOYED_AS`, `DEPENDS_ON`, `USES_SCHEMA`, `AUTHENTICATES_WITH`, `AUTHORIZES_WITH`, `VALIDATES` |

Observed access outcomes per credential role are recorded as `runtime_observed` **claims about outcomes** ("role X received access-denied on page Y"), never as `AUTHORIZES_WITH` relationships.

## 9. Error codes

Package import codes: PRD §13.10, plus `PKG_CLAIM_EXCEEDS_EVIDENCE`. QA and execution codes:
- `SCN_OBJECTIVE_INCONSISTENT`, `SCN_NOT_AUTOMATABLE`, `SCN_ORACLE_INCONSISTENT`, `SCN_BASIS_INVALID`;
- `APPROVAL_REQUIRED`, `APPROVAL_MISMATCH`;
- `SCOPE_DENIED`, `PRODUCTION_REFUSED`, `SUBMISSION_REQUIRES_APPROVAL`;
- `DEFECT_TRANSITION_INVALID`;
- `JOB_CANCELLED`, `BUDGET_EXHAUSTED`, `CONTAINER_RUNTIME_MISSING`.

Error object: `{code, severity ∈ {error, warning, info}, message (lang-tagged), artifact_id?, json_pointer?, remediation (lang-tagged), details?}`.

## 10. Versioning and compatibility

- Each schema has its own semantic version. The **contract version** is the set released together, with a changelog in `schemas/CHANGELOG.md`.
- Consumers declare supported ranges per schema. Unsupported major → reject. Newer minor → accept and preserve unknown fields. Patch → no shape change.
- A package's `package_schema_version` is the contract version it was written with. Artifacts are never rewritten in place to a newer version; migration produces a new artifact.

## 11. Governance (OD-15)

A contract change requires all of the following in the same pull request:
1. a changelog entry and, for majors, an ADR;
2. the schema change;
3. at least one valid and one invalid fixture per changed rule;
4. a version bump per §10;
5. producer (SAA and QAA) and consumer conformance runs in CI;
6. migration or rejection behavior for existing artifacts;
7. this document updated in the same change.

Reviewers: one maintainer familiar with each affected producer or consumer.

## 12. Fixtures

`fixtures/contract/valid/` and `fixtures/contract/invalid/<error-code>/`. Each invalid fixture has a `expected.json` stating `{code, json_pointer}`. CI asserts that every error code in §9 and PRD §13.10 and every CR rule has at least one fixture (IMP-005).
