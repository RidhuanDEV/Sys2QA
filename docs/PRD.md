# Sys2QA — Unified Product Requirements Document

**System Analysis Agent (SAA) + Quality Assurance Agent (QAA) on one open-source platform**

---

## 1. Document control

| Field | Value |
|---|---|
| Product | Sys2QA (working name of the platform) |
| Components | SAA — System Analysis Agent; QAA — Quality Assurance Agent; shared Sys2QA platform and SAA→QAA contract |
| Document type | Authoritative unified Product Requirements Document |
| Document status | **Draft for maintainer review.** Not yet approved. Nothing described here is implemented or tested. |
| Version | 1.0.0-draft.2 |
| Last updated | 2026-10-21 |
| Supersedes (after approval) | `SAA_PRD.md` (SAA PRD, Draft v1.0, 2026-10-21) and `QAA-PRD-SAA-QAA-collaboration.md` (QAA PRD, v0.2, 2026-10-21) |
| Primary audience | Maintainers, contributors, agent/tooling developers, QA engineers, security reviewers |
| License | Not selected — see OD-09 |

### 1.1 Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| SAA PRD v1.0 (draft) | 2026-10-21 | Maintainer | Source document: SAA product and architecture baseline |
| QAA PRD v0.2 | 2026-10-21 | Maintainer | Source document: QAA product requirements with SAA integration (§26) |
| 1.0.0-draft.1 | 2026-10-21 | Consolidation | Merged both source PRDs into one product specification; defined versioned SAA→QAA contract; added reconciliation log, open decisions and traceability matrix |
| 1.0.0-draft.2 | 2026-10-21 | Maintainer review revision | Evidence-adaptive product: starting modes A–D (repository, URL, both, package); automatic workflow discovery and catalog (no workflow names required); evidence-source-neutral model and contract; shared runtime observation service; QA objectives; environment-optional QA; not a DevOps agent; outcome-sliced roadmap |

### 1.2 Source documents and preservation

The two source PRDs remain in the repository unchanged for historical traceability until this document is approved. Where this document cites a source requirement, it uses these prefixes:

| Prefix | Source |
|---|---|
| `SAA §n` / `SAA-FR-nnn` | `SAA_PRD.md` section *n* / functional requirement |
| `QAA §n` / `FR-nnn` (original) → `QAA-FR-nnn` (unified) | `QAA-PRD-SAA-QAA-collaboration.md` section *n* / functional requirement |
| `MD-n` | Maintainer direction stated in project discussion on 2026-10-21, not yet written into a source PRD (see §3.3) |
| `MR §n` / `MR-REQ-n` | Maintainer product review of draft.1 (2026-10-21): section *n* / proposed requirement REQ-*n* of that review |

### 1.3 How to read requirement status

Every normative statement in this document has one of these statuses. **A status describes the specification, not the implementation.** "Confirmed" means "confirmed as a requirement by a source document", not "built".

| Status | Meaning |
|---|---|
| **Confirmed (C)** | Present in a source PRD; may be reworded or merged without changing intent. |
| **Proposed (P)** | Introduced during consolidation to close a gap, resolve a conflict, or formalize maintainer direction. Requires maintainer approval. |
| **Deferred (D)** | Valid requirement intentionally scheduled after the MVP. |
| **Out of scope (X)** | Explicitly excluded from the product or the stated release. |
| **Assumption (A-nn)** | Belief the plan depends on, to be validated. See §31.1. |
| **Open decision (OD-nn)** | Choice requiring human resolution, with alternatives and a recommendation. See §31.4. |

Priorities: **P0** = required for the first usable MVP; **P1** = next release after the MVP vertical slice; **P2** = later. Normative keywords **must**, **must not**, **should** and **may** follow their usual specification meaning.

---

## 2. Executive summary

Sys2QA is an open-source, local-first platform for understanding and testing software that the developer did not write or does not fully understand. **The developer starts with the evidence they have; Sys2QA discovers what that evidence can establish** (MD-4). The developer does not need to know the system's architecture, workflow names or business rules beforehand (MD-5). They also do not need to deploy, provision or administer the application to get value (MD-6).

Sys2QA supports four starting conditions (SYS-001). They are one product and one pipeline with different **evidence profiles**, not separate products.

| Starting mode | Developer has | Sys2QA produces | What this evidence cannot establish |
|---|---|---|---|
| **A — Repository** | A local source directory | Source-reconstructed system model, discovered workflow catalog, documentation, scenarios, manual test packs | Behavior of any specific running environment |
| **B — URL** | An authorized development or staging URL | Observed-behavior model: reachable pages, forms, navigation, visible validation and states, candidate workflows, characterization and exploratory scenarios | Backend internals, data model, unreachable or unlinked routes, background jobs, complete authorization logic, intended business requirements |
| **C — Repository + URL** | Both | Combined model with per-claim provenance, plus discrepancies between source and observed behavior | That source and environment are the same revision or configuration, unless confirmed |
| **D — Documentation Package** | A compatible package from any mode; no repository or environment required | Readiness assessment, scenarios, manual test preparation | That the package is current or complete |

Two collaborating agents share one foundation:

- **SAA — System Analysis Agent** owns system knowledge, whatever evidence it comes from.
  - It inventories the available evidence and finds application boundaries and entry points.
  - It **discovers workflows automatically**; the user never names them first.
  - Where evidence permits, it reconstructs rules, states, permissions, contracts and integrations.
  - It records what is source-verified, runtime-observed, inferred, contradicted or unknown, including where tracing stops and why.
  - It publishes a versioned **Documentation Package** whose evidence profile states whether source analysis and runtime observation were available.
- **QAA — Quality Assurance Agent** owns quality.
  - It imports a package of any evidence profile and assesses readiness for each QA activity.
  - It derives test conditions and risks.
  - It generates scenarios whose expected results declare their basis and **QA objective**: characterization, implementation conformance, requirement conformance or exploratory.
  - It obtains human approval, then supports **manual** and **automated** execution, producing evidence-backed results and reports.
  - Manual testing never depends on automation infrastructure.

The agents are loosely coupled through a versioned contract (§13). Browser observation is a shared, scope-enforced platform service. SAA uses it for discovery, and QAA uses it for targeted verification and execution.

```text
       Local repository          Authorized URL            Existing package
              |                        |                          |
      SAA source analysis     SAA runtime discovery               |
      (static, L0–L1)         (observation, L2)                   |
              |                        |                          |
              +-----------+------------+                          |
                          v                                       |
        Unified system knowledge (SKB): evidence, provenance,     |
        scope examined, coverage gaps, contradictions             |
                          |                                       |
        Workflow catalog (discovered, never named by the user)    |
                          |                                       |
              Documentation Package (versioned) <-----------------+
                          |
              QAA readiness assessment (per QA activity)
                          |
            Test conditions, risks and QA objectives
                          |
                   Scenario generation
                          |
                Human review and approval
                          |
            +-------------+--------------+
            v                            v
      Manual testing              Automated testing
      (no extra infrastructure)   (approved, constrained, needs a reachable environment)
            +-------------+--------------+
                          v
           Results, evidence, defects and QA reports
```

**Central product principle** (MD-4 … MD-6, maintainer review 2026-10-21):

> **Start with what the developer has. Discover what the evidence can establish. Reconstruct what can be understood. Test what can be justified. Make every limitation visible.**

Both agents share one more principle: **describe and test the system as evidenced, never as a model guesses it probably works.**

---

## 3. Product vision and principles

### 3.1 Vision

Make disciplined system understanding and software testing accessible to teams that own a working application but lack current documentation, time, or specialist QA capacity — without hiding uncertainty or removing human control.

**Product promise.** Point Sys2QA at whatever you have — a repository, an authorized development URL, both, or an existing package. You do not need to know how the system works, and you do not need to deploy anything. SAA explains how the system is evidenced to work and what it could not prove. QAA explains what it believes should be tested and why, lets a person review and approve the plan, then supports guided manual testing or validated automated execution with traceable evidence.

**Mission:** Discover → Reconstruct → Verify → Document → Assess readiness → Design tests → Approve → Execute → Report → Refresh.

**Central principle:** *Start with what the developer has. Discover what the evidence can establish. Reconstruct what can be understood. Test what can be justified. Make every limitation visible.*

### 3.2 Product principles

These principles bind both agents and the shared platform. Source: SAA §2.4, QAA §2.1, MD-1, MD-2.

1. **Evidence before explanation and before confidence.** Every substantive claim, and every meaningful expected result, references evidence or is explicitly labeled as inferred, unresolved or human-asserted.
2. **Unknowns are first-class output.** Missing links are recorded as gaps, never filled with a plausible story. QAA must not fabricate model entities to make a package look complete.
3. **Separate facts, interpretations and intent.** Implementation behavior (source code), observed behavior (runtime), inferred behavior, and confirmed requirements are distinct categories throughout the product.
4. **Static-first, execution by consent.** Reading files, and observing an authorized URL without submitting data, are the defaults. Running repository code, installing dependencies or starting applications is a separate, explicitly approved permission level.
5. **Human approval before execution.** Generated scenarios do not run until a person approves the exact scenario version for a specific baseline, environment and scope.
6. **Deterministic execution.** AI proposes and interprets; a constrained executor performs only validated, schema-supported actions and assertions.
7. **Manual and automated testing are both first-class.** Manual testing is a guided human workflow, never an AI browser run relabeled as manual.
8. **Traceability end to end.** A user can follow source evidence or requirement → documentation claim → test condition → scenario version → approval → execution → result → defect → report.
9. **Self-declared authorization; no third-party acquisition (MD-1, MD-2, MD-3).** Sys2QA is intended for code and applications the user is authorized to analyze and test, and relies on the user's recorded declaration rather than ownership verification. It does not clone, download or reverse-engineer repositories or systems. Possession of a URL, a checkout or credentials is never treated as approval for destructive testing; state-changing tests require explicit, version-bound approval.
10. **Repository and web content are untrusted data.** Text in source files, documentation, web pages and API responses cannot change policy, scope or permissions.
11. **One core per agent, multiple interfaces.** SAA's CLI, MCP server and Skill use one engine; QAA's UI and API use one service layer. No interface duplicates analysis or execution logic.
12. **Local-first, provider-neutral, open.** No hosted service or specific LLM provider is required to run the core workflow. Source code and credentials are not sent to external services by default.
13. **No silent mutation.** Default operation never modifies the target repository, global developer-agent configuration, or the target application's data.
14. **Language-inclusive without breaking semantics.** Users choose the natural language of generated artefacts; identifiers, code, routes, selectors and machine data are never translated.
15. **Evidence-adaptive, not prerequisite-driven (MD-4).** Sys2QA starts from whatever evidence the developer has (source, URL, both, or a package) and never blocks a user for evidence they do not possess. Depth and certainty vary with the evidence, and the product says so.
16. **Discover, do not ask (MD-5).** The user is never required to know or name workflows, architecture or business rules before analysis. Selecting a discovered workflow is a follow-up, not a prerequisite.
17. **Not a DevOps agent (MD-6).** Sys2QA analyzes software and helps establish its quality. It never requires the user to deploy, provision, configure infrastructure or build a test environment, and never does so itself.
18. **Completeness is reported, never assumed.** A finished run states what was examined, what was found, where tracing stopped, and which evidence would improve the result. "Completed" never means "everything was found".

### 3.3 Maintainer direction captured during consolidation

The following direction was stated by the maintainer during the consolidation discussion (2026-10-21) and is not present verbatim in either source PRD. Requirements derived from it are marked **Proposed** pending written approval.

- **MD-1 — Owner-scoped use.** Sys2QA is intended to be "safe": it is for projects and codebases owned by, or under the authority of, the person using it — unlike general-purpose reverse-engineering tools such as REA.
- **MD-2 — No cloning.** Sys2QA should not clone or otherwise acquire repositories; it works on the codebase the user already has.
- **MD-3 — Authorization is self-declared.** Sys2QA does not verify ownership of repositories or target domains. The user declares that they are authorized; the platform records the declaration and keeps the experience simple. The goal of the open-source project is to make QA easier, not to add friction.
- **MD-4 — Start with what the developer has.** Repository analysis, URL-based discovery, combined analysis and package import are all legitimate starting conditions of the same SAA → QAA process (maintainer review, MR §1, §3).
- **MD-5 — Discover rather than require knowledge.** Sys2QA must discover workflows from evidence; developers must not need to name them or describe the system first (MR §2, §4).
- **MD-6 — Not a DevOps agent.** Sys2QA must deliver value without requiring the user to deploy or administer an application or build end-to-end infrastructure (MR §5).

Consolidation note: MD-3 resolves the earlier proposal to add target-control verification (DNS/well-known token). That proposal is **not adopted** (see RC-C08). Safety is instead provided by controls that do not depend on proving ownership: a recorded authorization declaration, root sandboxing, URL scope policy and SSRF controls, environment classification, and explicit human approval for state-changing tests. Possession of a URL, a checkout or credentials therefore never authorizes *destructive* testing by itself — the approval gate does (SEC-005, SEC-010).

---

## 4. Problem statement

Real-world repositories frequently have missing, stale or fragmented documentation. Original developers may have left; business rules may live implicitly in conditional logic; deployments may span multiple frontends, backends, workers and scheduled jobs; and behavior may cross API, database, proxy, authentication and external-service boundaries. Manual documentation depends on interviews and reading, and drifts as code changes. (SAA §1.1)

Teams with a working development site and repository often lack a reliable, current test suite. Creating one requires understanding the application, finding key journeys, identifying valid and invalid inputs, defining expected outcomes, preparing data, implementing automation, executing, and documenting defects. (QAA §3)

Common failure modes the product addresses:

- QA tests the wrong behavior, misses cross-component effects, or mistakes an implementation detail for a requirement because no reliable system model exists.
- Scenarios omit negative, boundary, permission, state-transition or regression cases.
- AI-generated tests look plausible but rely on invented expected behavior.
- Browser automation demands selector, synchronization and fixture expertise; flaky tests erode trust.
- Manual testers receive vague scenarios and record results inconsistently.
- Repository, documentation and runtime behavior disagree and the disagreement is silently resolved.
- Teams working in different natural languages need consistent, readable artefacts.
- Existing tools record actions or run scripts, but do not connect evidence-backed system understanding, QA test design, human review, manual and automated execution, and traceable evidence in one workflow.
- Many developers do not have the full picture or full access (MR §1). Examples:
  - only a development URL, with no source;
  - only a frontend repository, with no backend access;
  - a years-old monolith nobody fully understands;
  - source code but no ability to run or deploy the application.
  
  Tools that need prior knowledge of workflows, or a complete running end-to-end environment, exclude these developers.

---

## 5. Goals and measurable success criteria

### 5.1 Product goals

| ID | Goal | Owner | Source |
|---|---|---|---|
| G-01 | Reconstruct a repository's structure and important behavior without requiring existing documentation. | SAA | SAA §2.1(1) |
| G-02 | Preserve application boundaries in monorepos and multi-version deployments. | SAA | SAA §2.1(2) |
| G-03 | Build evidence-backed relationships across modules, routes, APIs, persistence, configuration, deployment and external systems. | SAA | SAA §2.1(3) |
| G-04 | Generate human-readable documentation and a machine-readable model from one canonical knowledge base. | SAA | SAA §2.1(4) |
| G-05 | Provide a stable, versioned contract so QAA can retrieve workflows, contracts, roles, rules, tests, risks and unknowns. | Contract | SAA §2.1(5), QAA G11 |
| G-06 | Detect stale, incomplete, incompatible or conflicting documentation before test generation and execution. | QAA | QAA G12 |
| G-07 | Generate QA scenarios with explicit test-design techniques and risk-based prioritization. | QAA | QAA G3 |
| G-08 | Let users inspect, edit, approve, reject, defer and categorize every scenario before execution. | QAA + human | QAA G4 |
| G-09 | Support guided manual testing and constrained automated testing from the same approved scenarios. | QAA | QAA G5, G6 |
| G-10 | Produce consistent, exportable, localized reports with reproducibility metadata. | QAA | QAA G7, G8 |
| G-11 | Support incremental refresh and propagate change impact to documentation, scenarios, approvals and results. | SAA + QAA | SAA §2.1(7), QAA FR-020 |
| G-12 | Work locally and safely by default; protect repository contents, credentials, sessions and target data. | Platform | SAA §2.1(8), QAA G10 |
| G-13 | Be self-hostable, provider-neutral and suitable for open-source contribution. | Platform | QAA G9, SAA §11.3 |
| G-14 | Accept a repository, an authorized URL, both, or a package as the starting point, and produce the most defensible result that evidence allows. | Platform | MD-4, MR-REQ-1 |
| G-15 | Discover workflows automatically and report the examined scope, unresolved connections and limitations. | SAA | MD-5, MR-REQ-2 |
| G-16 | Deliver analysis and QA preparation without deployment or administration access to the target. | Platform | MD-6, MR-REQ-4 |
| G-17 | Generate useful scenarios from runtime evidence alone, labeled with their limits. | QAA | MR-REQ-5 |

### 5.2 Measurable success criteria

The source PRDs explicitly forbid publishing numeric targets before a baseline exists (SAA §11.2, §14.1; QAA §18.3). Success is therefore defined in two forms: **binary release gates** (pass/fail, §29) and **tracked metrics** whose numeric targets are set after the Phase 0/1 baseline (§26.4). No numeric target in this document is a commitment.

| ID | Success criterion | Type | How it is measured |
|---|---|---|---|
| SC-01 | A user can go from a local repository to an imported, readiness-assessed Documentation Package without an AI client connected to SAA. | Gate | E2E benchmark run on the fixture corpus (§26) |
| SC-02 | Every material claim in a published package is evidence-backed or labeled `inferred`, `unresolved`, `contradicted`, `stale` or `human_asserted`. | Gate | Contract validator over benchmark packages; zero unlabeled material claims |
| SC-03 | Every generated scenario links to at least one SAA artifact/entity or is explicitly labeled as gap-driven exploratory. | Gate | Scenario schema validator |
| SC-04 | The executor refuses 100% of unapproved, stale-baseline, malformed or out-of-scope definitions in the security suite. | Gate | Security/approval test suite |
| SC-05 | A manual run and an automated run of the same approved scenario version are both reportable and traceable to that version. | Gate | E2E benchmark |
| SC-06 | No secret from the fixture secret set appears in logs, prompts, packages, reports or audit records under tested operation. | Gate | Secret-leak test suite |
| SC-07 | Scenario acceptance rate, expected-result validity, coverage recall, duplicate rate, false-failure rate, evidence completeness, extraction and relationship precision/recall, uncertainty calibration, cost per accepted scenario. | Metric | Defined in §26.4; targets set after baseline |
| SC-08 | Time to first useful approved suite on a benchmark app. | Metric | Wall-clock measurement on benchmark; target set after baseline |
| SC-09 | Workflows are discovered with no workflow names supplied; the completeness report lists where each trace stops. | Gate + metric (workflow discovery recall) | Repository-only and combined fixtures (§26.2) |
| SC-10 | A user with only a URL reaches reviewed, manually executable scenarios, and no claim exceeds observation. | Gate | URL-only fixture; claim audit |
| SC-11 | A user with no running environment reaches an exported manual test pack. | Gate | Modes A and D on fixtures |

---

## 6. Non-goals and out-of-scope features

The following are **out of scope (X)** for the product or the MVP, as stated. Source: SAA §2.3, QAA §4.2, MD-1, MD-2.

| ID | Out of scope | Scope | Source |
|---|---|---|---|
| X-01 | Guaranteeing perfect understanding or recovering business intent absent from code, tests, data or human input. | Product | SAA §2.3 |
| X-02 | Recreating inaccessible source from deployed binaries; reverse-engineering compiled artifacts or third-party systems. | Product | SAA §2.3, MD-1 |
| X-03 | Cloning, downloading or otherwise acquiring repositories the user does not already hold and is not authorized to analyze. | Product | MD-2 (Proposed) |
| X-04 | Claiming equal semantic depth across all languages and frameworks. | Product | SAA §2.3 |
| X-05 | Automatic source-code edits, refactoring, fixes, commits, pull requests or deployments. | Product | SAA §2.3, QAA §4.2 |
| X-06 | Running repository scripts, migrations, package hooks, tests or applications without explicit authorization. | Product | SAA §2.3, QAA §16.2 |
| X-07 | Arbitrary shell commands or execution of AI-generated scripts. | Product | QAA §4.2 |
| X-08 | Unreviewed execution of generated scenarios. | Product | QAA §4.2 |
| X-09 | Fully autonomous testing; production testing; automatic connection to production databases or infrastructure. | MVP (production requires a separate safety design) | SAA §2.3, QAA §4.2, §20 |
| X-10 | Load, stress, endurance, penetration, fuzz, mobile-native, desktop-native or hardware testing. | MVP | QAA §4.2 |
| X-11 | Automatic support for every identity provider, CAPTCHA, MFA flow, browser or frontend architecture. | MVP | QAA §4.2 |
| X-12 | Guaranteeing generated expected results are correct without an authoritative requirement or human confirmation. | Product | QAA §4.2 |
| X-13 | Replacing professional QA review, acceptance testing, exploratory judgment, human system analysts, or a formal regulated-system test strategy. | Product | SAA §2.3, QAA §4.2 |
| X-14 | Replacing source control, observability platforms, test-management platforms or defect trackers. | Product | SAA §2.3 |
| X-15 | Treating LLM-generated explanations as evidence. | Product | SAA §2.3 |
| X-16 | Assuming comments, READMEs, tickets or tests are accurate when they disagree with implementation. | Product | SAA §2.3 |
| X-17 | Requiring a hosted service, or sending source code or credentials to a remote model provider by default. | Product | SAA §2.3, QAA §4.2 |
| X-18 | QAA re-performing SAA's full system analysis and documentation generation. | MVP | QAA §4.2 |
| X-19 | Treating unversioned Markdown alone as the integration contract when structured data is available. | Product | QAA §4.2 |
| X-20 | Describing a browser crawl as a comprehensive security, accessibility or performance assessment. | Product | QAA §6.7 |
| X-21 | Verifying ownership of repositories or target domains (DNS/well-known token, provider ownership checks). Authorization is self-declared. | Product | MD-3 |
| X-22 | DevOps work: deploying applications, provisioning databases or cloud resources, configuring CI/CD, DNS, proxies or infrastructure, or building test environments for the user. Sys2QA uses only environments the user already has. | Product | MD-6 |
| X-23 | Claiming backend internals, data models, unreachable behavior or intended requirements from black-box observation alone. | Product | MR §3 |

---

## 7. Target users and personas

| Persona | Primary needs | Success looks like | Primary agent |
|---|---|---|---|
| **QA engineer / QAA operator** | Trustworthy workflows, contracts, risks and edge cases; consistent techniques; reviewable expected results; regression organization; evidence for developers | QAA accelerates analysis and documentation without reducing control over what is tested or how outcomes are classified | QAA (consumes SAA) |
| **Manual tester** | Clear preconditions, steps, data, expected results; fields for actual results; evidence capture; easy defect reporting | Executes a scenario without interpreting vague instructions or writing code | QAA |
| **Developer** | Find regressions; understand failures with reproducible evidence; locate implementing code quickly; separate facts from inferences | A failure links to route, step, assertion, commit and source evidence | QAA + SAA |
| **Maintainer of a legacy system** | Map of architecture, entrypoints, business logic, data flow, operations and unknowns | Navigable, evidence-linked documentation with explicit gaps | SAA |
| **Senior system analyst / architect** | Accelerate reconnaissance, trace evidence, correct the model via annotations | Reviews and corrects a generated model instead of discovering everything manually | SAA |
| **Developer joining an unfamiliar codebase** | Quick answers with clickable evidence | Can distinguish fact, inference and unknown | SAA |
| **Team lead / product owner / modernization planner** | Coverage, risk, approval state, blockers, release readiness, dependency and impact maps | Report separates defects from environment failures, uncertain expectations and incomplete testing | QAA + SAA |
| **Self-hosting maintainer** | Deploy, choose LLM provider or local model, configure secrets/storage, audit workers | Works without mandatory SaaS beyond deliberately configured services | Platform |
| **Developer with only a URL** | Understand and test a dev/staging application without source access | Observed workflows and characterization scenarios, with clear limits | SAA (runtime) + QAA |
| **Frontend developer without backend access** | Understand which flows depend on unavailable services | Combined model in which external/backend boundaries are explicit gaps, not guesses | SAA + QAA |
| **Developer without deployment access** | Prepare and run tests without building infrastructure | Manual test packs and analysis with no environment work | QAA |

---

## 8. Product terminology and definitions

Terms below are normative and used consistently in all sections. Where the source PRDs used different words for the same concept, the unified term is listed first and the source synonyms are noted.

| Term | Definition |
|---|---|
| **Sys2QA** | The platform: SAA, QAA, the shared platform services and the SAA→QAA contract. |
| **SAA (System Analysis Agent)** | The component that analyzes a repository and publishes Documentation Packages. *Source synonym:* "System Analyst Agent" (SAA PRD title). See RC-T01. |
| **QAA (Quality Assurance Agent)** | The component that consumes Documentation Packages and performs QA analysis, design, review, execution and reporting. |
| **Project** | Platform record that groups the evidence sources the user has (zero or more local source roots, zero or more environments, imported packages), plus the Documentation Package versions, scope policies, scenarios, runs and reports derived from them. |
| **Repository target** | A local directory the user already holds (checkout or extracted archive), or an explicitly selected set of such directories, that SAA is authorized to read. |
| **Project boundary** | An application, package, service, worker, library or deployment unit that is independently meaningful inside a repository target. |
| **Revision** | Immutable identity of analyzed source: a Git commit SHA plus working-tree state, or a content fingerprint for non-Git sources. See CON-006. |
| **System Knowledge Base (SKB)** | SAA's canonical, versioned store of entities, relationships, claims, evidence, workflows, coverage, open questions and annotations. |
| **Documentation Package** | Versioned, immutable export of the SKB for one revision: manifest, system model, evidence index, Markdown documentation and optional assets. *Source synonyms:* "SAA documentation package", "SKB export", "artifact bundle". |
| **System model** | The machine-readable part of the package (`system-model.json`) — the contract view of the SKB. |
| **Entity** | A node of the system model (module, route, role, workflow, business rule, table, API operation, test, …). |
| **Relationship** | A typed edge between entities (`CALLS`, `READS_FROM`, `AUTHORIZES_WITH`, …). |
| **Evidence** | A source location, manifest entry, schema, test definition, Git change, config key, analyzer result, approved runtime/browser observation or human input supporting a claim. |
| **Claim** | An interpretation derived from evidence, with a provenance status (§13.6) and scope. |
| **Provenance status** | Controlled label on a claim: `source_verified`, `runtime_observed`, `test_verified`, `inferred`, `contradicted`, `unresolved`, `stale`, `human_asserted`. |
| **Confidence** | A qualitative, rationale-backed assessment of evidence quality. Never presented as a calibrated probability. |
| **Gap / open question** | Explicit record of missing, ambiguous, conflicting or unverifiable information, with impact and whether human clarification is needed. |
| **Contradiction** | A gap record where credible sources disagree (code vs. docs vs. tests vs. runtime vs. requirement). |
| **Annotation** | Human-provided correction, business context or approval, attributed separately from analyzer evidence. |
| **Requirement** | A statement of intended behavior supplied by a human or a requirements document. Distinct from implementation claims. |
| **Readiness** | QAA's assessment of whether a package is fit to be used as test basis for a given scope: `ready`, `ready_with_gaps`, `review_only`, `blocked`. |
| **Package freshness** | Relationship between a package's revision and the current baseline: `current`, `mismatched`, `stale`, `unverifiable`. |
| **Baseline** | The tuple (package ID and version, revision, environment, scope policy version) that scenarios and approvals are bound to. |
| **Test basis** | All material used to analyze and design tests: package, supplied requirements, user-confirmed rules, targeted source checks, runtime observations, prior results. |
| **Test condition** | A testable aspect of a feature, rule, workflow or permission derived from the test basis. |
| **Scenario** | QAA's versioned, structured test case (preconditions, data, steps, expected results, technique, priority, traceability). *Source synonyms:* test case, test scenario. |
| **Expected-result basis** | Controlled label stating why an expected result is expected (§15.9). |
| **Test oracle** | The source used to decide pass/fail for an expected result. |
| **Approval** | Immutable, audited decision that a specific scenario version may execute against a specific baseline. |
| **Environment** | A configured target application instance (base URL, allowed hosts, classification such as `development`/`staging`). |
| **Scope policy** | Allowed schemes, hosts, path prefixes, exclusions and permission level for an environment. |
| **Authorization declaration** | The user's recorded, self-declared statement that they are authorized to analyze a repository or test an environment (MD-3). Not verified by the platform; audited. See SEC-005. |
| **Manual run** | Execution of approved scenarios by a human tester; results are tester-reported. |
| **Automated run** | Execution of approved scenarios by the deterministic automation worker. |
| **Outcome** | Per-case result: `passed`, `failed`, `blocked`, `inconclusive`, `not_run`, `skipped`. |
| **Failure category** | Automated-run diagnosis distinguishing application failures from infrastructure, unsupported and inconclusive causes (§17.5). |
| **Defect** | Recorded deviation linked to a scenario version, run, step and evidence, with severity and lifecycle (§15.12). |
| **Adapter** | Replaceable analyzer (SAA) or execution/provider/export plug-in (QAA, platform) that declares capabilities and limitations. |
| **Skill** | Agent-facing instructions for planning and sequencing SAA tools. Not the analysis engine. |
| **MCP** | Model Context Protocol interface exposing SAA capabilities to compatible clients. Not the source of truth. |
| **Permission level** | Platform-wide classification of operation side effects, L0–L5 (§9.5). |
| **Starting mode** | The evidence the user starts with: A repository, B URL, C both, D package (§10.1). Modes can change as evidence is added. |
| **Evidence profile** | Which evidence types a package or result is built on (`source_analysis`, `runtime_observation`, `documentation_import`) and what that profile cannot establish (CON-020). |
| **Entry point** | A place where execution starts: route, page, API endpoint, CLI command, job, scheduler, event/queue consumer, webhook. |
| **Component trace** | Evidence-backed connection from one entry point or component to the components it calls, reads or writes. |
| **End-to-end workflow** | A discovered process composed of component traces across boundaries, with the points where composition stops. Not to be confused with a component trace. |
| **Workflow catalog** | SAA's list of discovered workflows with category, entry points, evidence profile, completion label and unresolved links (SAA-FR-040). |
| **Completeness report** | SAA's statement of what was examined, found, unresolved, unavailable and unexplored, and which evidence would improve the result (SAA-FR-045). |
| **Runtime observation service** | Shared platform service that performs all browser access within the declared scope, for SAA discovery and QAA verification/execution. |
| **Discovery probe** | Opt-in L2 mode that submits empty or invalid input to non-state-changing forms to observe validation (SEC-024). |
| **QA objective** | Purpose of a scenario: `characterization`, `implementation_conformance`, `requirement_conformance` or `exploratory` (§15.9). |
| **Manual test pack** | Exported approved scenarios plus result templates that a tester can execute without Sys2QA connected to an environment (QAA-FR-112). |

---

## 9. Overall architecture and agent responsibilities

### 9.1 Product shape

Sys2QA is one platform with two agents that share a contract and a small set of platform services. Each agent can be built, tested and released on its own against the versioned contract (CON-018). Browser access is centralized in a **shared runtime observation service**, so scope, SSRF, rate-limit and redaction controls are enforced once, identically for every caller.

```text
                  Users: developer · analyst · QA engineer · tester · lead
                                        |
               `sys2qa start` guided onboarding · Web UI · AI agent (MCP/Skill)
                                        |
          +-----------------------------+------------------------------+
          |                                                            |
   SAA interfaces                                             QAA interfaces
   CLI · MCP server · Analyst Skill                           Web UI · QAA API · CLI
          |                                                            |
   SAA orchestrator                                           QAA service layer
   (plans by evidence profile, budgets, tool policy)          (readiness, planning, review/approval,
          |                                                    runs, reports)
   SAA evidence adapters                                               |
   ├─ source: inventory · Git · language/framework ·          +-- package importer and readiness
   │          config/SQL/deploy · component tracer            +-- targeted source verifier (local, read-only)
   └─ runtime: discovery planner (L2) ──────────┐             +-- manual runner (no extra infrastructure)
          |                                     │             +-- automation adapter (Playwright, L3)
   Evidence store + SKB (canonical)             │                          |
   workflow catalog · gaps · completeness       │                          |
          |                                     v                          v
   Docs renderer · package exporter      Shared runtime observation service (platform)
          |                              scope policy · SSRF/egress · rate limits ·
          v                              isolated browser workers · redaction
   Sys2QA contract (versioned)                           |
   manifest (incl. evidence profile) · system model      v
   · evidence index · docs · diff · analysis request   Authorized target environment
                                                       (development or staging only)

   Shared platform services (never bypassable by plug-ins): policy and permission levels ·
   authorization declarations · secret references · LLM provider adapter · localization and glossary ·
   audit log · artifact storage and retention · configuration · observability
```

### 9.2 Responsibility split

| Responsibility | SAA | QAA | Shared platform | Human |
|---|:---:|:---:|:---:|:---:|
| Choose starting mode; declare authorization and scope | Guides | Guides | Records declaration; enforces scope | **Owns**; needs no prior knowledge of the system |
| Source inventory, stack, boundaries, entry points | **Owns** | — | — | — |
| Discovery of an authorized URL (pages, forms, navigation, visible validation and states) | **Owns** (SAA-FR-042) | Targeted verification only | Runtime observation service | Sets scope; may enable discovery probe |
| Workflow discovery and catalog | **Owns** | Consumes | — | Optionally selects discovered workflows to deepen |
| Rules, states, roles, contracts, integrations, error paths | **Owns** | Consumes | — | Annotates or corrects |
| Correlating source and runtime evidence; discrepancies | **Owns** | Reports QA impact | — | Confirms revision correspondence |
| Evidence provenance, gaps, completeness report, documentation versioning | **Owns** | Preserves | Contract | Resolves ambiguities |
| Documentation Package publication | **Owns** | — | Contract schema | Chooses output path and language |
| Package validation, readiness and freshness | Self-validates (SAA-FR-012) | **Owns** acceptance (per QA activity) | Contract validator | Decides on `review_only` overrides |
| Targeted verification of specific claims | On request (SAA-FR-037) | **Owns** | Runtime observation service | — |
| Re-analysis and re-discovery after changes | **Owns** | Detects staleness; requests | — | Triggers run |
| QA objectives, test conditions, techniques, risk priority | — | **Owns** | — | Adjusts risk inputs; confirms requirements |
| Scenario generation and validation | — | **Owns** | — | Edits |
| Approval | — | Enforces | Audit | **Owns** decision |
| Manual execution | — | Provides workflow and test packs | — | **Owns** results (tester-reported) |
| Automated execution | — | **Owns** (deterministic worker) | Isolation, egress | Starts / cancels |
| Defects and QA reports | — | **Owns** | Localization | Triages |
| Deployment, provisioning, infrastructure, CI/CD | **Not owned by Sys2QA** (X-22) | — | — | Uses environments they already have |
| Secrets, policy, audit, LLM access, localization, storage | Uses | Uses | **Owns** | Configures |

Rules (C, SAA §9.1, QAA §1.1, updated per MD-4 … MD-6):
- SAA may help investigate a test failure but must not perform QA execution, assertions or defect triage.
- QAA must not regenerate SAA's documentation or crawl the whole application by default (X-18). It may check specific source files and specific live pages to verify claims or resolve specific ambiguities. It records those findings as QAA evidence, not as SAA claims.
- Every starting mode reaches QAA through the same contract. Whole-application discovery of a URL is an SAA activity whose output is a package with a runtime-only or combined evidence profile (RC-C17, OD-24).
- Shared work must never blur which agent produced or verified a claim; every record carries its producer.

### 9.3 SAA internal layers (C, SAA §4.2)

- **Layer A — Analyst workflow ("analyst brain"):** scope first, plan by uncertainty and impact, select tools, trace, cross-validate, stop or deepen on completion gates, report limits. Lives in the orchestrator and the Skill.
- **Layer B — Tooling and analysis engine:** deterministic inventory, ignore rules, manifests, parsing, symbol/reference lookup, dependency graphs, route/model discovery, Git history, schema extraction, test inventory, graph queries, incremental invalidation, document export.
- **Layer C — Evidence and knowledge model (SKB):** durable source of truth for accepted knowledge — not chat transcripts.
- **Layer D — Delivery interfaces:** Skill (guides AI clients), CLI (developers, scripts, CI), MCP (coding agents), later optional UI/API.

### 9.4 QAA logical components (C, QAA §14.1)

Package importer/normalizer · documentation readiness checker · targeted source verifier · browser discovery planner · evidence correlator · QA planner · scenario generator · scenario critic/validator · translation/presentation layer · execution adapter (deterministic Playwright mapping, not an open-ended agent) · result classifier (reviewable suggestions). These are logical responsibilities; the MVP should use a small number of services and controlled LLM calls rather than one autonomous agent per component.

### 9.5 Platform permission levels

Unified from SAA §4.5 (runtime modes) and QAA §16 (safe execution). (P — unifies two source tables; no source behavior changed.)

| Level | Operation | Agent | Default | Gate |
|---|---|---|---|---|
| L0 | Inventory: list files, manifests, repository metadata | SAA | Enabled | Authorization declaration + root sandbox |
| L1 | Static read: parse source, configs, schemas, tests, Git metadata; QAA targeted source reads | SAA, QAA | Enabled | Same as L0 |
| L2 | Live non-destructive observation: navigate and read an authorized environment within scope; no form submission | SAA runtime discovery (SAA-FR-042); QAA targeted verification | Enabled after scoped declaration | Scope policy, SSRF controls, rate limits, authorization declaration |
| L2p | Discovery probe: submit empty or invalid input to forms not classified as state-changing, to observe validation | SAA runtime discovery | **Disabled**; opt-in per scope declaration | As L2, plus explicit opt-in and form classification (SEC-024) |
| L3 | Approved test execution, including flagged state-changing steps | QAA | Disabled until approval | Version-bound approval; state-changing approval and cleanup plan |
| L4 | Repository code execution: dependency install, build, repository tests, starting the app from source | SAA (P1), QAA (deferred) | Disabled | Explicit approval, allowlisted commands, strong sandbox, no default secrets or internal network |
| L5 | Production or live external systems | — | Out of scope (X-09) | Requires separate safety design |

No adapter, plug-in or tool gains a higher level merely by being registered (SAA §16).

### 9.6 Deployment topologies

The source PRDs assume different shapes: SAA is a local-first CLI/MCP tool (SAA §4.1), while QAA is described as a self-hosted web application with PostgreSQL, Redis/BullMQ and object storage (QAA §15.1). Both must remain possible. Final MVP choice: **OD-01**.

| Topology | Description | Fits |
|---|---|---|
| **T1 — Local single-user (recommended MVP)** | SAA CLI and QAA service run on the user's machine; QAA reads packages and (optionally) the same local checkout; local DB and file storage; browser worker local. | MD-2 (no cloning), local-first, solo maintainers, lowest operational cost |
| **T2 — Self-hosted team server** | SAA still runs where the code is (developer machine or CI); packages are uploaded to a self-hosted QAA server; multi-user access control. | Teams; requires OD-02 decision for source verification without cloning |

### 9.7 Implementation recommendations (non-normative)

These are recommendations, not requirements. The source PRDs suggest them, and they can change without a PRD revision.

- QAA §15.1 proposes a React + TypeScript web UI, a Node.js + TypeScript API (for example Fastify), PostgreSQL, Redis with BullMQ, Playwright workers, local or S3-compatible artifact storage, and a provider-neutral LLM adapter. For T1, an embedded database and in-process queue may replace PostgreSQL and Redis until multi-user operation justifies them (OD-01).
- SAA §16 proposes the package decomposition: `saa-core`, `saa-repo`, `saa-adapters`, `saa-adapter-js-ts`, `saa-adapter-config`, `saa-knowledge`, `saa-evidence`, `saa-workflows`, `saa-docs`, `saa-cli`, `saa-mcp`, `saa-skill`, `saa-qaa-contract`, `saa-benchmarks`. This PRD renames `saa-qaa-contract` to a platform-level `sys2qa-contract` package that both agents depend on (P).
- The implementation language of the SAA engine is not decided. Options and CPU trade-offs are in **OD-05**.

Architecture rules (C, SAA §16; QAA §15.2):
- CLI and MCP must not implement their own graph or analysis logic.
- The SKB and the contract must not depend on an LLM vendor.
- Analyzer adapters may be optional and independently unavailable.
- Deterministic non-LLM steps must be supported.
- The API process must not run long browser or model jobs synchronously.
- The database is the source of truth for approval and run state; queue messages are not.
- Workers re-check authorization, approval version, scope and run state before each job.
- A worker receives only the credentials and repository material required for its job.

---

## 10. End-to-end product workflows

Each workflow lists the happy path and its failure and recovery paths. Requirement IDs refer to §28.

### 10.1 Starting modes and access levels

Sys2QA adapts to the developer's evidence and access (MD-4, MD-6). The table below is normative for what each situation enables and what Sys2QA must not assume.

| What the developer has | Mode | What Sys2QA enables | What Sys2QA must not assume |
|---|---|---|---|
| Source code only | A | Static analysis, workflow catalog, documentation, scenario design, manual test packs | That the application can be run |
| A URL only (running application, no source) | B | Observation-based discovery, observed workflows, characterization and exploratory scenarios; manual testing; automated testing after approval and within scope | That source, internal data or intended requirements are available |
| Source code and a URL | C | Combined analysis, discrepancy detection, the strongest test basis | That both represent the same revision or configuration |
| A Documentation Package only | D | Readiness, scenario design, manual test preparation | That the package is current or complete |
| Source and a test environment, but no deployment access | A or C | Analysis and testing of the supplied environment | That Sys2QA can change infrastructure or deploy |

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| SYS-001 | **Flexible starting inputs.** A project can start in Mode A, B, C or D. Evidence can be added later (for example A → C) without restarting the project | Platform | P0 | P | Each mode reaches scenario review on its benchmark fixture. Adding a URL to a Mode A project produces a new package version, not a new project | MR-REQ-1 |
| SYS-002 | **Ask what the developer has, never what the system is.** Onboarding requires no workflow names, architecture or business rules; such knowledge is optional annotation after discovery | Platform | P0 | P | Review of the onboarding flow finds no mandatory question about system internals | MR §2, §8 |
| SYS-003 | **No DevOps prerequisites.** Every mode delivers analysis and QA preparation without the user deploying, provisioning or administering the application. Only Modes B/C and automated execution need a reachable environment, and only one the user already has | Platform | P0 | P | Modes A and D complete through manual test pack export with no environment configured | MR-REQ-4, MD-6 |
| SYS-004 | **Visible evidence profile.** Every summary, package and report states its evidence profile and what that profile cannot establish | SAA, QAA | P0 | P | Each report has an evidence-profile section; URL-only reports list the Mode B limitations of §2 | MR §3 |

### W1 — Start a project: "What do you have?"

1. The user runs `sys2qa start` (or its UI or agent equivalent) and chooses one option (SYS-001, SYS-002):
   - a local source directory;
   - a development or staging URL;
   - both;
   - an existing package.
   
   Sys2QA never clones or downloads source (SEC-017).
2. The user records a **scoped authorization declaration** (SEC-005). It covers:
   - source roots, hosts and paths in scope, and the environment classification;
   - the allowed operation level: observe only, discovery probe, execute tests, or tests that may modify data;
   - explicitly prohibited data or actions.
   
   The declaration is self-declared and not verified (MD-3).
3. Sys2QA validates what it can without side effects:
   - the path is readable and inside its roots;
   - the URL is reachable, its scheme and host are allowed, and it is not classified `production` (SEC-009);
   - the package validates (CON-009).
4. Sys2QA shows the project's **evidence profile** and what it can and cannot establish with it (SYS-004). It then continues to W2, W2b, W2c or W3.

Failure paths:
- **Unreadable path:** the exact failures are listed.
- **Unreachable URL:** the environment is marked `unreachable`, and the project stays usable in Mode A or D.
- **`production` classification:** discovery and execution are refused.
- **Login wall in Mode B:** discovery covers the public area and asks for a credential profile. It never bypasses authentication (QAA-FR-026).

### W2 — Mode A: repository analysis (no workflow names required)

1. **Scope preview** (SAA Phase 0). SAA shows:
   - roots, exclusions and detected languages;
   - candidate project boundaries;
   - the analysis profile (`overview`, `standard` or `deep`);
   - the permission level (L0–L1), budgets and output location. The default location is outside the repository (SAA-FR-036).
2. **Discovery** (SAA Phases 1–7, §11.1, §11.6):
   1. inventory and boundaries;
   2. **entry points**: routes, pages, API endpoints, CLI commands, jobs, schedulers, event/queue consumers, webhooks;
   3. component traces;
   4. **end-to-end workflow catalog** across the categories of §11.6;
   5. rules, states, roles, contracts and integrations;
   6. cross-validation and synthesis (SAA-FR-040, SAA-FR-041).
3. **Completeness report and catalog review** (SAA-FR-045). The user browses the discovered workflows and, optionally, selects some to **deepen** with more budget or a deeper profile. Selecting is never required.
4. **Publication.** SAA exports a Documentation Package (§13) with `evidence_profile.source_analysis = available`. The package is validated against the contract schema before it is declared publishable (SAA-FR-012, SAA-FR-029).
5. SAA prints the minimum run outputs (§11.4).

Failure paths:
- **Adapter failure:** the run continues where possible, and the status becomes `completed_with_limitations` or `partial` (SAA-FR-020).
- **Dynamic registration or reflection:** the hop is recorded as unresolved, with its reason.
- **Workflow continues into an unavailable repository or service:** it ends at an external boundary node.
- **Budget exhausted:** the run is `partial`, and the unvisited scope is listed.
- **Interruption:** the run is `cancelled` or `partial`, artifacts are labeled, and safe stages can resume.
- **Schema validation fails:** nothing is published; an error report is written.
- **Secrets detected:** values are redacted, and only location and type are recorded.

### W2b — Mode B: URL discovery (no source)

1. **Discovery plan from the scope declaration:**
   - start URL(s), allowed hosts and paths;
   - budget (pages, depth, time, requests);
   - credential profiles per role, if supplied;
   - discovery probe on or off (default off, SEC-024).
2. **Observation.** The shared runtime observation service explores within scope at L2. It records:
   - reachable pages and navigation;
   - forms and fields with their visible constraints (required, type, length, pattern attributes);
   - visible states and messages;
   - client-side routes of single-page applications, where observable.
   
   With discovery probe enabled, it submits empty or invalid input to forms not classified as state-changing, to observe validation.
3. **Modeling.** SAA builds the observed model:
   - `page`, `form` and `field` entities, navigation relations and candidate workflows (for example login → dashboard → profile);
   - all of them `runtime_observed`, with environment ID and observation time;
   - unreachable, unlinked, authentication-gated or unobserved areas recorded as gaps (SAA-FR-042, SAA-FR-043).
4. **Publication.** The package has `evidence_profile.runtime_observation = available` and `source_analysis = unavailable`, and lists the Mode B limitations.

Failure paths:
- **Off-scope redirects:** blocked and recorded (SEC-007).
- **Crawler traps** (infinite pagination, calendars, faceted search): cut off by budget and URL-pattern de-duplication.
- **Prompt-injection text in pages:** ignored (SEC-003).
- **Rate-limit or WAF responses:** discovery backs off, and the affected areas are recorded as `blocked`.
- **CAPTCHA or MFA:** that path stops, and the user is asked.

### W2c — Mode C: repository + URL

1. W2 and W2b run, in either order. SAA then correlates observed pages and forms with source routes and handlers (SAA-FR-044).
2. **Revision correspondence.** Sys2QA asks the user whether the environment runs the analyzed revision, or reads a configured version endpoint. Otherwise correspondence is `unconfirmed`, and discrepancies are labeled as possibly version-related.
3. **Discrepancy records** are created for cases such as:
   - a route declared in source but not reachable;
   - a field constraint that differs (for example, source enforces 13 digits but the browser field allows 16);
   - an observed page with no source route (another repository, a CMS, or a proxy).
4. The package contains both evidence types, with provenance per claim. A browser observation never upgrades a source claim beyond what it shows, and vice versa (SAA-FR-043).

### W3 — Package import, readiness and freshness

1. The user imports a package into QAA or selects it from the local filesystem. Mode D needs no repository and no environment.
2. QAA validates the manifest, schema versions, checksums, required artifacts, ID integrity, evidence references, evidence profile and analysis status (CON-009).
3. QAA assigns **package freshness**: `current`, `mismatched`, `stale` or `unverifiable` (QAA-FR-014). For source evidence it compares the revision with the project baseline. For runtime evidence it compares the observation window with the environment's known changes (CON-021).
4. QAA computes **readiness per QA activity**: `scenario_design`, `manual_preparation` and `automated_execution` (CON-022). Each is `ready`, `ready_with_gaps`, `review_only` or `blocked`.
   - A package is never downgraded for evidence it does not claim to have. Its limitations are attached to the affected scenarios instead.
   - QAA shows coverage by category, unresolved findings, contradictions and their consequences (QAA-FR-013, QAA-FR-018).
5. The project enters `ready_for_test_analysis` when at least `scenario_design` is not `blocked`.

Failure paths:
- **Missing, malformed or major-incompatible package, or checksum mismatch:** `blocked`, with a machine-readable error (§13.10).
- **Markdown-only package:** imported in fallback mode; structure is labeled `qaa_inferred`, and readiness is capped at `review_only` (CON-016).
- **Revision mismatch on selected flows:** `review_only`. Drafting and review are allowed; execution approval is blocked (CON-014).
- **No environment configured:** `automated_execution` is `blocked`; design and manual preparation are unaffected.

### W4 — QA analysis and scenario generation

1. QAA builds a **test plan**. It covers objectives, **QA objectives** (QAA-FR-111), scope, exclusions, risks, test basis, evidence profile, assumptions, exit criteria and suggested coverage (QAA-FR-030).
2. **Targeted verification.**
   - If an environment is configured, QAA may verify specific package items through the runtime observation service (QAA-FR-029). It never crawls the whole application; that is W2b.
   - If no environment is configured, this step is skipped (QAA-FR-112).
3. **Targeted source verification** (optional) reads specific files at the package revision from the local checkout (OD-02). It never runs repository code (QAA-FR-017).
4. The **evidence correlator** compares package claims, supplied requirements, source checks and observations. It records contradictions instead of silently choosing one source (QAA-FR-016).
5. QAA derives **test conditions**, applies techniques (§15), assigns risk priority, and generates scenarios. Every expected result has a basis, an oracle class and a QA objective (QAA-FR-031 … 038, QAA-FR-041, QAA-FR-111).
   - Runtime-only evidence yields characterization and exploratory scenarios (QAA-FR-110).
   - Expectations that need business intent become `needs_clarification`. They are never inferred from what was observed.
6. The **critic/validator** checks schema, quality checklist, duplicates, unsafe actions and unsupported expectations (QAA-FR-034, QAA-FR-035).
7. QAA lists **evidence-strengthening suggestions**: which extra evidence (source, requirement, environment, role credentials) would upgrade which expectations (QAA-FR-113).

Failure paths:
- **LLM output fails schema validation:** rejected and retried within budget, then reported.
- **Material gap:** generation is blocked for the affected area only. QAA creates a gap record and, optionally, an SAA analysis request (QAA-FR-018, CON-015).

### W5 — Human review and approval

Covered in §18. The user filters, inspects, edits, rejects, defers, requests regeneration, or approves. Approval produces an immutable record bound to the baseline (QAA-FR-052).

### W6 — Manual testing

Covered in §16.
- A tester runs approved scenarios step by step and records tester-reported results, evidence and defects. Runs can be paused and resumed.
- Manual test packs can be exported and executed **without a configured environment or any automation infrastructure** (QAA-FR-112).

### W7 — Automated testing

Covered in §17.
- The deterministic worker revalidates approval, baseline and scope. It executes only schema-supported actions, records assertions and evidence, and classifies outcomes and failure categories.
- Automated testing requires a reachable environment that the user already has. Sys2QA never provisions one (X-22).

### W8 — Results, defects and reports

QAA aggregates outcomes and links each result to its scenario version, baseline, environment and evidence. It manages the defect lifecycle (§15.12) and exports localized human-readable and machine-readable reports (QAA-FR-090 … 096). Reports state the evidence profile and the QA objective of each result (SYS-004, QAA-FR-111).

### W9 — Change, re-analysis, re-discovery and staleness propagation

1. **Source change.** SAA runs incremental or full re-analysis (SAA-FR-021) and publishes a new package version, with a **model diff report** where possible (SAA-FR-038, CON-014).
2. **Runtime change.** Re-running discovery on the environment produces a new package version. Observations older than the configured freshness window become `potentially_stale` (CON-021, OD-27).
3. QAA imports each new package as a **new baseline**. History is never overwritten (§13.11).
4. QAA marks affected scenarios `potentially_stale` or `stale` and suspends or invalidates approvals according to §13.11. Past results keep their original baseline.
5. QAA proposes impacted scenarios for review and regression (QAA-FR-020, QAA-FR-046).

Failure paths:
- **No diff available:** every scenario in the project becomes `potentially_stale` (conservative default).
- **Uncertain rename mapping:** entities are treated as removed and added, with a rename hint for human confirmation.

### W10 — Follow-up analysis: QAA → SAA

1. A test failure, contradiction or gap leads QAA to create a bounded **analysis request** (CON-015). It names the entity, workflow or route, the revision or environment, the question, and the budget.
2. In the MVP, the user runs the request with the SAA CLI (file-based transport). An API transport is P1 (QAA-FR-019, OD-12).
3. SAA returns a candidate update with evidence, status, caveats and the reason the model changes, published as a new package version (SAA-FR-037).
4. Policy decides whether low-risk source facts are auto-accepted. Contradictions and business-intent questions always require human review (SAA §9.3, OD-18).

---

## 11. SAA functional requirements

### 11.1 Investigation methodology (C, SAA §5)

SAA's "senior analyst" behavior is a repeatable process, not a personality prompt.

| Phase | Purpose | Key obligations |
|---|---|---|
| 0 Scope and safety | Establish what may be read and how much | Record roots, exclusions, allowed level, revision/worktree state, timestamp; honor ignore files and SAA exclusions; detect sensitive files before storing or sending content to a model; treat all content as untrusted; set file/token/CPU/time/depth budgets |
| 1 Reconnaissance | Inventory | File types, languages, manifests, lockfiles, build systems, frameworks, test tools, migrations, IaC, deployment files; candidate boundaries and entrypoints; read scripts as metadata only; record missing dependencies and available analyzers |
| 2 Structural model | Facts | Modules, symbols, imports, references, declarations, routes, schemas, event handlers, schedulers, tests; dependency and containment graphs; detect generated/vendored/duplicate code; never merge projects on name similarity |
| 3 Architecture and boundaries | Containers and links | Entrypoints, services, gateways/proxies, auth providers, stores, queues, jobs, external services; frontend→backend, service→service and code→data links; label links ending at unavailable systems as external/unverified |
| 4 Workflow reconstruction | Behavior | Entrypoint → validation/auth → orchestration → reads/writes → side effects → result/error; alternate branches, authorization failures, retries, transactions, exceptions, timeouts, idempotency when evidenced; use indexes/parsers before LLM reading; keep paths bounded and mark unresolved hops |
| 5 Rules and contracts | Testable rules | Validation constraints, state transitions, authorization checks, feature flags, defaults, enums, request/response shapes, DB constraints, error contracts; separate technical rules from business intent; infer business concepts only from multiple signals |
| 6 Cross-validation | Challenge | Direct evidence? Alternative path/override? Generated, dead, flagged or environment-specific? Contradicted by tests/docs/schema/config? Crosses an uninspectable boundary? Revision-specific? Misleading names/comments? Downgrade or split claims on conflict |
| 7 Synthesis and quality gates | Publishable output | Docs and gaps from the same SKB; validate references against revision and schema; coverage by project/language/adapter/directory/workflow; consistency checks; executive summary with limits and next investigations |
| 8 Handoff and refresh | Keep current | Publish versioned package; serve QAA; invalidate affected claims on change; keep history; keep annotations as a distinct provenance |

**Planning by value** (C, SAA §5.2): investigations are prioritized by user/business criticality, exposed interfaces, data mutation, external dependencies, unresolved links, change frequency, test importance and uncertainty. Each task records its question, current evidence, candidate tools, scope and budgets, expected output, side-effect level and stop condition.

**Workflow trace completion** (C, SAA §5.3): a trace may be labeled `complete_within_static_scope` only when the entrypoint is evidence-linked; every internal hop is source-backed or labeled inferred; key reads, writes and side effects are identified where supported; validation, authorization and major error branches are addressed or marked unknown; external boundaries are labeled; contradictions are recorded; and revision and coverage are recorded. This label never means that runtime or production behavior is proven.

**Tool selection** (C, SAA §6.3): use deterministic tools for inventory, counts, manifest values and line evidence; parsers for syntax; framework adapters for conventions; LSP/indexers for references; Git for change evidence (not intent); and the LLM only for planning, interpretation of extracted evidence, synthesis and next questions. Never use the LLM to simulate repository-wide search. Cache by revision, file fingerprint, adapter version and configuration.

### 11.2 Adapter strategy and support levels (C, SAA §6.2)

| Level | Name | Meaning |
|---|---|---|
| 0 | Detect | Recognizes language/framework indicators; reports gaps |
| 1 | Inventory | Project files, manifests, dependencies, entrypoints, approximate structure |
| 2 | Structural | Syntax, symbols, references, imports/calls |
| 3 | Framework-aware | Routes, DI, ORM mapping, jobs, events, conventions |
| 4 | Cross-boundary workflow | Evidence-backed relations across application/service boundaries with known limits |

Proposed initial priority (final choice: OD-06): (1) JavaScript/TypeScript and common web frameworks; (2) SQL, JSON/YAML/TOML/env-example, Docker/Compose, common proxy and CI configuration; (3) Python web services and workers; (4) PHP, Java/Spring, C#/.NET and Go in stages; (5) others on demand. Each adapter declares supported entities and relations, prerequisites, limitations and version. Parsing alone must not be used to claim that a dynamic call or runtime route is definitely connected.

### 11.3 SAA requirements

Columns: **Pri** = priority; **St** = status (§1.3).

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| SAA-FR-001 | Repository discovery | P0 | C | Detects root, files, manifests, VCS/revision metadata and excluded areas; reports unreadable or skipped files with reasons | SAA-FR-001 |
| SAA-FR-002 | Project boundary detection | P0 | C | Identifies candidate apps/packages in a monorepo and keeps separate boundaries, each with supporting evidence; benchmark monorepos are not collapsed | SAA-FR-002 |
| SAA-FR-003 | Language/stack detection | P0 | C | Produces a language/framework inventory with adapter support levels; unknown formats are reported as unknown, not mislabeled | SAA-FR-003 |
| SAA-FR-004 | Read-only static analysis | P0 | C | A default run executes no application/package scripts and changes no file under the analyzed roots (verified by filesystem diff in tests) | SAA-FR-004 |
| SAA-FR-005 | Structural extraction | P0 | C | Extracts modules/symbols/imports/references for supported languages; parser errors and coverage are recorded | SAA-FR-005 |
| SAA-FR-006 | Dependency graph | P0 | C | Project/module dependency graph with evidence and revision; cycles are recorded, not looped on | SAA-FR-006, SAA §13 |
| SAA-FR-007 | API/interface extraction | P0 | C | Supported route/endpoint/schema/interface definitions are linked to source evidence | SAA-FR-007 |
| SAA-FR-008 | Data model extraction | P0 | C | Supported schema/migration/ORM relations extracted; declared vs. inferred mappings distinguished | SAA-FR-008 |
| SAA-FR-009 | Workflow tracing (deepening) | P0 | C (modified) | Tracing operates on workflows and entry points **discovered** by SAA-FR-040. A user may select a discovered item to deepen, but never has to name one in advance. Unresolved hops are explicit, and completion labels follow §11.1 | SAA-FR-009, MD-5, RC-C18 |
| SAA-FR-010 | Evidence provenance | P0 | C | Every material claim/relationship has revision and evidence or is labeled `inferred`/`unresolved` | SAA-FR-010 |
| SAA-FR-011 | Contradictions and unknowns | P0 | C | Incompatible code/docs/test evidence is preserved as contradiction records; actionable open questions are generated | SAA-FR-011 |
| SAA-FR-012 | SKB schema/export | P0 | C | Output is schema-validated and versioned, with stable IDs and run metadata; an invalid SKB is never published | SAA-FR-012 |
| SAA-FR-013 | Markdown documentation | P0 | C | Baseline document set (§12.2) generated from the SKB, including coverage and unknowns | SAA-FR-013 |
| SAA-FR-014 | CLI | P0 | C (modified) | Guided start, analysis, catalog browsing, inspect, deepen/trace, validate, export and status all work with no AI client connected. Commands take paths, URLs or generated IDs, never user-invented workflow names (§23.4). Stable exit codes and `--json` output | SAA-FR-014, SAA §4.4, MR §8 |
| SAA-FR-015 | QAA read interface | P0 | C | QAA can query workflows, contracts, roles, rules, dependencies, evidence, freshness and unknowns programmatically via the package and a local query library | SAA-FR-015, SAA §9.4 |
| SAA-FR-016 | Analyst Skill package | P0 | C | Contains methodology, tool-use policy, evidence rules, security/prompt-injection rules, QAA handoff rules and command examples; declares the CLI/MCP capability versions it expects; unsupported tools surface as incompatibilities | SAA-FR-016, SAA §4.4 |
| SAA-FR-017 | MCP server | P0 | C | Exposes core query/analysis tools (SAA §4.4 list) through the same engine, with typed narrow schemas, declared side-effect levels, scoped roots and no access outside approved roots via arguments | SAA-FR-017, SAA §4.4 |
| SAA-FR-018 | Secret-safe output | P0 | C | → merged into **SEC-004** (platform-wide); SAA-specific acceptance: no fixture secret appears in SKB, package, docs or logs | SAA-FR-018 |
| SAA-FR-019 | Prompt-injection resistance | P0 | C | → merged into **SEC-003**; SAA-specific acceptance: injection fixtures in repo files cannot authorize tools, alter policy or expand roots | SAA-FR-019 |
| SAA-FR-020 | Unsupported/missing dependency handling | P0 | C | Partial analysis succeeds where possible and reports the exact failed or skipped capabilities and their consequences | SAA-FR-020 |
| SAA-FR-021 | Incremental re-analysis | P1 | C | After a revision change, changed/affected entities are recomputed and unrevalidated claims are marked `stale`; a full rescan remains available | SAA-FR-021 |
| SAA-FR-022 | Git change/history signals | P1 | C | Evidence-linked revision diffs and hotspots; commit messages are never treated as ground truth | SAA-FR-022 |
| SAA-FR-023 | Test mapping | P1 | C | Supported tests are linked to entities/workflows; discovered tests are distinguished from executed tests | SAA-FR-023 |
| SAA-FR-024 | Optional runtime observation by starting the application | P1 | C | Requires explicit approval, target and profile (L4); records environment/run boundaries and side effects. Distinct from SAA-FR-042, which observes an environment the user already has at L2 (OD-11) | SAA-FR-024 |
| SAA-FR-025 | Review/annotation flow | P1 | C | Human annotations are attributed, versioned and labeled `human_asserted`, never as source evidence | SAA-FR-025 |
| SAA-FR-026 | CI impact report | P2 | C | A changed revision yields a bounded impact report using the cached graph/index | SAA-FR-026 |
| SAA-FR-027 | Review UI | P2 | C | Users can navigate evidence, review contradictions and approve annotations | SAA-FR-027 |
| SAA-FR-028 | Team/hosted operation | P2 | C | Optional service with defined access control, storage policy and source-data handling | SAA-FR-028 |
| SAA-FR-029 | Documentation Package export | P0 | P | `saa export` produces a package that passes the contract validator (CON-009) for every benchmark repository; the package is immutable once written | QAA §26, SAA §9.4 |
| SAA-FR-030 | Roles and permissions extraction | P0 | P | For supported frameworks, actors/roles, permissions and the checks guarding routes/operations are emitted as `actor_role`/`permission` entities with `AUTHORIZES_WITH` evidence; otherwise a gap record is emitted | QAA §26.3, SAA §6.1(10) |
| SAA-FR-031 | UI routes, pages, forms and navigation | P0 | P | Supported frontend adapters emit `page`, `form`, `form_field` and navigation relations, with field constraints where evidenced; unsupported frontends produce coverage records | QAA §26.3, SAA §6.1(7) |
| SAA-FR-032 | Business rules and validation as structured records | P0 | P | Each extracted rule is a `business_rule` entity with conditions, expected behavior if known, boundaries/exceptions, evidence and status; technical rule and business intent are separate fields | SAA §5.1 Phase 5, QAA §26.3 |
| SAA-FR-033 | State transitions | P0 | P | Where evidenced, `state_machine` entities list states, triggers/guards, side effects and known invalid transitions; where not evidenced for a stateful entity, a gap record is emitted | SAA §5.1 Phase 5, QAA §26.3 |
| SAA-FR-034 | Error handling and alternative flows | P0 | P | Workflows include alternate, error, authorization-failure, timeout and retry branches when evidenced, or mark them `unknown` | SAA §5.1 Phase 4, QAA §26.3 |
| SAA-FR-035 | Documentation language selection | P0 | P | Natural-language fields and Markdown render in the selected language (`en`, `id`); identifiers, paths, code and excerpts are unchanged; each artifact records its language (§19) | Task scope, QAA §8 |
| SAA-FR-036 | Output location and no in-repo writes by default | P0 | P | Default output is an explicit path outside analyzed roots; in-repo output (`.saa/`, `docs/saa/`) is opt-in; existing artifacts are never overwritten without configured behavior or confirmation | SAA §7.6, §12.2(7), §19.3 |
| SAA-FR-037 | Follow-up analysis request intake | P1 | P | SAA accepts a CON-015 request, runs a bounded investigation, and returns a new package version with a change rationale; requests exceeding budget return `partial` | SAA §3.2 J3, §9.3 |
| SAA-FR-038 | Model diff report | P1 | P | Between two package versions SAA emits `diff-report.json` listing added/changed/removed/renamed (with confidence)/newly stale/contradicted entities and claims | SAA §7.4, QAA FR-020 |
| SAA-FR-039 | Analysis budgets and cancellation | P0 | P | Configurable file/time/token/depth budgets per profile; cancellation stops work and labels the run `cancelled`; budget exhaustion yields `partial` with unvisited scope listed | SAA §5.1 Phase 0, §11.2, §13 |
| SAA-FR-040 | **Automatic workflow discovery and catalog** | P0 | P | With no workflow names supplied, SAA produces a catalog of discovered workflows. Each entry has a category (§11.6), entry points, evidence profile, status, completion label and unresolved links. On benchmark fixtures every labeled workflow is either found or reported as a gap; recall is tracked as a metric | MR-REQ-2, MD-5 |
| SAA-FR-041 | **Two-level tracing** | P0 | P | Component traces and end-to-end workflows are distinct records. A workflow lists the component traces it composes and where composition stops. A list of calls is never presented as a business workflow without a workflow record | MR §4 |
| SAA-FR-042 | **Runtime discovery of an authorized URL** (Modes B, C) | P0 | P | Using the runtime observation service at L2, SAA discovers reachable pages, links, forms, fields, visible constraints, navigation flows and visible validation/state messages within scope. Each is recorded as `runtime_observed` evidence with environment ID and time. Candidate workflows are produced, and unreachable or unobserved areas are recorded as gaps. Forms are submitted only with discovery probe enabled (SEC-024) | MR-REQ-1, MR §3 |
| SAA-FR-043 | **Evidence-source-neutral, evidence-bounded model** | P0 | P | A valid model may contain only source evidence, only runtime evidence, or both, and each claim records its evidence types. No claim exceeds its evidence: for example, a fixture where a success message is observed yields no `WRITES_TO` or delivery claim | MR-REQ-3 |
| SAA-FR-044 | **Source–runtime correlation** (Mode C) | P0 | P | Observed pages and forms are mapped to source routes and handlers, with a rationale. Discrepancy records are produced when they disagree. Revision correspondence is `user_confirmed`, `observed` (version endpoint) or `unconfirmed`, and is shown on every discrepancy | MR §3 Mode C |
| SAA-FR-045 | **Completeness report** | P0 | P | Every run reports: roots/boundaries or hosts/paths examined; analyzable constructs; entry points found; workflows reconstructed; workflows with unresolved links; unavailable adapters or dependencies; excluded and unexplored areas; and **evidence that would improve the analysis** | MR §4 |
| SAA-FR-046 | **Catalog at scale** | P0 | P | Large systems' catalogs are grouped by boundary/module/category and ranked by the §5.2 value heuristics. Deep tracing of lower-ranked workflows is available on demand, and catalog entries are never silently dropped for budget reasons (they are marked `not_deepened`) | SAA §5.2, MR §4 |

### 11.4 Minimum run outputs (C, SAA §10.1)

At the end of every run SAA returns: analysis status (§20.2); target identity and revision; detected projects, languages, frameworks and adapter levels; files inspected, skipped, generated and excluded (summarized); counts of entities, relationships, claims and workflows; evidence quality and freshness summary; major contradictions and unknowns; artifact locations; failed prerequisites and next steps; and whether any optional action (L4) was executed, with authorization metadata.

### 11.5 SAA edge-case behavior (C, SAA §13)

| Case | Must | Must not |
|---|---|---|
| Monorepo, multiple apps or versions (V1/V2) | Keep separate boundaries, labels, entrypoints and prefixes; add only evidence-backed cross-project edges | Collapse on names alone |
| Polyglot repository | Per-language adapters with shared IDs; mark unsupported cross-language hops | Pretend equal coverage |
| Missing dependencies / unbuildable | Continue statically; report skipped features | Fail entirely unless essential |
| Generated/vendor/build output | Classify, exclude or analyze by policy, with reasons | Flood workflows with generated internals |
| Dynamic dispatch, reflection, DI, decorators | Use framework, LSP or runtime evidence; label uncertain links | Turn name similarity into a verified edge |
| Event-driven/async | Model publishers, topics, handlers, retries and dead-letter config when visible | Assume synchronous ordering |
| Missing external repository/service | External node plus unresolved boundary; document visible contract | Invent third-party internals |
| Conflicting docs/code/tests | Keep all evidence; create contradiction record | Treat README/comment/test as authoritative |
| Feature flags / environment-specific | Model conditions and config source; scope claims | Declare one branch universally active |
| Renames/moves | Link with rationale; flag uncertain mapping | Silently reuse IDs for unrelated entities |
| Very large repository | Prioritize high-value boundaries; paginate, cache, report unvisited scope | Claim full coverage after budget exhaustion |
| Binary/non-text | Use metadata analyzers or skip explicitly | Feed bytes to an LLM |
| Malicious instructions in content | Treat as data; quote minimally | Execute or obey |
| Corrupt syntax | Keep diagnostics; tolerant parsing; partial coverage | Fabricate AST relations |
| Stale SKB | Mark stale; refresh before QAA relies on it | Present old knowledge as current |
| URL: off-scope link or redirect | Block, record as out-of-scope boundary | Follow it |
| URL: login wall, CAPTCHA, MFA | Discover the public area; ask for a credential profile | Bypass or brute-force |
| URL: crawler traps (calendars, infinite pagination, facets) | De-duplicate URL patterns; stop at budget; record | Exhaust budget on one pattern and claim coverage |
| URL: single-page application | Observe client-side routes and in-page navigation where visible | Treat one URL as one page |
| URL: success message after a submission | Record the visible outcome only | Infer persistence, delivery or business correctness |

### 11.6 Workflow discovery (SAA-FR-040, 041, 045)

**Discovery targets.** These are categories SAA attempts to discover. They are not a promise that every adapter recognizes every category equally well; adapter support levels (§11.2) govern that.

| Category | Examples | Typical evidence: source | Typical evidence: runtime |
|---|---|---|---|
| User interface | Navigation, form submission, login, account recovery | Routes, components, form handlers | Reachable pages, forms, visible results |
| API | Request handling, validation, authorization, responses | Route handlers, schemas, middleware | Network responses visible to the browser |
| Business process | Approval, registration, order processing, activation | Services, state updates, rules | Multi-page flows, visible states |
| Data lifecycle | Create, read, update, delete, archival, status changes | Models, migrations, queries | Visible lists/details changing (probe off: read-only) |
| Asynchronous processing | Queues, event handlers, callbacks, workers | Publishers/subscribers, consumer registrations | Rarely observable; recorded as gaps |
| Scheduled processing | Cron jobs, periodic syncs, cleanups | Scheduler config, job definitions | Not observable; recorded as gaps |
| Integration | External APIs, payment, email, identity providers | HTTP clients, SDKs, webhook handlers | Redirects to providers (boundary only) |
| Authentication and authorization | Login, sessions, tokens, permission checks | Auth middleware, guards, role constants | Login pages, access-denied outcomes per credential profile |
| Error and recovery | Validation failures, exceptions, retries, fallbacks | Error handlers, retry config | Visible error messages and states |
| Cross-component | Frontend → API → service → DB → worker → external | Combined traces across boundaries | Partial: the visible ends of the chain |

**Discovery procedure.**
1. Find entry points per boundary.
2. Build component traces from each entry point.
3. Compose traces into end-to-end workflows across boundaries using evidence:
   - client calls to API routes;
   - publisher → topic → consumer;
   - scheduler → job;
   - webhook → handler;
   - in Mode C, observed page → source route.
4. Stop composition at evidence boundaries and record why: dynamic registration, missing repository, external provider, unresolved configuration, or unobservable at runtime.
5. Classify and rank (SAA-FR-046).

**When is SAA finished?** SAA never claims to have found everything. A run is finished when its plan and budget are exhausted or complete. What was found is stated by the completeness report (SAA-FR-045). A `completed` run can still contain substantial, explicitly listed gaps.

---

## 12. SAA outputs and documentation model

### 12.1 System Knowledge Base (C, SAA §7)

The SKB is the durable, machine-readable source of accepted knowledge. It is queryable, versioned, schema-validated, portable and diffable. Markdown documents are views generated from it. Core record types:

| Record | Content |
|---|---|
| System/Project | Repository identity, revision, worktree state, boundaries, stacks, profile, tool versions, timestamps, coverage |
| Entity | Node: application, package, module, file, function, class, route, page, form, form field, API operation, request/response schema, table/column/index, ORM model, business concept, business rule, actor/role, permission, state machine, workflow, test, config key, scheduled job, queue/topic, external service, deployment unit, secret reference, requirement |
| Relationship | `CONTAINS`, `IMPORTS`, `CALLS`, `REFERENCES`, `EXPOSES`, `CONSUMES`, `READS_FROM`, `WRITES_TO`, `PUBLISHES`, `SUBSCRIBES_TO`, `AUTHENTICATES_WITH`, `AUTHORIZES_WITH`, `VALIDATES`, `CONFIGURED_BY`, `DEPLOYED_AS`, `TESTS`, `USES_SCHEMA`, `DEPENDS_ON`, `TRIGGERS`, `SENDS_TO`, `NAVIGATES_TO`, `SUBMITS_TO`, `TRANSITIONS_TO`, `SATISFIES` |
| Evidence | Artifact type, path or external reference, line/column range or structural selector, revision, file fingerprint, analyzer and version, timestamp, excerpt or digest per privacy policy, verification method |
| Claim | Statement, provenance status, confidence rationale, subject entity, relationships, evidence, scope, caveats, last validated revision |
| Component trace | Entry point or component, the relations it establishes (`CALLS`, `READS_FROM`, …), evidence, and where tracing stopped and why |
| Workflow | Category (§11.6), discovery origin (`source`, `runtime`, `both`), composed component traces, ordered/branched steps, entry points, decisions, reads/writes, side effects, errors, external boundaries, tests, unresolved hops, completion label, `deepened` flag |
| Coverage item | Analyzed, skipped, unsupported, failed or partial, with reason |
| Open question/contradiction | Unresolved requirement, ambiguous mapping, conflicting evidence, missing dependency, stale claim, docs/tests/code mismatch |
| Annotation | Human correction, business note or approval; separately attributed |

The relationship types `NAVIGATES_TO`, `SUBMITS_TO`, `TRANSITIONS_TO` and `SATISFIES` and the entity types `page`, `form`, `form_field`, `actor_role`, `permission`, `state_machine`, `business_rule` and `requirement` are **Proposed** additions. They are needed to represent what QAA §26.3 requires (RC-G03).

Storage (C, SAA §7.6; location default changed per SAA-FR-036): `<output>/manifest.json`, `<output>/index/` (disposable cache), `<output>/knowledge/` (canonical SKB), `<output>/docs/` (Markdown), `<output>/packages/<package_id>/<version>/` (exported packages). Any optional graph database must remain rebuildable from the canonical SKB. The canonical storage format at scale is OD-08.

### 12.2 Generated documentation set (C, SAA §8)

File names are configurable; each document's **role** is fixed and is what QAA uses to find it (CON-011).

| Role | Default file | Required content |
|---|---|---|
| `executive_summary` | `00-executive-summary.md` | System summary, **evidence profile and what it cannot establish**, boundaries, major components, key workflows, completeness report summary, limitations, high-risk unknowns |
| `system_context` | `01-system-context.md` | Actors, applications, external services, trust boundaries |
| `architecture` | `02-architecture.md` | Containers/services/modules, dependencies, deployment boundary evidence, diagrams generated from relationships |
| `project_inventory` | `03-project-inventory.md` | Languages, frameworks, manifests, entrypoints, observed build/test commands (not executed), generated/vendor files, coverage |
| `components` | `04-components.md` | Responsibilities (inferred from code), interfaces, dependencies, stores, explicitly provided owners, key files |
| `workflow_catalog` | `05-workflow-catalog.md` (P) | All discovered workflows by category: entry points, evidence profile, completion, unresolved links, `not_deepened` markers |
| `workflows` | `05-workflows/<workflow>.md` | One per discovered workflow (detailed for ranked or deepened ones): steps, branches, reads/writes, side effects, errors, tests, confidence, unknown hops |
| `observed_behavior` | `05c-observed-behavior.md` (P) | Runtime-observed pages, navigation, forms, visible validation and states, environment and observation window, unobserved areas |
| `routes_and_pages` | `05a-routes-pages-forms.md` (P) | Route/page map, forms, fields, constraints, navigation, access preconditions |
| `roles_and_permissions` | `08-authentication-authorization.md` | Login/session/token/cookie handling, middleware, role/permission mapping, checks, gaps |
| `business_rules` | `05b-business-rules-and-states.md` (P) | Rules, validations, boundaries, state machines, invalid transitions |
| `api_contracts` | `06-api-contracts.md` | Methods/routes, auth, request/response schemas, errors, validation, source locations |
| `data_model` | `07-data-model.md` | Tables/models/fields, relations, migrations, constraints, query links, transactions, sensitivity caveats |
| `integrations_events` | `09-integrations-and-events.md` | HTTP clients, SDKs, queues, topics, webhooks, retries/timeouts, missing external evidence |
| `configuration_deployment` | `10-configuration-and-deployment.md` | Variable names (values redacted), precedence, ports, proxies, containers, build/deploy paths |
| `tests_coverage` | `11-tests-and-quality-coverage.md` | Test frameworks and locations, mappings, uncovered areas; execution status only if actually run |
| `dependencies_impact` | `12-dependencies-and-impact.md` | Dependency graph, cycles, hotspots, change evidence |
| `risks_contradictions` | `13-risks-and-contradictions.md` | Mismatches, fragile/dynamic boundaries, unsupported analyzers, stale evidence, coupling |
| `unknowns` | `14-unknowns-and-next-investigations.md` | Questions, missing repos/services, low-confidence claims, needed human input |

Every document states the analyzed revision, analysis date, profile, language, coverage caveats and SKB IDs or evidence references. A section that could not be analyzed documents the gap; it is never silently omitted.

### 12.3 Definition of done for a published claim (C, SAA Appendix C)

A claim may be published as `source_verified` only if its evidence refers to a real file or structure at the recorded revision, directly supports the narrow wording, does not extend beyond the inspected scope, has been checked against competing evidence when high-impact, and records scope and limitations. Otherwise it is narrowed, or labeled `inferred`, `contradicted` or `unresolved`.

---

## 13. SAA-to-QAA integration contract

### 13.1 Contract principles

- **Artifact-first for the MVP** (C, QAA §1.1, §23): SAA exports a versioned Documentation Package that QAA imports. A file-based local query library (SAA §9.4) and later an API or shared workspace (QAA-FR-019, P1) must expose the **same** canonical contract.
- **Independently versioned** (C, QAA §26): the contract has its own semantic version, separate from SAA and QAA release versions.
- **Structured data is authoritative for machines; Markdown is for humans** (C, QAA FR-011, X-19). QAA must not depend on parsing Markdown when structured artifacts exist.
- **Not unquestionable truth** (C, QAA §1.1): QAA preserves provenance and certainty labels, verifies relevant claims, and surfaces discrepancies.
- **Loose coupling**: either side can be tested alone against the published JSON Schemas and conformance fixtures (CON-018).
- **Revision-bound**: a package describes exactly one revision. Evidence from incompatible revisions is never silently merged (SAA §7.4).

### 13.2 Package structure

```text
<package_id>/<package_version>/
├── manifest.json            REQUIRED  identity, revision, analysis status, coverage, artifact list, checksums
├── system-model.json        REQUIRED  entities, relationships, claims, workflows, rules, states, roles, gaps
├── evidence-index.json      REQUIRED  evidence records referenced by claims and entities
├── docs/
│   ├── en/…                 REQUIRED  at least one language; roles per §12.2
│   └── id/…                 OPTIONAL  additional documentation languages
├── diff-report.json         OPTIONAL  change since previous_package (SAA-FR-038)
├── schemas/                 OPTIONAL  copies of the JSON Schemas used (for offline validation)
└── assets/                  OPTIONAL  diagrams, OpenAPI files, data dictionaries — each listed in manifest
```

Any file not listed in `manifest.artifacts` is ignored by QAA and reported as a warning.

### 13.3 Manifest

Required fields: `contract`, `package_schema_version`, `package_id`, `package_version`, `producer`, `project`, `evidence_profile`, `analysis`, `generated_at`, `languages`, `coverage_summary`, `artifacts`. Conditional fields:
- `repository` is required when `evidence_profile.source_analysis` is `available`, and is `null` otherwise.
- `observed_environments` is required when `runtime_observation` is `available`.
- `previous_package` is required when `package_version > 1`.

The example below is a Mode C (combined) package.

```json
{
  "contract": "sys2qa.documentation-package",
  "package_schema_version": "1.0.0",
  "package_id": "pkg:acme-portal",
  "package_version": 3,
  "previous_package": { "package_version": 2, "revision": "9c1e…b04a" },
  "producer": {
    "name": "SAA",
    "version": "0.1.0",
    "adapters": [
      { "id": "js-ts", "version": "0.1.0", "support_level": 3 },
      { "id": "sql", "version": "0.1.0", "support_level": 2 }
    ]
  },
  "project": { "system_id": "system:acme-portal", "name": "Acme Portal" },
  "evidence_profile": {
    "source_analysis": "available",
    "runtime_observation": "available",
    "documentation_import": "unavailable",
    "revision_correspondence": "user_confirmed",
    "cannot_establish": ["Behavior of scheduled jobs at runtime", "Email delivery by external provider"]
  },
  "observed_environments": [
    { "environment_id": "env:acme-staging", "base_url": "https://staging.acme.example",
      "classification": "staging", "observed_from": "2026-10-21T08:45:00Z", "observed_to": "2026-10-21T09:05:00Z",
      "target_app_locale": "id-ID", "deployed_revision": { "value": "4b77…e0c2", "source": "declared" },
      "permission_level_max": "L2", "discovery_probe": false }
  ],
  "repository": {
    "provider": "git",
    "identity": "github.com/example/acme-portal",
    "identity_source": "local_git_remote",
    "revision": { "kind": "git_commit", "value": "4b77…e0c2", "worktree_dirty": false },
    "branch_hint": "main"
  },
  "analysis": {
    "run_id": "run:2026-10-21T08:00:00Z-7f3a",
    "profile": "standard",
    "status": "completed_with_limitations",
    "permission_level_max": "L1",
    "optional_actions_executed": [],
    "started_at": "2026-10-21T08:00:00Z",
    "finished_at": "2026-10-21T08:41:12Z",
    "scope": { "roots": ["."], "excluded": ["node_modules/", "dist/", ".env"] },
    "limitations": ["Python worker in services/reports detected at support level 0 only."]
  },
  "generated_at": "2026-10-21T08:41:30Z",
  "languages": { "documentation": ["en", "id"], "default": "en", "machine_text": "en" },
  "coverage_summary": {
    "modules": "complete",
    "routes_pages": "complete",
    "roles_permissions": "partial",
    "business_rules": "partial",
    "workflows": "partial",
    "state_transitions": "absent",
    "api_contracts": "complete",
    "data_model": "complete",
    "integrations": "partial",
    "error_paths": "partial"
  },
  "redaction": { "secrets": "redacted", "excerpts": "short_excerpts", "max_excerpt_chars": 400 },
  "artifacts": [
    { "id": "system-model", "role": "system_model", "path": "system-model.json",
      "media_type": "application/json", "schema_version": "1.0.0", "required": true, "sha256": "…" },
    { "id": "evidence-index", "role": "evidence_index", "path": "evidence-index.json",
      "media_type": "application/json", "schema_version": "1.0.0", "required": true, "sha256": "…" },
    { "id": "doc-workflows-registration-en", "role": "workflows", "path": "docs/en/05-workflows/registration.md",
      "media_type": "text/markdown", "language": "en", "sha256": "…" },
    { "id": "doc-workflows-registration-id", "role": "workflows", "path": "docs/id/05-workflows/registration.md",
      "media_type": "text/markdown", "language": "id", "translation_of": "doc-workflows-registration-en",
      "machine_translated": true, "sha256": "…" },
    { "id": "diff-report", "role": "diff_report", "path": "diff-report.json",
      "media_type": "application/json", "schema_version": "1.0.0", "sha256": "…" }
  ]
}
```

Coverage values: `complete`, `partial`, `absent` (applicable but not found), `not_applicable`, `unsupported` (no adapter can analyze it), `unobservable` (cannot be established from the available evidence type, e.g. `data_model` in a URL-only package). `absent`, `unsupported` and `unobservable` must each have a gap record in the system model.

Evidence profile values (CON-020):
- Each of `source_analysis`, `runtime_observation` and `documentation_import` is `available`, `unavailable` or `partial`.
- `revision_correspondence` is `user_confirmed`, `observed`, `unconfirmed` or `not_applicable`.
- `cannot_establish` lists, in machine text, the important questions this profile cannot answer.

In a Mode B package, `repository` is `null`, and system-model and evidence revisions use `kind: observation_window` (§13.8).

### 13.4 Identifiers

| Rule | Specification |
|---|---|
| Grammar | `<kind>:<local-id>`. `kind` matches `[a-z][a-z0-9_]*`; `local-id` is non-empty, has no whitespace, is case-sensitive, and is at most 256 characters. |
| Kinds (minimum) | `system`, `project`, `module`, `page`, `route`, `form`, `field`, `api`, `actor_role`, `permission`, `workflow`, `step`, `business_rule`, `state_machine`, `entity`, `integration`, `test`, `requirement`, `claim`, `evidence`, `gap`, `run`, `pkg` |
| Stability | Semantic IDs derive from the kind, project boundary and natural key (for example route method and path, or rule subject and condition), never from line numbers. The same entity keeps its ID across revisions while its natural key is unchanged. |
| Revision-specific IDs | `evidence:*` and `run:*` may be revision-specific. |
| Renames | A rename or move maps the old ID to the new ID in `diff-report.json`, with a rename rationale and `confidence`. Uncertain mappings are reported, never silently merged (SAA §7.4). |
| Language independence | IDs never contain translated text and never change when documentation language changes. |
| QAA-owned IDs | QAA records use their own kinds (`scenario:`, `scnver:`, `approval:`, `mrun:`, `arun:`, `defect:`, `qevid:`, `report:`). Human-readable display keys such as `TC-REG-001` are separate from IDs. |
| Requirements | `requirement:*` entities may originate from SAA annotations or from QAA-supplied requirement documents. `origin` records which one, and the ID namespace is shared per project. |

### 13.5 System model

The system model is the SKB contract view for one revision. Minimum semantic coverage follows QAA §26.3. Every entity has `id`, `kind`, `name`, `project_boundary`, `status` (provenance), `evidence_ids`, `claim_ids` and an optional `lang`-tagged `description`.

```json
{
  "schema_version": "1.0.0",
  "system_id": "system:acme-portal",
  "revision": { "kind": "git_commit", "value": "4b77…e0c2", "worktree_dirty": false },
  "analysis_run_id": "run:2026-10-21T08:00:00Z-7f3a",
  "machine_text_language": "en",
  "entities": [
    { "id": "module:web.registration", "kind": "module", "name": "Registration (web)",
      "project_boundary": "project:web", "status": "source_verified", "evidence_ids": ["evidence:reg-module-1-40"] },
    { "id": "page:web:/registrasi", "kind": "page", "name": "Registration page",
      "route_pattern": "/registrasi", "module_id": "module:web.registration",
      "access_preconditions": ["permission:registration.create"], "status": "source_verified",
      "evidence_ids": ["evidence:router-22-24"] },
    { "id": "form:web:/registrasi#registration", "kind": "form", "page_id": "page:web:/registrasi",
      "submits_to": "api:POST:/api/registrations", "status": "source_verified", "evidence_ids": ["evidence:regform-10-88"] },
    { "id": "field:web:/registrasi#registration.nib", "kind": "field", "form_id": "form:web:/registrasi#registration",
      "label_literal": { "value": "NIB", "language": "id", "source": "source_code" },
      "constraints": { "required": true, "pattern": "^[0-9]{13}$", "min_length": 13, "max_length": 13 },
      "status": "source_verified", "evidence_ids": ["evidence:regform-41-47", "evidence:reg-schema-12-19"] },
    { "id": "actor_role:applicant", "kind": "actor_role", "name": "Applicant",
      "permissions": ["permission:registration.create"], "status": "inferred",
      "confidence_rationale": "Role name from auth middleware constant; no role documentation found.",
      "evidence_ids": ["evidence:auth-roles-3-15"] },
    { "id": "business_rule:registration.nib_required_13_digits", "kind": "business_rule",
      "statement": "Registration is rejected unless NIB is exactly 13 digits.",
      "technical_rule": "Server schema enforces required + /^[0-9]{13}$/ on nib.",
      "business_intent": null,
      "inputs": ["field:web:/registrasi#registration.nib"],
      "expected_behavior": { "on_violation": "HTTP 422 with field error 'nib'", "ui": "Inline required/format error" },
      "boundaries": [ { "field": "nib", "min_length": 13, "max_length": 13 } ],
      "status": "source_verified", "evidence_ids": ["evidence:reg-schema-12-19", "evidence:reg-controller-30-52"],
      "contradiction_ids": ["gap:nib-length-docs-mismatch"] },
    { "id": "state_machine:registration.status", "kind": "state_machine", "subject": "entity:registration",
      "states": ["draft", "submitted", "approved", "rejected"],
      "transitions": [
        { "from": "draft", "to": "submitted", "trigger": "api:POST:/api/registrations", "guard": "business_rule:registration.nib_required_13_digits", "status": "source_verified", "evidence_ids": ["evidence:reg-service-60-91"] },
        { "from": "submitted", "to": "approved", "trigger": "api:POST:/api/registrations/{id}/approve", "guard": "permission:registration.approve", "status": "inferred", "evidence_ids": ["evidence:reg-service-95-120"] }
      ],
      "invalid_transitions_known": [ { "from": "rejected", "to": "approved", "status": "source_verified", "evidence_ids": ["evidence:reg-service-122-130"] } ],
      "status": "inferred" }
  ],
  "relationships": [
    { "id": "rel:form-registration-submits", "type": "SUBMITS_TO", "from": "form:web:/registrasi#registration",
      "to": "api:POST:/api/registrations", "status": "source_verified", "evidence_ids": ["evidence:regform-80-88"] }
  ],
  "workflows": [
    { "id": "workflow:registration.submit", "name": "Submit registration", "actor": "actor_role:applicant",
      "entrypoint": "page:web:/registrasi",
      "steps": [
        { "id": "step:registration.submit.1", "order": 1, "entity_id": "page:web:/registrasi", "action": "open" },
        { "id": "step:registration.submit.2", "order": 2, "entity_id": "form:web:/registrasi#registration", "action": "submit",
          "validations": ["business_rule:registration.nib_required_13_digits"] },
        { "id": "step:registration.submit.3", "order": 3, "entity_id": "api:POST:/api/registrations", "action": "persist",
          "writes": ["entity:registration"], "side_effects": ["integration:email.confirmation"] }
      ],
      "branches": [ { "from_step": "step:registration.submit.2", "condition": "NIB invalid", "outcome": "validation_error", "status": "source_verified" } ],
      "unresolved_hops": [ { "after_step": "step:registration.submit.3", "reason": "Email provider external to repository", "gap_id": "gap:email-delivery" } ],
      "completion": "complete_within_static_scope",
      "status": "source_verified" }
  ],
  "claims": [
    { "id": "claim:registration-persists-after-validation",
      "text": { "language": "en", "value": "The registration API writes a registration record after NIB validation passes." },
      "status": "source_verified", "subject_entity_id": "api:POST:/api/registrations",
      "evidence_ids": ["evidence:reg-controller-30-52", "evidence:reg-service-60-91"],
      "scope": "static_analysis", "caveats": ["Email delivery not verified."], "last_validated_revision": "4b77…e0c2" }
  ],
  "gaps": [
    { "id": "gap:nib-length-docs-mismatch", "type": "contradiction",
      "description": "README states NIB has 16 digits; server schema enforces 13.",
      "impact": "Boundary tests for NIB depend on which is intended.", "evidence_ids": ["evidence:readme-40-41", "evidence:reg-schema-12-19"],
      "requires_human_clarification": true, "status": "unresolved" },
    { "id": "gap:email-delivery", "type": "external_boundary",
      "description": "Confirmation email provider is configured outside the repository.",
      "impact": "Email side effect cannot be asserted from source.", "requires_human_clarification": false, "status": "unresolved" }
  ],
  "coverage": [
    { "area": "services/reports", "status": "unsupported", "reason": "Python adapter not installed (support level 0)." }
  ]
}
```

### 13.6 Provenance status vocabulary and mapping to QAA expected-result basis

The source PRDs use two vocabularies for related concepts: SAA claim statuses (SAA §7.3) and QAA expected-result bases (QAA FR-033). Both are kept, because they answer different questions, and are mapped as follows (P, resolves RC-C04).

| SAA claim status | Meaning | QAA `expected_result.basis` when derived from it | Allowed QAA use |
|---|---|---|---|
| `source_verified` | Directly established by source/config/schema at the revision | `saa_documented` (with `saa_status: source_verified`) | Scenario `pending_review`; expected result describes **implemented** behavior |
| `test_verified` | Supported by an executed test result | `saa_documented` (`test_verified`) | Same as above |
| `runtime_observed` | Observed in a specific approved run | `saa_documented` (`runtime_observed`) | Same; scope limited to the observed conditions |
| `human_asserted` | Supplied by an analyst/stakeholder | `saa_documented` (`human_asserted`) | Treated like a stated requirement only if the annotation is marked as requirement-level |
| `inferred` | Plausible, not established | `inferred` | Exploratory or `needs_clarification`; never presented as a confirmed requirement |
| `contradicted` | Credible conflicting evidence | `unresolved` | Scenario forced to `needs_clarification` |
| `unresolved` | Evidence insufficient | `unresolved` | Gap-driven exploratory charter or `needs_clarification` |
| `stale` | Revision changed, not revalidated | Not usable as basis | Blocks approval for execution of dependent scenarios until revalidated |

QAA's full basis enumeration (controlled, P): `requirement_backed` (supplied requirement), `user_confirmed` (confirmed during QAA review), `saa_documented` (+ `saa_status`), `source_supported` (QAA targeted source check), `observed` (QAA browser/network observation), `inferred`, `unresolved`.

**Test-oracle rule (P):** only `requirement_backed`, `user_confirmed`, and `saa_documented` with `saa_status: human_asserted` at requirement level represent **intended** behavior. All other bases represent **implemented or observed** behavior. A pass against them is reported as verification against current implementation (characterization or regression), not validation of business needs (QAA §6.6).

### 13.7 Evidence index

```json
{
  "schema_version": "1.0.0",
  "revision": { "kind": "git_commit", "value": "4b77…e0c2" },
  "evidence": [
    { "id": "evidence:reg-schema-12-19", "source_type": "source_code",
      "path": "apps/api/src/registration/schema.ts", "range": { "start_line": 12, "end_line": 19 },
      "file_fingerprint": "sha256:…", "extractor": { "adapter": "js-ts", "version": "0.1.0", "method": "ast" },
      "excerpt": "nib: z.string().regex(/^[0-9]{13}$/)", "excerpt_policy": "short_excerpt",
      "captured_at": "2026-10-21T08:12:03Z" },
    { "id": "evidence:readme-40-41", "source_type": "documentation",
      "path": "README.md", "range": { "start_line": 40, "end_line": 41 },
      "file_fingerprint": "sha256:…", "extractor": { "adapter": "docs", "version": "0.1.0", "method": "text" },
      "excerpt_digest": "sha256:…", "excerpt_policy": "digest_only", "captured_at": "2026-10-21T08:12:09Z" }
  ]
}
```

`source_type` values: `source_code`, `configuration`, `schema`, `migration`, `test_definition`, `documentation`, `git_history`, `manifest`, `runtime_observation`, `test_result`, `human_annotation`, `requirement_document`. QAA adds its own evidence types in its store (`browser_observation`, `network_observation`, `targeted_source_check`, `tester_report`, `screenshot`, `trace`) and never writes them into an SAA package.

SAA runtime-discovery evidence uses `source_type: runtime_observation` with a `subtype` of `page`, `navigation`, `form`, `validation_message`, `state_message` or `access_outcome`. It adds `environment_id`, `url` (scope-normalized, query secrets redacted), `observed_at`, `credential_profile_role` (role name only), `discovery_probe` (bool) and an optional screenshot digest. `path` and `range` are absent.

### 13.8 Revision and environment metadata (P, resolves RC-C03)

| Field | Rule |
|---|---|
| `revision.kind` | `git_commit` (40/64-hex SHA) or `content_fingerprint` (hash over included files, for non-Git sources). |
| `revision.worktree_dirty` | `true` if uncommitted changes were analyzed. The package is then reproducible only from the fingerprint stored alongside (`revision.dirty_fingerprint`). |
| `repository.identity` | Read from local Git metadata (`local_git_remote`) or supplied by the user (`user_supplied`). Never fetched from a remote service. `null` when no source was analyzed. |
| `revision.kind = observation_window` | Runtime-only evidence identity: `environment_id`, `observed_from`, `observed_to`. Used when no source revision applies (Mode B), and alongside a source revision for runtime evidence in Mode C (CON-021). |
| `analysis.*` | Run ID, profile, timestamps, status, max permission level, optional L4 actions executed (with approval metadata). |
| Environment metadata | Belongs to QAA, not to the package. QAA records environment ID, base URL, classification, deployed revision when knowable (`declared` by user or `observed` from a version endpoint), browser, viewport, locale and timezone (QAA-FR-008). |

Policy for dirty or non-Git packages: **OD-04**. Recommended: allow import, cap readiness at `review_only`, and allow execution approval only after the user explicitly confirms the target environment runs that working tree (audited).

### 13.9 Completeness, readiness and freshness

**SAA analysis status** (C, SAA §13.1): `completed`, `completed_with_limitations`, `partial`, `failed`, `cancelled`. QAA PRD's `complete_with_gaps` maps to `completed_with_limitations` (RC-T04).

**QAA readiness** (P; formalizes QAA FR-013/014/018, §26.4), computed per selected scope:

| Readiness | Condition (any) | Allowed |
|---|---|---|
| `blocked` | Package missing, malformed, unsupported major version, checksum mismatch, broken references; `analysis.status` `failed`/`cancelled`; material gap on all selected flows | Inspect errors only |
| `review_only` | `analysis.status` `partial`; freshness `mismatched` or `stale` affecting selected flows; Markdown-only fallback; dirty or non-Git revision (OD-04); material contradiction on selected flows | Generate and review drafts; **no execution approval** |
| `ready_with_gaps` | `completed_with_limitations`; non-material gaps or `partial`/`absent` categories outside selected flows | Full workflow; gap areas flagged on affected scenarios |
| `ready` | `completed`, freshness `current`, no material gap in selected flows | Full workflow |

**Package freshness** (C, QAA FR-014): `current` (package revision equals baseline revision), `mismatched` (differs; impact assessable), `stale` (a newer package or revision exists and affects selected flows), `unverifiable` (deployed revision unknown). A mismatch does not mean the documentation is wrong; it must be visible (QAA §26.4).

**Readiness per QA activity (P, CON-022).** Readiness is computed separately for:
- `scenario_design`;
- `manual_preparation` (manual test packs);
- `automated_execution`.

The rules:
- A package is **never downgraded for evidence it does not claim to have**. A Mode B package is not `review_only` merely because it lacks source, and a Mode A package is not `blocked` for design merely because no environment exists.
- Missing evidence instead constrains the **QA objectives** that are possible (§15.9) and is attached as limitations to affected scenarios.
- `automated_execution` additionally requires a configured, reachable, non-production environment.

**Materiality (P):** a gap is material for a scope when it touches an entity on the path of a workflow in QA scope (chosen from the discovered catalog), a business rule used as an expected result, or a permission guarding a selected step. Users can override materiality with an audited reason.

### 13.10 Validation and error handling

QAA validates in this order and stops at the first `error`. Every result is machine-readable (`code`, `severity`, `artifact_id`, `json_pointer`, `message`, `remediation`).

| Code | Severity | Condition | QAA behavior |
|---|---|---|---|
| `PKG_NOT_FOUND` | error | Path or archive missing/unreadable | `blocked`; prompt to select/export a package |
| `PKG_MANIFEST_INVALID` | error | Manifest fails schema | `blocked`; list schema violations |
| `PKG_SCHEMA_UNSUPPORTED_MAJOR` | error | Major version outside QAA's supported range | `blocked`; state supported range and required SAA version |
| `PKG_ARTIFACT_MISSING` | error | Required artifact absent | `blocked` |
| `PKG_CHECKSUM_MISMATCH` | error | `sha256` mismatch | `blocked`; the package may be tampered or corrupt |
| `PKG_ARTIFACT_INVALID` | error | system-model/evidence-index fails schema | `blocked` |
| `PKG_REFERENCE_BROKEN` | error | Dangling entity/claim/evidence ID | `blocked`; list IDs |
| `PKG_ANALYSIS_FAILED` | error | `analysis.status` is `failed`/`cancelled` | `blocked` |
| `PKG_SECRET_SUSPECTED` | error | Validator detects a likely raw secret value | `blocked`; do not display the value; advise re-export |
| `PKG_EVIDENCE_REVISION_MISMATCH` | error | Evidence revision differs from package revision | `blocked` (no silent merge) |
| `PKG_EVIDENCE_PROFILE_INCONSISTENT` | error | For example, runtime evidence without `observed_environments`, source evidence with `repository: null`, or a `cannot_establish` item contradicted by a `source_verified` claim | `blocked`; list offending records |
| `PKG_ANALYSIS_PARTIAL` | warning | `partial` | `review_only` |
| `PKG_REVISION_MISMATCH` | warning | Revision ≠ baseline | Freshness `mismatched`; `review_only` for affected flows |
| `PKG_REVISION_UNVERIFIABLE` | warning | Deployed revision unknown | Freshness `unverifiable`; execution approval requires an explicit baseline confirmation |
| `PKG_DIRTY_OR_NON_GIT` | warning | Dirty worktree or fingerprint revision | Per OD-04 |
| `PKG_MARKDOWN_ONLY` | warning | No structured artifacts | Fallback import (CON-016); `review_only` |
| `PKG_MINOR_NEWER` | info | Newer minor version | Accept; preserve unknown fields |
| `PKG_LANGUAGE_UNAVAILABLE` | info | Requested documentation language missing | Fall back per §19.4 |
| `PKG_UNLISTED_FILE` | info | File not in manifest | Ignore and report |

The original package is stored unchanged next to QAA's normalized representation (C, QAA §26.4).

### 13.11 Re-analysis and staleness propagation

Re-analysis is SAA's responsibility (SAA-FR-021). Staleness propagation is QAA's (QAA-FR-046, QAA-FR-047). A new package for a different revision creates a **new baseline** and never overwrites earlier packages, scenarios, approvals or results (C, QAA §26.4).

Scenario freshness (P): `current`, `potentially_stale`, `stale`. Approval state (P): `active`, `suspended`, `invalidated`, `superseded`, `revoked`.

| Event | Documentation (SAA) | Scenario freshness | Approval | Prior results |
|---|---|---|---|---|
| New package, diff available; linked entity **unchanged** | Claims revalidated | `current` against new baseline | `suspended` until **revalidation**: a single human action that rebinds unaffected approvals to the new baseline (new approval records, audited) | Unchanged; labeled with original baseline |
| Linked entity **changed** | Changed claims re-derived | `potentially_stale` | `suspended`; reviewer must re-approve or edit | Unchanged |
| Linked entity **removed** or claim now `contradicted` | Removed/contradicted | `stale` | `invalidated`; edit or retire required | Unchanged |
| New package, **no diff** available | — | All `potentially_stale` | All `suspended` | Unchanged |
| Rename with uncertain mapping | Diff reports low-confidence rename | `potentially_stale` | `suspended` until the mapping is confirmed | Unchanged |
| Deployed revision of environment changes or becomes unknown | — | Freshness recomputed | `suspended` for affected scenarios | Unchanged |
| Environment re-discovered (new runtime package) | Observations re-derived; diff where possible | As for a new package with or without diff | As for a new package | Unchanged |
| Runtime observations older than the freshness window (OD-27) | Marked `stale` for revalidation | `potentially_stale` for scenarios relying only on runtime evidence | `suspended` | Unchanged |
| Scope policy, environment config or test-data profile changes | — | Unchanged | `suspended` for approvals bound to the old version | Unchanged |
| Scenario edited | — | New version `draft` | Prior version's approval `superseded`; the edit is not approved (QAA FR-053) | Unchanged |
| User revokes approval | — | — | `revoked` | Unchanged |

The executor runs a scenario only if its approval is `active` **and** the approval baseline (package ID + version, revision, environment, scope policy version, test-data profile) equals the run's baseline (QAA-FR-054). Reports comparing runs flag baseline differences (QAA-FR-095).

### 13.12 Follow-up analysis request (QAA → SAA)

```json
{
  "contract": "sys2qa.analysis-request",
  "schema_version": "1.0.0",
  "request_id": "areq:2026-10-22-001",
  "system_id": "system:acme-portal",
  "base_package": { "package_id": "pkg:acme-portal", "package_version": 3 },
  "revision": { "kind": "git_commit", "value": "4b77…e0c2" },
  "environment_id": null,
  "subject_ids": ["business_rule:registration.nib_required_13_digits", "gap:nib-length-docs-mismatch"],
  "question": "Is a 16-digit NIB accepted by any code path (client or server)?",
  "trigger": { "type": "test_failure", "ref": "arun:…/case:TC-REG-004" },
  "budget": { "max_files": 200, "max_minutes": 10, "max_llm_tokens": 50000 },
  "max_permission_level": "L1",
  "requested_by": "user:…",
  "created_at": "2026-10-22T03:10:00Z"
}
```

SAA responds by publishing a new package version whose `diff-report.json` references `request_id`, plus a response record (`answered`, `partial`, `rejected` with reason). Transport: file-based in the MVP; API P1 (OD-12).

### 13.13 Compatibility and versioning

- Contract versions use semantic versioning per schema (`package_schema_version`, `schema_version` per artifact).
- **Major:** breaking change; QAA rejects versions outside its declared supported range (C, QAA §26.4).
- **Minor:** additive; QAA accepts newer minors, ignores unknown fields for logic, and preserves them in the stored original.
- **Patch:** clarifications with no shape change.
- SAA declares the contract versions it can emit; QAA declares the versions it can read; the SAA Skill declares the CLI/MCP capability version it expects (SAA-FR-016).
- Each contract release ships JSON Schemas, conformance fixtures (valid and invalid packages) and a changelog (CON-018). Ownership of schema upgrades: OD-15.

### 13.14 Contract requirements

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| CON-001 | Versioned package structure (§13.2) | Contract | P0 | C | Conformance fixtures with required artifacts validate; missing required artifact fails with `PKG_ARTIFACT_MISSING` | QAA §26.1, SAA §9.4 |
| CON-002 | Manifest required fields (§13.3) | SAA writes, QAA validates | P0 | C | Schema rejects a manifest missing any required field | QAA §26.2, SAA §7.4 |
| CON-003 | Stable, language-independent IDs (§13.4) | SAA | P0 | C | Re-analysis of an unchanged revision produces identical entity IDs; changing doc language changes no ID | SAA §7.4, §11.1; QAA §26.3 |
| CON-004 | Evidence references with path, range, revision, fingerprint, extractor and excerpt policy (§13.7) | SAA | P0 | C | Every `evidence_id` resolves; every path exists at the revision in benchmark checks | SAA §7.2, QAA §26.3 |
| CON-005 | Provenance vocabulary and basis mapping (§13.6) | Contract | P0 | P | QAA derives `basis` exactly per the table; `contradicted` and `unresolved` claims never yield `pending_review` scenarios | SAA §7.3, QAA FR-033 |
| CON-006 | Revision identity incl. dirty/non-Git and observation windows (§13.8) | SAA | P0 | P | Dirty or non-Git analysis is labeled, never presented as a clean commit; runtime-only packages use `observation_window` | SAA §7.2, QAA FR-004, MR §7C |
| CON-007 | Coverage summary and analysis status (§13.3, §13.9) | SAA | P0 | P | Every `absent`/`unsupported` category has a gap record | SAA §10.1, QAA FR-013 |
| CON-008 | Semantic versioning and compatibility (§13.13) | Contract | P0 | C | Unsupported major is rejected; newer minor is accepted and unknown fields are preserved | QAA §26.4 |
| CON-009 | Ordered validation with machine-readable errors (§13.10) | QAA | P0 | P | Each error code is produced by a dedicated invalid fixture | QAA FR-009, §26.4 |
| CON-010 | Original package stored unchanged next to the normalized model | QAA | P0 | C | Byte-equal checksum of the stored original | QAA §26.4 |
| CON-011 | Artifact discovery by `role`, not filename | QAA | P0 | P | Renaming doc files while keeping roles does not change import results | RC-C02 |
| CON-012 | Language metadata on artifacts and text fields | SAA | P0 | P | Every Markdown artifact and natural-language field carries a BCP 47 tag | §19 |
| CON-013 | Gap records; no fabrication by either side | SAA, QAA | P0 | C | QAA never creates SAA-namespace entities; QAA gaps use `qgap:` IDs | SAA §2.4(4), QAA §26.4 |
| CON-014 | Diff report and staleness propagation (§13.11) | SAA (diff), QAA (propagation) | P0 (propagation) / P1 (diff) | P | Table §13.11 holds on the change-benchmark fixtures | SAA §7.4, QAA §26.4, FR-020 |
| CON-015 | Follow-up analysis request/response (§13.12) | QAA, SAA | P1 | P | A request round-trips to a new package version that references it | SAA §9.3, QAA FR-019 |
| CON-016 | Markdown-only fallback import | QAA | P1 | C | Structures extracted from Markdown are labeled `qaa_inferred`; readiness ≤ `review_only` | QAA §26.4 |
| CON-017 | Package secret safety and excerpt policy | SAA | P0 | C | The secret fixture set never appears in any package file; validator `PKG_SECRET_SUSPECTED` triggers on planted values | SAA §12.3, FR-018 |
| CON-018 | Contract published independently with schemas, fixtures and changelog | Contract | P0 | P | SAA and QAA CI each run conformance fixtures without the other component | QAA §26, task scope |
| CON-019 | Integrity checksums for all listed artifacts | SAA | P0 | P | Tampering with any listed file triggers `PKG_CHECKSUM_MISMATCH` | QAA §26.2 ("where supported") |
| CON-020 | **Evidence profile** in every package (§13.3) | SAA | P0 | P | Runtime-only, source-only and combined fixtures validate; an inconsistent profile triggers `PKG_EVIDENCE_PROFILE_INCONSISTENT` | MR §7C |
| CON-021 | **Runtime evidence identity and freshness** (`observation_window`, environment, locale, deployed revision source) | SAA, QAA | P0 | P | Every `runtime_observation` evidence record resolves to an observed environment and window; the freshness rules of §13.11 hold | MR §7C |
| CON-022 | **Readiness per QA activity**; no downgrade for unclaimed evidence (§13.9) | QAA | P0 | P | A Mode B fixture is `ready`/`ready_with_gaps` for design; a Mode A fixture with no environment is `blocked` only for `automated_execution` | MR §7C, MR-REQ-4 |

---

## 14. QAA functional requirements

Original QAA requirement numbers are preserved with a `QAA-` prefix (`FR-014` → `QAA-FR-014`). New requirements use unused numbers within the same group. The **Owner** column is QAA unless stated.

### 14.1 Projects and environments

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| QAA-FR-001 | Create, edit, archive and delete projects according to access permissions | Platform | P0 | C | CRUD works; deletion follows retention rules (SEC-015) | FR-001 |
| QAA-FR-002 | Project records base URL, environment label/classification, allowed hosts and optional path scope | QAA | P0 | C | Out-of-scope URL is rejected at configuration and at runtime | FR-002 |
| QAA-FR-003 | Project records repository identity and an immutable revision. **Modified:** no clone or fetch. Identity and revision come from the imported package and, optionally, from a local read-only checkout path; remote provider access is OD-02 | QAA | P0 | P (modifies C) | No network fetch of repository content occurs in the default configuration | FR-003, MD-2, RC-C07 |
| QAA-FR-004 | Analysis and runs record the exact revision and never follow a moving branch during an active run | QAA | P0 | C | Every run record has an immutable revision | FR-004 |
| QAA-FR-005 | Login profiles use secret references; values never appear in project views, prompts, logs or reports | QAA + Platform | P0 | C | Secret fixture never appears in outputs | FR-005 |
| QAA-FR-006 | Setup validates reachability and permissions without business-changing actions | QAA | P0 | C | Validation issues only `GET`/`HEAD`-equivalent navigation | FR-006 |
| QAA-FR-007 | Multiple environment profiles with distinct hosts and credential references | QAA | P1 | C | Two environments run with isolated sessions | FR-007 |
| QAA-FR-008 | Record browser, viewport, locale, timezone and relevant environment settings per run | QAA | P1 | C | Run record contains all listed fields | FR-008 |
| QAA-FR-009 | Import a Documentation Package from an archive or directory; validate manifest, schemas, artifacts, provenance and checksums | QAA | P0 | C | Satisfies CON-009 for all fixtures | FR-009 |

### 14.2 Documentation ingestion and targeted verification

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-010 | The package (of any evidence profile, incl. runtime-only) is the primary system model and test basis; full re-documentation or whole-application crawling is not a default QAA responsibility | P0 | C (scope clarified) | No QAA job enumerates the full repository or crawls the whole application by default | FR-010, RC-C17 |
| QAA-FR-011 | Use structured artifacts for mapping and validation, and Markdown for human review | P0 | C | Mapping works with Markdown removed from a fixture package | FR-011 |
| QAA-FR-012 | Preserve package/schema/analyzer versions, repository identity, revision, timestamps, artifact IDs and provenance | P0 | C | All fields are visible on the project and in exports | FR-012 |
| QAA-FR-013 | Validate category coverage (routes, features, workflows, roles/permissions, rules, states, integrations, unknowns) and flag missing or malformed documentation | P0 | C | Readiness screen lists every category with status | FR-013 |
| QAA-FR-014 | Compute package freshness: `current`, `mismatched`, `stale`, `unverifiable` | P0 | C | Rules of §13.9 hold on fixtures | FR-014 |
| QAA-FR-015 | Link scenarios to SAA IDs and, when available, file/line references | P0 | C | Every scenario resolves its links in the stored package | FR-015 |
| QAA-FR-016 | Report contradictions among SAA docs, requirements, source checks and observations; never pick a source silently | P0 | C | Contradiction fixture yields a visible conflict record | FR-016 |
| QAA-FR-017 | Repository access is read-only, local and targeted; repository scripts are never executed | P0 | C | Process audit shows no child processes spawned from repository content | FR-017, MD-2 |
| QAA-FR-018 | Mark gaps, unsupported versions, unresolved findings, low-confidence claims and inaccessible references; block generation where material | P0 | C | A material-gap fixture blocks generation for the affected flow only | FR-018 |
| QAA-FR-019 | API/shared-workspace integration with change notifications, same contract | P1 | C | Same fixtures pass through the API transport | FR-019 |
| QAA-FR-020 | Compare new packages and revisions between runs; suggest impacted scenarios for review | P1 | C | Change benchmark yields an impacted-scenario list | FR-020 |

### 14.3 Runtime observation (L2)

QAA-FR-021 … 028 are requirements on the **shared runtime observation service** (§9.1). They apply identically when SAA performs URL discovery (SAA-FR-042) and when QAA performs targeted verification or execution (RC-C17).

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-021 | Explore only within the approved host and path scope | P0 | C | Out-of-scope link/redirect fixtures are blocked and logged | FR-021 |
| QAA-FR-022 | Inventory accessible pages, links, forms, labels, controls, modals and visible validation | P0 | C | Benchmark app inventory matches the labeled fixture list | FR-022 |
| QAA-FR-023 | Basic username/password login via a protected secret reference | P0 | C | Login fixture succeeds; credential never logged | FR-023 |
| QAA-FR-024 | Record route/control observations with source, timestamp and confidence | P0 | C | Every observation has these fields | FR-024 |
| QAA-FR-025 | Never submit suspected destructive forms during discovery | P0 | C | Destructive-form fixture is not submitted | FR-025 |
| QAA-FR-026 | Unsupported login flow → stop and ask; never bypass controls | P0 | C | MFA/CAPTCHA fixture stops with guidance | FR-026 |
| QAA-FR-027 | Additional authentication (SSO, MFA) via documented user-assisted mechanisms | P1 | C | — | FR-027 |
| QAA-FR-028 | Users adjust exploration scope and exclude routes or data areas | P1 | C | Excluded route is never visited | FR-028 |
| QAA-FR-029 | QAA's own browser use is **targeted verification** of specific package items, bounded by a page/step/time budget; whole-application discovery is SAA-FR-042 | P0 | P | Budget exhaustion yields a partial verification record with unverified items | QAA §14.1, §17.2 |

### 14.4 Test planning and generation

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-030 | Test plan with objectives, scope, exclusions, risks, test basis, assumptions, exit criteria and suggested coverage | P0 | C | Plan schema validation passes; all fields present | FR-030, §6.1 |
| QAA-FR-031 | Generate scenarios using identifiable test-design techniques | P0 | C | Every scenario lists ≥1 technique with a rationale | FR-031 |
| QAA-FR-032 | Scenarios include preconditions, data, steps, expected results, cleanup, priority, rationale, execution suitability and evidence | P0 | C | Scenario schema enforces the fields | FR-032 |
| QAA-FR-033 | Each expected result carries a controlled `basis` (§13.6) | P0 | C (enum unified, P) | Schema rejects unknown basis | FR-033 |
| QAA-FR-033a | Each scenario links to SAA IDs and records the package version used | P0 | C | Link resolution check passes | FR-033a |
| QAA-FR-034 | Missing or ambiguous expectations → `needs_clarification` | P0 | C | Contradiction fixture yields `needs_clarification` | FR-034 |
| QAA-FR-035 | Duplicate detection with stated reason | P0 | C | Duplicate fixture is flagged | FR-035 |
| QAA-FR-036 | Never present generated assumptions as authoritative requirements | P0 | C | Inferred-basis results are visually and textually labeled in UI and exports | FR-036 |
| QAA-FR-037 | User chooses the natural language of generated artefacts | P0 | C | See LOC requirements | FR-037 |
| QAA-FR-038 | Transparent risk priority (impact, likelihood, exposure, rationale) | P0 | C | Inputs visible and editable; edits audited | FR-038, §6.4 |
| QAA-FR-039 | Accept acceptance criteria, business rules, feature descriptions or existing test documents as additional test basis | P1 | C | Supplied items become `requirement:*` records with `origin: qaa_supplied` | FR-039 |
| QAA-FR-040 | Exploratory testing charters for areas needing judgment or gap-driven investigation | P1 | C | Charter schema: goal, boundaries, time-box, observations | FR-040 |
| QAA-FR-041 | Each expected result records its **test oracle** and whether it verifies intended or implemented behavior (§13.6) | P0 | P | Reports show the oracle class per result | QAA §6.6, task scope |
| QAA-FR-042 | Authorization/role-based scenarios derived from SAA roles and permissions (allowed and denied cases) where safely checkable | P0 | P | For each in-scope permission guarding a selected step, ≥1 allowed and ≥1 denied scenario exists, or a recorded reason why not | QAA §6.7, §26.3 |
| QAA-FR-043 | Regression suites: named, versioned sets of approved scenarios | P1 | P | Suite run records the scenario versions included | QAA §6.7, §9.4 |
| QAA-FR-044 | Coverage reporting against the system model (§15.11) | P0 | P | Report shows coverage per workflow, rule, role-permission and route, plus uncovered items | QAA FR-090/092, task scope |
| QAA-FR-045 | Requirement-based testing: every supplied requirement has ≥1 scenario or an explicit gap | P1 | P | Requirements matrix has no silent omissions | QAA FR-039 |
| QAA-FR-046 | Staleness evaluation on new package, revision, environment or scope change (§13.11) | P0 | P | Change fixtures produce the expected freshness states | QAA §26.4 |
| QAA-FR-047 | Approval suspension/invalidation and human **revalidation** action (§13.11) | P0 | P | A suspended approval cannot execute; revalidation creates new audited approvals | QAA §26.4, FR-052/054 |
| QAA-FR-048 | Test-condition records derived from the test basis, linking scenarios to conditions | P0 | P | Each scenario references ≥1 condition; each condition references its basis | QAA §6.1(3), task scope |

### 14.5 Review and approval

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-050 | View, search, filter, sort, edit, approve, reject, defer and request regeneration | P0 | C | All actions available and audited | FR-050 |
| QAA-FR-051 | Individual or bulk approval after showing the exact versions selected | P0 | C | Bulk approval shows the full list before commit | FR-051 |
| QAA-FR-052 | Every approval is audited and bound to scenario version, revision, package version, environment, scope policy version and test-data profile | P0 | C (binding extended, P) | Approval record contains all binding fields | FR-052 |
| QAA-FR-053 | Editing an approved scenario creates a new version; approval does not transfer | P0 | C | Edit fixture yields an unapproved new version | FR-053 |
| QAA-FR-054 | Executor rejects unapproved, stale-baseline, malformed or out-of-scope definitions | P0 | C | 100% rejection in the approval security suite | FR-054 |
| QAA-FR-055 | Classify scenarios `manual_only`, `automation_candidate`, `automation_ready`, `both`, with explanation and audited override | P0 | C | Override creates an audit event | FR-055, §7.4 |
| QAA-FR-056 | Comments on scenario decisions and resolution of clarification requests | P1 | C | — | FR-056 |
| QAA-FR-057 | State-changing scenarios require an explicit state-changing approval and a cleanup plan or acknowledged irreversibility warning | P0 | P | Scenario flagged `state_changing` cannot be approved without either | QAA §16.4 |

### 14.6 Automated execution

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-060 | Execute approved actions through Playwright in an isolated worker | P0 | C | Worker runs in a disposable process/container | FR-060, §23 |
| QAA-FR-061 | Executor accepts only a constrained action/assertion schema, never arbitrary generated code | P0 | C | Code-injection fixture is rejected at validation | FR-061 |
| QAA-FR-062 | Supported actions: in-scope navigate, click, fill, select, check/radio; assertions: visible, text, value, URL, enabled/disabled | P0 | C | Each action and assertion has a fixture test | FR-062 |
| QAA-FR-063 | Each assertion records expected condition, actual observation, outcome and elapsed time | P0 | C | Step result schema enforces fields | FR-063 |
| QAA-FR-064 | Screenshots and traces stored per retention settings | P0 | C | Failed case has a screenshot and trace | FR-064 |
| QAA-FR-065 | Failure categories distinguish assertion failures from timeouts, navigation errors, blocked requests, runner failures and unsupported steps (§17.5) | P0 | C | Each category has a fixture | FR-065 |
| QAA-FR-066 | Configurable timeouts, concurrency, cancellation, resource limits and cleanup | P0 | C | Cancellation stops further actions and starts cleanup | FR-066 |
| QAA-FR-067 | Bounded retries; non-idempotent actions never retried without a safe strategy | P0 | C | Retry fixture on a POST step is not retried | FR-067 |
| QAA-FR-068 | Mask credentials and tokens in logs and reports | P0 | C | → merged into **SEC-004** | FR-068 |
| QAA-FR-069 | Export selected automated tests as TypeScript source | P1 | C | Exported test runs standalone against the benchmark | FR-069 |
| QAA-FR-070 | Recommend automation candidates from completed manual results | P1 | C | — | FR-070 |
| QAA-FR-071 | Deterministic test data from approved fixtures/profiles; cleanup executed and its result recorded | P0 | P | Cleanup outcome is part of the case result | QAA §7.2, §16.4 |

### 14.7 Manual execution

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-080 | Start a manual run from an approved scenario or suite | P0 | C | Unapproved scenario cannot start a manual run | FR-080 |
| QAA-FR-081 | Present preconditions, data, steps, expected results and evidence links in the selected language | P0 | C | Language switch keeps step identity | FR-081 |
| QAA-FR-082 | Mark steps pass, fail, blocked or not applicable per scenario rules | P0 | C | `not_applicable` only where the scenario allows it | FR-082 |
| QAA-FR-083 | Record actual results, notes and screenshots/permitted files | P0 | C | Required fields enforced before submission | FR-083 |
| QAA-FR-084 | Create a defect linked to scenario version, run and failed step | P0 | C | Defect record contains all links | FR-084 |
| QAA-FR-085 | Pause and resume with preserved progress | P0 | C | Reopened run restores step state | FR-085 |
| QAA-FR-086 | Label manual results tester-reported | P0 | C | Label appears in UI and exports | FR-086 |
| QAA-FR-087 | Assign runs to named testers; filter by assignee | P1 | C | — | FR-087 |
| QAA-FR-088 | Defect lifecycle and severity (§15.12) | P0 | P | State transitions validated by code; severity required | Task scope, QAA FR-084 |
| QAA-FR-089 | Abandon a manual run with a recorded reason; incomplete steps become `not_run` | P0 | P | Abandoned run is reported as such | QAA §7.3 |

### 14.8 Reporting and export

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-090 | Project summary with counts: proposed, approved, executed, passed, failed, blocked, inconclusive | P0 | C | Counts reconcile with stored records | FR-090 |
| QAA-FR-091 | Each result links to scenario version, environment, revision, package version, evidence and timestamps | P0 | C | Link check passes on exports | FR-091 |
| QAA-FR-092 | Reports include limitations, unresolved assumptions, coverage gaps and unsupported operations | P0 | C | Sections present even when empty ("none recorded") | FR-092 |
| QAA-FR-093 | Export scenarios and results as JSON and Markdown | P0 | C | Exports validate against schemas | FR-093 |
| QAA-FR-094 | HTML report and CSV summary | P1 | C | — | FR-094 |
| QAA-FR-095 | Compare runs; flag differences in environment, revision, package, scenario version and outcome | P1 | C | — | FR-095 |
| QAA-FR-096 | Report language selectable independently of UI language | P1 | C | See LOC-005 | FR-096 |
| QAA-FR-097 | Export defects to external trackers through an adapter interface | P2 | P | — | X-14, §24 |

### 14.9 Administration (shared platform services surfaced in QAA)

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| QAA-FR-100 | Configure model provider, model ID, timeouts, concurrency, secret storage, retention and worker settings | Platform | P0 | C | Settings persisted and applied to both agents where relevant | FR-100 |
| QAA-FR-101 | Log job transitions, approvals, credential use, policy decisions and artifact access without secrets | Platform | P0 | C | See OBS-002 | FR-101 |
| QAA-FR-102 | Cancel jobs; identify stuck jobs | Platform | P0 | C | Stuck-job detection fixture | FR-102 |
| QAA-FR-103 | Health checks and metrics: queue length, job duration, worker failure, resource use | Platform | P0 | C | Endpoints/commands exist | FR-103 |
| QAA-FR-104 | Multiple hosted or local LLM provider adapters | Platform | P1 | C | See OSS-009 | FR-104 |

### 14.10 Evidence-adaptive QA

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| QAA-FR-110 | **Source-optional QA.** Generate candidate scenarios from runtime-only packages. Such scenarios state their evidence basis and limits, and never assert internal implementation details or unsupported business requirements | P0 | P | URL-only fixture yields reviewable scenarios; a claim audit finds no internal-effect assertion (e.g., DB write, email delivery) without source or requirement basis | MR-REQ-5 |
| QAA-FR-111 | **QA objective per scenario**: `characterization`, `implementation_conformance`, `requirement_conformance` or `exploratory`, constrained by the expected-result basis (§15.9) | P0 | P | Schema rejects an objective inconsistent with its bases (e.g., `requirement_conformance` with only `observed` basis) | MR §11 |
| QAA-FR-112 | **Environment-optional QA.** Design, review, approve-for-manual and export **manual test packs** (Markdown/JSON plus result template) with no configured environment; results can be imported back and are linked to a declared environment | P0 | P | Mode A and D fixtures produce an exported pack; imported results appear in reports as tester-reported with the declared environment | MR-REQ-4, MD-6 |
| QAA-FR-113 | **Evidence-strengthening suggestions.** For each `needs_clarification` or low-oracle expectation, list which additional evidence (source, requirement, role credentials, environment, discovery probe) would strengthen it | P1 | P | Suggestions are present on URL-only fixture scenarios | MR §11 |

---

## 15. QA methodology and test-design capabilities

This section is normative for QAA behavior (C, QAA §6). QAA applies established testing practice; it does not substitute free-form AI browser interaction for test design. Terminology follows the ISTQB glossary as guidance, without claiming certification or compliance (QAA §27).

### 15.1 Test process

QAA models an iterative process: **planning** (objectives, scope, risks, environment, constraints, exit criteria) → **monitoring and control** (coverage, scenario quality, approvals, progress, blockers, deviations) → **analysis** (test conditions from the test basis) → **design** (cases and data via techniques) → **implementation** (manual suites or executable definitions, fixtures, prerequisites) → **execution** (approved steps, actual results, evidence) → **completion** (coverage, outcomes, residual risk, open questions, defects, follow-up). A contradiction or blocked case may return work to analysis or design.

### 15.2 Test basis (C, QAA §6.2)

Primary: the imported Documentation Package. Supplementary: supplied requirements and acceptance criteria (QAA-FR-039), targeted source checks at the package revision, observed UI and network behavior within scope, user-confirmed rules, clarification decisions, prior results and regression history. Every fact keeps its provenance: package and artifact/section ID, repository and revision, file/line where available, observation, timestamp, certainty label and analyzer version. QAA must not treat implementation as the correct business requirement.

### 15.3 Test scope and test types

| Test type | MVP | Notes |
|---|:-:|---|
| Functional UI testing (forms, validation, navigation) | **Yes** | Core MVP focus (QAA §6.7) |
| End-to-end user-journey testing | **Yes** | Driven by SAA workflows |
| Requirement-based testing | Partial | Against SAA-documented behavior in MVP; supplied requirements are P1 (QAA-FR-039, QAA-FR-045) |
| Authorization / role-based testing | **Yes**, safely checkable cases | Allowed vs. denied per role (QAA-FR-042); privileged destructive actions need state-changing approval |
| Negative and error-path testing | **Yes** | Invalid, missing, malformed, unauthorized, conflicting input |
| State-transition testing | **Yes**, where SAA documents states | Otherwise a gap is recorded |
| Regression testing | P1 | Named suites (QAA-FR-043), change-impact suggestions (QAA-FR-020) |
| Exploratory testing charters | P1 | QAA-FR-040 |
| Integration testing through the UI | **Yes**, as observed effects | No direct service-level assertions in MVP |
| API / contract testing | Deferred (Phase 3) | Separate labeled adapter |
| Accessibility checks | Deferred (Phase 3) | QAA must not imply accessibility compliance |
| Visual regression | Deferred (Phase 3) | — |
| Performance, load, stress, endurance | Out of scope (X-10) | Needs a separate safety design |
| Security / penetration / fuzz | Out of scope (X-10) | Browser crawl ≠ security assessment (X-20) |

### 15.4 Test-design techniques (C, QAA §6.3)

| Technique | Applied when | Typical SAA inputs |
|---|---|---|
| Equivalence partitioning | Inputs group into classes expected to behave alike | `field.constraints`, `business_rule.inputs` |
| Boundary value analysis | Ordered limits exist (length, range, date, count) | `business_rule.boundaries`, field min/max |
| Decision-table testing | Outcome depends on combinations of conditions | Rules with multiple conditions, permission × state |
| State-transition testing | Entities or processes have states | `state_machine` valid and known-invalid transitions |
| Use-case / user-journey testing | Meaningful end-to-end workflows | `workflow` steps and branches |
| Negative testing | Invalid, missing, malformed, unauthorized or conflicting input | Validations, error branches, permissions |
| Error guessing | Likely failure points from context | Labeled heuristic; basis at most `inferred` |
| Exploratory charters | Behavior hard to specify in advance or documented gaps | `gap` records |

QAA applies techniques selectively, explains why each is relevant, and avoids duplicate or low-value cases. It must not mechanically apply every technique to every feature.

### 15.5 Positive, negative and error paths

For each workflow in QA scope (chosen from the discovered catalog), QAA considers the main success path; documented alternative branches; validation failures per rule (one invalid class per case where practical); authorization failure (denied role or unauthenticated); documented error contracts (e.g., 422 or 409 shown in the UI); and timeouts or external failures where the UI exposes them. Paths SAA marks `unknown` become `needs_clarification` or exploratory charters, never invented expectations.

### 15.6 Authorization and role-based testing

QAA builds a role × permission × step matrix from SAA `actor_role` and `permission` entities and `AUTHORIZES_WITH` relations. For each in-scope guarded step it proposes an allowed case and a denied case (QAA-FR-042). It needs a credential profile per role. A role without a configured credential profile yields a `blocked` precondition, not a skipped check. Roles labeled `inferred` produce `needs_clarification` cases.

### 15.7 Risk-based prioritization (C, QAA §6.4)

- **Impact** 1–5, **likelihood** 1–5, **exposure** flags (high traffic, security-sensitive, permission-sensitive, data-critical, primary workflow, recently changed per SAA diff/hotspots).
- Default score = `impact × likelihood`, with exposure as a documented modifier or tie-breaker.
- The score is a prioritization aid, not a probability or a release-risk guarantee. Inputs and rationale are shown and editable (audited).
- QAA must not infer sensitive domains (for example payments) without evidence.

### 15.8 Manual vs. automated selection

QAA proposes an execution-mode classification (QAA-FR-055) using these criteria. A human can override it.

| Prefer **automated** when | Prefer **manual** when |
|---|---|
| Steps map fully to supported actions (QAA-FR-062) | Requires human judgment (visual/content quality, usability) |
| Stable locators exist (role, label, test ID) | Uses unsupported actions (file upload, CAPTCHA, MFA, email/SMS check) |
| Deterministic data and cleanup exist | Data cannot be reset or is irreversible |
| Case is a repeatable regression candidate | One-off, exploratory, or expected result `needs_clarification` |

Stable manual cases that passed repeatedly are recommended as automation candidates (QAA-FR-070).

### 15.9 Test oracles and expected-result validation

Every expected result records its `basis` (§13.6) and an **oracle class** (QAA-FR-041):

- `intended` — basis `requirement_backed`, `user_confirmed`, or requirement-level `human_asserted`.
- `implemented` — basis `saa_documented` (`source_verified`/`test_verified`) or `source_supported`.
- `observed` — basis `observed` or `runtime_observed`.
- `none` — basis `inferred` or `unresolved`. Such cases cannot be `automation_ready` and are reported as exploratory.

Reports separate **verification** (matches the oracle) from **validation** (meets stakeholder needs) (QAA §6.6). A pass against an `implemented` oracle is reported as "behaves as currently implemented."

**QA objectives** (QAA-FR-111, MR §11). These overlap but are not interchangeable. An observed behavior is never promoted to a requirement because no better information exists.

| QA objective | Question | Permitted expected-result bases | What a pass may be reported as |
|---|---|---|---|
| `characterization` | What does the application currently do? | `observed`, `saa_documented` (`runtime_observed`, `source_verified`, `test_verified`), `source_supported` | "Behaves as observed or implemented under the tested conditions" |
| `implementation_conformance` | Is behavior consistent with the available technical specification (API contract, schema, validator)? | `saa_documented` (`source_verified`, `test_verified`), `source_supported` | "Conforms to the implemented technical contract" |
| `requirement_conformance` | Does the system satisfy the intended business requirement? | `requirement_backed`, `user_confirmed`, requirement-level `human_asserted` | "Satisfies requirement <id>" (the only objective that may say so) |
| `exploratory` | What unexpected behavior, risk or defect can be found? | Any, including `inferred` and `unresolved` | Findings and observations, not pass/fail against requirements |

Example: in a URL-only project, submitting a registration form shows a success message.
- QAA may generate a `characterization` scenario that asserts the message.
- It must not assert that an account was created or an email delivered.
- It raises `needs_clarification` items (for example: should duplicate emails be rejected? does the account need approval before activation?) and offers `exploratory` charters.
- When source code, requirements or contracts are added later, QAA can upgrade these scenarios to stronger objectives.

### 15.10 Scenario data contract

Scenarios are structured, versioned and language-aware. Machine actions never depend on translated text. Illustrative contract (extends QAA §13; schema is finalized in Phase 0):

```json
{
  "schema_version": "1.0.0",
  "scenario_id": "scenario:registration.nib.invalid_length_12",
  "display_key": "TC-REG-002",
  "version": 1,
  "content_language": "en",
  "title": { "language": "en", "text": "Reject registration when NIB has 12 digits" },
  "feature_ref": "module:web.registration",
  "test_condition_ids": ["tcond:registration.nib.length_boundary"],
  "category": "negative_validation",
  "qa_objective": "implementation_conformance",
  "test_techniques": [ { "id": "boundary_value_analysis", "rationale": "NIB length is fixed at 13; 12 is just below the boundary." } ],
  "priority": "high",
  "risk": { "impact": 4, "likelihood": 3, "exposure": ["primary_workflow"], "score": 12,
            "rationale": "Invalid identifiers would create unusable registrations." },
  "execution_modes": ["manual", "automated"],
  "execution_classification": "both",
  "state_changing": false,
  "preconditions": [
    { "id": "pre-1", "text": "Signed in with credential profile 'applicant'.", "credential_profile_ref": "secretref:applicant" },
    { "id": "pre-2", "text": "Registration page is reachable." }
  ],
  "test_data": [ { "name": "nib", "value_ref": "fixture:registration.nib_12_digits", "sensitivity": "non_secret" } ],
  "steps": [
    { "step_id": "S1", "instruction": "Open the registration page.",
      "automation": { "action": "navigate", "target": { "kind": "route", "value": "/registrasi" } },
      "expected_result": null },
    { "step_id": "S2", "instruction": "Enter a 12-digit NIB.",
      "automation": { "action": "fill",
        "target": { "kind": "label", "value": "NIB", "literal_language": "id", "source_ref": "field:web:/registrasi#registration.nib" },
        "value_ref": "fixture:registration.nib_12_digits" },
      "expected_result": null },
    { "step_id": "S3", "instruction": "Submit the form.",
      "automation": { "action": "click", "target": { "kind": "role", "role": "button", "name": "Daftar", "literal_language": "id" } },
      "expected_result": {
        "description": "A NIB format error is shown and no registration is created.",
        "assertions": [ { "type": "visible", "target": { "kind": "test_id", "value": "error-nib" } },
                        { "type": "url", "operator": "equals", "value": "/registrasi" } ],
        "basis": "saa_documented", "saa_status": "source_verified", "oracle_class": "implemented",
        "trace": { "saa_ids": ["business_rule:registration.nib_required_13_digits"],
                   "evidence_ids": ["evidence:reg-schema-12-19"], "requirement_ids": [] } } }
  ],
  "cleanup": [],
  "assumptions": [],
  "open_gaps": ["gap:nib-length-docs-mismatch"],
  "baseline": { "package_id": "pkg:acme-portal", "package_version": 3, "revision": "4b77…e0c2" },
  "freshness": "current",
  "status": "needs_clarification",
  "status_reason": "Linked contradiction gap:nib-length-docs-mismatch (README says 16 digits).",
  "approval": null
}
```

Rules (C, QAA §13 implementation rules): `value_ref` points to fixtures or secret references, never live passwords; `basis` uses the controlled enum; schema validation runs before save, approval, export and execution; unsupported actions make the scenario `manual_only` or `blocked`, never approximated.

### 15.11 Coverage and traceability

Coverage is always reported **relative to the system model and stated scope**. It never claims completeness of the system (task constraint; QAA §22). Exploring every discoverable page does not establish complete coverage.

| Metric | Definition |
|---|---|
| Workflow coverage | In-scope catalog workflows with ≥1 approved scenario / in-scope catalog workflows; also per branch. Catalog workflows outside QA scope are listed, never silently dropped |
| Rule coverage | In-scope business rules with ≥1 scenario per relevant technique / in-scope rules |
| Role-permission coverage | Guarded (role, step) pairs with allowed and denied cases / in-scope pairs |
| Route/page coverage | In-scope documented pages exercised / in-scope documented pages |
| Requirement coverage (P1) | Supplied requirements with ≥1 scenario or gap / supplied requirements |
| Execution coverage | Approved scenarios executed in the run / approved scenarios in scope |

Traceability chain stored and exportable: `requirement | claim | evidence` → `test condition` → `scenario version` → `approval` → `run` → `step result` → `defect` → `report`.

### 15.12 Defect lifecycle and severity (P)

- **Severity** (impact on the system): `critical`, `major`, `minor`, `trivial`. **Priority** (urgency to fix) is separate: `high`, `medium`, `low`.
- **Lifecycle:** `new` → `triaged` → (`confirmed` | `rejected` | `duplicate` | `needs_info`) → `fixed` → `ready_for_retest` → (`closed` | `reopened`).
- A defect references scenario version, run, step, evidence, revision, package version and environment. It records whether it is a suspected **product defect** or **test defect** (the result classifier's suggestion stays reviewable, QAA §14.1).
- `closed` requires a passing retest on a recorded baseline or a recorded reason.
- Sys2QA is not a defect tracker (X-14). External tracker export is P2 (QAA-FR-097).

### 15.13 Test-case quality checklist (C, QAA §6.5)

Clear title and purpose; in-scope feature and risk; preconditions and data; concrete ordered steps; explicit expected result at each decision point; technique and rationale; evidence or marked assumption; cleanup if data changes; suitability for manual/automated execution; no duplication with approved tests. Cases with ambiguous expectations are `needs_clarification`, not ready.

---

## 16. Manual testing workflow

Manual testing is a first-class capability (C, QAA §7.3). A person follows the approved scenario in the real application; QAA acts as test-management and evidence-capture interface.

1. **Start** — tester selects an approved scenario or suite. QAA checks approval `active` and baseline match (same gate as automation, QAA-FR-054) and creates a manual run (`mrun:*`) bound to the scenario versions and environment (QAA-FR-080).
2. **Execute** — one step at a time, the screen shows purpose, risk, preconditions, test data (secret values are never displayed in scenario views; how a manual tester obtains test-account credentials is OD-21), current instruction, expected result and evidence links, in the selected language (QAA-FR-081).
3. **Record** — per step: `pass`, `fail`, `blocked`, `not_applicable` (only where allowed), actual result, notes, screenshots/files (type- and size-limited, SEC-019) (QAA-FR-082, QAA-FR-083).
4. **Defect** — from a failed step, create a defect pre-linked to scenario version, run and step (QAA-FR-084).
5. **Pause/resume/abandon** — progress persists; abandoning requires a reason; remaining steps become `not_run` (QAA-FR-085, QAA-FR-089).
6. **Submit** — QAA validates required fields; a case is complete only when required outcomes and evidence are recorded or omission is justified. Results are labeled **tester-reported** (QAA-FR-086).
7. **Reuse** — the scenario remains available for regression and automation assessment (QAA-FR-070).

Separation from automation: manual runs and automated runs are distinct record types with their own lifecycles and results, sharing only the scenario version identity. QAA never relabels an automated run as manual or vice versa.

**Environment-optional manual testing** (QAA-FR-112). A tester can execute an exported **manual test pack** against whatever environment they have access to, even one Sys2QA is not configured for. At run start the tester records a **declared environment** (name, URL if any, version if known). Results imported back are tester-reported and linked to that declaration. Sys2QA requires no deployment, infrastructure or automation set-up for this path (MD-6).

Failure paths: environment unreachable mid-run → steps marked `blocked` with reason; baseline becomes stale mid-run → run continues but is flagged and the report states the baseline change; tester session expires → progress is preserved.

---

## 17. Automated testing workflow

### 17.1 Flow

1. User selects an approved suite and environment.
2. QAA **revalidates** at enqueue time and again inside the worker before the first action: approval `active`, baseline match, scenario schema, action support, scope policy, environment classification (not production), credential availability and state-changing approval (QAA-FR-054, QAA-FR-057).
3. The job is queued with an idempotency key; duplicate delivery cannot cause duplicate execution (NFR-004).
4. An isolated, disposable Playwright worker executes only schema-supported actions (QAA-FR-060..062) with egress restricted to the scope policy at the infrastructure layer (SEC-007).
5. Each assertion records expected, actual, outcome and duration; screenshots, traces, console and relevant network errors are captured with redaction (QAA-FR-063, QAA-FR-064).
6. Cleanup runs per scenario; its result is recorded (QAA-FR-071).
7. Outcomes and failure categories are classified (§17.5); a localized report is generated.

### 17.2 Determinism rules (C, QAA §7.2)

Prefer locators by accessible role, label, text and stable test IDs; explicit assertions instead of assuming a click succeeded; web-first waits with bounded timeouts, never arbitrary sleeps; approved deterministic data; bounded retries only for idempotent steps or with a safe recovery strategy (QAA-FR-067).

### 17.3 Locale-sensitive locators (P)

A locator using UI text (label, role name) stores the literal **as observed in the target application language** with `literal_language`. It is never translated with the artefact language. If a run's target locale differs from the locator's `literal_language`, the step is flagged `unsupported_step` (locale mismatch) before execution rather than failing as a product defect.

### 17.4 Run lifecycle

`created` → `queued` → `running` → `completed` | `failed` | `cancelled` | `blocked` (C, QAA §12.2). A `completed` run may contain failed, blocked or inconclusive cases; the run status never hides case outcomes.

### 17.5 Outcomes and failure categories

| Case outcome | Meaning |
|---|---|
| `passed` | All required assertions passed |
| `failed` | A required assertion failed (application behavior differs from the expected result) |
| `blocked` | A prerequisite, permission, environment or dependency was unavailable |
| `inconclusive` | Evidence insufficient or result cannot be reliably classified |
| `not_run` | Execution did not occur |
| `skipped` | Explicitly skipped with a reason |

| Failure category (automated) | Classified as | Typical outcome |
|---|---|---|
| `assertion_failure` | Application behavior | `failed` |
| `navigation_error` (HTTP 5xx, error page on navigation) | Application or environment — reviewable | `failed` or `blocked` |
| `timeout` | Undetermined — reviewable | `inconclusive` |
| `blocked_request` / `out_of_scope_blocked` | Scope policy | `blocked` |
| `unsupported_step` (incl. locale mismatch) | Test definition | `blocked` |
| `test_data_error` / `cleanup_failure` | Test infrastructure | `blocked` or flagged on a passed case |
| `runner_failure` (crash, OOM, browser launch) | Infrastructure | `inconclusive` |
| `environment_unavailable` | Infrastructure | `blocked` |
| `credential_failure` | Configuration | `blocked` |

The classifier may suggest *product defect* vs. *test defect*; suggestions remain reviewable and are never presented as conclusions.

### 17.6 Cancellation, timeouts and resource limits

Cancellation stops future actions immediately and starts cleanup; partial evidence is preserved where possible. Configurable limits: per-step and per-case timeouts, total run duration, concurrency, CPU, memory, disk and artifact size (QAA-FR-066, NFR-002).

---

## 18. Human review and approval

### 18.1 Scenario lifecycle

`draft` → `needs_clarification` | `pending_review` → `approved` | `rejected` | `deferred` → `superseded` (C, QAA §12.1). Approved versions are immutable; edits create a new `draft` version; superseded versions remain for historical interpretation. Freshness (`current`/`potentially_stale`/`stale`) is an orthogonal attribute (§13.11).

### 18.2 Approval rules

- Approval requires: schema-valid scenario, status `pending_review`, freshness `current`, package readiness not `review_only`/`blocked` for the scenario's flows, all expected results with a basis other than `unresolved`, and — for `state_changing` scenarios — explicit state-changing approval plus cleanup plan or acknowledged irreversibility (QAA-FR-057).
- An approval binds: scenario ID + version, package ID + version, revision, environment ID, scope policy version, test-data profile, approver, timestamp (QAA-FR-052).
- Bulk approval displays every selected version before commit (QAA-FR-051).
- Approval states: `active`, `suspended`, `invalidated`, `superseded`, `revoked` (§13.11).
- **Revalidation** rebinds suspended, unaffected approvals to a new baseline as an explicit human action that creates new audited approval records (QAA-FR-047).
- Translation of presentation text does not change approval unless semantic content (steps, data, assertions, numbers) changes (LOC-007).
- Possession of credentials or a URL never substitutes for approval (MD-3 consolidation note).
- Approval for **manual** execution may bind to a declared environment created at run start (QAA-FR-112). Approval for **automated** execution always binds to a configured environment.

### 18.3 Clarification loop

`needs_clarification` items show the conflicting sources side by side. The user can: confirm a rule (basis becomes `user_confirmed`, audited), supply a requirement (`requirement_backed`), defer, or create an SAA analysis request (CON-015).

---

## 19. Output-language selection and localization

Language selection is a first-class product setting, not a prompt suffix (C, QAA §8). The QAA PRD defined it for QAA artefacts; this PRD extends it to SAA documentation (P, RC-G05).

### 19.1 Language dimensions

| Setting | Controls | Initial values | Owner |
|---|---|---|---|
| `ui_locale` | Sys2QA interface (QAA UI, CLI messages) | `en`, `id` | Platform |
| `saa_doc_language` | SAA Markdown and natural-language fields in the system model (one or more) | `en`, `id` | SAA |
| `scenario_language` | Scenario titles, descriptions, expected-result text | `en`, `id` | QAA |
| `manual_instruction_language` | Text shown to manual testers (defaults to `scenario_language`) | `en`, `id` | QAA |
| `report_language` | QA reports and defect descriptions (independent of UI, QAA-FR-096) | `en`, `id` | QAA |
| `target_app_locale` | Browser locale for discovery/runs; language of observed UI literals | Any; recorded per run | QAA (QAA-FR-008) |
| `automation_language` | Programming language of exported tests | TypeScript (QAA-FR-069, P1) | QAA |
| Source language | Identifiers, code, routes, API fields, DB values, logs | Never translated | — |

### 19.2 Resolution order

Explicit per-operation override → project setting → user preference → instance default (`en`). The resolved language is stored on every generated artefact with generation version.

### 19.3 Invariants (must not be translated)

Source paths, route paths, API names and fields, selectors and locator literals, test IDs, code and excerpts, exception messages, database names and values, enum codes, entity/scenario IDs, numeric values and units. A human-readable explanation may accompany an untranslated value, clearly labeled.

### 19.4 Fallback

If text is unavailable in the requested language, show the best available language with an explicit `fallback_language` marker; never silently mix. Machine translations are labeled `machine_translated: true` and are editable. Human-authored text is preserved in its original language, with optional translation.

### 19.5 Terminology consistency

Statuses, outcomes, severities, techniques and bases are stored as enum codes and rendered through a **versioned glossary** per locale. Exports include the glossary version. Translations must preserve negation, numeric boundaries, severity, status and security warnings.

### 19.6 Localization requirements

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| LOC-001 | Users choose languages at project creation and before generation/export; settings per §19.1 | Platform | P0 | C (SAA part P) | Each dimension can be set independently | QAA §8.1, §8.3 |
| LOC-002 | MVP supports `en` and `id` for UI and all generated artefacts | Platform | P0 | C | Benchmark artefacts usable in both | QAA §8.2 |
| LOC-003 | Adding a locale requires no schema change | Platform | P0 | C | New locale added via glossary/resources only | QAA §8.2 |
| LOC-004 | Every artefact records language code and generation version | SAA, QAA | P0 | C | Field present in all artefacts | QAA §8.2 |
| LOC-005 | Report language independent of UI language | QAA | P1 | C | — | QAA FR-096 |
| LOC-006 | Invariants of §19.3 hold in all generated text | SAA, QAA | P0 | C | Translation test suite: identifiers, numbers and negations unchanged | QAA §8.1, §8.3 |
| LOC-007 | Changing presentation language does not alter semantic steps or approval; semantic change renews approval | QAA | P0 | C | Approval unchanged after a pure translation; renewed after a step change | QAA §8.2 |
| LOC-008 | Machine translations labeled and editable; fallback per §19.4 | SAA, QAA | P0 | C | Labels visible in UI and exports | QAA §8.3 |
| LOC-009 | Versioned glossary of controlled terms per locale | Platform | P0 | P | Exports reference glossary version | QAA §8.3 |
| LOC-010 | Locale-sensitive locators handled per §17.3 | QAA | P0 | P | Locale-mismatch fixture yields `unsupported_step`, not `failed` | QAA §8.3 |
| LOC-011 | SAA documentation rendered in selected language(s); system-model IDs and enum codes language-neutral | SAA | P0 | P | Same SKB renders `en` and `id` docs with identical IDs | Task scope |

---

## 20. Data model and lifecycle states

### 20.1 Conceptual entities

Logical model, not a database schema. Long-lived records carry creation/update timestamps; versions, approvals and audit events are immutable or append-only (C, QAA §15.3).

| Area | Entities |
|---|---|
| Platform | `users`, `teams` (multi-user only), `projects`, `authorization_declarations`, `secret_references`, `settings`, `glossaries`, `audit_events`, `model_usage_records`, `artifacts` |
| SAA (SKB) | `systems`, `analysis_runs`, `project_boundaries`, `entities`, `relationships`, `claims`, `evidence`, `workflows`, `coverage_items`, `gaps`, `annotations`, `documentation_packages`, `package_artifacts`, `diff_reports`, `analysis_requests` |
| QAA ingestion | `imported_packages` (original + normalized), `readiness_assessments`, `baselines`, `repository_identities`, `local_checkout_bindings` |
| QAA environment | `environments`, `scope_policies` (versioned), `credential_profiles` |
| QAA design | `test_plans`, `test_conditions`, `test_scenarios`, `scenario_versions`, `scenario_trace_links`, `requirements` (QAA-supplied), `qaa_evidence` (browser/network/source-check), `qaa_gaps`, `test_data_profiles`, `fixtures` |
| QAA execution | `approvals`, `regression_suites`, `manual_runs`, `manual_step_results`, `automated_runs`, `automated_step_results`, `defects`, `reports` |

### 20.2 Lifecycle state summary

| Object | States | Defined in |
|---|---|---|
| SAA analysis run | `completed`, `completed_with_limitations`, `partial`, `failed`, `cancelled` | §13.9 |
| SAA claim | `source_verified`, `runtime_observed`, `test_verified`, `inferred`, `contradicted`, `unresolved`, `stale`, `human_asserted` | §13.6 |
| Workflow trace | `complete_within_static_scope`, `partial`, `runtime_observed_for_run`, `unresolved` | §11.1 |
| Workflow catalog entry | `deepened`, `not_deepened`; origin `source`, `runtime`, `both` | §11.6 |
| Evidence profile field | `available`, `partial`, `unavailable`; correspondence `user_confirmed`, `observed`, `unconfirmed`, `not_applicable` | §13.3 |
| Readiness (per QA activity) | `ready`, `ready_with_gaps`, `review_only`, `blocked` for each of `scenario_design`, `manual_preparation`, `automated_execution` | §13.9 |
| Package readiness | `ready`, `ready_with_gaps`, `review_only`, `blocked` | §13.9 |
| Package freshness | `current`, `mismatched`, `stale`, `unverifiable` | §13.9 |
| Environment | `configured`, `validated`, `unreachable`, `disabled` (P) | §10 W1 |
| Scenario | `draft`, `needs_clarification`, `pending_review`, `approved`, `rejected`, `deferred`, `superseded` | §18.1 |
| Scenario freshness | `current`, `potentially_stale`, `stale` | §13.11 |
| Execution classification | `manual_only`, `automation_candidate`, `automation_ready`, `both` | QAA-FR-055 |
| Approval | `active`, `suspended`, `invalidated`, `superseded`, `revoked` | §13.11 |
| Run (manual and automated) | `created`, `queued`, `running`, `completed`, `failed`, `cancelled`, `blocked` (manual runs also `paused`, `abandoned`, P) | §17.4, §16 |
| Case outcome | `passed`, `failed`, `blocked`, `inconclusive`, `not_run`, `skipped` | §17.5 |
| Manual step | `pass`, `fail`, `blocked`, `not_applicable`, `not_run` | §16 |
| Defect | `new`, `triaged`, `confirmed`, `rejected`, `duplicate`, `needs_info`, `fixed`, `ready_for_retest`, `closed`, `reopened` | §15.12 |

State transitions are validated by code, not by model output (DoD, §29.3).

---

## 21. Security, privacy and isolation requirements

### 21.1 Threat model (C, SAA §12.1, QAA §16)

Sys2QA reads sensitive, untrusted source code and drives a browser against user-supplied URLs. Threats: secret leakage; path traversal and out-of-root access; prompt injection via repository text, web content or API responses; execution of hostile package scripts; SSRF and internal network access, including DNS rebinding and redirects; destructive side effects on target data; credential and session theft or cross-project reuse; exposure of internal topology through generated documentation; tampered packages; resource exhaustion.

**Authorization model (MD-3).** Authorization is self-declared and recorded. The platform does not verify ownership. The controls below protect users and third parties *without* depending on ownership proof.

Three concepts remain separate (MR §6):
1. **Authorization declaration.** The user states they may analyze or test the target. This is the product's chosen trust model, not proof.
2. **Technical scope.** Code enforces which roots, hosts, paths and environments tools can reach, regardless of what the model or page content requests.
3. **Action approval.** State-changing tests need explicit, version-bound approval.

All browser controls (SEC-003, 007, 008, 009, 019, 020, 024, 025) are enforced by the shared runtime observation service, so they apply equally to URL-first discovery and to test execution. Accepting a URL as input never enables production testing.

### 21.2 Security requirements

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| SEC-001 | **Root sandboxing:** every file access resolves inside approved roots; symlinks resolved safely; traversal rejected; MCP arguments cannot widen roots | SAA, QAA source verifier | P0 | C | Traversal/symlink fixtures denied | SAA §12.2(1), §4.4 |
| SEC-002 | **No execution by default:** no scripts, installs, migrations, builds, tests or app start at L0–L2 | SAA, QAA | P0 | C | Process audit on benchmark runs shows no repository-originated processes | SAA §12.2(2), FR-004; QAA FR-017, §16.2 |
| SEC-003 | **Prompt-injection separation:** repository files, docs, comments, web pages (incl. hidden text) and API bodies are data; they cannot change policy, scope, permissions, approvals or request shell actions; policy enforced in code outside the model | SAA, QAA | P0 | C | Injection fixtures in repo and malicious benchmark page cause no policy change | SAA §12.2(5), FR-019; QAA §14.3 |
| SEC-004 | **Secret redaction:** detect credentials, tokens, keys; store references/variable names/redacted markers only; never in prompts, logs, traces, docs, packages, reports, screenshots (where feasible) or audit | Platform | P0 | C | Secret fixture set never appears in any output | SAA §12.2(4), FR-018, §12.3; QAA FR-068, §16.3 |
| SEC-005 | **Scoped authorization declaration.** Before analysis or adding an environment, the user records who declares, when, and what is in scope: source roots, hosts and paths, environment classification, operation level (observe / discovery probe / execute tests / tests may modify data), and prohibited data or actions. The declaration drives the enforced scope policy, is audited, and is not verified (MD-3) | Platform | P0 | P | Analysis and environment creation are impossible without a declaration; operations beyond the declared level are refused | QAA §16.1, MD-3, MR §6 |
| SEC-006 | **Least privilege and permission levels:** operations classified L0–L5 (§9.5); MCP tools declare side-effect level; no unrestricted shell tool by default | Platform | P0 | C | Tool registry exposes level per tool; L4 tools absent unless enabled | SAA §12.2(8), §4.4 |
| SEC-007 | **URL scope, SSRF and egress:** allowlisted schemes/hosts/path prefixes; every redirect and connection revalidated; DNS-rebinding protection by checking resolved addresses at connection time; egress enforced outside the application; URL params, page content and model output cannot expand scope | QAA | P0 | C | SSRF/redirect/DNS fixtures blocked (incl. cloud metadata IPs) | QAA §16.1, OWASP SSRF guidance |
| SEC-008 | **Private network policy:** loopback, private, link-local and metadata addresses blocked by default; an explicit administrator-enabled **local owner mode** allows named private/loopback targets (e.g. `localhost:3000`) for T1 with stronger isolation | QAA | P0 | C (local mode P) | Default blocks localhost; enabling local mode for a named host allows only that host | QAA §16.1, RC-C09 |
| SEC-009 | **Environment classification:** environments are `development`, `staging` or `production`; discovery and execution refuse `production` in MVP; classification shown before approval and execution | QAA | P0 | C | Production-classified env cannot run | QAA §16.4, X-09 |
| SEC-010 | **Destructive actions and test data:** discovery never submits suspected destructive forms; scenarios that create/update/delete/approve/publish/send are flagged `state_changing` and need explicit approval and cleanup plan or irreversibility acknowledgment; possession of URL/credentials is never sufficient | QAA | P0 | C | Unflagged state-changing fixture is detected by validator; approval gate enforced | QAA §16.4, FR-025, MD-3 note |
| SEC-011 | **Credential handling:** secret references only; exposed only to the specific worker at runtime; short-lived tokens preferred; no cross-project/tenant reuse of auth state; revocation and deletion instructions documented | Platform, QAA | P0 | C | Worker for project A cannot read project B secrets | QAA §16.3 |
| SEC-012 | **Worker isolation:** disposable workers per job; isolation between projects/tenants; workers receive only required credentials and repository material; re-check authorization, approval, scope and run state before starting | QAA | P0 | C | Cross-project artifact access fixture denied | QAA §15.2, §19 |
| SEC-013 | **Sandbox for repository code execution (L4):** if ever enabled, strong isolation, no default secrets or internal network, allowlisted commands, audit | SAA, QAA | P1 (SAA runtime) / deferred (QAA) | C | — | SAA §12.2(3), QAA §16.2 |
| SEC-014 | **Audit trail:** record authorization declarations, scope changes, credential configuration and use, approvals, run start/cancel, L4 actions, exports and deletions; no secret values | Platform | P0 | C | Audit entries exist for each listed action in E2E test | SAA §12.2(9), QAA §16.6 |
| SEC-015 | **Retention and deletion:** configurable retention for source excerpts/indexes, prompts/outputs, recordings, screenshots, traces; project deletion removes artefacts incl. object storage per documented backup policy; cache deletion removes excerpts | Platform | P0 | C | Deletion test leaves no project artefacts | SAA §12.3, QAA §16.5 |
| SEC-016 | **Output safety:** warn that docs/packages reveal topology; respect output path and ignore rules; no overwrite without configured behavior/confirmation | SAA | P0 | C | Warning shown on first export | SAA §12.2(7) |
| SEC-017 | **No repository acquisition:** Sys2QA never clones, fetches or downloads repository content; it reads only directories the user already holds locally (or a package exported from them) | SAA, QAA | P0 | P | No outbound VCS/network fetch of source in any default code path (network-isolated test) | MD-2 |
| SEC-018 | **Local-first model use:** no source upload by default; remote LLM use is opt-in, disclosed, with exclusions/redaction; no-remote-model mode where practical | Platform | P0 (disclosure) / P1 (no-remote mode) | C | Config shows provider and data disclosure; excluded files never in prompts | SAA §12.2(6), QAA §16.5, X-17 |
| SEC-019 | **Uploads/downloads:** browser downloads/uploads disabled unless a scenario needs them with controlled types/destinations; manual evidence uploads type- and size-limited | QAA | P0 | C | Unapproved download blocked | QAA §16.4 |
| SEC-020 | **Rate limiting:** discovery, navigation, requests and execution rate-limited per environment | QAA | P0 | C | Configured rate honored in tests | QAA §16.1 |
| SEC-021 | **Package integrity:** checksum validation and refusal of packages containing suspected raw secrets | QAA | P0 | P | See CON-019, `PKG_SECRET_SUSPECTED` | QAA §26.2 |
| SEC-022 | **Dependency integrity:** no automatic tool installers in unattended runs; adapter/tool versions pinned or recorded; downloads verified per distribution policy | Platform | P0 | C | Run metadata lists tool versions | SAA §12.2(10) |
| SEC-024 | **Discovery probe (L2p)** is off by default and enabled per scope declaration. It submits only empty/invalid input to forms the classifier does not mark as state-changing. It never targets login forms (to avoid account lockout), payment, deletion, invitation or messaging forms. Probe submissions are rate-limited and audited | Platform | P0 | P | Probe-off discovery submits no form; with probe on, destructive and login fixture forms are not submitted | MR §6, QAA FR-025 |
| SEC-025 | **One enforcement point for browser access.** No agent or plug-in opens browser or HTTP sessions to targets except through the runtime observation service | Platform | P0 | P | A static check or test shows no direct target access outside the service | MR §6, RC-C17 |
| SEC-023 | **Personal data:** redact or warn about personal data in screenshots/logs where feasible; store only evidence needed to explain and reproduce results | QAA | P1 | C | — | QAA §16.5 |

### 21.3 Sensitive-data handling (C, SAA §12.3)

`.env` files may be inventoried as existing but values are never copied; `.env.example`, schemas and config keys described with value redaction; excerpts bounded by length and redaction policy (line reference + digest preferred for sensitive findings); users can exclude paths and choose whether excerpts are exported.

---

## 22. Non-functional requirements

Numeric targets are set only after baseline measurement (SAA §11.2, QAA §17).

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| NFR-001 | **Correctness/auditability:** claims traceable or labeled; schema validation before publication; evidence paths and revisions checked; docs and machine outputs from one canonical model | SAA | P0 | C | Validator passes on benchmark packages | SAA §11.1 |
| NFR-002 | **Bounded resources:** streaming, indexes, bounded LLM context; configurable limits for files, generated/lock/vendor/binary files, depth, pages, steps, run duration, tokens, concurrency, CPU, memory, disk, artifacts | SAA, QAA | P0 | C | Limits configurable and enforced in tests | SAA §11.2, QAA §17.2 |
| NFR-003 | **Reproducibility:** same source, configuration and adapter versions yield materially identical extracted facts and IDs; LLM prose may vary | SAA | P0 | C | Two runs on the same revision produce identical entity/relationship sets | SAA §11.1 |
| NFR-004 | **Reliability:** persisted job state; recoverable UI after API restart; bounded retries for transient infra errors; idempotency keys prevent duplicate execution; failed adapter cannot corrupt accepted SKB; partial runs never marked complete; atomic output promotion | SAA, QAA | P0 | C | Crash/restart and duplicate-delivery fixtures | SAA §11.4, QAA §17.1 |
| NFR-005 | **Incremental and cached analysis:** cache by revision, file fingerprint, adapter version and config; incremental refresh with full-rescan option; progress reporting and cancellation | SAA | P0 (cache, progress, cancel) / P1 (incremental) | C | Second run on unchanged revision reuses cache (measured hit rate reported) | SAA §6.3, §11.2 |
| NFR-006 | **Responsiveness:** long jobs queued; dashboards responsive during jobs; estimates shown as estimates | QAA | P0 | C | API never blocks on browser/model jobs | QAA §15.2, §17.2 |
| NFR-007 | **Portability:** supported OS list explicit and tested (OD-16); no hosted account required; prerequisites checked by `saa doctor` and QAA health checks; outputs portable | Platform | P0 | C | CI matrix covers declared OS | SAA §11.3, QAA §17.4 |
| NFR-008 | **Maintainability/extensibility:** documented adapter interfaces; ontology independent of parsers; shared contract; versioned schemas and migrations; typed internal contracts; structured logs | Platform | P0 | C | Adapter added without core change in a test | SAA §11.5, QAA §17.4 |
| NFR-009 | **Accessibility:** keyboard-usable setup, review and manual execution; labeled controls; accessible status announcements; no color-only status | QAA UI | P0 | C | Automated a11y checks plus manual keyboard pass on core screens | QAA §11.2, §17.3 |
| NFR-010 | **Usability of errors:** every error states what failed, why it matters and the next action; retry guidance only where safe | Platform | P0 | C | Error catalog review | SAA §11.6, QAA §11.2 |
| NFR-011 | **Cost transparency:** model usage (tokens/cost where available) recorded per project, job and agent | Platform | P0 | C | Usage records exist per job | QAA §14.4, SAA §18 |

---

## 23. User interface and user experience requirements

### 23.1 Interfaces per agent

| Interface | Agent | Purpose | Priority |
|---|---|---|---|
| CLI (guided `sys2qa start`, plus power-user commands; §23.4) | Platform, SAA, QAA | Start from what you have; analyze/discover; browse catalog; inspect; deepen; validate; export; human and `--json` output; stable exit codes; cancellation; redacted logs | P0 |
| MCP server (`saa.get_system_overview`, `…list_projects_and_components`, `…search_code_and_knowledge`, `…get_entity`, `…get_evidence`, `…list_workflows`, `…get_completeness_report`, `…trace_workflow` (deepens a discovered workflow ID), `…get_api_contract`, `…get_data_model`, `…get_dependencies`, `…get_tests_for_entity`, `…get_change_impact`, `…get_unknowns_and_contradictions`, `…run_scoped_analysis`, `…get_analysis_status`, `…refresh_knowledge`) | SAA | Agent access; narrow typed tools; side-effect levels; progress for long operations | P0 |
| Analyst Skill | SAA | Guides AI clients through methodology and tools | P0 |
| Web UI | QAA (+ package viewer) | Projects, readiness, plan, review/approval, manual runner, automated monitor, results, settings | P0 |
| QAA API | QAA | Same service layer as UI; versioned | P0 (internal), P1 (public) |
| SAA review UI | SAA | Evidence navigation, contradictions, annotations | P2 (SAA-FR-027) |

### 23.2 Core screens (C, QAA §11.1, extended P)

1. **Projects dashboard** — package version and readiness, freshness, last run, failures, blockers, stale-scenario count.
2. **Start / project setup wizard** — "What do you have?" mode selection (A–D), scoped authorization declaration, evidence profile preview, environments and classification, scope, credential profiles, language settings, safety confirmation.
3. **Documentation readiness** (P) — validation results, coverage by category, gaps and contradictions with materiality, freshness, allowed actions.
4. **System map and workflow catalog** — discovered entry points and workflows by category; evidence profile per item; completion labels; unresolved links; unobserved areas; completeness report; "deepen" action; exclusions and uncertainty.
5. **Test plan** — objectives, scope, risk model, coverage summary, assumptions, exclusions.
6. **Scenario review** — list with filters (feature, risk, mode, basis/oracle, status, freshness), step preview, evidence/trace panel (SAA claim → evidence), language selector, approval controls, bulk approval preview, clarification panel.
7. **Manual runner** — one step at a time; expected vs. actual; status; notes; attachments; defect creation; pause/resume/abandon.
8. **Automated run monitor** — queue state, current case, elapsed time, safe cancellation, events.
9. **Results and evidence** — filters, expected vs. actual, failure category, screenshots, traces, logs, source evidence, defects, baseline.
10. **Change impact** (P) — new baseline, diff summary, suspended/invalidated approvals, revalidation action.
11. **Settings** — providers, languages, secrets, access control, retention, worker policies, local owner mode.

### 23.3 UX rules (C, QAA §11.2)

Show project state and next safe action; display scope and environment prominently before approval and execution; meaningful progress stages; visually separate source evidence, browser observations and AI inferences; never color alone; keyboard accessible; actionable errors; show all bulk selections; clearly flag incomplete or uncertain results; show freshness and readiness wherever scenarios or results appear (P); never ask the user for system knowledge (workflow names, architecture, rules) as a precondition (SYS-002); show the evidence profile and its limits on every summary (SYS-004).

### 23.4 CLI design principles (illustrative commands, not final)

Commands operate on **what the user has** and on **IDs generated by analysis**, never on names the user must already know (MR §8).

```text
sys2qa start                                   # guided: repository | URL | both | package
sys2qa analyze ./my-project                    # Mode A
sys2qa discover https://dev.example.test       # Mode B (requires scoped declaration)
sys2qa analyze ./my-project --url https://dev.example.test   # Mode C
sys2qa import ./acme-portal-pkg-v3/            # Mode D
sys2qa status <project-or-run-id>
sys2qa workflows list <run-id>                 # discovered catalog
sys2qa workflows show <run-id> <workflow-id>
sys2qa trace <workflow-id|entry-point-id> --deepen   # follow-up on a discovered item
sys2qa validate package <path>                 # names what is validated:
sys2qa validate evidence <run-id>              #   package schema vs. evidence integrity
sys2qa export <run-id> --format package
sys2qa qa plan <package-id>
sys2qa qa pack <suite-id> --format markdown    # manual test pack, no environment needed
```

`validate` always names its target (`package`, `evidence`, `consistency`), because these are different checks. The CLI may become an interactive terminal flow, a GUI or an agent conversation; the principle, not the syntax, is normative (OD-28).

---

## 24. Open-source distribution and extensibility

| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| OSS-001 | Core platform (SAA, QAA, contract) is open source and self-hostable; runs on operator-controlled infrastructure | P0 | C | Quick start works with no hosted Sys2QA service | QAA §21.1, SAA §11.3 |
| OSS-002 | License chosen deliberately before first public release; no release without a `LICENSE` file | P0 | C | Release checklist blocks without LICENSE | QAA §21.2 (OD-09) |
| OSS-003 | Repository standards: `README.md` (purpose, quick start, features, limitations, security warning), `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (private reporting), `.env.example` (placeholders only), `docs/architecture.md`, `docs/qa-methodology.md`, `docs/scenario-schema.md`, `docs/contract/` (package schemas), `docs/self-hosting.md`, `docs/threat-model.md`, `docs/model-providers.md`, `docs/language-and-localization.md`, `docs/adapters.md` | P0 | C (contract/adapters docs P) | Files exist before public preview | QAA §21.3 |
| OSS-004 | Documented extension interfaces: SAA language/framework/config adapters; QAA execution adapters; model providers; language packs; evidence extractors; report exporters; defect-tracker exporters (P2) | P0 (adapters, providers) / P1 (others) | C | Example adapter in repo | QAA §21.4, SAA §11.5 |
| OSS-005 | Plug-ins cannot bypass authorization, approval, scope, permission levels or worker policies; registration grants no extra level | P0 | C | Malicious plug-in fixture cannot escalate | QAA §21.4, SAA §16 |
| OSS-006 | Example projects: benchmark fixture repositories and apps (§26.2), a sample Documentation Package, a sample QAA export | P0 | P | Shipped under `examples/` or `benchmarks/` | SAA §15 Phase 0, QAA §18.2 |
| OSS-007 | Contribution expectations: tests for new behavior; contract conformance in CI for both agents; regression test for fixed defects where practical; ADRs for significant decisions | P0 | C | CONTRIBUTING documents them; CI enforces conformance | QAA §18.1, §21.5 |
| OSS-008 | Governance: maintainer-led, transparent triage, public design discussion, versioned releases, published roadmap; any hosted offering clearly distinguished | P1 | C | — | QAA §21.5 |
| OSS-009 | Provider-neutral LLM integration via a narrow adapter (structured generation, tool calls if needed, token/cost tracking, timeouts, error normalization); outputs validated locally; providers benchmarked; credentials outside prompts | P0 | C | Two providers pass the same contract tests | QAA §14.2, SAA §16 |
| OSS-010 | Independent versioning and release of SAA, QAA and the contract; each declares compatible contract range | P0 | P | Release notes state compatibility | §13.13 |
| OSS-011 | Self-hosting and local development: Docker-based setup and documented native local setup; configuration via files/env with `.env.example`; secrets via secret references or a deployment secret manager | P0 | C | Fresh-machine setup from docs succeeds | QAA §17.4, §15.1 |

Package names, registries and distribution channels are **not decided** (OD-10).

---

## 25. Observability, errors and auditability

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| OBS-001 | Metrics: queue depth, analysis/generation/browser durations, worker exits, outcomes, evidence volume, model usage, cancellations, cache hit rate, adapter failure rates | Platform | P0 | C | Metrics exposed via endpoint/command | QAA §17.5, SAA §18 |
| OBS-002 | Structured logs of state transitions, approvals, credential use, policy decisions, artifact access; no secrets | Platform | P0 | C | Log redaction tests | QAA FR-101 |
| OBS-003 | Machine-readable errors everywhere (code, severity, context, remediation); CLI stable exit codes | Platform | P0 | C | Error catalog documented | SAA §4.4, §9.4 |
| OBS-004 | Health checks; stuck-job detection; cancellation | Platform | P0 | C | — | QAA FR-102, FR-103 |
| OBS-005 | Telemetry off by default and opt-in; never collects source, secrets, private paths or SKB content without explicit informed consent | Platform | P0 | C | Default config sends nothing | SAA §18 |
| OBS-006 | Audit events per SEC-014, append-only, exportable | Platform | P0 | C | — | SAA §12.2(9), QAA §16.6 |

---

## 26. Testing and evaluation strategy

Sys2QA is tested with the principles it promotes (QAA §18). Benchmarks and expert review — not claims like "understands the whole codebase" — define quality (SAA §14.1).

### 26.1 Test levels for Sys2QA itself

Unit (schemas, state machines, risk scoring, permissions, translation preservation, classification, ID stability); integration (migrations, queue, storage, secret refs, adapters, providers); **contract conformance** (SAA output and QAA input against shared fixtures, run independently); component (scenario editor, approval state, manual runner, reports); end-to-end (local repo → SAA package → QAA import → generation → approval → manual + automated runs → report); security (SSRF, redirects/DNS, access control, prompt injection, secret redaction, cross-project isolation, root sandbox, no-execution); regression for fixed defects.

### 26.2 Benchmark corpus

**SAA repositories** (C, SAA §14.2): small documented web app with tests; undocumented legacy app with dead code; monorepo with independent frontends/services; multi-language frontend/API/worker/migrations; dynamic conventions/DI/reflection; event-driven with queues and jobs; missing dependencies/failed build; contradictory code/comments/README/tests; generated/vendor/duplicate symbols; secrets and prompt-injection strings; external API with inaccessible implementation; large repository with budget exhaustion and incremental change; revision changes with rename/remove/move; optional safe runtime case.

**QAA fixture applications** (C, QAA §18.2): login/logout; required/optional fields; partitions and boundaries; multi-condition rules; state transitions and permissions; pagination/search/sort/filter; seeded defects; broken links/missing routes/console errors; unstable dynamic controls; prompt-injection page; out-of-scope redirect routes.

**Joint benchmarks** (P): each QAA fixture app also exists as a repository so the full SAA → QAA pipeline is measured; plus a pair of revisions per app to test staleness propagation (§13.11).

**Flexibility fixtures** (P, MR §9). These are the first benchmark set:
1. **Repository-only:** an undocumented application with several workflows, business rules, database interactions and a background job.
2. **URL-only:** a development website with multiple pages, forms, navigation paths, validation errors and observable state changes.
3. **Combined:** the same application as source plus a running environment, with at least one deliberate discrepancy.
4. **Incomplete evidence:** an inaccessible dependency and an unobservable workflow boundary.

Each fixture is evaluated on whether Sys2QA:
- discovers workflows without being given their names;
- keeps inferred and verified behavior distinct;
- states where analysis stops;
- produces useful scenarios from each starting mode;
- detects source/runtime discrepancies;
- never claims that an observed success message proves an internal side effect;
- completes the useful parts with no deployment access.

### 26.3 Evaluation principles

Measure discovery and honesty about limits; publish benchmark results and known limitations with releases; no numeric claims before baselines; evaluate scenario correctness and coverage, not scenario count.

### 26.4 Metrics

| Area | Metrics | Source |
|---|---|---|
| SAA | Inventory coverage; boundary precision/recall; extraction correctness; relationship precision/recall; workflow trace quality (expert review); evidence traceability; uncertainty calibration; contradiction detection; freshness correctness; security behavior; document usefulness; cost/performance (time, resources, tokens, cache hit rate) | SAA §14.3 |
| Contract | QAA usefulness: answers defined queries and derives traceable tests without loading the whole source tree; conformance pass rate | SAA §14.3 |
| QAA | Scenario acceptance rate; expected-result validity; coverage recall; duplicate rate; automation reliability; false-failure rate; evidence completeness; manual completion rate; time to first useful suite; cost per accepted scenario | QAA §18.3 |
| Staleness (P) | Correct freshness/approval transitions on change benchmarks | §13.11 |

---

## 27. MVP scope and phased roadmap

### 27.1 Delivery principle

Deliver **complete user outcomes from an unknown starting point**, one evidence profile at a time, rather than completing one technical layer after another (MR §9, SAA §15 guardrails). Each phase ends with a user able to do something useful end to end.

Consolidation note (RC-C19): the maintainer review proposed a layer-ordered roadmap: foundation → SAA → URL discovery → QAA design → manual → automation → breadth. Under that ordering, no user could produce a reviewed, executed test until Phase 4. The roadmap below keeps the same building blocks and safety gates but reorders them into outcome slices. The final choice is **OD-26**.

### 27.2 MVP (public preview) scope

The MVP is Phases 0–3 below and covers all **P0** requirements:
- Modes A, B, C and D;
- automatic workflow discovery and catalog, with a completeness report;
- JS/TS + SQL + config/deploy source adapters (OD-06);
- runtime discovery through the shared observation service;
- package export with evidence profile, plus the contract validator;
- QAA readiness per activity, QA objectives, scenarios with basis, oracle and traceability;
- review and approval;
- manual testing and manual test packs with no environment required;
- Playwright automation for the constrained action set;
- defects; JSON/Markdown exports; `en`/`id`;
- the P0 security controls of §21;
- local single-user topology (pending OD-01).

Phases 1 and 2 may ship as **early-access releases**. They are useful on their own and need no automation infrastructure.

### 27.3 Roadmap

| Phase | User outcome | SAA deliverables | QAA deliverables | Shared deliverables | Exit gate |
|---|---|---|---|---|---|
| **0 — Shared foundation** | — (enabling) | SKB schema with an evidence model that does not assume source; IDs; claim statuses; adapter interface; CLI skeleton | Scenario schema with QA objective, basis and oracle; lifecycle | Contract v1.0 with evidence profile and runtime evidence identity; project/scope/declaration model; runtime observation service safety boundary (SSRF, scope, rate limits); the four benchmark fixtures of §26.2; threat model; decisions on OD-01, 02, 04, 05, 06, 09, 24, 26 | Source and browser evidence are both represented without losing provenance; conformance fixtures pass |
| **1 — Repository → manual QA** (early access) | A developer with only an unfamiliar repository gets a system map, a workflow catalog with gaps, and an approved, manually executed suite with a report, **with no environment** | Source discovery (JS/TS, SQL, config); entry points; workflow catalog; completeness report; docs; package | Import; readiness per activity; plan; techniques; characterization and implementation-conformance scenarios; review/approval; manual runner; manual test packs; defects; reports | `en`/`id`; audit; LLM adapter | Repository-only fixture: workflows discovered without names; a manual suite is executed and reported |
| **2 — URL → manual QA** (early access) | A developer with only a dev/staging URL gets observed workflows and useful candidate scenarios, executed manually | Runtime discovery (L2); observed model; Mode B limitations; discovery probe (opt-in) | Source-optional scenarios; exploratory charters for gaps; clarification items for business intent | Runtime observation service complete; scope declaration UX | URL-only fixture: useful scenarios and **no claim beyond observation**, for example no internal side effect inferred from a success message |
| **3 — Combined evidence + constrained automation** (MVP complete) | Repository + URL yields discrepancies and the strongest basis; approved scenarios run automatically and safely | Source–runtime correlation; revision correspondence; discrepancy records | Playwright worker; approval gates; isolation; cleanup; failure categories; targeted verification | Worker isolation; egress controls | Combined fixture discrepancy detected; incomplete-evidence fixture reports where analysis stops; automation security suite passes; §29.1 gate passes |
| **4 — Depth and change** | Systems evolve without stale tests | Incremental refresh; model diff; more adapters; LSP resolution; async/job/event depth; test mapping; annotations; follow-up requests | Regression suites; change-impact suggestions; supplied requirements and requirement-based testing; more auth strategies; run comparison; HTML/CSV | Analysis-request API (P1) | Staleness benchmark passes; incremental results correct under moves and schema/config changes |
| **5 — Team, CI and extensibility** | Teams and pipelines | CI impact reports; review UI; policy packs; SAA runtime mode (L4) with sandbox | API/contract, accessibility and visual-regression adapters; tracker export; CI for approved suites | Team storage and access control if justified; self-hosted model support | Team features without widening source-data exposure |

Performance testing, penetration testing, production execution and infrastructure provisioning need separate safety designs. They are never added silently as general agent actions (QAA §20, X-22).

---

## 28. Functional requirement catalogue

### 28.1 ID scheme

| Prefix | Area | Defined in | Notes |
|---|---|---|---|
| `SYS-nnn` | Product-level (starting modes, onboarding, no DevOps prerequisites) | §10.1 | New in draft.2 |
| `SAA-FR-nnn` | SAA functional | §11.3 | 001–028 preserved from SAA PRD; 029–046 proposed |
| `CON-nnn` | SAA↔QAA contract | §13.14 | New; consolidates SAA §7, §9 and QAA §26 |
| `QAA-FR-nnn` | QAA functional | §14 | Original `FR-nnn` numbers preserved with prefix; new IDs use free numbers in each group |
| `LOC-nnn` | Localization | §19.6 | Consolidates QAA §8; extends to SAA |
| `SEC-nnn` | Security, privacy, isolation | §21.2 | Consolidates SAA §12 and QAA §16 |
| `NFR-nnn` | Non-functional | §22 | Consolidates SAA §11 and QAA §17 |
| `OSS-nnn` | Open source, extensibility | §24 | Consolidates QAA §21, SAA §16 |
| `OBS-nnn` | Observability, audit | §25 | Consolidates SAA §18, QAA §17.5, FR-101–103 |
| `G-`, `SC-`, `X-` | Goals, success criteria, out of scope | §5, §6 | — |
| `RC-` | Reconciliation log entries | Appendix A | — |
| `OD-`, `A-` | Open decisions, assumptions | §31 | — |

IDs are permanent. A retired requirement keeps its ID with status "Withdrawn" and a reason; numbers are never reused.

### 28.2 Totals

| Area | Total | P0 | P1 | P2 | Confirmed | Proposed |
|---|---:|---:|---:|---:|---:|---:|
| SYS | 4 | 4 | 0 | 0 | 0 | 4 |
| SAA-FR | 46 | 36 | 7 | 3 | 28 | 18 |
| CON | 22 | 20 | 2 | 0 | 9 | 13 |
| QAA-FR | 96 | 76 | 19 | 1 | 77 | 19 |
| LOC | 11 | 10 | 1 | 0 | 8 | 3 |
| SEC | 25 | 23 | 2 | 0 | 20 | 5 |
| NFR | 11 | 11 | 0 | 0 | 11 | 0 |
| OSS | 11 | 10 | 1 | 0 | 9 | 2 |
| OBS | 6 | 6 | 0 | 0 | 6 | 0 |
| **Total** | **232** | **196** | **32** | **4** | **168** | **64** |

Counting notes:
- CON-014 counts as P0: QAA's staleness propagation is P0; the SAA diff part is P1.
- NFR-005 and SEC-018 count as P0, although each has a P1 sub-part.
- SAA-FR-018/019 and QAA-FR-068 are counted even though they were merged into SEC-004/SEC-003. They remain as agent-level acceptance hooks.
- "Confirmed" includes source requirements that were modified with a recorded reason (SAA-FR-009, SAA-FR-014). QAA-FR-003 counts as Proposed.

### 28.3 P0 index (MVP)

- **Product-level:** SYS-001–004.
- **SAA:** SAA-FR-001–020, 029–036, 039–046.
- **Contract:** CON-001–014, 017–022.
- **QAA:** QAA-FR-001–006, 009–018, 021–026, 029–038, 033a, 041, 042, 044, 046–048, 050–055, 057, 060–068, 071, 080–086, 088, 089, 090–093, 100–103, 110–112.
- **Localization:** LOC-001–004, 006–011.
- **Security:** SEC-001–012, 014–022, 024, 025.
- **NFR:** NFR-001–011.
- **OSS:** OSS-001–007, 009–011.
- **OBS:** OBS-001–006.

### 28.4 P1/P2/Deferred index

- **P1:**
  - SAA-FR-021–025, 037, 038;
  - CON-015, 016;
  - QAA-FR-007, 008, 019, 020, 027, 028, 039, 040, 043, 045, 056, 069, 070, 087, 094–096, 104, 113;
  - LOC-005;
  - SEC-013 (SAA runtime), SEC-023;
  - OSS-008.
- **P2:** SAA-FR-026–028; QAA-FR-097.
- **Deferred to Phase 5 (no ID yet):** API/contract testing adapter, accessibility checks, visual regression, additional automation engines, CI execution of approved suites.

---

## 29. Acceptance criteria and definition of done

### 29.1 MVP release gate

The MVP is releasable as a public preview only when **all P0 requirements** meet their acceptance criteria and every check below passes on the benchmark corpus. Checks merge SAA §14.4 and QAA §19.

**SAA**
- [ ] CLI analyzes a repository with no AI agent connected; default operation is read-only and static and executes no scripts.
- [ ] Supported stack is detected with support levels; unsupported areas are explicit.
- [ ] Boundaries and dependency graphs are correct for benchmark monorepos (expert-reviewed).
- [ ] Discovered workflows are traced with evidence per internal hop or explicit unresolved labels; deepened workflows meet the §11.1 completion rules.
- [ ] Roles/permissions, routes/pages/forms, business rules and (where present) state machines are emitted or gap-recorded.
- [ ] SKB and package pass schema validation; every important claim is evidence-backed or classified.
- [ ] Markdown docs and package share one model and revision; docs render in `en` and `id`.
- [ ] Partial/failed/cancelled states cannot be confused with complete analysis.

**Contract**
- [ ] SAA and QAA each pass the contract conformance fixtures independently.
- [ ] Every §13.10 error code is produced by its invalid fixture and blocks or downgrades as specified.
- [ ] Staleness propagation (§13.11) behaves as specified on the change benchmark.

**QAA — handoff and design**
- [ ] User imports a valid package, configures an authorized environment, languages and optional local checkout; package metadata and provenance are stored.
- [ ] Missing, incompatible, stale, mismatched or unresolved documentation is reported before generation.
- [ ] Documented flows map to routes and observed behavior on a benchmark app; out-of-scope navigation is blocked.
- [ ] SAA documentation, targeted source checks, supplied requirements and observations are distinct evidence types.
- [ ] Every scenario traces to ≥1 SAA artifact/entity or is labeled gap-driven exploratory; each expected result has a basis and oracle class.
- [ ] Ambiguous expectations are `needs_clarification`.

**QAA — approval and execution**
- [ ] Users edit, reject, defer and approve; the executor refuses unapproved, changed, suspended or mismatched-baseline versions.
- [ ] An approved suite runs on Playwright; results link expected and actual outcomes and evidence; assertion failures and infrastructure failures are separated; cancellation stops actions and starts cleanup; no arbitrary code execution is possible.
- [ ] A tester completes a manual run with actual results, evidence, pause/resume and a linked defect; results are labeled tester-reported.
- [ ] English and Indonesian artefacts preserve identifiers, numbers and status terminology.

**Evidence-adaptive behavior**
- [ ] Each starting mode (A, B, C, D) reaches scenario review on its fixture; no mode requires information the user lacks (SYS-001 … 003).
- [ ] Workflows are discovered with no names supplied; the catalog and completeness report state examined scope, unresolved links, unavailable adapters, unexplored areas and evidence that would help (SAA-FR-040, 045).
- [ ] Component traces and end-to-end workflows are distinct; composition stops are explained (SAA-FR-041).
- [ ] A URL-only project yields characterization/exploratory scenarios and no internal-effect claims (SAA-FR-043, QAA-FR-110).
- [ ] Combined mode detects the fixture discrepancy and shows revision correspondence (SAA-FR-044).
- [ ] Modes A and D export a manual test pack with no environment; results import back (QAA-FR-112).
- [ ] Every scenario's QA objective is consistent with its bases (QAA-FR-111).
- [ ] Discovery with probe off submits no forms; with probe on, login and destructive forms are not submitted (SEC-024).

**Security and operations**
- [ ] No fixture secret appears in logs, prompts, packages, reports or audit records.
- [ ] Prompt-injection, SSRF/scope, root-sandbox and no-execution suites pass.
- [ ] Workers cannot access another project's credentials or artifacts.
- [ ] No repository content is fetched over the network in default configuration (SEC-017).
- [ ] Operators can configure timeouts, concurrency and retention; a fresh self-hosted install works from documentation.
- [ ] Benchmark results and known limitations are published with the release.

### 29.2 Definition of done for a requirement or feature

A feature is not done because a model demonstrated it once (QAA §25). It is done when:
1. Requirements, constraints and acceptance criteria are documented and linked to its ID.
2. Schemas and state transitions are validated by code.
3. Authorization, approval, scope and permission levels are enforced outside the model.
4. Unit, integration, contract-conformance and relevant end-to-end tests exist and pass.
5. Failure, cancellation and partial-result paths are handled and tested.
6. Logs, outputs and reports avoid secrets (redaction tests pass).
7. User-facing text exists in `en` and `id`.
8. Documentation describes supported behavior and limitations.
9. A benchmark demonstrates behavior reproducibly.
10. Accessibility and usability are checked for applicable workflows.

### 29.3 Definition of done for a published SAA claim

See §12.3.

### 29.4 Definition of done for an executable scenario

Schema-valid; quality checklist (§15.13) satisfied; every expected result has a basis other than `unresolved`; trace links resolve in the stored package; freshness `current`; approval `active` with a matching baseline; state-changing approval and cleanup present where needed; for automation, all steps map to supported actions with locators of matching `literal_language`.

---

## 30. Requirement traceability matrix

### 30.1 SAA PRD → unified

| Source | Unified | Disposition |
|---|---|---|
| SAA-FR-001 … SAA-FR-017 | SAA-FR-001 … SAA-FR-017 | Retained 1:1 (SAA-FR-014/016/017 enriched from SAA §4.4) |
| SAA-FR-018 | SEC-004 (+ SAA-FR-018 hook) | Merged with QAA FR-068 (RC-D01) |
| SAA-FR-019 | SEC-003 (+ SAA-FR-019 hook) | Merged with QAA §14.3 (RC-D02) |
| SAA-FR-020 … SAA-FR-028 | SAA-FR-020 … SAA-FR-028 | Retained 1:1; SAA-FR-024 ownership boundary → OD-11 |
| SAA §2.1 goals | G-01 … G-05, G-11, G-12 | Retained |
| SAA §2.3 non-goals | X-01, X-02, X-04 … X-06, X-09, X-13 … X-17 | Retained |
| SAA §2.4 principles | §3.2 | Merged with QAA §2.1 |
| SAA §3 personas, journeys | §7, §10 (W2, W9, W10) | Merged |
| SAA §4.1–4.3 architecture | §9.1–9.3 | Merged |
| SAA §4.4 CLI/MCP/Skill | SAA-FR-014, 016, 017; §23.1 | Retained |
| SAA §4.5 runtime modes | §9.5 permission levels | Unified with QAA §16 (P) |
| SAA §5 methodology | §11.1 | Retained |
| SAA §5.1 Phase 4–5 (errors, rules, states) | SAA-FR-032, 033, 034 | Formalized as requirements (P) |
| SAA §6 capabilities/adapters | §11.2; SAA-FR-030, 031 | Retained; roles and UI extraction formalized (P) |
| SAA §7 SKB | §12.1, §13 (CON-002 … 007) | Retained; contract view added |
| SAA §7.6 storage | SAA-FR-036, §12.1 | Default location changed per SAA §19.3 recommendation (RC-C06) |
| SAA §8 docs set | §12.2, SAA-FR-013 | Retained; roles added (CON-011) |
| SAA §9 QAA contract | §13, SAA-FR-015, 029, 037 | Merged with QAA §26 |
| SAA §10.1 run outputs | §11.4 | Retained |
| SAA §11 NFRs | NFR-001 … 005, 007, 008, 010 | Merged |
| SAA §12 security | SEC-001 … 004, 006, 013 … 016, 018, 022; §21.3 | Merged |
| SAA §13 edge cases | §11.5; SAA-FR-039 | Retained |
| SAA §14 evaluation | §26 | Merged |
| SAA §15 roadmap | §27 | Merged |
| SAA §16 decomposition | §9.7 (non-normative), OSS-004, OSS-005 | Retained as recommendation |
| SAA §17 risks | §31.2 | Merged |
| SAA §18 telemetry | OBS-001, OBS-005, NFR-011 | Retained |
| SAA §19 decisions/questions | §31.4 (OD-01, 05–08, 16–19) | Retained |
| SAA App. A–D | §10, §13.5, §12.3, §8/§32 | Retained |

### 30.2 QAA PRD → unified

| Source | Unified | Disposition |
|---|---|---|
| FR-001, 002, 004 … 009 | QAA-FR-001, 002, 004 … 009 | Retained 1:1 |
| FR-003 | QAA-FR-003 | **Modified** — no clone/fetch; local checkout or package only (RC-C07, MD-2, OD-02) |
| FR-010 … 020 | QAA-FR-010 … 020 | Retained 1:1 |
| FR-021 … 028 | QAA-FR-021 … 028 | Retained 1:1 |
| FR-030 … 040, 033a | QAA-FR-030 … 040, 033a | Retained; FR-033 basis enum unified (CON-005) |
| FR-050 … 056 | QAA-FR-050 … 056 | Retained; FR-052 binding extended (RC-C15) |
| FR-060 … 067, 069, 070 | QAA-FR-060 … 067, 069, 070 | Retained 1:1 |
| FR-068 | SEC-004 (+ QAA-FR-068 hook) | Merged (RC-D01) |
| FR-080 … 087 | QAA-FR-080 … 087 | Retained 1:1 |
| FR-090 … 096 | QAA-FR-090 … 096 | Retained 1:1 |
| FR-100 … 104 | QAA-FR-100 … 104; OSS-009; OBS-002, 004 | Retained; owner = shared platform |
| QAA §1–§3 summary, vision, problem | §2–§4 | Merged |
| QAA §4 goals/non-goals | G-05 … G-10, G-12, G-13; X-05, X-07 … X-12, X-17 … X-19 | Merged |
| QAA §5 personas | §7 | Merged |
| QAA §6 methodology | §15 | Retained; oracle, coverage, defect lifecycle added (P) |
| QAA §7 modes | §16, §17, QAA-FR-055 | Retained |
| QAA §8 localization | §19, LOC-001 … 010 | Retained; extended to SAA (LOC-011) |
| QAA §9 journeys | §10 (W1, W3 … W8) | Merged |
| QAA §11 UI | §23 | Retained; readiness and change-impact screens added (P) |
| QAA §12 state models | §17.4, §18.1, §20.2 | Retained; freshness and approval states added (P) |
| QAA §13 scenario contract | §15.10 | Retained; traceability, oracle, freshness, locale fields added (P) |
| QAA §14 agent design | §9.4, OSS-009, NFR-002, NFR-011, SEC-003 | Merged |
| QAA §15 architecture | §9.6, §9.7, §20.1 | Retained as recommendation; topology → OD-01 |
| QAA §16 security | SEC-005, 007 … 012, 014, 015, 019, 020, 023 | Merged; attestation kept as self-declaration (MD-3) |
| QAA §17 NFRs | NFR-002, 004, 006 … 009, OBS-001 | Merged |
| QAA §18 own QA | §26 | Merged |
| QAA §19 MVP criteria | §29.1 | Merged |
| QAA §20 roadmap | §27 | Merged |
| QAA §21 open source | OSS-001 … 003, 007, 008, 011 | Retained |
| QAA §22 risks | §31.2 | Merged |
| QAA §23 decisions | §9, §31.4 | Retained; Playwright, TypeScript export, en/id, staging-first confirmed |
| QAA §24 questions | OD-01, 02, 06, 07, 09, 13, 14, 15, 20, 23 | Retained |
| QAA §25 DoD | §29.2 | Retained |
| QAA §26 SAA contract | §13, CON-001 … 016 | Retained and made concrete |

### 30.3 Proposed requirements → origin

| Unified | Origin |
|---|---|
| SAA-FR-029 … 039 | QAA §26 needs, SAA §5/§7/§9/§19 text without IDs, task scope (SAA doc language) |
| CON-005, 006, 007, 009, 011, 012, 014, 015, 018, 019 | Conflicts RC-C02 … C05, C11; gaps RC-G02, G13, G15 |
| QAA-FR-003 (mod), 029, 041 … 048, 057, 071, 088, 089, 097 | MD-2; QAA §6, §7, §16, §26.4 text without IDs; gaps RC-G04, G06 … G08, G14 |
| LOC-009 … 011 | QAA §8.3; gaps RC-G05, RC-G09 |
| SEC-005, 017, 021 | MD-2, MD-3, QAA §16.1, RC-G13 |
| OSS-006, 010 | SAA §15 Phase 0, QAA §18.2, §13.13 |

### 30.4 Items not converted into requirements

| Item | Reason |
|---|---|
| QAA §15.1 technology choices (React, Fastify, PostgreSQL, Redis/BullMQ, S3) | Implementation recommendations (§9.7), pending OD-01 |
| SAA §16 package names | Non-normative decomposition (§9.7) |
| SAA §4.3 description of REA's integration pattern | External reference; not re-verified during consolidation; informational only |
| QAA "Initial target" and SAA language priority | Scope assumptions (A-01) and OD-06 |

No source requirement was dropped. Source requirements whose behavior was changed need maintainer approval:
- QAA FR-003 (no clone; RC-C07);
- SAA-FR-009 (tracing applies to discovered workflows, not user-named ones; RC-C18);
- SAA-FR-014 (CLI operates on generated IDs; MR §8).

QAA FR-010 and the QAA FR-021 … 028 scope were clarified, not changed (RC-C17).

### 30.5 Maintainer review (draft.1 → draft.2) → unified

| Review item | Unified |
|---|---|
| MR-REQ-1 Flexible starting inputs | SYS-001, SAA-FR-042, CON-020 |
| MR-REQ-2 Automatic workflow discovery | SAA-FR-040, 041, 045, 046; SAA-FR-009 (modified) |
| MR-REQ-3 Evidence-bounded claims | SAA-FR-043, CON-020, CON-021, X-23 |
| MR-REQ-4 Useful without deployment access | SYS-003, QAA-FR-112, CON-022, X-22 |
| MR-REQ-5 Source-optional QA | QAA-FR-110, QAA-FR-113, CON-022 |
| MR §6 Declaration vs. scope vs. approval | SEC-005 (modified), SEC-024, SEC-025, §21.1 |
| MR §8 CLI | SAA-FR-014 (modified), §23.4, SYS-002 |
| MR §9 Roadmap and fixtures | §27 (reordered, RC-C19, OD-26), §26.2 |
| MR §11 QA objectives | QAA-FR-111, §15.9 |

---

## 31. Assumptions, risks, dependencies and open decisions

### 31.1 Assumptions

| ID | Assumption | Validate by |
|---|---|---|
| A-01 | First target systems are web applications/services with related DB, config and deployment code, in a Git repository | Early user repositories |
| A-02 | Markdown + JSON are sufficient output formats for the MVP | User feedback in Phase 1 |
| A-03 | When source is used, the user already holds a local checkout (MD-2); many users will have only a URL or only part of the source | Onboarding mode mix (opt-in telemetry) / interviews |
| A-04 | A reachable development or staging environment exists for QAA | Setup wizard drop-off |
| A-05 | Developers prefer local outputs they can inspect, diff and commit selectively | Phase 1 feedback |
| A-06 | SAA will be used with AI coding agents, so MCP and the Skill add value | Usage of MCP vs. CLI |
| A-07 | English and Indonesian cover the initial users | Locale requests |
| A-08 | Single tester per manual run is sufficient for the MVP | Phase 1 feedback |
| A-09 | Self-declared authorization (MD-3) is acceptable for the target audience | Community feedback; security review |
| A-10 | URL-only users have a dev/staging environment they are permitted to test, and read-only discovery is useful to them | Phase 2 feedback |
| A-11 | Characterization and exploratory scenarios are valuable even without requirements | Scenario acceptance rate on URL-only fixtures |

### 31.2 Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Overclaiming completeness (SAA) or coverage (QAA) | False trust | Claim statuses, coverage relative to model, explicit unknowns, benchmarks |
| LLM hallucination / invented expected behavior | Wrong docs, false failures | Deterministic extraction, mandatory evidence, basis/oracle labels, human approval |
| Adapter breadth too early | Shallow, buggy analysis | Support levels; focused MVP stack (OD-06) |
| Dynamic behavior not statically resolvable | Missing/false edges | `unresolved` status, framework resolvers/LSP, optional runtime later |
| Stale docs used for testing | Tests against outdated behavior | Freshness, staleness propagation, approval suspension (§13.11) |
| Monorepo components merged | Wrong architecture and impact | Boundary model and benchmark cases |
| Secret leakage | Compromise | Redaction, secret references, local-first, exclusions, tests |
| Prompt injection (repo or web) | Policy bypass | Data/instruction separation, policy in code, no shell tool |
| Destructive test effects | Data loss | Staging-first, state-changing flags, approval, cleanup, production refused |
| SSRF via target URL | Internal access | Allowlist, egress controls, DNS/redirect validation, private-network block |
| Misuse against systems the user does not own (accepted risk of MD-3) | Harm to third parties; project reputation | Recorded declaration, no destructive tests without approval, rate limits, production refused, clear docs and SECURITY.md |
| Flaky automation | Lost trust | Stable locators, web-first waits, controlled data, failure categories, bounded retries |
| Translation changes meaning | Invalid assertions | Language-independent action data, invariants, glossary, approval renewal on semantic change |
| Schema too complex | Slow iteration | Minimal essential types, versioned extensions |
| Expensive full scans (CPU/time) | Poor adoption | Fingerprint cache, incremental analysis, profiles, budgets, parallel parsing (OD-05) |
| Generated docs expose topology | Information leakage | Output warnings, external default path, redaction |
| LLM/provider drift or lock-in | Inconsistent quality, cost | Provider adapter, schema validation, provider benchmarks |
| Product too broad | Slow delivery | Vertical slice, phase gates |
| Misconfigured self-hosting | Exposure | Secure defaults, configuration checks, docs |
| URL-only discovery causes side effects (lockouts, emails, records) | Harm to test environment, user friction | Probe off by default, form classification, login forms never probed, rate limits (SEC-024) |
| URL-only results mistaken for full understanding | False confidence | Evidence profile and `cannot_establish` on every output (SYS-004); QA objectives (QAA-FR-111) |
| Workflow catalog too large to be useful on big monoliths | Users overwhelmed | Grouping, ranking, `not_deepened` markers (SAA-FR-046) |
| Source and environment differ silently in Mode C | Wrong discrepancies | Revision correspondence status on every discrepancy (SAA-FR-044) |

### 31.3 Dependencies

| Dependency | Status | Used for |
|---|---|---|
| Git (local metadata only) | Required for `git_commit` revisions | Revision identity, history signals |
| Playwright | Selected for MVP automation (QAA §23) | Automated execution, traces |
| Model Context Protocol | Selected interface (SAA §4.3); SDK choice open | SAA MCP server |
| LLM provider(s) or local model | Optional, operator-configured (OD-07) | Planning, synthesis, scenario generation |
| Parsers/indexers (e.g., Tree-sitter, language servers, TypeScript compiler API) | Suggested by SAA §6.2, not selected | SAA adapters |
| Container/process isolation runtime | Required for worker isolation; specific technology open | QAA workers, L4 sandbox |
| Database and queue | Recommended (QAA §15.1), pending OD-01 | QAA state and jobs |

### 31.4 Open decisions

| ID | Decision | Alternatives | Impact | Recommendation |
|---|---|---|---|---|
| OD-01 | MVP deployment topology | T1 local single-user; T2 self-hosted multi-user from day one | Infrastructure scope, auth/RBAC work, MD-2 feasibility | **T1 for MVP**, with T2 in Phase 2; keep the service layer multi-user-ready |
| OD-02 | How QAA performs targeted source verification without cloning | (a) Read the same local checkout (T1); (b) only use package excerpts; (c) provider API reads of specific files at the revision (T2) | Depth of QAA verification in team mode | (a) in T1; (b) as fallback; (c) deferred and opt-in |
| OD-03 | Target/repository ownership verification | DNS/well-known token; provider permission check; self-declaration | Friction vs. misuse risk | **Closed by MD-3: self-declaration** (X-21). Revisit only on maintainer request |
| OD-04 | Dirty-worktree and non-Git packages | Reject; review-only; allow with explicit baseline confirmation | Developer convenience vs. reproducibility | Import; `review_only`; execution approval after an explicit, audited baseline confirmation |
| OD-05 | **Implementation language(s)** | See §31.5 | Contributor reach, CPU performance, distribution | **TypeScript monorepo for Phase 0–1**, with adapters behind a process boundary so hot paths can later move to Rust or Go after profiling |
| OD-06 | First deep adapters | JS/TS web stack; Python; PHP; Java; .NET; Go | MVP usefulness | JS/TS + SQL + config/deploy, per both PRDs, confirmed against first real user repos |
| OD-07 | Default LLM provider(s); no-remote-model mode | Hosted provider(s); local model endpoint; deterministic-only mode | Privacy, cost, quality | Provider-neutral adapter; no default remote provider configured; deterministic SAA extraction works with no model |
| OD-08 | Canonical SKB storage at scale | JSON bundle; partitioned JSON; SQLite-backed index; hybrid | Performance, diffability | Partitioned JSON canonical + rebuildable SQLite index (hybrid) |
| OD-09 | License | Apache-2.0; MIT; copyleft (e.g., AGPL-3.0) | Reuse, patents, hosted-fork behavior | Maintainer decision; Apache-2.0 is a reasonable candidate (explicit patent grant) per QAA §21.2 |
| OD-10 | Package names, registries, distribution | npm, container images, standalone binaries | Install experience | Decide after OD-05 |
| OD-11 | Runtime observation ownership | SAA starts the app and observes (SAA-FR-024); SAA observes an existing environment (SAA-FR-042); QAA observes | Overlap and safety | **Revised:** SAA owns whole-application L2 discovery of an existing environment (SAA-FR-042); QAA does targeted verification; both go through the shared runtime observation service (SEC-025). Starting the app (L4, SAA-FR-024) stays P1 |
| OD-12 | Follow-up request transport | File-based; local API; shared workspace | Loop latency | File-based P1, API with QAA-FR-019 |
| OD-13 | Locale scope | `en`/`id` only; user-contributed packs | Community reach vs. quality | `en`/`id` official; packs accepted via glossary contribution process in Phase 2 |
| OD-14 | Retention defaults and sharing of manual evidence | Short default; operator-defined; per-project | Privacy, storage | Operator-defined with conservative defaults documented |
| OD-15 | Contract governance | SAA maintainers own; joint ownership; separate maintainers | Upgrade coordination | Joint ownership; changes via ADR + conformance fixtures |
| OD-16 | Supported OS for v1 | Linux only; Linux + macOS; + Windows | Contributor reach, CI cost | Linux + macOS + Windows for CLI if OD-05 = TypeScript; QAA workers Linux containers |
| OD-17 | Allowlisted commands for SAA runtime/L4 mode | None; per-project allowlist | Safety | None in MVP; per-project allowlist in Phase 3 |
| OD-18 | Auto-acceptance of SAA follow-up updates | Always review; auto-accept low-risk source facts | Speed vs. control | Auto-accept only `source_verified` structural facts; contradictions and intent always reviewed |
| OD-19 | Skill conventions targeted first | Specific agent clients | Adoption | Choose based on maintainer's primary agent; declare compatibility in Skill metadata |
| OD-20 | Benchmark corpus defining quality bar | Synthetic fixtures; open-source apps (with permission/license compatibility) | Evaluation validity | Start synthetic; add licensed OSS apps |
| OD-21 | How manual testers obtain test-account credentials | Tester's own accounts; platform reveal with audit; out-of-band | Security vs. usability | Tester-owned credentials out of band in MVP; audited reveal later |
| OD-22 | Approval carry-forward for unaffected scenarios on new baseline | Manual revalidation (default in §13.11); automatic carry-forward | Friction vs. control | Manual one-action revalidation (current spec) |
| OD-23 | VCS support | Git only; others | Scope | Git only; content fingerprint for everything else |
| OD-24 | Who performs whole-application URL discovery | (a) SAA runtime adapter producing a runtime-only package; (b) QAA crawls directly and builds its own model | Contract simplicity; duplicated modeling; Mode C merging | **(a)**: one system model and one contract for every mode; QAA stays a consumer; Mode C merges in one SKB. Cost: URL-only users still run the SAA step, hidden behind `sys2qa start` |
| OD-25 | Discovery probe default | Off; on for `development` classification only; always on | Usefulness of URL-only validation discovery vs. side effects (lockouts, emails, records) | Off by default; one-click opt-in in the declaration; never for login or state-changing forms |
| OD-26 | Roadmap ordering | Layer-ordered (maintainer review MR §9); outcome-sliced (§27.3) | Time to first end-to-end value; early feedback | Outcome-sliced; the same blocks and safety gates, reordered |
| OD-27 | Runtime evidence freshness window | Fixed default; per-environment; on deploy signal only | Staleness accuracy vs. noise | Per-environment setting with a documented conservative default; immediate staleness when the deployed revision is known to change |
| OD-28 | Primary onboarding surface | Interactive CLI; web UI; agent conversation (MCP/Skill) | Accessibility to non-experts | All three over one onboarding service; web UI first for non-CLI users, CLI for power users |

### 31.5 OD-05 detail — implementation language options

Analysis cost is driven more by **algorithm and caching choices** than by host language. Parsing libraries such as Tree-sitter are native code whichever language calls them. The largest cost levers are the same in every option: skip vendor/generated files, cache by file fingerprint and adapter version, analyze incrementally by revision diff, use profiles (`overview`/`standard`/`deep`), parse in parallel per file, and call the LLM only where deterministic tools cannot answer.

| Option | Shape | Strengths | Weaknesses | CPU profile |
|---|---|---|---|---|
| **A. TypeScript everywhere** | SAA engine, CLI, MCP, contract, QAA API/UI, Playwright runner in one TS monorepo | One language for contributors; contract schemas written once and shared; direct access to the TypeScript compiler API for deep JS/TS semantics (the MVP's first adapter); mature MCP and Playwright ecosystems; matches QAA §15.1 | Single-threaded event loop needs worker threads/processes for parallel parsing; higher memory per worker; graph-heavy work slower than native | Adequate for MVP-size repos with worker pools + native parser bindings; hot spots can move out later |
| **B. Go engine + TypeScript QAA** | SAA core in Go (single binary); QAA, UI, runner in TS; contract as JSON Schema | Easy parallelism; fast startup; static binaries simplify distribution; approachable for contributors | Two toolchains; schemas generated twice; deep TS type analysis still needs a Node sidecar or a native TS compiler port (TypeScript's announced native Go port should be checked for API readiness before relying on it) | Strong multi-core throughput for inventory/graph/indexing |
| **C. Rust core + TypeScript** | Rust for inventory, parsing, indexing, graph, hashing; TS elsewhere | Best raw performance and memory efficiency; excellent Tree-sitter support; single binary | Steepest contributor barrier; slower iteration while the ontology is still changing; same TS-semantics sidecar issue | Best for very large repos and CI-scale incremental analysis |
| **D. Python** | SAA in Python; QAA in TS (Playwright) | Rich AI/LLM tooling; quick prototyping | CPU-bound parallelism constrained (multiprocessing overhead); packaging/distribution harder; two languages anyway | Weakest for CPU-heavy, many-file analysis |

**Recommendation:** Option A for Phase 0–1. Define the SAA adapter interface as a **process boundary** (JSON over stdio, versioned like the contract) from day one, so a profiled bottleneck adapter can be rewritten in Rust or Go without touching the ontology, CLI, MCP or QAA. Revisit after Phase 1 benchmarks report wall-clock, CPU and memory per repository size.

---

## 32. Glossary and references

### 32.1 Glossary

Core product terms are defined in §8. Additional terms:

- **AST** — Abstract Syntax Tree.
- **Boundary value analysis / equivalence partitioning / decision-table / state-transition testing** — test-design techniques per ISTQB usage (§15.4).
- **Characterization test** — a test that captures current implemented behavior without asserting it is intended.
- **Business rule** — validation, decision, permission or state transition implemented by the system; intent may need human confirmation.
- **Egress control** — network-layer restriction of outbound connections.
- **SSRF** — Server-Side Request Forgery.
- **Static-first** — static extraction by default; execution is a separately approved mode.
- **Test oracle** — source of truth for deciding whether an observed result is correct.
- **Verification vs. validation** — conformance to a specification vs. fitness for stakeholder needs.

### 32.2 References

Carried from the source PRDs. Used as guidance only; no certification or compliance is claimed.

1. REA — Reverse Engineer Anything, public repository: https://github.com/morluto/rea (cited by SAA PRD, reviewed by its author 2026-10-21; not re-verified during consolidation).
2. Model Context Protocol: https://modelcontextprotocol.io/
3. ISTQB Glossary — Test case: https://glossary.istqb.org/en_US/term/test-case
4. ISTQB Glossary — Test basis: https://glossary.istqb.org/en_US/term/test-basis
5. ISTQB Glossary — Risk-based testing: https://glossary.istqb.org/en_US/term/risk-based-testing/2
6. ISTQB Glossary — Exploratory testing: https://glossary.istqb.org/en_US/term/exploratory-testing
7. ISTQB Glossary — Test execution automation: https://glossary.istqb.org/en_US/term/test-execution-automation
8. Playwright — Test generator: https://playwright.dev/docs/codegen
9. Playwright — Assertions: https://playwright.dev/docs/test-assertions
10. Playwright — Tracing: https://playwright.dev/docs/api/class-tracing
11. GitHub Docs — Choosing permissions for a GitHub App: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
12. OWASP — SSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
13. Choose a License: https://choosealicense.com/

---

## Appendix A. Source reconciliation log

### A.1 Duplicates merged

| ID | Topic | Sources | Unified |
|---|---|---|---|
| RC-D01 | Secret redaction/masking | SAA-FR-018, SAA §12.2(4), §12.3; QAA FR-068, FR-005, §16.3 | SEC-004 |
| RC-D02 | Prompt-injection resistance | SAA-FR-019, §12.2(5); QAA §14.3 | SEC-003 |
| RC-D03 | No repository script execution | SAA-FR-004, §12.2(2); QAA FR-017, §16.2 | SEC-002 |
| RC-D04 | Audit trail | SAA §12.2(9); QAA §16.6, FR-101 | SEC-014, OBS-002 |
| RC-D05 | Retention and deletion | SAA §12.3; QAA §16.5 | SEC-015 |
| RC-D06 | Provider-neutral LLM | SAA §16, §19.3; QAA §14.2, FR-100, FR-104 | OSS-009, QAA-FR-100/104 |
| RC-D07 | Evaluation/benchmarks | SAA §14; QAA §18 | §26 |
| RC-D08 | Roadmap | SAA §15; QAA §20 | §27 |
| RC-D09 | Context/cost management | SAA §11.2; QAA §14.4 | NFR-002, NFR-011 |
| RC-D10 | Knowledge handoff description | SAA §7, §9; QAA §1.1, §26 | §13 |
| RC-D11 | Principles | SAA §2.4; QAA §2.1 | §3.2 |
| RC-D12 | Personas | SAA §3.1; QAA §5 | §7 |

### A.2 Conflicts and resolutions

| ID | Conflict | Resolution | Status |
|---|---|---|---|
| RC-C01 | SAA local-first CLI vs. QAA self-hosted web app with PostgreSQL/Redis/S3 | Both supported as topologies T1/T2 | **OD-01** |
| RC-C02 | Package layout: SAA `.saa/manifest.json`, `SKB.json`, `docs/saa/00–14` vs. QAA `manifest.json`, `system-model.json`, `evidence-index.json`, `docs/system-overview.md` | Unified layout §13.2; QAA finds docs by role (CON-011); SAA doc set keeps its file names | Resolved (P) |
| RC-C03 | Revision: SAA allows content fingerprint and records dirty worktree; QAA requires immutable commit SHA | `revision.kind` + `worktree_dirty` (CON-006); policy | Partly resolved; **OD-04** |
| RC-C04 | Claim statuses (SAA) vs. expected-result basis (QAA) | Both kept; mapping §13.6 (CON-005) | Resolved (P) |
| RC-C05 | `complete_with_gaps` (QAA) vs. `completed_with_limitations` (SAA) | SAA taxonomy used in manifest; QAA readiness separate (§13.9) | Resolved (P) |
| RC-C06 | SAA §7.6 writes `.saa/`, `docs/saa/` into the repo vs. SAA §19.3 recommends external path and "no silent mutation" | External default, in-repo opt-in (SAA-FR-036) | Resolved (P) |
| RC-C07 | QAA FR-003 "connect to a Git repository", source-verification worker and source snapshots vs. MD-2 "no cloning" | QAA-FR-003 modified; SEC-017; local checkout binding | Resolved pending approval; **OD-02** for team mode |
| RC-C08 | QAA §16.1 attestation vs. consolidation proposal of ownership/domain verification | MD-3: self-declared authorization; verification not adopted (X-21); safety via approval, scope and classification | Resolved by maintainer |
| RC-C09 | QAA blocks loopback/private networks by default vs. owners testing `localhost` | Explicit admin-enabled local owner mode (SEC-008), consistent with QAA §16.1 private-network clause | Resolved (P) |
| RC-C10 | SAA-FR-024 runtime observation vs. QAA live discovery | MVP: QAA owns L2 observation; SAA runtime P1 | **OD-11** |
| RC-C11 | SAA Journey 3 interactive follow-up vs. QAA MVP artifact-only (API P1) | File-based analysis request (CON-015, P1) | Resolved (P); **OD-12** |
| RC-C12 | ID formats `evidence:handler-12-38` / `route:POST:/accounts` vs. `EVID-012` / `TC-REG-001` | Grammar §13.4; display keys separate | Resolved (P) |
| RC-C13 | QAA targets web apps; SAA broad language detection | MVP = intersection (web, JS/TS first) | Resolved; **OD-06** |
| RC-C14 | SAA-FR-015 programmatic query vs. QAA bundle import | Same contract, two access paths | Resolved |
| RC-C15 | QAA FR-052 approval binding omitted package version and test-data profile (QAA §9.3 mentions data profile) | Binding extended (QAA-FR-052) | Resolved (P) |
| RC-C16 | draft.1 onboarding started from a local repository (W1); the maintainer review requires repository, URL, both and package as starting points | Starting modes A–D (§10.1, SYS-001) | Resolved (P) |
| RC-C17 | URL-only mode needs whole-application browser discovery; draft.1 gave browser discovery to QAA while X-18/QAA FR-010 forbid QAA from re-doing system analysis | SAA owns URL discovery via the shared runtime observation service; QAA keeps targeted verification; QAA FR-021 … 028 apply to the service | Resolved (P); **OD-24** |
| RC-C18 | SAA-FR-009 traced "user-selected workflows", which assumes the user knows them | Discovery first (SAA-FR-040); SAA-FR-009 deepens discovered items | Resolved (P) |
| RC-C19 | Maintainer review roadmap (layer-ordered) vs. its own principle "prove the complete experience before breadth" | Outcome-sliced roadmap (§27.3) | **OD-26** |

### A.3 Terminology alignment

| ID | Source terms | Unified term |
|---|---|---|
| RC-T01 | "System Analyst Agent" (SAA PRD) / "System Analysis Agent" (QAA PRD) | **System Analysis Agent**, as stated by the maintainer in the consolidation brief |
| RC-T02 | SKB, SKB export, documentation package, artifact bundle, system model | SKB (internal), Documentation Package (export), system model (`system-model.json`) |
| RC-T03 | Test case, test scenario, scenario | Scenario |
| RC-T04 | `complete_with_gaps` / `completed_with_limitations` | `completed_with_limitations` |
| RC-T05 | Confidence, certainty label | Provenance status + confidence rationale |
| RC-T06 | `runtime_observed` (SAA) / observed (QAA) | Kept distinct by producer: `runtime_observed` (SAA claim), `observed` (QAA basis) |
| RC-T07 | Repository connection | Repository identity + local checkout binding |
| RC-T08 | Evidence (both) | SAA `evidence:*` in packages; QAA `qevid:*` in QAA store |
| RC-T09 | User attestation / authorization confirmation | Authorization declaration |
| RC-T10 | "Trace" (a command that finds a workflow) | Component trace (record) vs. end-to-end workflow (record); `trace` command = deepen a discovered item |

### A.4 Gaps closed (present in one PRD only, or in neither)

| ID | Gap | Closed by |
|---|---|---|
| RC-G01 | SAA-only interfaces (CLI/MCP/Skill) and QAA-only execution modes | Preserved without conflict (§23.1, §16, §17) |
| RC-G02 | Readiness states not enumerated | §13.9 |
| RC-G03 | Roles, permissions, pages/forms, business rules, state machines, requirements missing from SAA ontology but required by QAA §26.3 | §12.1, SAA-FR-030 … 033 |
| RC-G04 | Staleness effects on scenarios, approvals and results undefined | §13.11, QAA-FR-046, 047 |
| RC-G05 | SAA documentation language unspecified | SAA-FR-035, LOC-011 |
| RC-G06 | Defect severity and lifecycle undefined | §15.12, QAA-FR-088 |
| RC-G07 | Test oracle not modeled | §15.9, QAA-FR-041 |
| RC-G08 | Coverage metrics undefined | §15.11, QAA-FR-044 |
| RC-G09 | UI-text locators vs. target-app locale | §17.3, LOC-010 |
| RC-G10 | Manual tester access to test credentials | OD-21 |
| RC-G11 | Ownership of `requirement` entities | §13.4 |
| RC-G12 | Validation error codes for package import | §13.10 |
| RC-G13 | Package integrity "where supported" | CON-019, SEC-021 |
| RC-G14 | Test conditions not a record type | QAA-FR-048 |
| RC-G15 | Analysis budgets/cancellation not an SAA FR | SAA-FR-039 |
| RC-G16 | No QA objective distinguishing characterization from requirement conformance | §15.9, QAA-FR-111 |
| RC-G17 | No path to value without a running environment | QAA-FR-112, CON-022, SYS-003 |
| RC-G18 | Contract could not represent packages without source | CON-020, CON-021, §13.8 |
| RC-G19 | No definition of when discovery is "finished" | §11.6, SAA-FR-045 |

### A.5 Items that could not be validated during consolidation

- REA's current capabilities and integration pattern (SAA §4.3) were not re-checked; the description is kept as a cited reference only.
- No benchmark, performance or accuracy figure exists in either source. None is introduced.
- No code, schema file, license, package name or CI exists in the repository. Every requirement is unimplemented and untested.

---

**End of document**

