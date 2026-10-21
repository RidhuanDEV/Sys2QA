# System Analyst Agent (SAA)
## Product Requirements Document

**Document status:** Draft v1.0 — product and architecture baseline  
**Date:** 21 October 2026  
**Product family:** SAA → QAA (Quality Assurance Agent)  
**Primary audience:** Product owner, engineering team, agent/tooling developers, QA and security reviewers

---

## Executive summary

System Analyst Agent (SAA) is an evidence-driven software archaeology and system-understanding product. Its mission is to turn an existing software repository—including undocumented legacy code—into a structured, navigable, versioned model of the system and a comprehensive documentation set that developers and downstream agents can rely on.

SAA acts like a disciplined senior system analyst. It inventories the repository, identifies independent applications and runtime boundaries, selects the appropriate language/framework analyzers, traces important behavior through code, reconstructs API and data contracts, compares evidence from source code, tests, configuration, documentation and optional runtime observations, and records what is known, inferred, contradicted or still unknown. It produces both human-readable Markdown documents and a machine-readable knowledge base. QAA then consumes that knowledge base to design and prioritize tests, understand expected behavior, investigate failures, and reason about regression impact.

SAA must not be implemented as only a prompt, Skill, MCP server or CLI command. The product is a shared **analysis engine + analyst workflow + evidence/knowledge model**, made available through several interfaces:

1. **SAA Analyst Skill:** teaches a compatible AI agent how to plan investigations, ask useful follow-up questions, use evidence properly and synthesize findings.
2. **SAA CLI:** the primary installation, analysis, inspection, export and automation interface. It works without an AI coding agent.
3. **SAA MCP server:** exposes the same core capabilities to compatible AI agents, with session-aware investigation and evidence retrieval.
4. **Core analysis engine and adapters:** performs deterministic repository discovery, language-aware extraction, framework-specific analysis, evidence normalization, graph construction, incremental refresh and document generation.
5. **Knowledge base and documentation artifacts:** preserve the results in stable, inspectable formats and serve as the contract between SAA and QAA.

The initial release is local-first, read-only and static-analysis-first. Runtime analysis is an optional, explicitly approved capability, not a default requirement. Language coverage is broad at the detection/inventory level but deep analysis is delivered through a deliberately prioritized set of language and framework adapters.

**Product principle:** SAA must describe the system as evidenced to work, not as an LLM guesses it probably works.

---

## 1. Product definition

### 1.1 Problem statement

Real-world repositories frequently have missing, stale or fragmented documentation. Original developers may have left; business rules may be implicit in conditional logic; deployed systems may consist of multiple frontends, backends, workers and scheduled jobs; application behavior may cross API, database, proxy, authentication and external-service boundaries. Traditional documentation efforts depend on interviews and manual reading, and the resulting documents drift as code changes.

Without a reliable system model, a QA agent can test the wrong behavior, miss cross-component effects, mistake an implementation detail for a requirement, or waste time rediscovering the system. QAA needs more than raw source code or a generic code summary: it needs traceable relationships, behavioral workflows, contracts, confidence levels, and explicit gaps.

### 1.2 Product vision

Given a repository and the access permissions granted by its owner, SAA should create the most complete defensible system model possible from available evidence, explain how the model was derived, identify important unknowns, and keep the model synchronized as the repository changes.

The target outcome is that a developer or QAA can ask questions such as:

- What applications and services make up this system, and which are independent?
- What happens when a user performs a particular business operation?
- Which UI component calls which API, through which proxy or gateway, and which data does the backend read or write?
- Which tables, fields, events or external services participate in this workflow?
- Where are authentication, authorization, validation and error handling implemented?
- What tests already cover this path, and what important paths remain untested?
- If this function, API contract, schema or configuration changes, what else may be affected?
- Which statements are proven by code, observed at runtime, inferred, contradictory or unresolved?

### 1.3 Product mission

**Discover → Reconstruct → Verify → Document → Preserve → Serve QAA → Refresh.**

SAA is a system-understanding foundation for QA, development, onboarding, maintenance and future modernization. QAA remains a separate product/agent focused on quality assurance. SAA may help investigate a test failure, but does not become QAA or silently assume QA execution responsibilities.

### 1.4 Definitions

- **Repository target:** a directory, repository checkout, archive or explicitly selected set of repositories to analyze.
- **Project boundary:** an application, package, service, worker, library, deployment unit or other independently meaningful component inside a target.
- **System knowledge base (SKB):** normalized machine-readable entities, relationships, evidence, uncertainty, coverage and source revision metadata.
- **Evidence:** a source location, manifest entry, schema, test, Git change, config value, static analyzer result or approved runtime observation supporting a finding.
- **Claim/finding:** an interpretation derived from one or more evidence records.
- **Workflow trace:** an evidence-backed path through entrypoints, component calls, API boundaries, data operations, side effects and results.
- **Adapter:** a replaceable analyzer for a language, framework, file type, infrastructure format or runtime source.
- **Skill:** agent-facing instructions for choosing and sequencing tools; it is not the analysis engine itself.
- **MCP:** Model Context Protocol integration that exposes SAA capabilities to compatible clients; it is an interface, not the source of truth.
- **Confidence:** SAA's calibrated assessment of a claim based on evidence quality and ambiguity. It must never be presented as a mathematically validated probability unless calibrated as such.

---

## 2. Goals, non-goals and product principles

### 2.1 Primary goals

1. Reconstruct a repository's observable software structure and important behavior without requiring existing documentation.
2. Identify application boundaries in monorepos and multi-version deployments instead of merging components merely because names are similar.
3. Build evidence-backed relationships across modules, functions, routes, APIs, persistence, configuration, deployments and external systems.
4. Generate useful human-readable documentation and a machine-readable knowledge base from the same underlying model.
5. Give QAA a stable contract to retrieve workflows, API/data contracts, component dependencies, existing tests, risk areas and unresolved questions.
6. Explain why a conclusion was reached and allow a reviewer to open its evidence.
7. Support incremental updates so the knowledge base can be refreshed after source changes without repeatedly analyzing everything.
8. Work locally and safely by default, with no source modifications or target execution during the default analysis path.
9. Support multiple languages through a common ontology and replaceable adapters, while being explicit about adapter coverage and limitations.
10. Make investigations repeatable through versioned outputs, deterministic extraction, recorded tool versions and configurable analysis profiles.

### 2.2 Secondary goals

- Provide developer onboarding and system-maintenance documentation.
- Surface likely architectural risks and undocumented coupling for human review.
- Help prioritize QA based on business-flow criticality and change impact.
- Compare the system model across commits or releases.
- Allow team-specific policies, naming conventions and domain vocabulary without hard-coding them into the core ontology.

### 2.3 Non-goals for the initial release

- Guaranteeing perfect understanding or recovering business intent that is absent from code, tests, data or human input.
- Recreating inaccessible source code from a deployed binary or reverse-engineering arbitrary compiled artifacts as a first-release promise.
- Claiming every programming language and framework has equal semantic depth.
- Automatically editing source code, refactoring systems, fixing defects or deploying changes.
- Running arbitrary repository scripts, migrations, tests, package hooks or applications without explicit authorization.
- Automatically connecting to production databases or production infrastructure.
- Replacing source control, a full observability platform, a test execution platform or human system analysts.
- Treating LLM-generated explanations as evidence in their own right.
- Assuming comments, README files, tickets or tests are always accurate when they disagree with implementation.
- Requiring a hosted service or sending source code to a remote model provider by default.

### 2.4 Product principles

1. **Evidence before explanation.** Every substantive architectural or behavioral claim must link to evidence, or be explicitly labeled as an inference or unknown.
2. **Source code is evidence, not omniscience.** Code can show implementation behavior; it may not establish intended behavior or actual production behavior in every environment.
3. **Separate facts from interpretations.** Extracted symbols and declared routes are distinct from an inferred end-to-end workflow.
4. **Unknowns are first-class output.** A missing link is not to be silently filled with a plausible story.
5. **Static-first, runtime by consent.** Reading and parsing files is the default. Executing a target is a separate permission level.
6. **One core, multiple interfaces.** CLI and MCP use the same engine and output contracts. Skill instructions orchestrate them rather than duplicating analysis logic.
7. **Language-agnostic core, language-specific depth.** Normalize what can be understood consistently, and disclose where semantics are limited.
8. **Respect project boundaries.** Preserve independent apps, versions, packages and services unless evidence proves they are connected.
9. **Incremental and version-aware.** Tie knowledge to a specific repository revision and invalidate stale claims when dependencies change.
10. **No silent mutation.** The default operation never modifies the target repository or changes global developer-agent configuration.
11. **LLM output is untrusted.** Repository text, including comments and documentation, can contain prompt-injection attempts and must never override tool/security policy.
12. **Readable by both humans and machines.** Markdown documents and the structured SKB are generated from the same accepted knowledge model.

---

## 3. Target users and key scenarios

### 3.1 Primary personas

**A. QA engineer / QAA operator**  
Needs trustworthy workflows, contracts, risk points, known tests, edge cases and dependencies to design tests and explain failures.

**B. Maintainer of a legacy system**  
Inherited a repository with limited context and needs a map of architecture, entrypoints, business logic, data flow, operational requirements and unknowns.

**C. Senior system analyst / software architect**  
Needs to accelerate reconnaissance and trace evidence, then review and correct the generated model instead of manually discovering everything from scratch.

**D. Developer joining an unfamiliar codebase**  
Needs quick answers with clickable evidence and clear separation between facts, inferences and unresolved behavior.

**E. Engineering lead / modernization planner**  
Needs dependency maps, component boundaries, risk areas, impact analysis and a versioned baseline before making changes.

### 3.2 Core user journeys

**Journey 1: First-time documentation of an undocumented codebase**
1. User points SAA at a local checkout or archive.
2. SAA explains the selected scope, excluded directories, detected languages, project boundaries and planned analysis profile.
3. User starts a read-only analysis.
4. SAA inventories files/config, builds structural facts, traces selected workflows, cross-checks tests/docs/configuration and records gaps.
5. SAA produces a summary, detailed Markdown docs, machine-readable SKB, source/revision metadata and a coverage/limitations report.
6. User reviews high-impact and low-confidence findings; optional corrections are saved as explicit analyst annotations, not silently rewritten claims.
7. QAA imports the SKB and can retrieve documented flows and contracts.

**Journey 2: Follow a business workflow**
1. User asks, “Trace account registration from UI to database and email service.”
2. Skill plans a bounded investigation and calls relevant tools.
3. SAA identifies candidate entrypoints, traces calls/data, detects branch/error paths and checks tests/configuration.
4. Results show a workflow diagram/table with evidence per hop, confidence and unknown boundaries.
5. User can request deeper investigation of any gap.

**Journey 3: QAA investigates a failed test**
1. QAA queries the SKB for the endpoint, workflow, dependencies, validation rules and relevant tests.
2. QAA analyzes the failure against known behavior and source evidence.
3. If a relationship is missing or contradictory, QAA asks SAA for a scoped follow-up investigation.
4. SAA creates candidate findings, validates them against repository evidence, versions the changes and exposes them to QAA.
5. No result is treated as authoritative until it meets the configured evidence/validation policy.

**Journey 4: Refresh after a code change**
1. SAA detects the repository revision change.
2. It computes a change set, identifies affected indexes and related graph regions.
3. It refreshes affected components and relevant workflows, then checks for stale evidence.
4. It preserves history and reports changed/removed/new findings, unresolved dependencies and impact on QAA test priorities.

### 3.3 Jobs to be done

- “Help me understand this system quickly without inventing answers.”
- “Show me where this behavior is implemented and how sure we are.”
- “Tell me what this change may impact, and what evidence supports that.”
- “Generate documentation QAA can query structurally, not just read as a long summary.”
- “Show what SAA could not prove so I know where human input or runtime observation is needed.”

---

## 4. Product architecture and delivery model

### 4.1 Recommended shape

SAA is a local-first application composed of an orchestration layer, a deterministic analysis engine, language/framework adapters, a normalized evidence and knowledge layer, document renderers, and optional interfaces. All user interfaces use the same underlying contracts.

```text
Developer / Analyst / QAA
          |
   +------+----------------+
   |                       |
SAA Skill                CLI / MCP
(investigation plan)  (execution interfaces)
   |                       |
   +-----------+-----------+
               v
       SAA Orchestrator
  (plan, tools, budgets, review)
               |
       Analysis Tool Registry
  +------------+-------------+
  |            |             |
Repo & Git  Language AST   Framework / config /
Inventory   / symbol tools  DB / API / test adapters
  |            |             |
  +------------+-------------+
               v
  Normalized Facts + Evidence Store
               |
  System Knowledge Graph / SKB
               |
  Validation, contradiction, freshness checks
               |
     +---------+-----------+
     |                     |
Markdown Documentation   Structured SKB API/export
                             |
                        QAA Integration
```

### 4.2 The four essential layers

**Layer A — Analyst Brain (reasoning workflow)**

Defines how the agent investigates: scope first, plan by uncertainty and impact, select tools, trace evidence, cross-validate, stop or deepen based on completion gates, and report limitations. It includes question decomposition, investigation heuristics, completion checks, and documentation templates. It must not contain the entire repository or hard-code the behavior of every language.

**Layer B — Tooling and analysis engine**

Performs repeatable extraction and operations: file inventory, ignore rules, manifests, parser invocation, symbol/reference lookup, dependency graphing, route/model discovery, Git diff/history, schema extraction, test inventory, graph queries, incremental invalidation, and document export. Prefer deterministic analyzers for deterministic questions.

**Layer C — Evidence and knowledge model**

Stores source facts, claims, relationships, evidence provenance, uncertainty, contradictions, scope coverage, analysis versions and generated artifacts. This layer is the durable source of truth for accepted system knowledge—not the chat transcript.

**Layer D — Delivery interfaces**

- Skill guides AI clients.
- CLI supports developers, scripts and CI.
- MCP makes the same capabilities callable by coding agents.
- Optional later API/UI can support teams and larger deployments.

### 4.3 Should SAA use a Skill, MCP, CLI or something else?

**Decision: deliver the Skill, CLI and MCP as complementary interfaces, not competing choices.**

| Interface | Primary purpose | Required? | Important boundary |
|---|---|---:|---|
| Analyst Skill | Give an AI agent the SAA investigation process and tool-use guidance | Yes for agent-led use | Instructions only; cannot replace parsing/indexing/evidence persistence |
| CLI | Install, analyze, inspect, query, diff, export and automate | Yes | Must operate without an AI agent and return stable machine-readable outputs |
| MCP server | Allow a compatible AI agent to inspect/query a target and run scoped analysis | Yes for agent integration | Thin adapter to core services; must reuse CLI/core contracts |
| Core engine + adapters | Analyze repositories and create validated outputs | Yes | Product logic and deterministic extraction live here |
| SKB + generated docs | Preserve analysis and provide the QAA handoff | Yes | Versioned, portable, inspectable, schema-validated |
| Web UI | Browse the model, review evidence and accept annotations | Later | Not required to prove the core product |
| Hosted service/team server | Shared projects, access control, centralized jobs | Later/optional | Must not be necessary for local-first operation |
| CI integration | Refresh SKB and report change impact on pull requests | Later after CLI stabilizes | Must be bounded and reliable; no expensive full scan on every invocation by default |

REA's current public project documents a related integration pattern: the agent workflow is guided by instructions, while MCP and CLI provide inspectable capabilities and evidence. SAA adopts that useful delivery pattern but prioritizes reconstructing source-code architecture, business workflows and a QAA-ready knowledge model. Reference: https://github.com/morluto/rea (reviewed 21 Oct 2026).

### 4.4 Interface requirements

**CLI (example command design; final names can be refined)**

- `saa init [path]` — create or configure SAA project metadata without modifying application source.
- `saa analyze <path> [--profile overview|standard|deep] [--json]` — run analysis; default is read-only/static.
- `saa status [path]` — show repository revision, coverage, last run, stale components and adapter readiness.
- `saa inspect <entity-id>` — show a component, function, route, model, workflow or other entity with evidence.
- `saa trace <workflow-or-entrypoint>` — trace an operation and list evidence per hop.
- `saa search <query>` — search names, docs, symbols and claims.
- `saa graph <entity-id> [--depth N]` — query dependencies and impact relationships.
- `saa docs [--format markdown]` — generate or refresh documentation.
- `saa export [--format json]` — export the SKB.
- `saa diff [base-revision]` — compare model versions and report potentially affected entities/workflows.
- `saa validate` — validate schema, evidence references, coverage, freshness and generated artifacts.
- `saa adapters` / `saa capabilities` — report supported analyzers and limitations.
- `saa doctor` — diagnose prerequisites, permissions, cache and adapter availability.

CLI output should support both human-readable and machine-readable JSON output, stable exit codes, cancellation, log redaction and a configurable output directory. Commands must not silently run target code.

**MCP server (example tool set)**

- `saa.get_system_overview`
- `saa.list_projects_and_components`
- `saa.search_code_and_knowledge`
- `saa.get_entity`
- `saa.get_evidence`
- `saa.trace_workflow`
- `saa.get_api_contract`
- `saa.get_data_model`
- `saa.get_dependencies`
- `saa.get_tests_for_entity`
- `saa.get_change_impact`
- `saa.get_unknowns_and_contradictions`
- `saa.run_scoped_analysis`
- `saa.get_analysis_status`
- `saa.refresh_knowledge`

Tool schemas must be narrow and typed. High-cost operations require explicit scope/budget and return progress/status rather than unbounded dumps. MCP should expose capabilities and side-effect levels to help clients choose safe operations. MCP server access must be scoped to configured roots; clients must not use tool arguments to access arbitrary filesystem paths outside approved roots.

**Analyst Skill contents**

- SAA role, mission, and evidence-first rules.
- Investigation lifecycle and completion gates.
- How to select tools and relevant analyzers.
- Workflow tracing method and how to treat dynamic dispatch/reflection/event handlers.
- How to distinguish fact, inference, contradiction, unknown and runtime-only observation.
- Repository prompt-injection handling rules.
- Documentation synthesis and quality-check procedure.
- QAA handoff rules and when to request follow-up analysis.
- Commands/examples for the selected CLI and MCP tools.

Skill version must state which SAA CLI/MCP capabilities it expects. Unsupported tool references must be surfaced as incompatibilities rather than silently skipped.

### 4.5 Runtime modes and permissions

| Mode | Behavior | Default |
|---|---|---|
| Inventory | List files, manifests, directories, language signals and repository metadata | Enabled |
| Static analysis | Parse/read source, configs, schemas, tests and Git metadata | Enabled |
| Dependency setup | Install missing dependencies or invoke package manager hooks | Disabled; explicit approval required |
| Test/build execution | Run test/build commands | Disabled; allowlist/approval required |
| Runtime observation | Start app/services or use browser/device to observe behavior | Disabled; explicit target and safety plan required |
| External/production access | Connect to live third-party services, production database or infrastructure | Out of scope for MVP; always explicit opt-in and policy-governed |

---

## 5. Senior System Analyst investigation methodology

SAA's “senior analyst brain” must be a repeatable process, not a vague personality prompt. It plans bounded investigations, chooses tools by the question being answered, manages uncertainty and has explicit quality gates.

### 5.1 Investigation lifecycle

**Phase 0 — Scope and safety**
- Identify the repository root(s), requested scope, exclusions, and allowed operations.
- Record the current Git commit or a stable repository fingerprint, working-tree status and timestamp.
- Read `.gitignore`, relevant ignore files and SAA-specific exclusions, while allowing explicit overrides.
- Detect potentially sensitive files before storing or sending contents to any model.
- Treat all source and documentation as untrusted data, not instructions.
- Establish budgets for files, tokens, CPU/time, recursion depth and optional runtime activity.

**Phase 1 — Reconnaissance**
- Inventory directories and file types.
- Detect programming languages, manifests, lockfiles, build systems, frameworks, test tools, migrations, IaC and deployment definitions.
- Identify likely project boundaries and entrypoints: web apps, API servers, worker processes, CLI apps, scheduled jobs, libraries, frontend bundles and infrastructure packages.
- Read package manifests and scripts as metadata without executing them.
- Record missing dependencies and available analyzers.

**Phase 2 — Structural model**
- Extract modules/packages, symbols, imports, references, class/function declarations, routes/controllers, schemas/models, event handlers, task schedulers and test files.
- Build dependency and containment graphs.
- Detect generated code, vendored dependencies, build outputs and duplicate/parallel versions.
- Do not merge separate projects solely because names, framework or API paths look alike.

**Phase 3 — Architecture and boundary reconstruction**
- Identify user/client entrypoints, service boundaries, API gateways/proxies, auth providers, persistence stores, queues, scheduled jobs and external services where supported by evidence.
- Reconstruct frontend-to-backend, service-to-service and code-to-data links.
- Determine which links are established by source references, configuration, deployment files, tests or runtime observations.
- Mark links that end at unavailable repositories or third-party systems as external/unverified.

**Phase 4 — Workflow and behavioral reconstruction**
- Select important workflows by explicit user request, exposed route/command, tests, business-critical naming, data mutations and observed change history.
- Trace entrypoint → validation/authentication → orchestration/service → data reads/writes → side effects → result/error handling.
- Include relevant alternate branches, authorization failures, retries, transaction boundaries, exceptions, timeouts and idempotency behavior when evidence is available.
- Use call/reference indexes and parsers before LLM-driven reading; follow dynamic calls, dependency injection, event emitters, reflection or callbacks with appropriate specialized analysis.
- Keep workflow paths bounded and mark unresolved hops rather than pretending they are complete.

**Phase 5 — Business-rule and contract extraction**
- Extract concrete validation constraints, state transitions, authorization checks, feature flags, defaults, enum/status transitions, API request/response shapes, database constraints and error contracts.
- Infer business concepts only when supported by multiple signals; label uncertain domain interpretation as inferred.
- Compare code with tests, docs, schemas, migrations, config and history. Record contradictions explicitly.
- Separate technical rules (“rejects empty email string”) from business intent (“only employees may register”) unless the business meaning is explicit.

**Phase 6 — Cross-validation and challenge**
For important claims, ask:
- What evidence directly supports this claim?
- Is there another implementation path or override?
- Is the observed definition generated, dead, feature-flagged or environment-specific?
- Do tests/docs/schema/config contradict the code?
- Does the conclusion cross a repository/service boundary that cannot be inspected?
- Is it valid only for a specific commit or execution?
- Could a name/comment have misled interpretation?

The system must be able to downgrade or split a claim when evidence conflicts. Runtime observation can verify what occurred in a particular run, but does not prove all paths behave identically.

**Phase 7 — Synthesis and quality gates**
- Build documentation from accepted findings and unresolved questions from the same SKB.
- Validate every source reference against the analyzed revision and output schema.
- Report coverage by project, language, adapter, directory and requested workflow.
- Run consistency checks: missing evidence, broken links, duplicated entities, contradictions, stale facts and unlinked major boundaries.
- Produce an executive summary with explicit limitations and the recommended next investigations.

**Phase 8 — Knowledge handoff and refresh**
- Publish a versioned SKB and human documentation set.
- Expose a stable, queryable interface to QAA.
- On code change, invalidate affected claims and edges, recompute impacted workflows and preserve history.
- Accept analyst annotations as a distinct provenance type and never misrepresent human input as source-verified fact.

### 5.2 Planning strategy: investigate by value, not by file order

The analyst planner should prioritize questions using a transparent heuristic rather than exploring every file equally. Inputs include business/user criticality, exposed interfaces, data mutation, external dependencies, number of unresolved links, change frequency, test importance and uncertainty. The initial implementation can use rules; the LLM can propose a plan, but the plan must respect explicit budgets and permissions.

Each investigation task should include:
- Question/claim being investigated.
- Current evidence and unresolved links.
- Candidate tools/adapters.
- Scope and time/token/file budgets.
- Expected output and evidence requirement.
- Side-effect level.
- Stop condition.

### 5.3 Completion criteria for a workflow trace

A trace may be labeled **complete within static-analysis scope** only when:
1. Its entrypoint is identified and evidence-linked.
2. Every reported internal hop has a source-backed relation or a clear inference label.
3. Key data reads/writes and side effects are identified where supported.
4. Relevant validation/auth boundaries and major error branches are addressed or explicitly marked unknown.
5. External/unavailable boundary transitions are clearly labeled.
6. Contradictory evidence is recorded.
7. The trace records source revision and analyzer coverage.

“Complete within static-analysis scope” does not mean that all runtime paths or production behavior have been proven.

---

## 6. Analysis capabilities and adapter strategy

### 6.1 Core capabilities

1. Repository/file inventory and ignore rules.
2. Language/framework/build tool detection.
3. Project-boundary and monorepo detection.
4. Package/dependency analysis, including lockfiles and workspace definitions.
5. Syntax-tree parsing and symbol/reference extraction.
6. Module/import/dependency graph construction.
7. Framework-aware routes, controllers, middleware, dependency injection and configuration extraction.
8. API contract discovery from code and schema files, with confidence/coverage annotations.
9. Database model, migration, DDL, ORM mapping and query extraction.
10. Authentication, authorization, session, cookie and identity-provider flow mapping where code/config supports it.
11. Business workflow tracing across controllers, services, repositories, event handlers and jobs.
12. External integration discovery: HTTP clients, queues, messaging, storage, email/SMS, SDKs and webhooks.
13. Test inventory and mapping from tests to source entities/contracts/workflows.
14. Deployment and configuration analysis: Dockerfiles, Compose, CI pipelines, reverse proxies, environment variables (names only by default), infrastructure-as-code and service ports.
15. Git change history and likely ownership/change-hotspot signals, with no assumption that history proves intent.
16. Evidence and contradiction management.
17. Markdown documentation generation and SKB export.
18. Incremental refresh, revision diff and impact analysis.
19. Optional approved runtime observations and test outputs in later phases.

### 6.2 Language and framework strategy

SAA should detect a broad range of languages from file signatures and manifests, but advertise different support levels per adapter:

- **Level 0 — Detect:** recognizes language/framework/project indicators and reports coverage gaps.
- **Level 1 — Inventory:** identifies project files, manifests, dependencies, entrypoints and approximate structure.
- **Level 2 — Structural:** parses syntax, symbols, references and imports/calls where supported.
- **Level 3 — Framework-aware:** extracts routes, dependency injection, ORM mapping, jobs, events and relevant framework conventions.
- **Level 4 — Cross-boundary workflow:** reliably relates supported components across application/service boundaries with evidence and known limitations.

Proposed initial priority (final priority can be changed based on actual user repositories):

1. JavaScript/TypeScript and common web frameworks/runtimes.
2. SQL, JSON/YAML/TOML/env-example, Docker/Compose, common proxy and CI configuration.
3. Python web services and task workers.
4. PHP frameworks, Java/Spring, C#/.NET and Go in staged adapters.
5. Additional languages/frameworks based on actual demand: Ruby, Kotlin, Rust, C/C++, Swift, Dart and others.

The normalized data model is language-agnostic. Adapters can use Tree-sitter or another parser for syntax, LSP/indexers for symbols/references, and framework-specific logic for semantic behavior. Parsing alone must not be used to claim that a dynamic call or runtime route is definitely connected. Each adapter declares supported entities/relations, prerequisites, limitations and version.

### 6.3 Tool selection rules

- Use a deterministic tool for exact inventory, counts, manifest values and line-based evidence.
- Use parser/AST tools for syntax and symbols.
- Use framework adapters for semantic conventions such as decorators, routing, DI and ORM mappings.
- Use LSP/indexes for references and definitions when available.
- Use Git tools for revision/change evidence, not as proof of business intent.
- Use the LLM for investigation planning, interpretation of extracted evidence, cross-source synthesis and proposing next questions.
- Do not ask the LLM to simulate repository-wide search by guessing from a few files.
- Cache tool results by repository revision, file fingerprint, tool/adapter version and relevant configuration.

---

## 7. System Knowledge Base (SKB)

### 7.1 Requirements

The SKB is the durable, machine-readable source of accepted system knowledge. It must be queryable, versioned, schema-validated, portable, diffable and suitable for programmatic use by QAA. Markdown documents are views generated from the SKB; they are not the only stored output.

### 7.2 Core record types

**System / Project** — root, repository identity, revision, worktree state, project boundaries, detected stacks, analysis profile, tool versions, timestamps and coverage.

**Entity** — a node in the system model. Examples: application, package, module, source file, function, class, route, API operation, request/response schema, database table/column/index, ORM model, business concept, workflow, test, configuration key, scheduled job, queue/topic, external service, deployment unit or secret reference.

**Relationship** — typed connection between entities. Examples: `CONTAINS`, `IMPORTS`, `CALLS`, `REFERENCES`, `EXPOSES`, `CONSUMES`, `READS_FROM`, `WRITES_TO`, `PUBLISHES`, `SUBSCRIBES_TO`, `AUTHENTICATES_WITH`, `AUTHORIZES_WITH`, `VALIDATES`, `CONFIGURED_BY`, `DEPLOYED_AS`, `TESTS`, `USES_SCHEMA`, `DEPENDS_ON`, `TRIGGERS`, `SENDS_TO`.

**Evidence record** — source or observation supporting a fact/claim. Includes artifact type, source path or external reference, start/end location or structured selector, repository revision, source fingerprint, analyzer/tool, extractor version, timestamp, evidence excerpt or digest according to privacy policy, and verification method.

**Claim** — an interpretable statement such as “POST /accounts creates an account record after validating the request.” It links one or more evidence records and records status, confidence rationale, scope and caveats.

**Workflow** — an ordered/branched sequence of steps with entrypoint, transitions, key decisions, reads/writes, side effects, errors, external boundaries, tests and unresolved hops.

**Coverage item** — records what was analyzed, skipped, unsupported, failed or partially analyzed and why.

**Open question / contradiction** — explicit unresolved requirement, ambiguous mapping, conflicting evidence, missing external dependency, stale claim or likely mismatch between docs, tests and code.

**Analyst annotation** — a human-provided correction, business-context note or approval, separately identified from analyzer evidence.

### 7.3 Required provenance and statuses

All evidence-backed entities and claims must retain source revision and provenance. Allowed statuses include:

- `source_verified` — directly established by source/config/schema evidence in the recorded revision.
- `runtime_observed` — observed during a specific approved run, with environment/run metadata.
- `test_verified` — a test result supports the claim under the recorded test setup; it does not prove untested paths.
- `inferred` — plausible interpretation based on cited evidence but not directly established.
- `contradicted` — credible evidence conflicts with the current claim.
- `unresolved` — available evidence is insufficient to decide.
- `stale` — source/revision changed and the claim has not been revalidated.
- `human_asserted` — supplied by an analyst/stakeholder; not source-verified unless later independently verified.

Confidence should be accompanied by a rationale such as direct AST relation, framework convention, cross-file correlation, test evidence, inferred naming or incomplete boundary. The system must not use a simple LLM confidence score as its only evidence-quality mechanism.

### 7.4 Stable identifiers and versioning

- Every record has a stable semantic ID where possible and revision-specific identity where necessary.
- Source locations include relative path, line/column or structural selector, file fingerprint and repository revision.
- Renames should be linked when continuity is reasonably detected; uncertain rename mapping must be reported.
- The SKB schema has an explicit `schema_version` and supports migrations.
- Analysis runs have IDs, tool/adaptor versions, run profile, scope, completion status and warnings.
- The system preserves model snapshots/diffs to show newly discovered, changed, removed, contradicted and stale claims.
- An export must not silently merge evidence from incompatible revisions.

### 7.5 Example SKB claim

```json
{
  "schema_version": "1.0",
  "system_id": "system:example-app",
  "repository": {
    "revision": "<commit-or-content-fingerprint>",
    "analysis_run_id": "run:2026-10-21T00:00:00Z"
  },
  "claims": [
    {
      "id": "claim:account-create-persists",
      "text": "The account creation handler writes an account record after request validation.",
      "status": "source_verified",
      "confidence_rationale": "Handler-to-service call and repository write are linked by structural references; validation call is in the same traced path.",
      "subject_entity_id": "route:POST:/accounts",
      "relationship_ids": ["rel:route-invokes-service", "rel:service-writes-account"],
      "evidence_ids": ["evidence:handler-12-38", "evidence:service-40-71"],
      "scope": "static-analysis",
      "caveats": ["External email delivery is not verified by this claim."],
      "last_validated_revision": "<commit-or-content-fingerprint>"
    }
  ],
  "open_questions": [
    {
      "id": "question:account-email-delivery",
      "question": "Is account confirmation email delivery required in all production environments?",
      "status": "unresolved",
      "reason": "Email client call is present, but provider availability and deployment configuration are external to the analyzed repository.",
      "related_entity_ids": ["route:POST:/accounts", "service:email-client"]
    }
  ]
}
```

The example is illustrative, not a finalized schema contract. The engineering specification must define JSON Schema (or an equivalent typed schema), required fields, ID strategy, compatibility rules and validation errors before the production implementation.

### 7.6 Storage strategy

MVP should prefer a simple local artifact layout and avoid requiring a server database:

- `.saa/manifest.json` — analysis metadata, scope, adapters, revisions and output versions.
- `.saa/index/` — disposable parser/index/cache data, safely rebuildable.
- `.saa/knowledge/` — canonical structured SKB or normalized partitioned files.
- `docs/saa/` — generated Markdown documents.
- Optional graph/index database may be added when performance requires it; it must remain rebuildable from canonical SKB data.

Default behavior should avoid placing sensitive source excerpts in committed output. Generated docs and SKB can contain internal architecture details, so SAA must warn before writing files into a repository or exporting artifacts. Output directory and ignore behavior should be configurable. Whether output is committed into the target repo or stored externally is a user decision.

---

## 8. Generated documentation specification

SAA should generate a coherent set of documents from the SKB. Exact file names are configurable, but the baseline structure is:

| File | Purpose | Required content |
|---|---|---|
| `00-executive-summary.md` | Entry point for new readers | System summary, project boundaries, major components, key workflows, coverage, limitations, high-risk unknowns |
| `01-system-context.md` | External context | Actors, applications, external services, trust/boundary notes and evidence-backed system context |
| `02-architecture.md` | Architecture view | Containers/apps/services/modules, dependency relationships, deployment boundary evidence and diagrams |
| `03-project-inventory.md` | Repository map | Languages, frameworks, manifests, entrypoints, build/test commands observed as configuration, generated/vendor files, coverage and unsupported areas |
| `04-components.md` | Component catalog | Responsibility inferred from code, public interfaces, dependencies, data stores, owners if explicitly provided, key files and evidence |
| `05-workflows/` | Business/technical workflow catalog | One document per selected workflow, step-by-step trace, branches, reads/writes, side effects, error paths, tests, confidence, unknown hops |
| `06-api-contracts.md` | API surface | Methods/routes, auth, request/response schemas, status/error responses, validation and source locations |
| `07-data-model.md` | Persistence model | Tables/models/fields, relations, migrations, constraints, query links, transactions where visible, sensitive-data caveats |
| `08-authentication-authorization.md` | Identity/access control | Login/session/token/cookie handling, middleware, authorization checks, role/permission mapping and gaps |
| `09-integrations-and-events.md` | External systems and async paths | HTTP clients, SDKs, queues, topics, events, webhooks, retries/timeouts if defined, missing external evidence |
| `10-configuration-and-deployment.md` | Operational configuration | Required variable names, config precedence if discoverable, ports, routes/proxy, containers, build/deploy pathways; redact values by default |
| `11-tests-and-quality-coverage.md` | Testing map | Test frameworks, test locations, source/workflow mappings, uncovered model areas, test execution status only when actually run |
| `12-dependencies-and-impact.md` | Change impact | Major dependency graph, cycles, hotspots, change-history evidence and relevant downstream edges |
| `13-risks-and-contradictions.md` | Risks | Explicit mismatches, fragile/dynamic boundaries, unsupported analyzers, stale evidence, potential coupling and risk rationale |
| `14-unknowns-and-next-investigations.md` | Known gaps | Questions, missing repositories/services, contradictory sources, low-confidence claims, suggested evidence or human input needed |
| `SKB.json` (or versioned bundle) | QAA input | Structured entities, relationships, claims, evidence, workflows, coverage and run metadata |

Every document must include the analyzed revision, analysis date, profile, applicable coverage caveats, and links/references to evidence or SKB identifiers. If a section could not be analyzed, document the gap instead of omitting it silently. Diagrams must be generated from structured relationships where possible, rather than drawn independently and allowed to drift.

---

## 9. QAA integration contract

### 9.1 Responsibility split

**SAA owns:** repository understanding, codebase inventory, architecture reconstruction, workflow/contract evidence, knowledge versioning, uncertainty/contradiction handling and documentation generation.

**QAA owns:** test strategy, test-case generation, test execution when permitted, assertions, defect triage, regression prioritization and QA reporting.

**Shared responsibility:** scoping follow-up investigations and correlating test failures with system knowledge. Shared work must not blur which agent produced or verified a claim.

### 9.2 QAA consumption requirements

QAA must be able to retrieve, via file bundle or programmatic API:
- system/project boundaries and detected stack;
- workflow traces with entrypoints, transitions, branches, data effects, external dependencies and unknowns;
- API request/response/error contracts and auth requirements;
- data models, state/status transitions and validation rules;
- source-to-test mapping and existing test inventory;
- dependencies and potential change impact;
- evidence references and status for every important claim;
- freshness metadata and whether a finding is stale;
- contradictory evidence and unresolved questions.

QAA should not have to parse an unstructured summary to answer basic queries. The SKB must support stable IDs, typed relations and machine-readable contract fields.

### 9.3 QAA workflow using SAA

1. At the start of a QA job, QAA checks SKB compatibility and freshness against the source revision under test.
2. QAA asks for the relevant workflow/contracts/risk nodes rather than loading the entire repository knowledge base into context.
3. QAA derives tests and traceable expected behavior from supported claims. Inferred claims may generate exploratory tests but must not be presented as confirmed requirements.
4. When a test fails or evidence is missing, QAA can request a bounded SAA investigation with the failing route/function/workflow and source revision.
5. SAA returns a candidate update with evidence, status, caveats and the reason it changes the model.
6. Policy determines whether the update is auto-accepted for low-risk source facts or must be reviewed; contradictions and business-intent questions require heightened review.
7. QAA records which SKB version was used for the test run so results are reproducible.

### 9.4 QAA API/contract requirements

The first production integration can use versioned JSON files plus a local query library. MCP tools are a convenience for agent interaction, not the only integration mechanism. The interface must include:
- schema version and compatibility policy;
- system ID, repository revision and analysis run ID;
- typed entity/relationship queries;
- workflow and contract query methods;
- evidence retrieval and line ranges;
- stale/coverage status;
- safe bounded follow-up analysis request;
- machine-readable errors and unsupported-capability responses.

---

## 10. Functional requirements

Priority definitions: **P0 = required for MVP**, **P1 = next release**, **P2 = later**.

| ID | Requirement | Priority | Acceptance condition |
|---|---|---:|---|
| SAA-FR-001 | Repository discovery | P0 | Detect root, files, manifests, VCS/revision metadata and excluded areas; report unreadable or skipped files |
| SAA-FR-002 | Project boundary detection | P0 | Identify candidate applications/packages in a monorepo and preserve separate boundaries with supporting evidence |
| SAA-FR-003 | Language/stack detection | P0 | Provide language/framework inventory and adapter coverage levels; unknown formats are not silently mislabeled |
| SAA-FR-004 | Read-only static analysis | P0 | Default analysis never executes application or package scripts and does not change source files |
| SAA-FR-005 | Structural extraction | P0 | Extract modules/symbols/imports/references for initial supported languages and record parser errors/coverage |
| SAA-FR-006 | Dependency graph | P0 | Build a graph of project/module dependencies with evidence and revision metadata |
| SAA-FR-007 | API/interface extraction | P0 | Extract supported route/endpoint/schema/interface definitions and link them to source evidence |
| SAA-FR-008 | Data model extraction | P0 | Extract supported schema/migration/ORM relationships and distinguish declared vs inferred mappings |
| SAA-FR-009 | Workflow tracing | P0 | Trace user-selected workflows/entrypoints across supported internal components; unresolved hops remain explicit |
| SAA-FR-010 | Evidence provenance | P0 | Every material claim/relationship has source revision and evidence or is labeled inferred/unresolved |
| SAA-FR-011 | Contradictions and unknowns | P0 | Preserve incompatible code/docs/test evidence and generate actionable unresolved questions |
| SAA-FR-012 | SKB schema/export | P0 | Generate schema-validated, versioned machine-readable output with stable IDs and analysis metadata |
| SAA-FR-013 | Markdown docs | P0 | Generate baseline document set from SKB, including coverage and unknowns |
| SAA-FR-014 | CLI | P0 | Run overview/deep analysis, inspect, trace, validate and export without an AI client |
| SAA-FR-015 | QAA read interface | P0 | QAA can query workflows, contracts, dependencies, evidence, freshness and unknowns programmatically |
| SAA-FR-016 | Skill package | P0 | Includes investigation methodology, tool-use policy, evidence rules, security instructions and supported command examples |
| SAA-FR-017 | MCP server | P0 | Exposes core query/analysis workflows using the same engine, typed outputs, scoped roots and operation permissions |
| SAA-FR-018 | Secret-safe output | P0 | Sensitive values are not copied into logs/docs/SKB by default; findings use redacted references |
| SAA-FR-019 | Prompt-injection resistance | P0 | Instructions in repo files cannot authorize tool actions, alter policy or expand scope |
| SAA-FR-020 | Unsupported/missing dependency handling | P0 | Partial analysis succeeds where possible and reports exact failed/skipped capabilities and consequences |
| SAA-FR-021 | Incremental reanalysis | P1 | Recompute changed/affected entities and mark stale claims after revision changes |
| SAA-FR-022 | Git change/history signals | P1 | Provide evidence-linked revision diffs/hotspots without treating commit messages as ground truth |
| SAA-FR-023 | Test mapping | P1 | Link supported tests to source entities/workflows and distinguish discovered tests from actually executed tests |
| SAA-FR-024 | Optional runtime observation | P1 | Requires explicit approval, target and profile; captures environment/run boundaries and side effects |
| SAA-FR-025 | Review/annotation flow | P1 | Human annotations are separately attributed, versioned and never mislabeled as source evidence |
| SAA-FR-026 | CI impact report | P2 | Changed revision yields a bounded impact report using cached graph/index where possible |
| SAA-FR-027 | Review UI | P2 | Users can navigate evidence, review contradictions and approve annotations |
| SAA-FR-028 | Team/hosted operation | P2 | Optional service with defined access control, storage policy and source-data handling |

### 10.1 Minimum user-visible outputs

At the end of each run, SAA must return:
- analysis status: completed / completed with limitations / partial / failed;
- target identity and revision;
- detected projects, languages, frameworks and analyzer levels;
- files inspected, skipped, generated or excluded (summarized, not necessarily every path in console output);
- entities/relationships/claims/workflows discovered;
- evidence quality and freshness summary;
- major contradictions and unknowns;
- generated artifact locations;
- exact failed prerequisites and recommended next steps;
- whether any optional action was executed (tests/build/runtime), with explicit authorization metadata.

---

## 11. Non-functional requirements

### 11.1 Correctness and auditability
- Claims must be traceable to evidence or explicitly labeled as inferred, unresolved, contradictory or human asserted.
- SKB output passes schema validation before being considered publishable.
- Evidence paths and revisions must be checked; invalid or stale references must be flagged.
- Analysis must be reproducible enough that the same source, configuration and analyzer versions yield materially consistent extracted facts. LLM-written prose may vary, but canonical facts/IDs must not churn unnecessarily.
- Generated docs and machine outputs derive from the same canonical SKB.

### 11.2 Performance and scalability
- Use streaming, indexes and bounded context rather than placing the whole repository in an LLM prompt.
- Support cancellation and progress reporting.
- Cache deterministic analysis by file/revision fingerprint and analyzer version.
- Use incremental analysis when the repository changes; retain a full-rescan option.
- Set configurable limits for huge repositories, generated files, lockfiles, dependency directories, binary artifacts and deeply nested folders.
- Publish baseline performance targets only after measuring representative repositories; do not promise arbitrary fixed durations before benchmarks exist.

### 11.3 Portability
- The CLI should support at least the operating systems selected for the project's initial distribution plan; OS support must be explicit and tested.
- Local operation should not require a hosted SAA account.
- Adapter/tool prerequisites must be visible and checked by a diagnostics command.
- SKB and Markdown outputs must be portable between environments without dependence on an internal server.

### 11.4 Reliability
- A failed adapter must not corrupt accepted SKB data or prevent unrelated supported analysis from finishing.
- Analysis should support resumable or incremental work for large repositories.
- Tool calls have timeouts, bounded outputs and structured errors.
- A failed partial run must be marked partial, not reported as complete.
- Output generation should use temporary files and atomic promotion where practical.

### 11.5 Maintainability and extensibility
- New analyzers implement a documented adapter interface and declare capabilities/prerequisites.
- Core ontology and evidence contracts are independent from language-specific parsers.
- CLI, MCP and local query API share business logic and schema contracts.
- Adapter and SKB schema versions are recorded in every analysis.

### 11.6 Accessibility and usability
- CLI errors should state what failed, why it matters and a concrete next action.
- Documentation should use consistent terminology and provide a simple entry point for new maintainers.
- Evidence navigation should prefer relative paths, line/column references and entity IDs.

---

## 12. Security, privacy and operational safety

### 12.1 Threat model

SAA reads potentially sensitive source code and untrusted project content. Risks include secret leakage, path traversal, prompt injection through repository text, accidental execution of hostile package scripts, access outside the approved root, destructive side effects from runtime tests, and generated documentation exposing security-sensitive architecture.

### 12.2 Required controls

1. **Root sandboxing:** every file access must resolve within explicitly approved repository roots unless a separate dependency root is authorized. Resolve symlinks safely and detect path traversal.
2. **No execution by default:** do not run project scripts, install packages, run migrations, start services or connect to live external systems in standard analysis.
3. **Explicit escalation:** runtime/test/build/dependency operations require named scope, clear side-effect summary, user approval and a bounded command/tool allowlist.
4. **Secret redaction:** detect likely credentials, tokens, private keys and secret values. Store references/variable names or redacted indicators, not raw values, by default. Avoid placing secrets in LLM context, traces, logs or docs.
5. **Prompt-injection separation:** repository files are data. Tool results cannot supply new instructions that change permissions, roots or safety policies. The agent must not follow embedded commands in comments, README files, issues or test fixtures.
6. **Local-first processing:** no source upload to a hosted service by default. When using a remote LLM provider, disclose that selected context may be sent by the host; allow users to configure redaction/exclusions and a no-remote-model mode where practical.
7. **Output safety:** warn that generated docs/SKB may reveal routes, topology and internal details. Respect output path and ignore rules; do not overwrite existing artifacts without configured behavior or confirmation.
8. **Least privilege:** MCP tools use narrow capabilities, scoped roots and separate read-only vs execution permissions. Do not expose an unrestricted shell tool as the default analysis interface.
9. **Audit trail:** record optional command/runtime actions, approvals, target scope and tool version without logging secret values.
10. **Dependency integrity:** avoid automatic tool installers in unattended runs; pin or record adapter/tool versions and verify downloaded assets according to distribution policy.

### 12.3 Sensitive-data handling

- Environment files may be inventoried as existing, but raw values should not be copied to SKB or documentation by default.
- `.env.example`, schema and config keys may be described with value redaction.
- Source evidence excerpts are subject to a maximum length and redaction policy; storing a line reference plus digest may be preferable for sensitive findings.
- User must be able to exclude directories/files and select whether internal evidence snippets are included in exports.
- Deleting an analysis cache should remove cached source excerpts and indexes according to documented retention semantics.

---

## 13. Edge cases and failure behavior

| Case | Expected behavior | Must not do |
|---|---|---|
| Monorepo with multiple apps | Detect candidate boundaries, analyze each separately, add only evidence-backed cross-project edges | Collapse apps into one system based on names alone |
| Multiple versions of frontend/backend | Preserve version labels, entrypoints, API prefixes and deployment routes separately | Treat V1 and V2 as one implementation by default |
| Polyglot repository | Use per-language adapters plus shared IDs and relation types; mark unsupported cross-language hops | Pretend every language has equal semantic coverage |
| Missing dependencies or unbuildable project | Continue static analysis; report skipped framework features and reasons | Fail the entire analysis unless the unsupported dependency is essential |
| Generated code/vendor/build artifacts | Classify, exclude or analyze according to policy; retain evidence for why excluded | Flood workflow documentation with generated or vendored internals |
| Dynamic dispatch/reflection/DI/decorators | Use framework/LSP/runtime evidence where available; label uncertain links | Turn naming similarity into a verified call edge |
| Event-driven/asynchronous system | Model publishers, event names/topics, handlers, queues, retry/dead-letter config where visible | Assume synchronous execution order when code does not guarantee it |
| Circular imports or dependency cycles | Record cycles and visualize them; do not loop indefinitely | Stall analysis or arbitrarily delete edges |
| Missing external repository/service | Keep an external node and unresolved boundary; document expected contract if visible | Invent third-party implementation details |
| Conflicting docs and code | Preserve both evidence sources and create a contradiction record | Silently treat README/comment as authoritative |
| Tests disagree with implementation | Record test claims, observed test results if actually run, and implementation evidence separately | Assume tests prove production behavior or are always current |
| Feature flags/environment-specific behavior | Represent conditional behavior and config source; scope claims to known config | State one branch is universally active without evidence |
| File rename/reorganization | Attempt stable entity linking with rationale; mark uncertain mappings | Silently map unrelated entities under the same ID |
| Extremely large repository | Prioritize entrypoints and high-value boundaries, paginate and cache, report unvisited scope | Claim full coverage after budget exhaustion |
| Binary/non-text files | Use supported metadata analyzers or explicitly skip them | Feed arbitrary binary bytes to an LLM as if readable source |
| Malicious instructions in code/comments/docs | Treat as untrusted input, quote only necessary evidence and keep policy boundaries | Execute embedded commands or reveal secrets because a file requested it |
| Secrets in config or code | Redact and record location/type only when useful | Put raw credentials in docs, logs, prompts or SKB |
| Corrupt syntax/parser failure | Preserve diagnostics, attempt tolerant parsing where supported, mark partial coverage | Fabricate AST relations from malformed input without qualification |
| Stale SKB | Mark claims/edges stale and refresh affected regions before QAA relies on them | Present old knowledge as current for a new commit |
| Interrupted run | Mark partial and resume/retry safe stages | Publish a partial model as completed |
| Unavailable language adapter | Report detect-only/unsupported status and propose a bounded next step | Hide missing coverage behind a generic overview |
| Optional runtime/test operation fails | Preserve static result; attach run error and environment metadata | Interpret failure to start as proof the application is broken in production |

### 13.1 Failure status taxonomy

- `completed`: required planned tasks succeeded with no material coverage caveat.
- `completed_with_limitations`: core result is useful, and known skipped/unsupported areas are disclosed.
- `partial`: major scoped work remains incomplete due to budget, tool or parsing failure.
- `failed`: no trustworthy usable result could be produced for the requested operation.
- `cancelled`: user or caller cancelled the run; partial artifacts are labeled accordingly.

---

## 14. Acceptance criteria and evaluation plan

### 14.1 Validation philosophy

SAA must be evaluated against labeled benchmark repositories and expert review, not vague claims such as “understands the whole codebase.” Metrics should measure both what SAA discovers and whether it clearly states what it cannot know. Numeric thresholds should be committed only after collecting a baseline on representative repositories; no arbitrary accuracy target should be used to hide weak coverage.

### 14.2 Benchmark suite

Build a versioned corpus containing at least these cases:
1. Small documented single-language web app with tests.
2. Undocumented legacy application with mixed patterns and dead code.
3. Monorepo containing multiple independent frontends/services.
4. Multi-language frontend/API/worker/database migration stack.
5. Repository with dynamic framework conventions, dependency injection and reflection.
6. Event-driven service with queues, handlers and scheduled jobs.
7. Missing dependencies and failed build environment.
8. Contradictory implementation, comments, README and tests.
9. Generated/vendor files and duplicate symbols.
10. Secrets and intentional prompt-injection strings in source/docs.
11. External API with contract visible but implementation inaccessible.
12. Large repository with budget exhaustion and incremental change.
13. Source revision changes that rename, remove or move high-impact entities.
14. Optional runtime case where a safe disposable environment can be created.

### 14.3 Metrics

- **Inventory coverage:** proportion of eligible files/projects classified correctly.
- **Boundary quality:** expert-reviewed precision/recall of application/service boundaries.
- **Extraction correctness:** accuracy of symbols, imports, routes, models and schema facts for supported adapters.
- **Relationship quality:** precision/recall for calls, data flow, dependency and cross-component edges against labeled cases.
- **Workflow trace quality:** expert review of completeness, branch coverage, correct ordering and unsupported-hop labeling.
- **Evidence traceability:** percentage of material claims with valid, relevant source evidence and correct revision.
- **Uncertainty calibration:** whether ambiguous/unsupported claims are labeled uncertain instead of confidently invented.
- **Contradiction detection:** ability to identify controlled disagreements between source/docs/tests/configuration.
- **Freshness correctness:** stale entity and edge invalidation after code changes.
- **Security behavior:** no out-of-root access, unauthorized target execution, secret disclosure or prompt-injection policy override in adversarial tests.
- **QAA usefulness:** whether QAA can answer defined queries and derive traceable tests without loading the entire source tree.
- **Cost/performance:** wall-clock time, resource use, model tokens/cost and cache hit rate by repository size/profile.
- **Document usefulness:** human reviewer scores for clarity, navigation, correctness and actionable unknowns.

### 14.4 MVP release gate

MVP is acceptable only when:
- The CLI analyzes a repository without an AI coding agent connected.
- Default operation is read-only/static and does not execute scripts.
- Core supported stack is detected with coverage levels and explicit unsupported areas.
- Project boundaries and basic dependency graphs are constructed for benchmark monorepos.
- Selected workflows can be traced with evidence on each internal hop or explicit unresolved labels.
- SKB schema validation passes and every important claim is evidence-backed or classified accordingly.
- Markdown docs and SKB share the same source model and revision metadata.
- QAA can query workflows, contracts, dependencies, evidence, unknowns and freshness.
- Prompt injection and secret-redaction tests pass the agreed security suite.
- Partial/failure states cannot be confused with complete analysis.
- Rendered documentation is navigable and does not expose raw secrets by default.
- Representative benchmark results and known limitations are published with the release.

---

## 15. Roadmap and release boundaries

### Phase 0 — Foundation and schema (architecture spike)

**Objective:** prove the knowledge contract and core investigation workflow before adding many analyzers.

Deliverables:
- SKB schema, IDs, evidence model, claim statuses and schema validation.
- Repo inventory and revision/fingerprint metadata.
- Adapter interface and capability reporting.
- Local output layout and deterministic CLI skeleton.
- A small benchmark corpus with known expected relationships.
- Security threat model and prompt-injection/secret-handling fixtures.

Exit gate: one small system can be analyzed, documented and queried by a simple QAA consumer with evidence links intact.

### Phase 1 — MVP: static-first SAA

Deliverables:
- CLI analyze/inspect/trace/docs/export/validate/status commands.
- Analyst Skill package.
- MCP query/analysis server reusing core contracts.
- Initial deep adapter(s) selected from actual project demand; recommended starting point is JavaScript/TypeScript and common web-stack plus SQL and deployment/config files.
- Project boundary detection, module graph, supported route/API extraction, basic persistence model, test inventory, cross-file workflow trace.
- Baseline Markdown documentation set.
- QAA file-bundle/local query integration.
- Coverage, unknowns, contradiction, provenance and security reporting.

Exit gate: QAA can consume the generated model and produce traceable QA plans on the benchmark suite.

### Phase 2 — Cross-component and legacy depth

Deliverables:
- Additional language/framework adapters based on demand.
- Improved data flow, async event/job analysis, auth/session, proxy/deployment route and API contract mapping.
- Git-aware incremental refresh and model diff.
- Better dynamic-resolution support using LSP/indexers and framework-specific resolvers.
- Test-to-source/workflow mapping and impact scoring.
- Human annotation/review workflow in CLI or lightweight UI.

Exit gate: incremental results remain correct under file moves, schema changes, config changes and multi-app updates.

### Phase 3 — Controlled runtime verification

Deliverables:
- Optional disposable-environment setup instructions.
- Explicitly approved test/build/runtime observations with side-effect plans.
- Runtime evidence records with environment/run metadata.
- Static-vs-runtime discrepancy reporting.
- Safe browser/API tracing integrations where appropriate.

Exit gate: runtime observations are reproducible, permissioned, scoped and never confused with universal behavior.

### Phase 4 — Team/CI/visual knowledge experience

Deliverables:
- CI change-impact report and pull-request summaries.
- Optional web UI for graph navigation, evidence review, contradiction resolution and coverage status.
- Team storage/access control if justified by user demand.
- Policy packs and organization-specific vocabulary.
- Additional language support based on usage data.

Exit gate: team workflows add value without compromising local-first security or increasing source-data exposure beyond explicit user policy.

### Scope guardrails

Do not attempt to implement all languages, perfect dynamic call tracing, runtime analysis, hosted collaboration and a visual graph UI in the first release. Prioritize one end-to-end product slice: analyze → evidence-backed model → docs → QAA query. The foundation should make deeper adapters additive rather than requiring an architectural rewrite.

---

## 16. Suggested engineering decomposition

The team can organize code into these packages/modules; names are illustrative:

- `saa-core`: domain types, config, orchestration interfaces, policy/budgets, run status.
- `saa-repo`: file inventory, ignore rules, Git/revision metadata, safe path resolution.
- `saa-adapters`: adapter contracts, capability descriptors and adapter registry.
- `saa-adapter-js-ts`: parser/symbol/import and selected framework extraction.
- `saa-adapter-config`: SQL, JSON/YAML/TOML, Docker/proxy/CI configuration parsing.
- `saa-knowledge`: SKB schema, IDs, store/retrieval, graph queries, versioning and migrations.
- `saa-evidence`: evidence records, source maps, redaction and provenance validation.
- `saa-workflows`: trace planning, graph traversal, bounded workflow reconstruction and cross-validation.
- `saa-docs`: Markdown templates, diagrams and link validation.
- `saa-cli`: terminal commands, config, progress, exit codes and JSON output.
- `saa-mcp`: MCP tool schemas and adapters to core services.
- `saa-skill`: investigation instructions, workflows, safety rules and usage examples.
- `saa-qaa-contract`: shared versioned schema/client interface and sample QAA queries.
- `saa-benchmarks`: synthetic/fixture repositories, expected outputs, adversarial tests and evaluation reports.

Architecture rules:
- MCP and CLI must not each implement their own graph or analysis logic.
- SKB must not depend on a particular LLM vendor.
- Analyzer adapters may be optional and independently unavailable.
- The engine must support deterministic non-LLM analysis steps.
- LLM provider integration should be an interchangeable service behind a narrow interface.
- No analyzer should gain execution/network access merely because it is registered.

---

## 17. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Overclaiming system completeness | Users and QAA trust incorrect behavior | Coverage metrics, evidence thresholds, explicit unknowns, claim statuses and benchmark validation |
| LLM hallucination across large codebase | Incorrect docs and tests | Deterministic extraction, bounded evidence context, cross-validation and mandatory evidence links |
| Adapter coverage too broad too early | Shallow/buggy analysis, long delivery | Capability tiers; start with a focused stack; publish adapter matrix; build adapters incrementally |
| Dynamic language behavior cannot be statically resolved | Missing or false edges | Use unresolved edge status, framework resolvers/LSP and optional approved runtime verification |
| Generated documentation becomes stale | QAA follows outdated contracts | Revision metadata, incremental refresh, stale statuses and QAA freshness checks |
| Monorepo components are incorrectly merged | Wrong architecture and impact report | Project boundary model and dedicated benchmark cases for independent apps/versions |
| Sensitive code leaks into model or artifacts | Security/compliance impact | Local-first default, redaction, exclusions, minimal excerpts and explicit remote provider disclosures |
| Prompt injection from repository content | Unauthorized actions or data exposure | Treat repository text as untrusted data; tool policy enforced outside LLM; no generic shell by default |
| Runtime analysis causes side effects | Data loss or external service calls | Separate permission mode, disposable environments, dry-run plans, allowlists and audit trail |
| Graph/model schema becomes too complex | Slow iteration and difficult QAA integration | Start with normalized essential entity/relationship types; version schema; expand via extensions |
| Expensive full scans | Poor adoption and workflow cost | Incremental graph, caches, profiles, budgets and query-scope limits |
| Generated docs expose security topology | Internal detail leakage | Output warnings, redaction policy, controlled output path and exclusion support |
| LLM provider changes output behavior | Inconsistent claim quality | LLM-independent canonical schema, versioned prompts/skill and regression benchmark suite |

---

## 18. Product analytics and operational telemetry

For local-first builds, telemetry is opt-in and should not collect source contents. Local run reports can measure:
- files/projects examined and skipped;
- adapter use and failure rates;
- claims/relationships/workflows emitted by type;
- unresolved/contradicted/stale claim counts;
- time/cost/cache metrics;
- output validation and QAA integration status;
- user-accepted/rejected annotations if explicit local review is implemented.

Never collect source code, raw secrets, full file paths from private repositories or generated SKB content for analytics without explicit informed consent. Product evaluation can use local benchmark results or user-exported anonymized metrics.

---

## 19. Assumptions, decisions and open questions

### 19.1 Decisions set by this PRD

1. SAA uses broad language detection with selective deep analysis per supported adapter.
2. Static-first hybrid analysis is the default; runtime observation is optional and explicitly approved.
3. SAA outputs both human-readable Markdown docs and structured SKB.
4. CLI, MCP and Skill are complementary interfaces to one analysis engine.
5. Local-first, read-only operation is the MVP default.
6. Evidence, uncertainty, contradiction and source revision are first-class model concepts.
7. QAA consumes SKB by stable schema/query contract, not by depending solely on prose.
8. SAA does not promise to infer undocumented business intent without evidence or analyst input.

### 19.2 Assumptions to validate with initial users

- The first target repositories are likely web applications/services and related database/config/deployment code.
- Markdown and JSON are sufficient output formats for MVP.
- Developers prefer local output they can inspect, diff and commit selectively.
- SAA will be used with one or more AI coding agents, so agent instructions and MCP are valuable.
- QAA will benefit from stable IDs, source references and direct local SKB access.

### 19.3 Technical/product decisions for implementation kickoff

- Which initial OS platforms must be supported in v1?
- Which language/framework adapter has highest priority based on the actual QAA repository and representative user projects?
- Which LLM provider(s), if any, are allowed by default, and can analysis be run fully without remote model calls?
- How should SKB be stored canonically at scale: JSON bundle, partitioned JSON, SQLite-backed index or a hybrid? Preserve export portability regardless.
- Should generated docs default to `docs/saa/` in the target repository, a sibling directory or an external output path? Recommended default: explicit output path with no overwrite; make in-repo generation opt-in.
- Which coding-agent Skill conventions should the first release target, and how will version compatibility be checked?
- Which test/build commands, if any, can be allowlisted for optional approved runtime mode?
- What exact QAA contract will be adopted, and who owns schema-version upgrades?

These questions do not block the architecture baseline. The first engineering spike should settle them using a thin vertical slice and benchmark repositories rather than attempting a complete multi-language engine immediately.

---

## Appendix A. Example end-to-end workflow

User request: “Document this undocumented multi-application repository and prepare knowledge for QAA.”

1. **Scope preview:** SAA lists candidate roots and independent apps, detects JS/TS, Python and SQL, reports excluded dependency directories and declares static-only mode.
2. **Index:** inventory/manifests/Git metadata are read; no package scripts execute.
3. **Structure:** parsers/indexers identify frontend routes, API handlers, service functions, models, migrations and tests where supported.
4. **Boundary model:** frontend V1, frontend V2, API V1 and API V2 remain distinct if separate routes/config/deployment evidence supports it.
5. **Workflow selection:** prioritize user-facing operations with data mutation, auth boundary, major API routes and test references.
6. **Tracing:** route → client request → proxy rule → API handler → service → repository/query → side effect. Each relation has evidence, or it is labeled unknown/inferred.
7. **Cross-check:** compare route configuration, schemas, tests and docs. Contradictory or environment-dependent details become explicit findings.
8. **Synthesis:** create overview, architecture, project inventory, API/data/auth/workflow docs, risks, tests and unknowns.
9. **Validation:** verify evidence references and schema; report unsupported adapters and stale/incomplete areas.
10. **QAA handoff:** QAA queries workflows/contracts for a planned test target and records the SKB version used.
11. **Follow-up:** a QAA failure can trigger targeted SAA analysis. Any update is versioned and evidence-backed.

## Appendix B. Example workflow trace representation

Each workflow should contain:
- `workflow_id`, name, business purpose (with confidence/status), source revision and analysis profile;
- entrypoint entity and evidence;
- ordered/branched steps with entity IDs, relation types, evidence IDs, conditions and confidence rationale;
- API/request/response and persistence effects where supported;
- authentication/authorization and validation checkpoints;
- external services/events/background jobs;
- error/timeout/retry/rollback behavior when visible;
- test IDs and existing test coverage status;
- unresolved hops, contradictions and recommended verification steps;
- status such as `complete_within_static_scope`, `partial`, `runtime_observed_for_run`, or `unresolved`.

## Appendix C. Definition of done for a generated claim

A claim is ready to publish as `source_verified` only if:
1. Its supporting evidence refers to a real file/structure at the recorded revision.
2. The evidence directly supports the narrow wording used.
3. The inference does not extend beyond the inspected scope.
4. Competing/contradictory evidence has been searched for where the claim is high impact.
5. Its scope and limitations are captured.

Otherwise it must be narrowed, labeled `inferred`, recorded as `contradicted`, or retained as `unresolved`.

## Appendix D. Glossary

- **AST:** Abstract Syntax Tree, a structured representation of source syntax.
- **Business rule:** A validation, decision, permission or state transition implemented by the system; intent may require human confirmation.
- **Evidence provenance:** Information about where a finding came from, when, and using which tool/method.
- **MCP:** Model Context Protocol; a way for compatible clients to call tools/resources.
- **QAA:** Quality Assurance Agent, the downstream consumer that performs QA planning and activities.
- **SAA:** System Analyst Agent, the source-code analysis and documentation system defined by this PRD.
- **SKB:** System Knowledge Base, the structured model shared with QAA.
- **Source-verified:** The specific implementation claim is directly supported by source/config evidence, not a guarantee about all production executions.
- **Runtime-observed:** Behavior was observed in a specific controlled execution and environment.
- **Static-first:** Static extraction is the default; execution is a separately approved mode.

## References

1. REA — Reverse Engineer Anything, public upstream repository and its current README describing agent instructions, CLI/MCP use, evidence and analysis boundaries: https://github.com/morluto/rea (reviewed 21 October 2026).
2. Model Context Protocol (MCP), official project documentation: https://modelcontextprotocol.io/ (protocol reference; exact SDK choice is an implementation decision).

---

**End of PRD v1.0**
