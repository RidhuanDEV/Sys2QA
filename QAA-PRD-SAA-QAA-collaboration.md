# QAA: AI-Assisted Quality Assurance Platform

**Product Requirements Document (PRD)**

| Field | Value |
|---|---|
| Product | QAA (working name: Quality Assurance Agent) |
| Document status | Draft for product and engineering review; SAA integration defined |
| Version | 0.2 |
| Last updated | 2026-10-21 |
| Product model | Open-source, self-hostable web application |
| Primary audience | Developers, QA engineers, testers, small engineering teams, and open-source maintainers |
| Initial target | Web applications with a Git repository and a reachable development or staging environment |
| License | To be selected before the first public release; see Open-Source Strategy |

---

## 1. Executive Summary

QAA is an open-source, AI-assisted quality assurance platform designed to operate downstream of SAA (System Analysis Agent). SAA analyzes a software system and produces its system documentation and structured system model. QAA consumes that versioned documentation package as its primary test basis, checks important claims against the authorized live application and, where configured, the corresponding repository revision, then designs QA scenarios, waits for human review, and supports both automated and manual testing.

The intended product pipeline is **Repository and system analysis with SAA → versioned system documentation package → QAA test analysis and design → human scenario approval → automated and/or manual execution → evidence-backed QA report**. The handoff between SAA and QAA is a defined contract, not an implicit assumption that one agent can read the other's chat history.

In the QAA workflow, a user imports or selects the SAA-generated documentation package, supplies the development or staging URL, configures authentication where needed, and optionally connects the same repository with read-only access for targeted verification. QAA does not repeat SAA's full system-documentation task by default. It identifies missing, stale, conflicting, or insufficient documentation and performs focused verification needed to design safe and meaningful tests.

QAA supports two distinct execution modes:

1. **Automated software testing:** approved scenarios are translated into validated, deterministic browser tests and executed by a controlled automation worker.
2. **Manual testing:** a human tester follows the approved scenario step by step in the target application, records actual results, attaches evidence, and marks each step or case with a result.

Both modes share the same scenario model and traceability model, so the team can compare outcomes and progressively automate stable, repeatable manual tests.

Users can choose the natural language used for generated test plans, scenarios, test instructions, findings, and reports. The language used for generated documentation is separate from the application's UI language, the source-code language, and the programming language used by the automation runner.

QAA is not intended to replace QA knowledge, human judgment, or product requirements. Its purpose is to make proven testing practices easier to apply, reduce repetitive test design and documentation work, help users discover gaps, and make test execution and evidence more consistent.

### 1.1 Relationship to SAA (System Analysis Agent)

SAA and QAA are complementary stages in one workflow, with distinct responsibilities:

- **SAA owns system understanding and documentation:** inspect the system and its source repository, map architecture and dependencies, identify modules, routes, user journeys, roles, data flows, business rules, states, integrations, and known uncertainties, then publish versioned human-readable documentation plus machine-readable artifacts.
- **QAA owns quality analysis and testing:** consume SAA's outputs, assess testability and risk, identify missing or contradictory test basis, correlate documentation with observed runtime behavior and optional repository evidence, generate scenarios using QA techniques, obtain human approval, support manual and automated execution, and report outcomes.
- **The shared contract owns interoperability:** artifact schema, project identity, repository revision, provenance, documentation IDs, evidence references, timestamps, analyzer versions, and compatibility rules.

SAA documentation is the default starting point for QAA, but it is not automatically treated as unquestionable truth. SAA output may contain inferred or stale information. QAA must preserve provenance and certainty labels, validate relevant flows against the selected application environment, and surface discrepancies for human resolution. If the documentation package is missing, incompatible, or materially out of date, QAA must not silently proceed as though the system model were current.

For the first MVP, use an **artifact-first integration**: SAA exports a versioned bundle that a user can import into QAA. A direct API or shared workspace integration can follow later without changing the canonical artifact contract.

## 2. Product Vision

**Vision:** Make disciplined software testing accessible to teams that have a working application but limited time or specialist QA capacity, without hiding uncertainty or removing human control.

**Product promise:** Give QAA a repository and an authorized development URL. QAA will explain what it believes should be tested, show why each scenario was proposed, let a person review the test plan, and then support automated execution or guided manual testing.

### 2.1 Product principles

1. **QA methodology before agent complexity.** The product workflow must follow sound test planning, test analysis, test design, implementation, execution, and completion practices. AI is used to assist those activities, not replace them with free-form clicking.
2. **Evidence before confidence.** Every meaningful expected result should reference a requirement, user-approved rule, existing test, source-code finding, observed behavior, or explicitly labeled inference.
3. **Human approval before execution.** Generated scenarios do not run until the user approves the exact test version for a specific environment and scope.
4. **Automation and manual testing are first-class modes.** Manual testing is a guided workflow for a human tester, not an AI-controlled browser run mislabeled as manual testing.
5. **Deterministic execution.** The AI proposes and interprets; a constrained executor performs only supported, validated actions and assertions.
6. **Traceability.** Users can follow the chain from source evidence or requirement to scenario, approval, execution, result, and bug report.
7. **Transparent uncertainty.** QAA must distinguish confirmed outcomes, failed assertions, blocked tests, inconclusive results, and unverified hypotheses.
8. **Safe by default.** Arbitrary URLs and repositories are untrusted. Execution must be scoped, isolated, auditable, and explicitly authorized.
9. **Open and portable.** The core product should be self-hostable, provider-neutral where practical, and documented so users can inspect how testing decisions are made.
10. **Language-inclusive.** Users should be able to read and review testing artefacts in a selected natural language without translating source identifiers or altering code semantics.

## 3. Problem Statement

Teams often have a development website and a source repository but lack a reliable, up-to-date test suite. Creating that suite requires understanding the application, finding the key user journeys, identifying valid and invalid inputs, defining expected outcomes, preparing test data, implementing automation, running tests, and documenting defects.

Common pain points include:

- Test scenarios are written manually and may omit negative, boundary, permissions, state-transition, or regression cases.
- Browser automation requires technical knowledge of selectors, synchronization, fixtures, assertions, and maintenance.
- Manual testers may receive incomplete scenarios or record results inconsistently.
- A repository describes part of the intended implementation, while the running application reveals actual behavior. These sources can disagree.
- Tests can become flaky or provide weak evidence when the target environment, test data, or expected result is unclear.
- Generated AI tests may look plausible while relying on invented expected behavior.
- Teams using different natural languages need readable and consistent test scenarios and reports.
- Existing tools can help record actions or run scripted tests, but QAA's proposed value is to connect repository-aware discovery, QA test design, review, both manual and automated execution, and traceable evidence in one workflow.

## 4. Goals and Non-Goals

### 4.1 Product goals

- **G1:** Let a user create a project from a Git repository and a reachable, authorized web application URL.
- **G2:** Build a useful, evidence-backed inventory of in-scope routes, pages, forms, user journeys, validation rules, and existing tests.
- **G3:** Generate QA scenarios using explicit test-design techniques and risk-based prioritization.
- **G4:** Let users inspect, edit, approve, reject, defer, and categorize every proposed scenario before execution.
- **G5:** Execute approved scenarios through a constrained automated browser runner.
- **G6:** Support guided manual testing from the same approved scenarios, including recording actual results, notes, screenshots, and defects.
- **G7:** Produce consistent reports and exportable test artefacts in the user's selected output language.
- **G8:** Provide reproducibility through repository commit references, scenario versions, environment snapshots, execution history, and retained evidence.
- **G9:** Make the platform self-hostable and suitable for public open-source contribution.
- **G10:** Protect repository contents, login credentials, browser sessions, application data, and generated artefacts.
- **G11:** Consume SAA's versioned system documentation package as the primary test basis and preserve links from scenarios back to documentation sections and supporting evidence.
- **G12:** Detect stale, incomplete, incompatible, or conflicting SAA documentation before test generation and communicate the consequences clearly.

### 4.2 Non-goals for MVP

- Fully autonomous production testing.
- Unreviewed execution of generated scenarios.
- Automatic source-code edits, fixes, commits, pull requests, or deployments.
- Arbitrary execution of shell commands or AI-generated scripts.
- Guaranteeing that all generated expected results are correct without an authoritative requirement or human confirmation.
- Replacing professional QA review, acceptance testing, exploratory judgment, or a formal test strategy for regulated systems.
- Full load, stress, endurance, penetration, fuzz, mobile-native, desktop-native, or hardware testing.
- Automatic support for every identity provider, CAPTCHA, MFA, browser, framework, or frontend architecture at launch.
- A proprietary hosted service being mandatory to use the open-source core.
- Sending a user's entire repository or credentials to an external model provider by default.
- Replacing SAA's full system-analysis and documentation-generation responsibilities inside QAA in the MVP.
- Treating unversioned Markdown alone as a reliable integration contract when structured metadata is available.

## 5. Target Users and Personas

### 5.1 QA engineer

**Needs:** Use test techniques consistently, prioritize risk, review expected results, organize regression suites, and present evidence to developers.

**Success looks like:** QAA accelerates test analysis and documentation without reducing control over what is tested or how outcomes are classified.

### 5.2 Manual tester

**Needs:** Clear preconditions, steps, test data, expected results, fields for actual results, evidence attachment, and easy defect reporting.

**Success looks like:** A tester can execute a generated scenario without having to interpret vague instructions or write code.

### 5.3 Developer

**Needs:** Find important regressions, understand failures, inspect reproducible evidence, and convert stable cases into automated regression tests.

**Success looks like:** Reports link a failure to a precise route, test step, assertion, commit, and relevant source evidence.

### 5.4 Team lead or product owner

**Needs:** Understand coverage, severity, risk, approval state, blockers, and release readiness without reading raw logs.

**Success looks like:** A clear report distinguishes actual defects from environment failures, uncertain expectations, and incomplete testing.

### 5.5 Self-hosting maintainer

**Needs:** Deploy the platform, choose an LLM provider or local model, configure secrets and storage, and audit worker behavior.

**Success looks like:** The platform works without mandatory external SaaS dependencies beyond services the operator deliberately configures.

## 6. Core QA Methodology

This section is normative for product behavior. QAA must represent and encourage the following practices rather than merely generate browser actions.

### 6.1 Testing lifecycle

QAA should model a practical test process:

1. **Test planning:** establish objectives, scope, risks, environment, resources, constraints, and exit criteria.
2. **Test monitoring and control:** track discovery coverage, scenario quality, approvals, progress, blockers, and deviations.
3. **Test analysis:** identify testable features and test conditions from requirements, existing documentation, user-confirmed rules, repository evidence, and observed application behavior.
4. **Test design:** derive test cases and test data using suitable test-design techniques.
5. **Test implementation:** organize approved test cases into manual suites or executable automation definitions, with shared fixtures and prerequisites.
6. **Test execution:** carry out the approved steps and record actual results and evidence.
7. **Test completion:** summarize coverage, outcomes, residual risk, unresolved questions, defects, and recommended follow-up.

These stages may be iterative. A discovered contradiction or blocked scenario can send the workflow back to analysis or design.

### 6.2 Evidence and test basis

The **test basis** is the material used to analyze and design tests. In the SAA-first workflow, the imported SAA documentation package is the primary system model. QAA may supplement it with:

- Product requirements, acceptance criteria, user stories, or supplied test specifications.
- SAA-generated architecture, module, route, user-flow, role/permission, data-flow, state-transition, business-rule, integration, API, and error-flow documentation.
- Source code, existing tests, API definitions, and repository metadata from the matching commit, when read-only repository access is configured.
- Observed user interface behavior and network responses within the permitted scope.
- User-confirmed rules, clarification decisions, previous execution results, and regression history.

Every fact should retain its provenance: source package, documentation asset/section ID, repository and commit, file/line reference where available, runtime observation, generation or observation timestamp, certainty label, and analyzer version. SAA documentation is a structured and traceable test basis, not unquestionable truth. QAA must not silently treat implementation as the correct business requirement. When SAA documentation, source code, user-provided requirements, and runtime behavior conflict, the discrepancy must be shown to the user and the expected behavior may require clarification.

### 6.3 Test-design techniques

QAA should apply techniques intentionally and record which technique motivated a scenario. MVP techniques:

- **Equivalence partitioning:** group inputs expected to behave similarly, such as valid and invalid identifier formats.
- **Boundary value analysis:** test values at, immediately below, and immediately above meaningful limits.
- **Decision-table testing:** cover combinations of conditions and resulting actions where business rules depend on multiple inputs.
- **State-transition testing:** check valid and invalid transitions, such as draft, submitted, approved, rejected, or cancelled.
- **Use-case and user-journey testing:** verify meaningful workflows from start to finish.
- **Negative testing:** provide missing, malformed, unauthorized, conflicting, or otherwise invalid input.
- **Error guessing:** propose likely failure cases from application context, labeled as heuristic suggestions.
- **Exploratory testing charters:** define a goal, boundaries, and observations for a human tester to explore behavior that is difficult to predict in advance.

QAA must not mechanically generate every technique for every feature. It should explain why a technique is relevant and prioritize useful, non-duplicative cases.

### 6.4 Risk-based prioritization

Each test case receives a transparent priority and risk assessment. Use a documented model, for example:

- **Impact:** consequence if the behavior fails, from 1 to 5.
- **Likelihood:** estimated likelihood of failure or change-related risk, from 1 to 5.
- **Exposure:** whether the feature is high traffic, security-sensitive, permission-sensitive, data-critical, or central to a primary workflow.

A simple initial score may be `impact × likelihood`, with exposure used as a documented modifier or tie-breaker. This is a prioritization aid, not a statistically valid probability or a guarantee of release risk. Display the score inputs and rationale so a user can change them.

High-priority candidates include authentication and authorization boundaries, important data writes, payment-like operations if present, core business workflows, data integrity, and recently changed code. QAA must not infer that a domain has payments or sensitive workflows unless evidence supports it.

### 6.5 Test-case quality checklist

A test case should be reviewed against:

- Clear title and purpose.
- In-scope feature and risk.
- Preconditions and required test data.
- Concrete, ordered steps.
- Explicit expected result for each important decision point.
- Test-design technique and rationale.
- Supporting evidence or a clearly marked assumption.
- A cleanup requirement if data is created or changed.
- Repeatability and suitability for manual, automated, or either execution mode.
- No unnecessary duplication with existing approved tests.

Cases with ambiguous expected behavior should be marked **Needs clarification**, not presented as ready to execute.

### 6.6 Verification versus validation

QAA may check whether observed behavior matches a specification or an approved expected result, and it may help stakeholders assess whether the application's behavior meets their needs. These are related but distinct questions. A test passing against a generated assumption does not establish that the application meets business needs. Reports must preserve this distinction.

### 6.7 Test levels and types

**MVP focus:** web UI functional testing and end-to-end user-journey testing, including validation, navigation, permissions that can be safely checked, and core workflow regression.

**Architecture should allow later extensions:** API/contract tests, component tests, accessibility checks, visual regression, performance testing, and specialized security testing. These are out of scope for the first MVP unless explicitly implemented as separate, labeled modules. QAA must not describe a basic browser crawl as a comprehensive security or performance assessment.

## 7. Product Modes

### 7.1 Scenario generation mode

QAA consumes the SAA system model, validates relevant claims against the configured target, and generates candidate scenarios. It does not execute the candidates. It presents documentation readiness, an inventory mapped from SAA, the QA plan, coverage gaps, unresolved conflicts, and the scenario review interface.

### 7.2 Automated software testing mode

After user approval, QAA maps a structured scenario into a constrained set of supported automation actions and assertions. The runner executes the same approved version and records the actual browser behavior.

Requirements:

- Prefer resilient locators based on accessible role, label, text, and stable test IDs where available.
- Prefer explicit assertions over assumptions such as "the click succeeded".
- Use reliable wait conditions and bounded timeouts rather than arbitrary sleeps.
- Record browser logs and relevant network errors while protecting secrets and personal data.
- Produce a trace or equivalent replayable evidence for supported runs.
- Distinguish assertion failure from navigation failure, timeout, infrastructure problem, unsupported action, or environment unavailability.
- Use deterministic, approved test data and clean up created data where possible.
- Do not automatically retry a potentially destructive action unless the action is known to be idempotent or the test has a safe recovery strategy.

The initial browser automation engine should use Playwright. It is a replaceable execution adapter, not the owner of the QA methodology.

### 7.3 Manual testing mode

Manual testing is performed by a person who follows the generated scenario in the real application. QAA acts as a test-management and evidence-capture interface.

A manual test screen must show:

- Scenario purpose and risk.
- Preconditions and test data.
- Current step and expected result.
- Instructions and any useful source or UI evidence.
- Controls to mark a step **Pass**, **Fail**, **Blocked**, or **Not applicable** where allowed.
- Fields for actual result, notes, screenshot/file evidence, and defect reference.
- Controls to pause, resume, abandon, or submit the completed test.

The application should not assume it can observe all manual interactions. A tester's recorded result is an attestation and should be labeled as tester-reported unless independently verified. A manual case is not complete until required outcomes and evidence fields are recorded or an explicit reason for omission is provided.

Manual testing must support:

- A single tester completing a suite.
- Reopening a partially completed run.
- Recording a defect and linking it to the failed step.
- Exporting test scenarios and results for review.
- Reusing the scenario as a candidate for automation after the manual run.

### 7.4 Shared scenario model

Manual and automated execution must refer to the same scenario identity and version, while allowing mode-specific implementation metadata. This avoids creating separate, inconsistent test definitions for the same intended behavior.

A scenario can be:

- `manual_only`: it requires human judgment or an action not supported by the runner.
- `automation_candidate`: its actions appear automatable but need user confirmation or further locator/test-data work.
- `automation_ready`: all required actions and assertions are supported, scoped, and approved for automation.
- `both`: suitable for both modes.

QAA should explain the classification and let users override it with an audit event.

## 8. Natural-Language Output and Localization

Language selection is a first-class requirement, not a prompt suffix that is applied inconsistently.

### 8.1 Separate language settings

QAA must distinguish:

1. **Application UI language:** language of QAA's own interface.
2. **Generated artefact language:** language of test plans, scenario descriptions, manual instructions, expected results, defect descriptions, and reports.
3. **Target application language:** language currently shown by the application under test.
4. **Automation programming language:** programming language used by exported executable tests. TypeScript is the proposed first supported code language.
5. **Source language:** language already used by repository identifiers, source code, API fields, database values, and technical logs.

Changing the generated artefact language must not translate source file paths, route paths, API names, selectors, code snippets, exception messages, database field names, or identifiers unless they are clearly labeled as a human-readable explanation. Preserve the original value and optionally show a translated explanation alongside it.

### 8.2 MVP language support

- Initial UI locales: English and Indonesian (`en`, `id`).
- Generated artefact language: at minimum English and Indonesian.
- Architecture must allow more locales without changing the scenario schema.
- Default language may be inherited from user preferences, then project settings, with a clear override per analysis or export.
- Every generated artefact stores its language code and generation version.
- Changing the language should create a translated presentation/version without changing the semantic test steps or approval status of the underlying scenario. If translation changes test semantics or technical action data, approval must be renewed.

### 8.3 Language output acceptance rules

- The user can choose the output language when creating a project and change it before generating or exporting results.
- All generated natural-language fields use the selected language consistently.
- Standard technical tokens and identifiers remain unchanged.
- The output preserves severity, status, negation, numeric boundary values, expected-result meaning, and security warnings during translation.
- Human-authored text may be preserved in its original language, with an optional translation.
- Reports record the language in which they were generated.
- Test steps and assertions must use machine-stable targets independent of their display language wherever possible.
- The product must label machine translations and allow the user to edit them.

## 9. Primary User Journeys

### 9.0 SAA-to-QAA handoff

1. A user runs SAA against an authorized repository and completes the system-analysis/documentation process.
2. SAA publishes an exportable documentation package containing human-readable documentation and structured artifacts, each tied to a repository identity and immutable commit SHA.
3. The user imports or selects this package in QAA. QAA validates the manifest, schema version, artifact completeness, provenance, and commit identity.
4. The user configures the target development/staging URL, allowed scope, authentication profile, browser settings, and output language.
5. QAA compares the package's analyzed revision with the configured target/repository baseline. It reports mismatch, staleness, missing flow definitions, or unresolved SAA findings before generating tests.
6. QAA performs targeted runtime verification of relevant flows and source references where available. It does not silently regenerate all system documentation.
7. QAA maps documentation entities and flows to test conditions, applies QA test-design techniques, and generates manual/automation-ready scenarios with traceable references to the SAA package.

### 9.1 Create a project

1. User selects **New Project** and imports/selects a valid SAA documentation package.
2. User enters project name, target base URL, environment label, and output language.
3. User confirms the repository identity and analyzed commit recorded in the SAA package. A read-only repository connection may be configured for focused source verification and change analysis.
4. User configures an authentication profile or selects no authentication.
5. User defines allowed hostnames and optional URL path scope.
6. QAA validates the SAA package, configuration, and access without running destructive operations.
7. QAA shows documentation readiness, unresolved analysis issues, and target/revision mismatches. The project enters `Ready for test analysis` only when required prerequisites are satisfied.

### 9.2 Discover and generate test scenarios

1. User starts test analysis using the selected SAA documentation package.
2. QAA validates package schema and completeness, checks repository/commit identity, and loads its documentation index.
3. QAA explores only permitted browser paths relevant to documented features and flows.
4. Where repository access is configured, QAA performs targeted source verification rather than repeating SAA's full documentation analysis.
5. QAA compares documented flows and expected behavior with runtime observations, identifying gaps, conflicts, stale sections, and unsupported areas.
6. QAA proposes a QA test plan with scope, coverage, risk, assumptions, unresolved questions, and estimated workload.
7. QAA creates candidate scenarios linked to SAA document IDs and supporting evidence, then validates them against the scenario schema and quality checklist.
8. User reviews scenarios in the selected output language.

### 9.3 Review and approve tests

1. User filters scenarios by feature, risk, execution mode, evidence confidence, and status.
2. User inspects the test steps, expected results, rationale, source evidence, and browser observations.
3. User edits, rejects, defers, requests regeneration, or approves one or more scenarios.
4. QAA validates approval prerequisites and creates an immutable approved version.
5. Approval is bound to repository revision, target environment, scope, scenario version, and applicable test-data profile.

### 9.4 Run automated tests

1. User chooses an approved suite and target environment.
2. QAA revalidates URL policy, environment status, approved test versions, and safety requirements.
3. The queue schedules isolated browser jobs under configured concurrency and time limits.
4. The runner executes only allowed action types and records assertions and evidence.
5. QAA classifies each case and run, stores evidence, and generates a localized report.
6. User reviews failed, blocked, and inconclusive outcomes, then may create a defect or revise the test with a new approval cycle.

### 9.5 Run manual tests

1. User selects an approved manual scenario or suite.
2. QAA creates a manual execution run assigned to a tester.
3. The tester follows each step and records the actual result.
4. The tester attaches evidence and creates a linked defect where appropriate.
5. QAA validates required fields and summarizes outcomes.
6. The scenario remains available for future manual regression or assessment for automation.

### 9.6 Review and export results

1. User filters a run by status, priority, feature, or execution mode.
2. User opens an individual result to inspect expected and actual behavior, assertion, evidence, environment, commit SHA, and timestamps.
3. User exports a human-readable report and machine-readable scenario/result data.
4. User can compare runs, while QAA clearly flags changes in commit, environment, test definition, and configuration.

## 10. Functional Requirements

Priority definitions: **P0** means required for the first usable MVP; **P1** means important but can follow the first vertical slice; **P2** means later enhancement.

### 10.1 Project and environment management

- **FR-001 (P0):** Users can create, edit, archive, and delete projects according to access permissions.
- **FR-002 (P0):** A project can record a web application base URL, environment label, allowed hostnames, and optional path scope.
- **FR-003 (P0):** A project can connect to a Git repository and select a branch or immutable commit reference.
- **FR-004 (P0):** Analysis records the exact commit SHA used and never silently follows a moving branch during an active run.
- **FR-005 (P0):** Users can configure a supported login profile without exposing its secret values in ordinary project views, prompts, logs, or reports.
- **FR-006 (P0):** Project setup validates reachability and permissions without running business-changing actions.
- **FR-007 (P1):** Users can define multiple environment profiles with distinct hosts and credential references.
- **FR-008 (P1):** The project records browser, viewport, locale, timezone, and relevant environment settings used for a run.
- **FR-009 (P0):** QAA can import an SAA documentation package from a versioned archive or supported directory and validates its manifest, schemas, required assets, provenance, and checksums where supplied.

### 10.2 SAA documentation ingestion and targeted source verification

- **FR-010 (P0):** QAA uses the selected SAA documentation package as the primary system model and test basis. Full system-documentation regeneration is not a default QAA responsibility.
- **FR-011 (P0):** QAA reads both human-readable documentation and machine-readable artifacts when included; structured data is used for mapping and validation, while Markdown/HTML documentation is used for human review.
- **FR-012 (P0):** QAA preserves the SAA package version, schema version, analyzer version, repository identity, commit SHA, generation timestamp, artifact IDs, and evidence provenance.
- **FR-013 (P0):** QAA validates required coverage and flags missing or malformed documentation for routes, features, workflows, roles/permissions, data rules, state transitions, integrations, and known uncertainties when those categories are applicable to the system.
- **FR-014 (P0):** QAA compares the package's repository commit with the configured repository/target baseline and marks the package as current, mismatched, stale, or unverifiable according to explicit rules.
- **FR-015 (P0):** QAA can link a scenario back to one or more SAA documentation asset/section IDs and, when available, original source file/line references.
- **FR-016 (P0):** QAA reports contradictions between SAA documentation, supplied requirements, targeted source checks, and live observations instead of silently choosing one source as authoritative.
- **FR-017 (P0):** Repository access, when configured, is read-only and used for targeted verification, source links, existing-test discovery, or change-impact analysis. Repository scripts are not executed during this process.
- **FR-018 (P0):** QAA marks documentation gaps, unsupported artifact versions, unresolved SAA findings, low-confidence claims, and inaccessible references, and can prevent test generation when the missing information is material.
- **FR-019 (P1):** QAA can integrate with SAA through an API/shared workspace and receive change notifications while retaining the same artifact contract.
- **FR-020 (P1):** QAA compares repository changes and new SAA package versions between runs, then suggests impacted scenarios for review.

### 10.3 Browser discovery

- **FR-021 (P0):** QAA explores only within explicitly approved host and path scope.
- **FR-022 (P0):** QAA inventories accessible pages, navigation links, forms, labels, controls, modals, and visible validation behavior.
- **FR-023 (P0):** QAA supports a basic username/password login flow where credentials are supplied through a protected secret reference.
- **FR-024 (P0):** QAA records route and control observations with source, timestamp, and confidence metadata.
- **FR-025 (P0):** QAA does not submit suspected destructive forms during discovery.
- **FR-026 (P0):** QAA handles a detected unsupported login flow by stopping and asking for user configuration instead of bypassing controls.
- **FR-027 (P1):** QAA supports additional authentication methods such as SSO or MFA through documented, user-assisted mechanisms.
- **FR-028 (P1):** Users can adjust exploration scope and exclude specific routes or data areas.

### 10.4 Test planning and generation

- **FR-030 (P0):** QAA creates a test plan containing objectives, scope, exclusions, risks, available evidence, assumptions, and suggested coverage.
- **FR-031 (P0):** QAA generates scenarios using relevant, identifiable test-design techniques.
- **FR-032 (P0):** Generated scenarios include preconditions, test data, steps, expected results, cleanup needs, priority, rationale, execution-mode suitability, and evidence references.
- **FR-033 (P0):** Each expected result is labeled as requirement-backed, user-confirmed, SAA-documentation-backed, source-supported, observed, inferred, or unresolved.
- **FR-033a (P0):** Each scenario links to relevant SAA documentation IDs/sections and preserves the provenance and version of the package used during generation.
- **FR-034 (P0):** QAA flags missing or ambiguous expected behavior as `needs_clarification`.
- **FR-035 (P0):** QAA applies duplicate detection and proposes a reason when two cases appear redundant.
- **FR-036 (P0):** QAA does not represent generated assumptions as authoritative requirements.
- **FR-037 (P0):** Users can choose the natural language for generated artefacts.
- **FR-038 (P0):** QAA explains its risk priority with transparent inputs or a human-readable rationale.
- **FR-039 (P1):** Users can provide acceptance criteria, business rules, feature descriptions, or existing test documents as additional test basis.
- **FR-040 (P1):** QAA can generate exploratory testing charters for areas needing human judgment.

### 10.5 Scenario review and approval

- **FR-050 (P0):** Users can view, search, filter, sort, edit, approve, reject, defer, and request regeneration for scenarios.
- **FR-051 (P0):** Users can approve cases individually or in bulk after seeing the exact versions selected.
- **FR-052 (P0):** Every approval creates an audit event and refers to the exact scenario version, commit SHA, environment, and test scope.
- **FR-053 (P0):** Edits to an approved scenario create a new version and invalidate approval for the edited version.
- **FR-054 (P0):** The executor rejects unapproved, stale, malformed, or out-of-scope definitions.
- **FR-055 (P0):** Users can classify a scenario as manual-only, automation-candidate, automation-ready, or suitable for both modes.
- **FR-056 (P1):** Users can comment on scenario decisions and resolve clarification requests.

### 10.6 Automated execution

- **FR-060 (P0):** QAA executes supported approved actions through Playwright in an isolated worker.
- **FR-061 (P0):** The executor accepts a constrained schema of action and assertion types, not arbitrary LLM-generated executable code.
- **FR-062 (P0):** Supported actions include navigation within scope, click, fill, selection, checkbox/radio interaction, and safe assertions for visibility, text, value, URL, and enabled/disabled state.
- **FR-063 (P0):** Each assertion records expected condition, actual observation, outcome, and elapsed time where available.
- **FR-064 (P0):** QAA stores screenshots and browser traces for relevant results according to retention settings.
- **FR-065 (P0):** QAA classifies assertion failures separately from timeouts, navigation errors, blocked requests, runner failures, and unsupported steps.
- **FR-066 (P0):** QAA applies configurable timeouts, concurrency limits, cancellation, resource limits, and cleanup.
- **FR-067 (P0):** Retries are bounded and never automatically repeat a non-idempotent action without an explicit safe strategy.
- **FR-068 (P0):** The runner masks credentials and sensitive tokens in logs and reports.
- **FR-069 (P1):** Users can export selected automated tests as source code in the initially supported automation language.
- **FR-070 (P1):** The system can recommend automation candidates from previously completed manual test results.

### 10.7 Manual execution

- **FR-080 (P0):** Users can start a manual run from an approved scenario or suite.
- **FR-081 (P0):** The interface presents preconditions, data, steps, expected results, and evidence links in the selected language.
- **FR-082 (P0):** Testers can mark each step as pass, fail, blocked, or not applicable according to scenario rules.
- **FR-083 (P0):** Testers can record actual results, notes, and screenshots or other permitted evidence.
- **FR-084 (P0):** Testers can create a defect record linked to the scenario, run, and failed step.
- **FR-085 (P0):** Manual runs can be paused and resumed while preserving progress.
- **FR-086 (P0):** QAA labels manually reported results as tester-reported and does not imply independent verification.
- **FR-087 (P1):** Teams can assign runs to named testers and filter results by assignee.

### 10.8 Reporting and export

- **FR-090 (P0):** QAA provides a project summary with counts for proposed, approved, executed, passed, failed, blocked, and inconclusive cases.
- **FR-091 (P0):** Each result links to the exact test version, target environment, repository commit, evidence, and run timestamps.
- **FR-092 (P0):** Reports include limitations, unresolved assumptions, coverage gaps, and any unsupported operations.
- **FR-093 (P0):** Users can export scenario and result data in JSON and Markdown.
- **FR-094 (P1):** Users can export a human-readable HTML report and CSV summary.
- **FR-095 (P1):** Users can compare runs and identify changes to environment, commit, scenario version, or outcome.
- **FR-096 (P1):** Report language can be selected independently of the QAA interface language.

### 10.9 Administration and observability

- **FR-100 (P0):** Administrators can configure model provider, model identifier, timeouts, concurrency limits, secret storage, artifact retention, and worker settings.
- **FR-101 (P0):** The system logs job state transitions, approval actions, credential use events, execution policy decisions, and artifact access without logging secrets.
- **FR-102 (P0):** Jobs can be cancelled and stuck jobs identified.
- **FR-103 (P0):** The system provides health checks and basic metrics for queue length, job duration, worker failure, and resource usage.
- **FR-104 (P1):** The system supports provider adapters for multiple hosted or locally served LLMs.

## 11. User Interface Requirements

### 11.1 Core screens

1. **Projects dashboard:** recent projects, discovery status, last test run, failures, blockers, and quick links.
2. **Project setup wizard:** URL, repository, commit/branch, authentication, scope, output language, and safety confirmation.
3. **Discovery overview:** route map, detected features, forms, evidence, exclusions, and uncertainty.
4. **Test plan:** objectives, in-scope areas, priority model, coverage summary, assumptions, and exclusions.
5. **Scenario review:** editable scenario list, step preview, evidence panel, language selector, risk filters, and approval controls.
6. **Manual runner:** one-step-at-a-time instructions, expected result, actual result, status control, notes, and attachment upload.
7. **Automated run monitor:** queue state, current case, elapsed time, safe cancellation, and execution events.
8. **Results and evidence:** status filters, expected-versus-actual comparison, screenshots, traces, logs, related source evidence, and defect details.
9. **Settings:** provider configuration, languages, secret management, access control, retention, and worker policies.

### 11.2 UX rules

- Make project state and the next safe action clear.
- Display scope and target environment prominently before approval or execution.
- Show meaningful progress stages, not only a generic spinner.
- Separate source evidence, browser observations, and AI inferences visually.
- Never use color alone to communicate status.
- Provide accessible keyboard navigation and labels for the review and manual execution workflows.
- Keep error messages actionable, with retry guidance only where retrying is safe.
- Show all bulk-approval selections before committing approval.
- Clearly indicate when a result is incomplete or uncertain.

## 12. Functional State Models

### 12.1 Scenario lifecycle

Suggested lifecycle:

`draft -> needs_clarification | pending_review -> approved | rejected | deferred -> superseded`

An approved scenario is immutable. Editing creates a new draft version. A superseded version remains available for historical run interpretation.

### 12.2 Test-run lifecycle

Suggested lifecycle:

`created -> queued -> running -> completed | failed | cancelled | blocked`

Individual case outcomes:

- `passed`: all required assertions or manual step criteria passed.
- `failed`: a required assertion failed or the tester reported a failure with sufficient actual-result detail.
- `blocked`: the test could not proceed because a prerequisite, permission, environment, or dependency was unavailable.
- `inconclusive`: evidence is insufficient or the result cannot be reliably classified.
- `not_run`: execution did not occur.
- `skipped`: explicitly skipped with a reason.

A run can be technically completed while containing failed, blocked, or inconclusive test cases. Run status must not conceal individual outcomes.

## 13. Scenario Data Contract

The persisted scenario must be structured, versioned, and language-aware. An illustrative representation follows. It is a logical contract, not a final implementation schema.

```json
{
  "schema_version": "1.0",
  "scenario_id": "TC-REG-001",
  "version": 1,
  "title": {
    "language": "en",
    "text": "Reject registration without NIB"
  },
  "feature": "Registration",
  "category": "negative_validation",
  "test_techniques": ["equivalence_partitioning"],
  "priority": "high",
  "risk": {
    "impact": 4,
    "likelihood": 3,
    "rationale": "A required identifier must be validated before submission."
  },
  "execution_modes": ["manual", "automated"],
  "preconditions": [
    "A test account is authenticated",
    "The registration page is accessible"
  ],
  "test_data": [
    {
      "name": "nib",
      "value_ref": "fixture:registration.missing_nib",
      "sensitivity": "non_secret"
    }
  ],
  "steps": [
    {
      "step_id": "S1",
      "instruction": "Open the registration page",
      "automation": {
        "action": "navigate",
        "target": {"kind": "route", "value": "/registrasi"}
      },
      "expected_result": null
    },
    {
      "step_id": "S2",
      "instruction": "Submit the form with the NIB field empty",
      "automation": {
        "action": "fill",
        "target": {"kind": "label", "value": "NIB"},
        "value_ref": "fixture:registration.missing_nib"
      },
      "expected_result": {
        "description": "The required-field validation is shown and registration is not submitted.",
        "basis": "source_supported",
        "evidence_refs": ["EVID-012"]
      }
    }
  ],
  "cleanup": [],
  "assumptions": [],
  "evidence_refs": ["EVID-012", "EVID-019"],
  "approval": {
    "status": "pending_review",
    "approved_by": null,
    "approved_at": null
  }
}
```

Implementation rules:

- Machine actions and locators must not depend on translated human-readable instructions.
- `value_ref` should refer to controlled test fixtures or protected secret references. Do not persist live passwords as scenario values.
- `expected_result.basis` must use a controlled enumeration.
- Schema validation occurs before saving, approval, export, and execution.
- Unsupported actions must be presented as manual-only or blocked, not silently approximated.

## 14. LLM and Agent Design

### 14.1 Logical components

- **SAA artifact importer/normalizer:** validates the SAA manifest and schemas, resolves documentation asset IDs, verifies package completeness, and converts supported SAA output versions into QAA's internal system-model representation.
- **Documentation readiness checker:** evaluates freshness, commit alignment, missing artifacts, unresolved SAA findings, and whether enough information exists to design tests responsibly.
- **Targeted source verifier:** when a read-only repository connection exists, checks relevant source references and existing tests without repeating SAA's full system-documentation workflow or executing repository code.
- **Browser discovery planner:** selects safe routes and interactions within an explicit discovery budget, guided by documented routes and flows.
- **Evidence correlator:** matches SAA documentation claims with source references, browser observations, supplied requirements, and existing tests.
- **QA planner:** defines scope, risks, coverage, test techniques, and assumptions.
- **Scenario generator:** emits schema-conforming cases in the selected output language.
- **Scenario critic/validator:** checks completeness, contradictions, duplicate cases, unsafe actions, and unsupported expected results.
- **Translation/presentation layer:** translates human-readable artefacts while preserving action data and technical identifiers.
- **Execution adapter:** maps validated approved definitions to deterministic Playwright APIs. It is not an open-ended agent.
- **Result classifier:** distinguishes assertion failures, product defects, test defects, environment failures, and inconclusive outcomes. Classification suggestions must remain reviewable.

These are logical responsibilities, not a requirement to run a separate autonomous agent for every component. MVP should prefer a small number of services and controlled LLM calls.

### 14.2 Model provider abstraction

The core should support a common internal interface for structured generation, tool-call requests if needed, token/cost tracking, timeouts, and error normalization. Configuration should identify provider, model, endpoint, and policy. Provider credentials remain outside prompts.

Do not assume every model supports identical JSON schema enforcement, context length, tool calls, or data-handling properties. Validate all outputs locally, test providers against a benchmark, and document any limitations.

### 14.3 Prompt-injection controls

Repository files, README instructions, comments, web page content, hidden HTML text, and API response bodies are untrusted data. They may be analyzed as evidence, but must not be allowed to override system policy, widen URL scope, expose secrets, approve tests, or request arbitrary shell actions. Tool permissions must be enforced in application code rather than left to model instructions.

### 14.4 Context and cost management

- Index repository structure and retrieve relevant snippets instead of putting the full repository into prompts.
- Exclude secrets and nonessential large files.
- Cache analysis keyed to commit SHA and analyzer version.
- Deduplicate evidence and scenarios.
- Record model usage by project and job.
- Allow self-hosted model configuration where compatible.
- Provide budget, maximum-step, timeout, and token controls.

## 15. Proposed Technical Architecture

### 15.1 Services

- **Web UI:** React and TypeScript.
- **API service:** Node.js and TypeScript using a framework such as Fastify.
- **Database:** PostgreSQL for canonical state and versioned records.
- **Job broker:** Redis with BullMQ or an equivalent queue.
- **SAA integration adapter/importer:** ingests a versioned SAA artifact package and normalizes its system model.
- **Documentation readiness worker:** checks artifact completeness, schema compatibility, revision alignment, and unresolved documentation risks.
- **Source verification worker:** optional read-only, narrowly scoped repository checks; not the primary system-documentation generator.
- **Discovery worker:** isolated browser session that validates relevant documented UI elements and flows within scope.
- **Automation worker:** disposable Playwright process/container with strict action allowlists.
- **Artifact storage:** local filesystem in simple development installations; S3-compatible storage for deployments that need it.
- **Secret store:** deployment-provided secret manager where available, or encrypted-at-rest secret records protected by a separately managed key.
- **LLM adapter:** provider-neutral abstraction, optionally connected to a local model endpoint.

### 15.2 Design constraints

- The API process must not execute long-running browser or model jobs synchronously.
- Workers must be disposable and isolated between tenants/projects where the deployment is multi-user.
- The database is the source of truth for approval and run states; queue messages are not the only record of state.
- Workers re-check authorization, approval version, target scope, and run state before each job begins.
- A worker should receive only the credentials and repository material required for its specific job.
- Browser network access must be controlled at the infrastructure layer, not only by URL parsing.
- Artifact retention and deletion must be configurable.
- Local-first and self-hosted use must be documented; external model services are opt-in and explicitly configured.

### 15.3 Conceptual data model

Core entities:

- `users` and `teams` (for installations that enable multi-user access)
- `projects`
- `repository_connections`
- `repository_snapshots`
- `saa_documentation_packages` (package version, schema version, analyzer version, repository identity, commit SHA, generation timestamp, checksum/status)
- `documentation_assets` (human-readable files and machine-readable artifacts with stable IDs)
- `documentation_evidence_links` (asset/section IDs linked to source, route, feature, flow, or test scenario)
- `environments`
- `secret_references`
- `scope_policies`
- `analysis_runs`
- `evidence_items`
- `features` and `routes`
- `test_plans`
- `test_scenarios`
- `scenario_versions`
- `scenario_evidence_links`
- `approvals`
- `manual_runs` and `manual_step_results`
- `automated_runs` and `automated_step_results`
- `defects`
- `artifacts`
- `audit_events`
- `model_usage_records`

All long-lived records should carry creation/update timestamps. Important versions and audit entries should be immutable or append-only. Project deletion must define how related artefacts and secret references are deleted, including object storage.

## 16. Security, Privacy, and Trust Requirements

QAA accepts arbitrary user-supplied URLs and processes potentially untrusted source code. Security is a launch requirement.

### 16.1 Authorization and scope

- Require the user to confirm they are authorized to test the target application and repository.
- Allowlist target hostnames, schemes, and optionally path prefixes.
- Revalidate every redirect and outbound connection.
- Block access to loopback, private, link-local, and cloud metadata addresses by default. Any private-network deployment mode must require explicit administrator configuration and stronger isolation.
- Protect against DNS rebinding by validating resolved destinations at connection time and enforcing egress rules outside the application.
- Do not allow URL parameters, page content, or model decisions to expand target scope.
- Rate-limit discovery, API requests, navigation, and test execution.

### 16.2 Repository safety

- Treat the repository as untrusted input.
- Do not run install hooks, build scripts, test scripts, or arbitrary code during static discovery.
- If a future feature needs to launch the app from source, require an explicit opt-in and run it in a strongly isolated sandbox with no default access to secrets or internal networks.
- Apply file size limits and exclude secret patterns, `.env` files, private keys, tokens, and unrelated files from model context.

### 16.3 Credential handling

- Never store credentials in plaintext in the application database, test scenario, model prompt, console output, screenshot, or exported report.
- Use a protected secret reference and expose the secret only to the appropriate worker at runtime.
- Prefer short-lived tokens or user-scoped access where available.
- Mask credentials and session tokens from logs and network artefacts where possible.
- Provide credential revocation and deletion instructions.
- Do not reuse authentication state across projects or tenants.

### 16.4 Safe test execution

- MVP defaults to development/staging environments and requires explicit production opt-in if production support is added later.
- Discovery must avoid data-changing actions.
- Generated cases likely to create, update, delete, approve, publish, send, or trigger real-world effects must be marked as state-changing and require explicit approval and appropriate fixtures.
- Require a cleanup plan or a visible warning when data changes cannot be safely reversed.
- Disable arbitrary file downloads and uploads unless a test specifically needs them and the file types and destinations are controlled.
- Provide immediate cancellation and worker termination controls.

### 16.5 Data retention and privacy

- Operators can configure retention for source snapshots, prompts/outputs, browser recordings, screenshots, and traces.
- Users can delete project data and its artifacts, subject to the deployment's backup policy, which must be documented.
- Data sent to external model providers must be disclosed in configuration and documentation.
- Store only the evidence needed to explain and reproduce results.
- Redact or warn about personal data in screenshots and logs where feasible.

### 16.6 Auditability

Record who connected a repository, changed the target scope, configured credentials, approved a scenario, started/cancelled a run, exported a report, or deleted data. Do not record secret values in the audit log.

## 17. Non-Functional Requirements

The following are initial product targets and should be calibrated through benchmarks.

### 17.1 Reliability

- Persist job state so the UI can recover after API restarts.
- Use bounded retries for transient infrastructure errors.
- Prevent duplicate execution caused by repeated queue delivery, using idempotency keys and run-state checks.
- Make cancellation and cleanup observable.
- Preserve partial evidence after a worker crash where technically possible.

### 17.2 Performance and resource usage

- Project and run dashboards should remain responsive while long jobs execute.
- Queue work rather than blocking API requests.
- Enforce configurable limits for total pages discovered, browser steps, total run duration, model usage, concurrency, CPU, memory, disk, and artifacts.
- Display estimates as estimates, not promises.

### 17.3 Usability and accessibility

- Core project setup, scenario review, and manual execution must be usable by keyboard.
- Form controls require labels and accessible status announcements.
- Reports must be readable without color perception.
- Scenario steps should be written in clear, direct language without unnecessary jargon.

### 17.4 Portability and maintainability

- Provide Docker-based local development and deployment instructions.
- Keep provider-specific model logic behind adapters.
- Keep test methodology and scenario schema independent of the selected automation engine.
- Use database migrations, typed internal contracts, structured logs, and versioned APIs.
- Document supported platforms and dependencies.

### 17.5 Observability

Track queue depth, analysis duration, generation duration, browser duration, worker exits, test outcomes, evidence volume, model usage, and cancellation counts. Observability data must not include secret values.

## 18. Quality Strategy for QAA Itself

QAA must be tested using the same principles that it promotes.

### 18.1 Test levels

- **Unit tests:** schema validation, state transitions, risk scoring, permissions, translation preservation, and result classification.
- **Integration tests:** database migrations, queue lifecycle, object storage, secret references, repository adapters, and model-provider adapters.
- **Component tests:** scenario editor, approval state, manual test runner, filters, and report rendering.
- **End-to-end tests:** create project, connect sample repository, discover, generate tests, approve, execute, and review results.
- **Security tests:** SSRF attempts, redirect and DNS cases, access-control checks, prompt-injection content, secret redaction, and cross-project isolation.
- **Regression tests:** every fixed defect should add a regression case when practical.

### 18.2 Benchmark fixture applications

Maintain a set of purpose-built sample applications with known characteristics, including:

- Login and logout flows.
- Required and optional form fields.
- Equivalence partitions and boundary validation.
- Multi-condition decision rules.
- State transitions and permission restrictions.
- Pagination, search, sorting, and filtering.
- Known seeded defects.
- Broken links, missing routes, and console errors.
- Dynamic controls that challenge locator stability.
- A malicious page with prompt-injection text.
- Routes that attempt redirects outside the authorized scope.

The evaluation should measure scenario correctness and coverage, not just the number of tests generated.

### 18.3 Evaluation metrics

- **Scenario acceptance rate:** percentage of generated scenarios approved without major revision.
- **Expected-result validity:** percentage of reviewed expected results judged correct against the authoritative test basis.
- **Coverage recall:** percentage of known in-scope routes and required behaviors represented by appropriate cases.
- **Duplicate rate:** proportion of redundant generated scenarios.
- **Automation execution reliability:** consistency across repeated executions against a stable test environment.
- **False-failure rate:** percentage of reported failures that are not genuine product defects or approved assertion failures.
- **Evidence completeness:** percentage of results with the required evidence and provenance.
- **Manual completion rate:** percentage of started manual runs completed or explicitly closed with a reason.
- **Time to first useful suite:** elapsed time until a user can review and approve a useful group of scenarios.
- **Cost per accepted scenario:** model and execution cost for each approved, usable scenario.

Define baseline values from repeatable evaluation before making numeric success claims publicly.

## 19. MVP Acceptance Criteria

The MVP is ready for public preview when all P0 requirements are implemented and the following end-to-end criteria pass.

### SAA handoff, project and discovery

- A user can import a valid SAA documentation package and configure an authorized development URL, output language, and optional read-only repository connection.
- QAA validates and stores the package version, schema version, repository identity, commit SHA, generation metadata, and artifact provenance.
- QAA reports missing, incompatible, stale, mismatched, or unresolved documentation before scenario generation.
- QAA maps documented features/flows to relevant routes and observed browser behavior in a benchmark app.
- SAA documentation, targeted source evidence, supplied requirements, and observed browser behavior are stored as distinct evidence types.
- Out-of-scope navigation is blocked.
- QAA can trace each generated scenario to at least one relevant SAA documentation asset or explicitly label it as a gap-driven exploratory scenario.

### Scenario quality and approval

- QAA generates scenarios with preconditions, ordered steps, expected results, technique, priority rationale, execution suitability, and evidence references.
- Ambiguous expectations are explicitly flagged.
- Users can edit, reject, defer, or approve scenarios.
- The executor refuses a case that has not been approved or whose approved version has changed.
- English and Indonesian outputs are usable, preserve technical identifiers, and use consistent status and severity terminology.

### Automated testing

- At least one approved suite can execute against the supported benchmark app using Playwright.
- Every case result links to expected and actual outcomes and relevant evidence.
- Assertion failures and infrastructure failures are reported separately.
- Cancellation stops future test actions and starts cleanup.
- The runner cannot execute arbitrary generated code or perform actions outside the supported schema.

### Manual testing

- A tester can start a run, complete steps, record actual outcomes, attach evidence, pause/resume, and submit results.
- A failed step can be linked to a defect record.
- Manual results are clearly labeled as tester-reported.

### Security and operations

- Secrets do not appear in application logs, reports, or generated prompts under normal tested operation.
- SSRF and scope tests demonstrate blocking of prohibited destinations.
- A worker cannot access another project's credentials or artifacts.
- Operators can configure timeouts, concurrency, and artifact retention.
- A self-hosted installation can be run from documented setup instructions.

## 20. Release Scope and Roadmap

### Phase 0: SAA-QAA contract and foundations

- Agree with SAA maintainers on a versioned artifact manifest, stable documentation IDs, evidence provenance, and compatibility policy.
- Define a machine-readable system model alongside human-readable documentation; do not rely on Markdown parsing alone.
- Define how QAA detects stale packages, commit mismatches, partial exports, and unresolved SAA findings.
- Confirm scenario schema and test lifecycle.
- Build safe URL scope and worker isolation before exposing URL discovery publicly.
- Create benchmark system documentation packages and benchmark applications with known flows and expected outcomes.

### Phase 1: First usable vertical slice

- Import SAA documentation package with manifest/schema validation and package readiness checks.
- Configure the target URL, authentication reference, output language, and repository identity; support read-only repository verification where needed.
- Map SAA-documented flows to live routes and observed forms using a narrow set of supported web stacks.
- Generate evidence-linked scenarios using QA test-design techniques and explicit human approval.
- Playwright automated execution for a constrained action set.
- Guided manual execution of the same approved scenarios.
- Markdown and JSON exports with SAA documentation references and execution evidence.

### Phase 2: Better quality and team workflows

- More authentication strategies.
- Improved repository change analysis and regression suggestions.
- Test assignment and team permissions.
- Run comparison and HTML reporting.
- More robust data fixture and cleanup support.
- Additional locales and optional export formats.

### Phase 3: Extensible testing platform

- API/contract test adapter.
- Accessibility and visual regression integrations.
- Additional automation engines or exported programming languages based on demand.
- CI integration for approved suites.
- Pluggable test-design methods and framework analyzers.
- Optional self-hosted model support and configurable data policies.

Performance testing, penetration testing, and production execution require separate safety designs and should not be silently added as general-purpose agent actions.

## 21. Open-Source Strategy

### 21.1 Distribution model

The core platform should be open source and self-hostable. Users should be able to connect a repository and run the core workflow on infrastructure they control. External hosted model services, if used, must be configured by the operator and disclosed clearly.

### 21.2 License decision

The repository license must be chosen deliberately before public release. **Apache License 2.0** is a reasonable candidate if the project's goal is broad reuse, including commercial use, with an explicit patent grant. **MIT** is another simple permissive option. A copyleft license may be more appropriate if the maintainers specifically want derivatives to share source under corresponding terms. The decision should consider maintainer intent and contributor expectations; do not publish without a clear `LICENSE` file.

### 21.3 Repository standards

Include at minimum:

- `README.md` with purpose, screenshots, quick start, supported features, limitations, and security warning.
- `LICENSE`.
- `CONTRIBUTING.md`.
- `CODE_OF_CONDUCT.md`.
- `SECURITY.md` with private vulnerability-reporting instructions.
- `.env.example` containing placeholders only.
- `docs/architecture.md`.
- `docs/qa-methodology.md`.
- `docs/scenario-schema.md`.
- `docs/self-hosting.md`.
- `docs/threat-model.md`.
- `docs/model-providers.md`.
- `docs/language-and-localization.md`.
- Tests and benchmark fixtures.

### 21.4 Contribution and extension boundaries

Provide documented interfaces for repository analyzers, model providers, language packs, evidence extractors, report exporters, and execution adapters. Plugin code must not bypass authorization, approval, scope, or worker policies.

### 21.5 Governance

For an early-stage project, use a maintainer-led model with transparent issue triage, public design discussions, versioned releases, and a published roadmap. Record significant architectural decisions as ADRs. Any future commercial hosted offering should be clearly distinguished from the capabilities available in the open-source edition.

## 22. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| AI invents expected behavior | False failures and misplaced confidence | Evidence labels, clarification status, human review, and benchmark evaluation |
| Application is explored incompletely | Hidden workflows remain untested | Show discovered scope, exclusions, route coverage, and explicit limitations |
| Tests are flaky | Developers stop trusting results | Stable locators, explicit assertions, controlled data, bounded retries, traces, and separate environment failure classification |
| Test submits destructive data | Loss or corruption of application data | Staging-first default, state-changing action flags, safe fixtures, cleanup plan, and explicit approval |
| URL becomes an SSRF vector | Access to internal systems or secrets | Egress restrictions, target allowlist, redirect/DNS validation, private-address blocking, and worker isolation |
| Repository contains malicious scripts or prompt injection | Code execution or policy manipulation | Read-only static analysis, no default script execution, treat repository content as data, sandbox when execution is explicitly enabled |
| Credentials leak into prompts or artifacts | Account compromise | Protected secret references, runtime injection, redaction, short-lived tokens, per-project isolation, retention controls |
| Translation changes test meaning | Invalid assertions or misleading reports | Stable action schema, translation tests, preserved identifiers and numbers, human-editable artefacts, renewed approval on semantic changes |
| Product becomes too broad | Slow delivery and low quality | Keep MVP focused on web UI functional and end-to-end tests, common login flows, and manual/automated scenarios |
| Model vendor lock-in | Higher cost or loss of provider choice | Provider adapter, structured internal schema, regression benchmark across providers |
| Open-source users misconfigure deployment | Security exposure | Secure defaults, deployment warnings, documented secrets/network controls, minimal permissions, and configuration checks |

## 23. Key Product Decisions

| Decision | MVP choice | Rationale |
|---|---|---|
| Product workflow | SAA first, then QAA | SAA produces the system documentation/model; QAA uses it as the primary test basis |
| SAA integration | Versioned artifact bundle for MVP; API/shared workspace later | Keeps the projects loosely coupled and lets users inspect/export the handoff |
| QAA access model | SAA documentation package + target URL/authentication; optional read-only repository verification | Avoids duplicating SAA while preserving evidence checks and repository traceability |
| Documentation trust | Provenance-aware, not automatically authoritative | SAA output may be inferred, stale, incomplete, or inconsistent with runtime behavior |
| Execution model | Human approval before execution | Prevents unreviewed AI-generated tests from interacting with applications |
| Test modes | Automated and guided manual | Allows teams to test immediately and automate selectively over time |
| Automation engine | Playwright | Mature browser automation, assertions, and debugging traces |
| Test definition | Versioned structured scenario schema | Shared source for manual instructions and constrained automated execution |
| Initial source stacks | Select a small set based on benchmark and maintainer capacity | Improves discovery quality rather than pretending to support every framework |
| Initial generated languages | English and Indonesian | Supports the initial user need while keeping localization extensible |
| Initial automation code language | TypeScript | Matches the proposed Node.js/Playwright stack; natural-language output is separate |
| LLM architecture | Provider-neutral adapter | Keeps provider choice replaceable and supports self-hosted options where compatible |
| State-changing tests | Explicitly flagged and specially approved | Reduces risk to application data and real users |
| Production testing | Out of MVP scope | Requires stronger controls and a distinct risk review |
| Source modification | Out of MVP scope | QAA first establishes reliable discovery and testing before attempting fixes |
| License | Pending maintainer decision | License should match intended contribution and reuse model |

## 24. Questions to Resolve Before Implementation

These questions do not block drafting the PRD, but they should be decided before committing to implementation details:

1. What exact name, scope, and ownership boundaries will SAA use, and which SAA versions are in active development?
2. Which machine-readable artifacts can SAA export in the first release, and which are mandatory versus optional?
3. What stable IDs and schema-versioning policy will SAA use for modules, routes, flows, business rules, permissions, entities, and evidence references?
4. Will the first integration be a downloadable/importable artifact bundle, local filesystem integration, or a direct API? The PRD assumes bundle import first.
5. How will SAA indicate inferred information, unknowns, confidence, evidence provenance, and unresolved analysis tasks?
6. Which frontend/backend stacks and repository providers must be supported first?
7. Will the product be single-user/local-first initially, or multi-user with teams and role-based access control from day one?
8. Which model providers and local inference options should be tested against the benchmark?
9. Where will the first deployment run, and can the runner reach private development networks safely?
10. How will manual-run screenshots and artifacts be retained and shared, and which license best matches the maintainers' goals?
11. Should English and Indonesian be the only release locales, or should the first release allow user-contributed language packs?
12. Which benchmark SAA packages and target applications will define the initial quality bar?

## 25. Definition of Done

A feature is not complete merely because an AI model can demonstrate it once. A feature is done when:

- Requirements and constraints are documented.
- The schema and state transitions are validated by code.
- Authorization and scope rules are enforced outside the model.
- Unit, integration, and relevant end-to-end tests exist.
- Failure and cancellation paths are handled.
- Logs and reports avoid secrets.
- User-facing text is available in required MVP languages.
- Documentation describes supported behavior and limitations.
- A benchmark demonstrates expected behavior and provides reproducible results.
- Accessibility and usability are checked for applicable user workflows.

## 26. SAA Integration Contract: Minimum Artifact Requirements

This contract is the MVP boundary between SAA and QAA. It should be versioned independently of either product's internal implementation.

### 26.1 Required package structure

The exact filenames can be agreed with the SAA maintainers, but the export should contain:

- `manifest.json`: package ID, package/schema version, SAA version, repository identity, analyzed commit SHA, generation time, language metadata, artifact list, checksums where supported, and completeness status.
- Human-readable system documentation in Markdown (or an equivalent open format) covering the system overview, architecture, module inventory, route/page map, user journeys, business rules, roles and permissions, important data entities/flows, API/integration inventory, state transitions, error paths, known gaps, and assumptions where applicable.
- Machine-readable `system-model.json` (or equivalent) containing stable IDs and structured relationships for modules, routes, actors, flows, steps, rules, states, entities, APIs, integrations, and unresolved items.
- `evidence-index.json` (or equivalent) mapping documentation claims to repository paths/line ranges, API definitions, existing test references, or other source evidence where available.
- Optional diagrams, dependency maps, API specifications, data dictionaries, and supporting assets, each discoverable from the manifest.

### 26.2 Minimum manifest example

```json
{
  "package_schema_version": "1.0",
  "package_id": "system-docs-example",
  "producer": {
    "name": "SAA",
    "version": "0.1.0"
  },
  "repository": {
    "provider": "git",
    "url_or_id": "example/project",
    "commit_sha": "<immutable-commit-sha>"
  },
  "generated_at": "2026-10-21T00:00:00Z",
  "completeness": "complete_with_gaps",
  "artifacts": [
    {
      "id": "system-model",
      "path": "system-model.json",
      "media_type": "application/json",
      "version": "1.0"
    },
    {
      "id": "system-overview",
      "path": "docs/system-overview.md",
      "media_type": "text/markdown",
      "language": "en"
    },
    {
      "id": "user-flows",
      "path": "docs/user-flows.md",
      "media_type": "text/markdown",
      "language": "en"
    },
    {
      "id": "evidence-index",
      "path": "evidence-index.json",
      "media_type": "application/json",
      "version": "1.0"
    }
  ]
}
```

The example is illustrative. SAA and QAA maintainers must agree on the actual schema, timestamp rules, repository identifier format, checksum requirements, and backwards-compatibility policy before implementation.

### 26.3 Minimum semantic fields

At minimum, the structured model should be able to represent:

- **System and module:** stable ID, name, purpose, dependencies, evidence references, certainty/status.
- **Route/page:** stable ID, route pattern, page/module association, access preconditions, discovered controls.
- **Actor/role/permission:** stable IDs, actions allowed, access constraints, supporting evidence, unresolved questions.
- **User flow:** stable ID, actor, purpose, ordered steps, entry/exit conditions, alternate/error branches, state changes, related routes/APIs.
- **Business rule/validation:** stable ID, rule statement, inputs/conditions, expected behavior when known, boundary/exception notes, evidence, and certainty.
- **Entity/data flow:** stable IDs, relevant fields and relationships, read/write side effects, sensitivity classification where known.
- **API/integration:** method, path or operation, purpose, request/response references, dependencies, authorization notes and evidence when available.
- **State transition:** entity or process, source state, trigger/guard, destination state, side effects, invalid transitions where known.
- **Gap/assumption:** stable ID, description, impact, evidence missing, and whether human clarification is required.
- **Evidence reference:** source type, repository/commit, file/line range or documentation anchor, extraction method, generation time and certainty.

### 26.4 Compatibility and freshness rules

- Unknown major schema versions are rejected with an actionable error; compatible minor versions may be accepted according to declared rules.
- QAA stores the original package unchanged alongside its normalized internal representation.
- A new package for a different commit creates a new analysis baseline; it must not overwrite history for previous scenarios or runs.
- A commit mismatch does not automatically mean the docs are wrong, but it must be visible. QAA can allow limited review mode while blocking execution approval when the mismatch materially affects the selected flows.
- QAA must not fabricate missing system-model entities to make a package appear complete. It may create explicit gap records and request another SAA run or human clarification.
- If only human-readable Markdown is provided, QAA may support a best-effort import as a compatibility fallback, but must label extracted structure as QAA-inferred and lower-confidence. Structured artifacts are required for the intended high-quality integration.

## 27. References

The following sources inform the testing terminology, browser automation approach, repository authorization, open-source licensing discussion, and URL-security controls. The PRD uses them as guidance; it does not claim formal certification or compliance with a testing standard.

1. ISTQB Glossary, [Test case](https://glossary.istqb.org/en_US/term/test-case): test cases include preconditions, inputs, actions, expected results, and postconditions.
2. ISTQB Glossary, [Test basis](https://glossary.istqb.org/en_US/term/test-basis): materials used as the basis for test analysis and design.
3. ISTQB Glossary, [Risk-based testing](https://glossary.istqb.org/en_US/term/risk-based-testing/2): testing activities are selected and prioritized according to risks and risk levels.
4. ISTQB Glossary, [Exploratory testing](https://glossary.istqb.org/en_US/term/exploratory-testing): test design and execution can be adjusted according to exploration and previous results.
5. ISTQB Glossary, [Test execution automation](https://glossary.istqb.org/en_US/term/test-execution-automation): automation includes controlling execution, comparing actual and expected results, preconditions, and reporting.
6. Playwright, [Test generator](https://playwright.dev/docs/codegen): browser action recording and locator generation.
7. Playwright, [Assertions](https://playwright.dev/docs/test-assertions): web-first assertions and retry behavior.
8. Playwright, [Tracing](https://playwright.dev/docs/api/class-tracing): browser operations and network activity can be retained for debugging.
9. GitHub Docs, [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app): select the minimum permissions required.
10. OWASP, [Server Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html): defensive controls for applications that access user-supplied URLs.
11. Choose a License, [Choose an open-source license](https://choosealicense.com/): compare permissive and copyleft licensing approaches.

---

**End of document**
