# Sys2QA — Implementation Plan & Backlog

| Field | Value |
|---|---|
| Status | Baseline 1.0 (matches PRD 1.0.0) |
| Last updated | 2026-10-22 |
| Source of truth for | Implementation tasks, their order, dependencies, requirement mapping and status |
| Not the source of truth for | Requirements (PRD), test details (Test Strategy), architecture (Software Architecture) |

Release strategy (OD-26): **all of Gates 1–5 are built before the first public release.** Gates are internal milestones with objective exit checks (PRD §27, §29.1). Gate 0 is a foundation milestone added by this plan; it has no public meaning.

---

## 1. Rules for every task

**Definition of Ready.** A task can start when:
- its dependencies are `done`;
- the requirements it implements are Approved or Confirmed and depend on no open decision (PRD §1.3; none are open at baseline 1.0.0);
- the contract parts it touches exist in `schemas/`, or are part of the task itself.

**Definition of Done.** A task is done when:
- the code is merged with tests tagged `[@req …]` for every listed requirement (Test Strategy §1);
- CI stages 1–3 are green on Linux, macOS and Windows;
- security tests (ST-xx) listed for the task pass;
- docs that are the source of truth for the change are updated in the same pull request (Contract Spec, Data Model, Architecture or ADR);
- no requirement is claimed by the task without a passing tagged test, unless it is listed as manual-evidence in Test Strategy §8.

**Status values:** `todo`, `in_progress`, `blocked`, `done`. Every task starts as `todo`.

**Foundations are never deferred.** These are built in Gate 0, before features: contract and validator, fixtures, security enforcement points, audit and logging, job status and cancellation, provenance and revision binding, and the benchmark harness (PRD §9.8 rule 6).

## 2. Milestones and critical path

```text
G0 Foundation ──► G1 Repo→model ──► G2 Model→scenarios ──► G3 Manual QA ──► G4 URL→model (+Mode C) ──► G5 Automation ──► RC
     │                                                     ▲                    ▲
     └── fixtures F1–F4, security harness, proxy design ───┴────────────────────┘ (built early, used later)
```

The critical path is contract (IMP-003/004) → intake and adapters (IMP-101–109) → tracer and catalog (IMP-110/111) → package export (IMP-117) → import and readiness (IMP-201/202) → scenario generation (IMP-205) → approval (IMP-207) → manual runner (IMP-301) → proxy and discovery (IMP-401/404) → executor (IMP-502).

Parallel workstreams once G0 is done:

| Workstream | Tasks that can proceed in parallel |
|---|---|
| A — SAA analysis | IMP-101 … IMP-120 |
| B — QAA design | IMP-201 … IMP-210, using **contract fixtures** as input before SAA output exists |
| C — Runtime | IMP-401 … IMP-403 (proxy, workers, form classifier), built against F2 early; enabled only after the ST subset passes |
| D — UI and interfaces | IMP-211, IMP-016 shells, parity tests growing with every service |

## 3. Spikes (time-boxed investigations before the dependent task)

| Spike | Question | Feeds | Time-box |
|---|---|---|---|
| SP-1 | SQL parser library for DDL/migrations (dialects: PostgreSQL, MySQL, SQLite) | IMP-108 | 2 days |
| SP-2 | OS credential-store library across Linux/macOS/Windows; encrypted-file fallback design | IMP-010 | 2 days |
| SP-3 | Container control: Docker Engine API client vs. CLI; rootless/user-namespace support per OS | IMP-501 | 3 days |
| SP-4 | First `js-ts` framework set beyond Express, Next.js and React Router (e.g. NestJS, Fastify) based on fixture needs | IMP-107 | 2 days |
| SP-5 | Proxy handling for WebSocket and HTTP/2 through `CONNECT`; Playwright proxy configuration per OS | IMP-401 | 3 days |

Each spike ends with a short ADR or an update to an existing ADR.

## 4. Backlog

Columns: **Reqs** = PRD requirement IDs the task implements (it must provide tagged tests for them); **Deps** = task dependencies; **Done when** = task-specific acceptance, in addition to the Definition of Done.

### Gate 0 — Foundation

| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-001 | Monorepo scaffold: pnpm workspaces, strict TS, ESLint/Prettier, Vitest, Playwright Test, CI matrix (Linux/macOS/Windows), docs link check | NFR-008, OSS-007, OSS-011 | — | Empty packages build and test on all three OSs; CI stages 1–2 run | done |
| IMP-002 | Dependency rules (dependency-cruiser) per Architecture §4.1 | CON-027, SYS-005 | IMP-001 | A forbidden import in a test branch fails CI | done |
| IMP-003 | Author JSON Schemas v1.0.0 for every document in Contract Spec §2; generate TS types | CON-001, CON-002, CON-003, CON-004, CON-005, CON-006, CON-007, CON-008, CON-012, CON-020, CON-021, CON-024, CON-026 | IMP-001 | Schemas compile; generated types committed; PRD §13 examples validate (after field alignment) | done |
| IMP-004 | Contract library: Ajv validators, semantic rules CR-001…CR-070, error catalog, producer constraints | CON-009, CON-013, CON-019, CON-023, CON-025, CON-027, CON-028, OBS-003 | IMP-003 | Every CR rule and error code is implemented in `contract` only | done |
| IMP-005 | Contract fixtures: valid and invalid per error code and CR rule; conformance runner usable by SAA and QAA CI independently | CON-018 | IMP-004 | CI asserts each code and rule has ≥ 1 fixture | done |
| IMP-006 | Project model, evidence sources, scoped authorization declarations, scope policies (versioned), policy engine (L0–L4, production refusal, local owner mode) | SYS-001, SEC-005, SEC-006, QAA-FR-001, QAA-FR-002 | IMP-004, IMP-007 | Policy decisions unit-tested for every level; declarations append-only | done |
| IMP-007 | SQLite state and index schemas, migrations, WAL, single-writer host, integrity check on start | NFR-004 | IMP-001 | Migration tests from an empty database; crash-recovery test | done |
| IMP-008 | Job orchestrator: persistent queue, leases, idempotency keys, timeouts, budgets, cooperative cancel then kill, worker supervision, progress events | QAA-FR-066, QAA-FR-102, NFR-002, NFR-004, NFR-006 | IMP-007 | Duplicate enqueue reuses the job; cancel kills a worker within the grace period; stuck jobs detected | done |
| IMP-009 | Audit (append-only, hash-chained, same transaction as the action) and structured logging with redaction | SEC-004, SEC-014, OBS-002, OBS-006, QAA-FR-101 | IMP-007 | ST-04 (logging part), ST-16 pass | done |
| IMP-010 | Secret store: `secretref:` IDs; OS credential store backend, encrypted-file fallback; per-job injection API | SEC-011, QAA-FR-005 | SP-2, IMP-007 | Secrets never written to state.db or logs (test) | in_progress |
| IMP-011 | LLM port: backends (hosted, local endpoint, none); schema-validated output; usage recording; record/replay for CI | OSS-009, SEC-018, NFR-011, QAA-FR-100 | IMP-004 | Deterministic-only mode works; replay harness in CI; disclosure shown in config | done |
| IMP-012 | i18n and versioned glossary (`en`, `id`), locale resolution order, invariant checks | LOC-001, LOC-002, LOC-003, LOC-004, LOC-006, LOC-008, LOC-009 | IMP-001 | Translation invariant tests (IDs, numbers, negations) pass | done |
| IMP-013 | Benchmark fixtures F1–F4 with reviewed ground truth (Test Strategy §4) | NFR-001 | IMP-001 | Second-person review recorded for every ground-truth file | todo |
| IMP-014 | Benchmark harness: metrics of Test Strategy §5, reports, trend storage | NFR-001, NFR-003 | IMP-004, IMP-013 | Harness runs on a stub producer and reports all metrics | todo |
| IMP-015 | Security harness: secret-leak scanner over all outputs, injection corpus, SSRF/DNS fixture servers, malicious adapter, malicious packages | SEC-003, SEC-022, SAA-FR-019 | IMP-001 | Harness runs; known-bad stubs are detected | done |
| IMP-016 | Application-services layer skeleton; CLI, local HTTP API (loopback, token, origin checks) and MCP shells; parity test harness; IPC to a running host | SYS-002, SYS-005, NFR-010 | IMP-004, IMP-006, IMP-008 | A sample command runs identically via CLI, API and MCP (PT); ST-12 passes | done |
| IMP-017 | Traceability tooling (`pnpm trace`): PRD ID parser, test-tag scanner, report | — (process) | IMP-001 | Report lists P0 requirements without tests; unknown tags fail CI | done |
| IMP-018 | Observability: metrics command and endpoint, health checks, opt-in telemetry switch (off by default) | OBS-001, OBS-004, OBS-005, QAA-FR-103 | IMP-008 | Default config sends nothing (test) | done |
| IMP-019 | Retention and deletion jobs; project deletion across state, files and secrets | SEC-015 | IMP-007, IMP-010 | ST-18 passes; deletion leaves no project artifacts | todo |
| IMP-020 | Configuration layering and `sys2qa doctor` (Node, browsers, SQLite driver, optional container runtime) | NFR-007, OSS-001 | IMP-016 | `doctor` reports each prerequisite with remediation; the configuration output shows the LLM provider and data disclosure (SEC-018, carried over from IMP-011) | done |

### Gate 1 — Repository → system model

| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-101 | Source intake: root sandbox, safe path resolution, ignore rules, streaming inventory, budgets | SAA-FR-001, SAA-FR-004, SAA-FR-039, SEC-001, SEC-002 | IMP-008, IMP-006 | ST-01, ST-02 pass; 100k-file fixture streams within budget | todo |
| IMP-102 | Revision identity: read-only Git metadata, dirty fingerprint, content fingerprint, no network | QAA-FR-004, SEC-017 | IMP-101 | Network-isolated test shows no fetch; dirty and non-Git cases labeled (OD-04) | todo |
| IMP-103 | Secret detection and redaction at intake and before every output | SAA-FR-018, CON-017 | IMP-101, IMP-015 | ST-04 passes for Gate 1 outputs | todo |
| IMP-104 | Stack detection and project boundaries; partial-analysis handling | SAA-FR-002, SAA-FR-003, SAA-FR-020 | IMP-101 | F1 and monorepo fixtures produce the expected boundaries | todo |
| IMP-105 | Adapter protocol (JSON-RPC over stdio), adapter host, capability and support-matrix declaration, resource limits | SAA-FR-047, OSS-004, OSS-005 | IMP-004, IMP-008 | ST-14 passes; `saa adapters` prints the matrix | todo |
| IMP-106 | `js-ts` adapter: modules, symbols, imports, references, dependency graph | SAA-FR-005, SAA-FR-006 | IMP-105 | F1 structural ground truth matches; parser errors recorded as coverage | todo |
| IMP-107 | `js-ts` framework layer: routes, handlers, pages, forms, fields, middleware (Express, Next.js, React Router; more after SP-4) | SAA-FR-007, SAA-FR-031 | IMP-106, SP-4 | F1 route/page/form ground truth matches; dynamic route yields an unresolved gap | todo |
| IMP-108 | `sql` adapter: DDL and migrations, Prisma schema; declared vs. inferred mappings | SAA-FR-008 | IMP-105, SP-1 | F1 data-model ground truth matches | todo |
| IMP-109 | `config-deploy` adapter: env-example names (values redacted), Docker/Compose, CI files, package scripts as metadata | SAA-FR-020 | IMP-105 | F1 config entities extracted; no script executed (ST-02) | todo |
| IMP-110 | Entry-point discovery and component tracer with stop reasons | SAA-FR-009, SAA-FR-041 | IMP-106, IMP-107, IMP-108 | Component traces for F1 entry points; stop reasons match ground truth | todo |
| IMP-111 | Workflow composer, discovery statuses, catalog ranking and grouping, deepen operation | SAA-FR-040, SAA-FR-046 | IMP-110 | Discovery recall, precision and reconstruction metrics produced on F1 and F4; CR-040–043 pass | todo |
| IMP-112 | Rules, roles/permissions, state machines, error and alternative flows | SAA-FR-030, SAA-FR-032, SAA-FR-033, SAA-FR-034 | IMP-110 | F1 rules, roles and state ground truth matches or is gap-recorded | todo |
| IMP-113 | Cross-validation, contradictions, provenance and status assignment (CR-001/002) | SAA-FR-010, SAA-FR-011, SAA-FR-043 | IMP-111, IMP-112 | F1 README/code contradiction detected; over-claiming count 0 | todo |
| IMP-114 | Completeness report (scope, unresolved, unavailable adapters, unexplored, evidence that would help) | SAA-FR-045 | IMP-111 | Uncertainty-reporting accuracy reported on F4 | todo |
| IMP-115 | SKB store: partitioned JSON, atomic writes, index build and rebuild, fingerprint cache | SAA-FR-012, NFR-005 | IMP-007, IMP-113 | Index rebuild gives identical query results; second run reuses cache | todo |
| IMP-116 | Documentation renderer (`en`, `id`) from the SKB by role | SAA-FR-013, SAA-FR-035, LOC-011 | IMP-115, IMP-012 | All §12.2 roles rendered or gap-documented; IDs identical across languages | todo |
| IMP-117 | Package exporter: staging, validation, checksums, output location policy, first-export warning; local query library | SAA-FR-015, SAA-FR-029, SAA-FR-036, SEC-016 | IMP-115, IMP-116 | Exported F1 package passes the conformance suite; ST-17 passes | todo |
| IMP-118 | SAA commands in the CLI (`start`, `analyze`, `status`, `workflows list/show`, `trace --deepen`, `validate`, `export`, `adapters`) | SAA-FR-014 | IMP-016, IMP-117 | Parity tests cover each command | todo |
| IMP-119 | MCP tools for SAA operations, side-effect levels declared | SAA-FR-017 | IMP-016, IMP-117 | MCP parity tests pass; out-of-root arguments rejected | todo |
| IMP-120 | Analyst Skill package (Claude Code conformance target) | SAA-FR-016 | IMP-118, IMP-119 | Claude Code conformance run recorded; other clients smoke-tested | todo |
| IMP-121 | **Gate 1 acceptance run** (PRD §29.1 Gate 1) | — | IMP-101–IMP-120 | Gate report archived; all Gate 1 checklist items have evidence | todo |

### Gate 2 — System model → QA scenarios

| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-201 | Package import: archive/directory, size and path checks, ordered validation, original stored byte-for-byte, artifact discovery by role | QAA-FR-009, QAA-FR-010, QAA-FR-011, QAA-FR-012, CON-010, CON-011, SEC-021 | IMP-005, IMP-007 | ST-13 passes; every import error fixture yields its code | todo |
| IMP-202 | Readiness per activity, freshness, materiality, gap blocking; repository identity binding | QAA-FR-003, QAA-FR-013, QAA-FR-014, QAA-FR-018, CON-022 | IMP-201 | Readiness fixtures for Modes A, B and D produce the expected per-activity results | todo |
| IMP-203 | Test plan builder with transparent risk model | QAA-FR-030, QAA-FR-038 | IMP-202 | Plan validates; risk inputs editable and audited | todo |
| IMP-204 | Test conditions and technique engine (EP, BVA, decision tables, state transitions, journeys, negative, error guessing, role matrix) | QAA-FR-031, QAA-FR-042, QAA-FR-048 | IMP-203 | F1 expected conditions covered; allowed and denied role cases generated | todo |
| IMP-205 | Scenario generator (LLM-assisted, schema-validated; works in deterministic-only mode with templates): basis, oracle, objective, traceability, language | QAA-FR-015, QAA-FR-032, QAA-FR-033, QAA-FR-033a, QAA-FR-036, QAA-FR-037, QAA-FR-041, QAA-FR-110, QAA-FR-111 | IMP-204, IMP-011 | Forbidden expectations count 0 on F1/F2 fixtures; CR-050–054 pass | todo |
| IMP-206 | Critic and validator: quality checklist, duplicates, contradictions surfaced, `needs_clarification` | QAA-FR-016, QAA-FR-034, QAA-FR-035 | IMP-205 | Duplicate and contradiction fixtures flagged | todo |
| IMP-207 | Review and approval: versions, immutability, full baseline binding, bulk approval preview, state-changing approval, execution-mode classification | QAA-FR-050, QAA-FR-051, QAA-FR-052, QAA-FR-053, QAA-FR-054, QAA-FR-055, QAA-FR-057 | IMP-206, IMP-009 | ST-08, ST-09 pass | todo |
| IMP-208 | Staleness propagation and one-action revalidation | QAA-FR-046, QAA-FR-047, CON-014 | IMP-207 | PRD §13.11 table holds on change fixtures | todo |
| IMP-209 | Targeted source verification from the local checkout at the package revision | QAA-FR-017 | IMP-202, IMP-101 | Revision mismatch yields `unconfirmed`; no process spawned from repository content | todo |
| IMP-210 | Coverage computation relative to the model | QAA-FR-044 | IMP-205 | Coverage report matches hand-computed values on F1 | todo |
| IMP-211 | Web UI: start wizard (Modes A–D, scoped declaration), readiness, system map and catalog, scenario review and approval; accessibility | SYS-002, SYS-004, NFR-009 | IMP-016, IMP-202, IMP-207 | E2E flows pass; automated a11y checks pass; keyboard-only review recorded | todo |
| IMP-212 | **Gate 2 acceptance run** | — | IMP-201–IMP-211 | Gate report archived | todo |

### Gate 3 — Manual QA

| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-301 | Manual runner (service + UI): steps, statuses, actual results, attachments, pause/resume/abandon, tester-reported labeling | QAA-FR-080, QAA-FR-081, QAA-FR-082, QAA-FR-083, QAA-FR-085, QAA-FR-086, QAA-FR-089 | IMP-207, IMP-211 | E2E manual run on F1 scenarios | todo |
| IMP-302 | Manual test packs: export (Markdown/JSON + result template), result import with declared environment | QAA-FR-112 | IMP-301 | Mode A and D packs exported with no environment; import round-trip test | todo |
| IMP-303 | Defects: creation from failed steps, lifecycle, severity and priority | QAA-FR-084, QAA-FR-088 | IMP-301 | CR-070 transition tests pass | todo |
| IMP-304 | Reports and exports (JSON, Markdown; `en`/`id`): counts, links, limitations, evidence profile, QA objectives | QAA-FR-090, QAA-FR-091, QAA-FR-092, QAA-FR-093, SYS-004 | IMP-301, IMP-303, IMP-012 | Report fixtures validate; counts reconcile with stored records | todo |
| IMP-305 | **Gate 3 acceptance run** | — | IMP-301–IMP-304 | Gate report archived | todo |

### Gate 4 — URL → observed model → QA scenarios (+ Mode C)

| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-401 | Scope-enforcing local proxy: IP-pinned connect checks, private-range blocking, local owner mode, redirects, rate limits, audit (ADR-007) | SEC-007, SEC-008, SEC-020, SEC-025 | IMP-006, IMP-009, IMP-015, SP-5 | ST-05, ST-06 pass on all OSs | todo |
| IMP-402 | Native L2 worker launcher: per-job process, fresh context and profile, proxy-only egress, reachability validation without side effects | SEC-012, QAA-FR-006 | IMP-401, IMP-008 | ST-11 (L2 part) passes | todo |
| IMP-403 | Form classifier and form-interaction policy with per-form user confirmation (OD-29); upload/download control | SEC-019, SEC-024, QAA-FR-025 | IMP-402 | ST-07 passes | todo |
| IMP-404 | Discovery crawler: pages, navigation, forms, SPA routes, trap control, credential-profile login, production refusal, injection-safe | QAA-FR-021, QAA-FR-022, QAA-FR-023, QAA-FR-024, QAA-FR-026, SEC-003, SEC-009 | IMP-403, IMP-010 | F2 page and form recall reported; ST-03 (web part) passes | todo |
| IMP-405 | Observed-model builder: entities, observed workflow catalog, statuses, completeness report, CR-002 compliance | QAA-FR-114, CON-023 | IMP-404 | Over-claiming count 0 on F2; uncertainty-reporting accuracy reported | todo |
| IMP-406 | QAA package publication (producer `QAA`), same validator | QAA-FR-116 | IMP-405, IMP-117 | F2 package passes conformance; usable as a Mode D import | todo |
| IMP-407 | Source–runtime correlation and correlation report with revision correspondence | QAA-FR-115 | IMP-406, IMP-117 | All F3 deliberate discrepancies detected | todo |
| IMP-408 | Targeted runtime verification of specific package items | QAA-FR-029 | IMP-402 | Budget exhaustion yields a partial verification record | todo |
| IMP-409 | **Gate 4 acceptance run** | — | IMP-401–IMP-408 | Gate report archived; L2 security gate passed (PRD §27.4) | todo |

### Gate 5 — Controlled automation

| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-501 | L3 container workers: image, lifecycle, network restricted to the proxy, no host mounts, credential injection, kill on cancel; `doctor` detection | SEC-010, SEC-012 | SP-3, IMP-401 | ST-19 passes on Linux, macOS (Docker Desktop or compatible) and Windows (WSL2) | todo |
| IMP-502 | Executor in `test-runner`: constrained actions and assertions → Playwright; assertion records; bounded retries only for idempotent steps | QAA-FR-060, QAA-FR-061, QAA-FR-062, QAA-FR-063, QAA-FR-067 | IMP-501, IMP-207 | ST-10 passes; each action and assertion has a fixture test | todo |
| IMP-503 | Evidence capture: screenshots, traces, console and network errors with redaction; retention integration | QAA-FR-064 | IMP-502, IMP-019 | Failed cases always carry a screenshot and trace; secrets redacted (ST-04) | todo |
| IMP-504 | Failure classification (categories of PRD §17.5), reviewable product/test-defect suggestion | QAA-FR-065 | IMP-502 | Each category produced by a fixture | todo |
| IMP-505 | Cancellation, timeouts, test data from fixtures, cleanup recording, credential masking | QAA-FR-066, QAA-FR-068, QAA-FR-071 | IMP-502 | Cancel stops actions and runs cleanup; cleanup outcome recorded | todo |
| IMP-506 | Locale-safe locators and translation-semantics approval renewal | LOC-007, LOC-010 | IMP-502, IMP-012 | Locale-mismatch fixture yields `unsupported_step`; translation does not change approval | todo |
| IMP-507 | **Gate 5 acceptance run** | — | IMP-501–IMP-506 | Gate report archived; L3 security gate passed | todo |

### Release candidate

| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-901 | Packaging: npm package(s), Playwright browser install, prebuilt SQLite binaries, clean-machine install tests on three OSs, SBOM, published OS support matrix per capability | NFR-007, OSS-010, SEC-022 | IMP-507 | Clean-VM installs pass for every claimed capability | todo |
| IMP-902 | Interface parity completion across CLI, web UI (API), MCP and Skill | SYS-005 | IMP-507 | PT suite covers every application service | todo |
| IMP-903 | User documentation: user guide, CLI/MCP/Skill reference, compatibility matrix, known limitations, examples (sample package and QAA export) | OSS-003, OSS-006 | IMP-507 | Docs reviewed against the tested product | todo |
| IMP-904 | Full security review and complete ST suite on all OSs | — (Threat Model) | IMP-507 | No open critical or major security finding | todo |
| IMP-905 | End-to-end on F1–F4 for all modes, including no-environment paths; benchmark write-up | SYS-003 | IMP-507 | RC criteria in Test Strategy §9 met | todo |
| IMP-906 | Repository standards: LICENSE (done), NOTICE if needed, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, `.env.example` | OSS-002, OSS-003 | — | Files present and reviewed | todo |

## 5. After the first public release (P1/P2)

Planned as follow-up milestones (PRD §27.5). Tasks are written when the milestone starts:
- **SAA:** SAA-FR-021–025, SAA-FR-037, SAA-FR-038; SAA-FR-026–028 (P2).
- **Contract:** CON-015, CON-016.
- **QAA:** QAA-FR-007, 008, 019, 020, 027, 028, 039, 040, 043, 045, 056, 069, 070, 087, 094–096, 104, 113; QAA-FR-097 (P2).
- **Other:** LOC-005, SEC-013, SEC-023 (partly covered by IMP-503), OSS-008.

## 6. Progress notes

| Date | Task | Note |
|---|---|---|
| 2026-10-22 | IMP-001 | Scaffold in place: pnpm workspace, 13 packages per Architecture §4, strict TS, ESLint, Prettier, Vitest, docs link check, CI workflow (static checks + tests on Linux/macOS/Windows × Node 22/24). `pnpm verify` is green locally on Linux. **Done 2026-10-22:** CI run #1 (commit `f732bf9`) green on all 7 jobs — static checks on Linux and tests on Linux, macOS and Windows with Node 22 and 24. **Deviations:** (1) `engines.node` is `>=22.12.0` and CI tests 22 and 24, rather than pinning the Active LTS only (ADR-002); this widens support at no cost and matches the development environment. (2) Playwright Test is deferred to the first browser-level test (IMP-211/IMP-404) instead of being installed empty now. (3) TypeScript is pinned to `~6.0.3` because typescript-eslint supports `<6.1`; TypeScript 7 is re-evaluated when tooling supports it. |
| 2026-10-22 | IMP-003 | 18 schemas v1.0.0 in `schemas/` (strict Ajv compile), generated types in `packages/contract/src/generated/types.ts` with `pnpm schemas:check` in CI, 14 canonical valid examples aligned from the PRD, 32 tests including negative tests for every schema-level rule. **Done 2026-10-22:** green in CI run #1 (`f732bf9`) on all three OSs. Schemas still without a valid example (`diff-report`, `analysis-response`, `test-plan`, `manual-test-pack`) are tracked by a test and closed in IMP-005. |
| 2026-10-22 | IMP-002 | dependency-cruiser 18.7 with the rules of Architecture §4.1 in `scripts/dependency-rules.mjs` (`pnpm deps:check`, in `verify` and CI stage 1). A fixture tree with one violation per rule is checked by `tests/architecture/dependency-rules.test.ts`; adding `import "node:net"` to `qaa-core` locally made `deps:check` exit 1. Root `tests/` is now part of the Vitest run and the type-check. **Done 2026-10-22:** CI run #5 (`7c4ad43`) green on all 7 jobs. |
| 2026-10-22 | IMP-007 | `@sys2qa/platform` storage: `better-sqlite3` 13 (ADR-004; pnpm `onlyBuiltDependencies`), `openStateDatabase` (integrity check before migrations, WAL, `synchronous = FULL`, foreign keys, `BEGIN IMMEDIATE` transactions), forward-only checksummed migrations, `0001_initial_state.sql` with every table of Data Model §4 (STRICT, enumeration CHECKs, append-only triggers, immutable approved scenario versions), versioned rebuildable index schema with FTS5, and `host.lock` for the single writer. Decisions recorded in Data Model §4, §6, §7, §9 and §10: job states, the `project_deletions` tombstone (a marker column cannot authorize a cascade, because SQLite no longer shows the parent row to child triggers), and integrity check before migrations. 17 tests including crash recovery (SIGKILL during an open transaction) and a damaged file. CI run #6 failed on Windows: allowing the package's build script made pnpm compile it, and node-gyp could not find the runner's Visual Studio. The bundled prebuilt binaries make the build unnecessary, so it is now ignored (ADR-004). **Done 2026-10-22:** CI run #7 (`fcab17b`) green on all 7 jobs. |
| 2026-10-22 | IMP-017 | `scripts/traceability.mjs`: parses PRD requirement tables (240 requirements, 204 P0), contract rules CR-xxx and gate ownership from this plan, scans `[@req …]` tags, and reads Vitest JSON results. `pnpm trace` writes `reports/traceability.md` (CI artifact `traceability` from the Ubuntu/Node 24 cell). `pnpm trace:check` fails on unknown tags (verified with a temporary `[@req XYZ-999]` test). A test checks that every P0 requirement is owned by a task. The pseudo-tag `[@req CR-rules]` was removed. Today: 47 of 204 P0 requirements have a passing tagged test. **Done 2026-10-22:** CI run #7 (`fcab17b`) green on all 7 jobs. |
| 2026-10-22 | IMP-009 | `@sys2qa/platform`: `Redactor` (sensitive field names, the contract's secret detectors via the new `redactSecrets`, and exact values registered by the secret store), `appendAudit` (refuses to run outside a transaction; one hash chain per project plus one installation-wide, so deleting a project leaves the other chains verifiable), `verifyAuditChain`, `exportAudit`, and a JSON-lines logger with daily files. Contract: `bearer_token` detector and `redactSecrets`, which masks a private key through its END marker. ST-04 (logging part): seven planted secrets never appear in log lines or audit exports. ST-16: an edited or removed row fails verification even with the triggers dropped. **Done 2026-10-22:** CI run #8 (`7a3ad90`) green on all 7 jobs. |
| 2026-10-22 | IMP-008 | `@sys2qa/platform` jobs: `JobStore` (leases, idempotency keys rejecting reuse for a different request, transitions validated in code, lease ownership checks, transient-only retries with backoff, recovery after host restart, stuck-job detection) and `JobOrchestrator` (global and per-type concurrency, lease renewal, duration and counted budgets, `--max-old-space-size` for workers, cooperative cancel then kill, worker IPC protocol, allowlisted worker environment). Migration 0002 adds `run_after` and `last_progress_at`, with a test that upgrades a version-1 database holding a queued job. ULID generator for operational IDs. 20 tests, including a worker that ignores cancel being killed within the grace period; run five times without a flake. CI run #9 failed once on Windows/Node 22: a worker's result was lost because the job was settled on the child's `exit` event, which can precede delivery of its last IPC message. Jobs now settle on `close`, and workers disconnect after their final message. **Done 2026-10-22:** CI run #10 (`6e92704`) green on all 7 jobs. |
| 2026-10-22 | IMP-006 | `@sys2qa/platform` policy: pure `decide()` covering L0–L5. A declaration is required. Its level is a ceiling, capped by the scope policy. L4 needs the administrator switch. L5 and production are refused (`PRODUCTION_REFUSED`). State-changing tests must be declared. Prohibited paths, URLs and operations are refused. Paths must be lexically inside the declared roots. URLs must match the allowed hosts, ports and segment-bounded path prefixes; schemes are limited and credentials in URLs are refused. Metadata addresses are always refused, and loopback or private hosts need local owner mode on both the environment and the installation. `ProjectService`: project CRUD; evidence sources with derived starting mode A–D; append-only declarations constrained by source kind; environment configuration that requires a declaration and rejects an out-of-scope base URL; scope policies versioned only on change; audited settings; and project deletion of state rows. Every decision is logged as `policy.decision`. Migration 0003 adds `environments.scope_json`. The hostname check runs at decision time; resolved-address checks belong to the proxy (IMP-401). 58 tests. **Done 2026-10-22:** CI run #10 (`6e92704`) green on all 7 jobs. |
| 2026-10-22 | IMP-012 | Versioned glossaries `glossary.en.json` and `glossary.id.json` (1.0.0, 255 terms each) covering every controlled enumeration of the contract, plus readiness activities and job states; a test fails if any term is missing. `GlossaryRegistry` loads any `glossary.<locale>.json` (a new locale needs no code or schema change, tested with a temporary `ms` file) and renders codes with an explicit fallback marker. Unknown codes are shown verbatim. `resolveLanguage` resolves each §19.1 dimension (override → project → user → `en`, manual instructions following the scenario language, several documentation languages, unsupported values reported). `selectText` implements §19.4. `checkTranslationInvariants` checks protected tokens (code spans, quoted literals, IDs, URLs, paths, enum codes), numbers and negation counts. The Indonesian terms are a first version for the LOC-002 human review. **Done 2026-10-22:** CI run #11 (`e6b10a6`) green on all 7 jobs. |
| 2026-10-22 | IMP-011 | `@sys2qa/platform` LLM port. `LlmService` puts untrusted data in `<untrusted_data>` blocks that cannot be closed from inside, redacts secrets, and drops excluded files: defaults (`.env*`, keys, `secrets/`) plus configuration. It validates every output against its JSON Schema through the new contract function `validateJsonSchema`, so Ajv stays in the contract. It normalizes errors (`LLM_UNAVAILABLE`, `LLM_TIMEOUT`, `LLM_CANCELLED`, `LLM_RATE_LIMITED`, `LLM_PROVIDER_ERROR`, `LLM_REQUEST_REJECTED`, `LLM_OUTPUT_INVALID`, `LLM_REPLAY_MISSING`) and records usage per project, job and agent without prompt content (migration 0004). It produces an en/id disclosure. Backends: `none` (deterministic-only), `openai_compatible` (consent required for non-loopback endpoints; API key from a secret reference, never in the prompt), and record/replay with a committed cassette (`fixtures/llm/`). The OSS-009 "two providers" acceptance needs live provider runs and remains open. 14 tests. **Done 2026-10-22:** CI run #12 (`92a3651`) green on all 7 jobs. The disclosure is produced by `LlmService.disclosure()`; printing it in the configuration output moved to IMP-020's acceptance, because no configuration surface exists yet. |
| 2026-10-22 | IMP-015 | Security harness in `tests/security/harness/`, with fixtures in `fixtures/security/`: planted fake secrets (token-shaped values stored in parts) and a leak scanner over raw and encoded forms; a 9-entry injection corpus planted in a fixture repository (including install scripts that would leave sentinels) and a page with hidden text, plus policy-state snapshot and diff; an SSRF fixture server (redirects to internal, metadata, private, link-local, IPv6 loopback and off-scope targets, redirect chains, WebSocket upgrade) and a DNS-rebinding lookup; a malicious adapter stub (socket, write outside scratch, spawn, memory) with a connection trap and sentinel finder; and a ZIP writer and reader with zip-slip, absolute-path, drive-letter, symlink, oversized and entry-flood archives. Every detector is proven against a bad stub. Real checks run against the corpus: the redacting logger, the LLM prompt builder (no policy change; the data block cannot be closed) and the URL policy. Finding fixed in the contract: `DB_PASSWORD=…` and `AWS_SECRET_ACCESS_KEY=…` escaped the credential detector. **Done 2026-10-22:** CI run #13 (`aacfb47`) green on all 7 jobs. |
| 2026-10-22 | IMP-016 | `@sys2qa/app-services`: operation catalog (system info, project create/list/get, add evidence, declare, configure environment, policy check, package validation), `AppServices.execute` with JSON-Schema input validation, error mapping (`{code, kind, message, remediation, retryable}`), `service.call` logging and L4 hiding. Host composition root; hardened Fastify loopback API; API client; `host.json` endpoint for IPC. `apps/cli`: `util.parseArgs` commands that each map to one operation, `--json`, stable exit codes, use of a running host's API, and `pnpm sys2qa` for development. `apps/mcp`: low-level MCP `Server` exposing the catalog as tools with level and effect metadata, plus a stdio entry. Parity harness (`tests/parity/`): an 18-step onboarding script with refusals and errors gives identical results through CLI, HTTP API and MCP, and the CLI exit codes match the error kinds. ST-12: missing or wrong token, foreign Origin, DNS-rebound Host and non-JSON bodies are rejected. **Done 2026-10-22:** CI run #14 (`ce2f3b4`) green on all 7 jobs. |
| 2026-10-22 | IMP-018 | `@sys2qa/platform` observability:
- `collectMetrics` from persisted state: queue depth per type, running jobs, jobs by state, failures by code, cancellations, worker crashes, stuck jobs, attempt-duration percentiles from job events, model usage, process memory and CPU, and `state.db` size. Evidence volume, cache hit rate, adapter failure rate and browser duration are reported as not collected until their producers exist.
- `renderPrometheus` and `checkHealth`: integrity, migrations, audit chain, stuck jobs, disk space; the worst check wins.
- Telemetry setting off by default, with an allowlisted payload of counts and versions and no transport shipped.

Exposed as `system.metrics`, `system.health` and `system.set_setting` (audited), as `GET /api/v1/metrics` and `GET /api/v1/health` (token required), and as `sys2qa metrics|health|settings set`. Tests:
- the metrics fixture;
- health ok, then degraded, then failing;
- the default configuration sends nothing;
- the payload contains no project names, paths or IDs.

**Done 2026-10-22:** CI run #15 (`1daea27`) green on all 7 jobs. |
| 2026-10-22 | IMP-020 | `loadConfig`: defaults → `<home>/config.json` → `SYS2QA_*` → overrides; schema-validated with the source of each setting; refuses a config file containing a secret. The host now takes its LLM backend, log level and LLM exclusions from the configuration. Doctor checks:
- Node ≥ 22.12, and the SQLite driver with ≥ 3.37 and FTS5;
- a writable home, disk space and Git;
- configuration validity and the model provider disclosure, including the remote-without-consent failure;
- in `runtime-observer`, the browser runtime (optional probe; Playwright is not a dependency yet) and the container runtime.

`system.config` and `system.doctor` operations; `sys2qa config show` and `sys2qa doctor` (runs without a host; exit 6 on failure; human report with `next:` lines). **Done 2026-10-22:** CI run #16 (`ae66b95`) green on all 7 jobs. |
| 2026-10-25 | SP-2, IMP-010 | SP-2 result in ADR-011: `@napi-rs/keyring` (MIT, prebuilt for every target OS and architecture; `keytar` is archived), with the Linux store pinned to Secret Service because the kernel keyring does not survive a reboot. A probe in a headless container failed fast, so a fallback is needed: `<home>/secrets.enc`, AES-256-GCM per entry with the reference as AAD and a scrypt key from `SYS2QA_SECRETS_PASSPHRASE`. Without either backend, secret operations fail with `SECRET_STORE_UNAVAILABLE`; nothing is ever stored unencrypted. `SecretService`: `secretref:<project>.<name>`, migration 0005 `secret_refs` (owners only, no values), audited `credential.configured`, `credential.removed` and `credential.used`, `injectForJob`, which refuses references of other projects and registers values for exact-match redaction, and `removeAllForProject` for IMP-019. Operations `secret.put`, `secret.list` and `secret.remove`; `secret.put` is refused through MCP, so values never pass through a model's context, and the CLI reads the value from stdin. Tests cover the file round trip (0600), wrong passphrase, tampering, an entry moved to another reference, backend selection, no value in `state.db`/WAL, logs or audit, and cross-project refusal. Not yet wired: the LLM API key reference (resolution is asynchronous) and worker delivery of injected values (IMP-401/501). Done when CI is green. |
| 2026-10-22 | IMP-004 | `packages/contract/src/validation/`: error catalog for every code (en/id title and remediation, `toErrorObject`), staged `validatePackage` in PRD §13.10 order (stops after the first stage with errors), CR-001…CR-070 (`validateScenario`, `checkExecutionAllowed`, `checkDefectTransition`), secret detectors that never echo values, revision keys, oracle derivation. Schema-enforced rules carry their rule ID. Codes that need runtime state are assigned to their components in Contract Specification §9. Unreleased schema amendment: `gap.coverage_category` (for CR-030). **Done 2026-10-22:** CI run #3 (`8486270`) green on all 7 jobs. |
| 2026-10-22 | IMP-005 | Two complete valid packages (`mode-a-saa`, `mode-b-qaa`) plus single-document examples now cover all 18 schemas. 43 generated invalid cases under `fixtures/contract/invalid/` (`pnpm fixtures`, checked in CI by `pnpm fixtures:check`). Conformance tests require every contract-detected code and every CR rule to have a case with exactly its expected code. The runner SAA and QAA CI use is `validatePackage` from `@sys2qa/contract` plus this suite; a CLI wrapper arrives with the CLI shell (IMP-016). 151 tests; `pnpm verify` green locally. **Done 2026-10-22:** CI run #3 (`8486270`) green on all 7 jobs. |

## 7. Risks to the plan

| Risk | Signal | Response |
|---|---|---|
| Gate 1 takes much longer than expected (adapter depth) | IMP-106–IMP-111 slip | Narrow the `js-ts` framework set (SP-4), never the honesty rules |
| Two producers drift semantically | Conformance failures between SAA and QAA outputs | Stop feature work until the `contract` fix lands (CON-027) |
| Container prerequisite blocks testers on macOS or Windows | IMP-501 install failures | Keep L3 optional at runtime; document per-OS steps; `doctor` guidance |
| LLM variability breaks CI | Replay mismatches | Record/replay discipline; structural assertions only (Test Strategy §3) |
| Scope creep from P1 items | P1 tasks enter gate milestones | P1 work is not merged into gate milestones without a PRD change |
