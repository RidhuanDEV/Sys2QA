# Sys2QA — Software Architecture

| Field | Value |
|---|---|
| Status | Baseline 1.0 (matches PRD 1.0.0) |
| Last updated | 2026-10-22 |
| Source of truth for | Current architecture, module boundaries, dependency rules, process model, data flows |
| Not the source of truth for | Requirements (PRD), decision rationale (ADRs), field-level contract (Contract Specification), persistence details (Data Model) |

This document describes **how Sys2QA is built**. Requirement IDs refer to `docs/PRD.md`, `ADR-nnn` to `adr/`, and `IMP-nnn` to the Implementation Plan.

---

## 1. Architectural drivers

| Driver | Source | Architectural consequence |
|---|---|---|
| Start from whatever evidence exists (repo, URL, both, package) | MD-4, SYS-001 | Mode-neutral project model; two package producers; one contract |
| Discover, don't ask | MD-5, SAA-FR-040, QAA-FR-114 | Discovery pipelines produce catalogs; "trace" only deepens IDs |
| Not a DevOps agent; local-first | MD-6, OD-01 | Single local host process; embedded storage; no servers |
| Evidence honesty | PRD §9.8 rule 5, CON-023 | Facts from deterministic extractors; claim/evidence validation in the contract library |
| Untrusted inputs everywhere | SEC-001–003 | Sandboxed workers; policy in code; egress proxy |
| One contract, two producers | OD-24, CON-025, CON-027 | `contract` package is the only definition of shapes and semantics |
| Interface parity | SYS-005 | All interfaces are thin adapters over application services |
| Reproducibility | NFR-003, CON-006 | Revision/observation identity on every artifact; deterministic IDs |

## 2. System context

```text
                    +-----------------------------------------------------------+
                    |                      Developer / tester                    |
                    +-----+-----------------+-----------------+-----------------+--+
                          | CLI             | browser         | AI agent (MCP/Skill)
                          v                 v                 v
+----------------+   +---------------------------------------------------------------+
| Local source   |-->|                    Sys2QA (local host)                         |
| directory      |   |  reads only inside approved roots; never clones or fetches     |
+----------------+   |                                                               |
+----------------+   |  observes/tests only within declared scope via local proxy    |---> Authorized dev/staging
| Imported       |-->|                                                               |     application (target)
| package        |   |  optional LLM calls through one adapter                       |---> LLM provider or local
+----------------+   |  container runtime used only for L3 automated execution       |     model endpoint (optional)
                     +---------------------------------------------------------------+
                                           |                        |
                                           v                        v
                               Output directory (packages,   Docker-compatible runtime
                               docs, reports, exports)        (only for L3, OD-16)
```

External systems Sys2QA **does not** touch: Git hosting APIs (no clone/fetch, SEC-017), production environments (SEC-009), deployment or infrastructure tooling (X-22).

## 3. Containers (process model)

Here "container" uses the C4 meaning: a separately running unit. It is not necessarily an OS container.

| Unit | Runs as | Responsibilities | Trust level |
|---|---|---|---|
| **Host** | One Node.js process started by the CLI, the web UI launcher or the MCP server | Application services, domain modules, job orchestrator, policy, SQLite, audit, LLM adapter, local HTTP API (loopback) and web UI assets, scope-enforcing proxy | Trusted |
| **Adapter workers** | Child processes, one per adapter invocation (ADR-009) | Parse source files from the sandboxed root; return facts and evidence | Untrusted input; restricted |
| **Discovery/verification browser workers (L2)** | Child processes running native Playwright (ADR-005, OD-30) | Navigate and observe within scope through the proxy | Untrusted content; restricted |
| **Automation workers (L3)** | Disposable Linux containers (ADR-005, OD-16) | Execute approved scenario versions through the proxy | Untrusted content; strongly isolated |
| **Web UI** | Browser tab pointing to the loopback API | Presentation only | Untrusted client (validated by the API like any other) |
| **MCP server** | stdio entry point that embeds or connects to the host | Expose application services as MCP tools | Interface adapter |

A single host process per user session owns the SQLite database (one writer). A second CLI invocation while the host is running connects to it through a local IPC socket instead of opening the database (IMP-016).

## 4. Module structure (monorepo)

```text
apps/
  cli/            CLI commands → application services (no domain logic)
  web/            React SPA → loopback HTTP API
  mcp/            MCP server → application services
packages/
  contract/       JSON Schemas → generated types, Ajv validators, semantic rules CR-xxx (ADR-003)
  platform/       config, project & declarations, scope policy, secrets, audit, jobs, LLM port, i18n/glossary
  evidence/       evidence records, provenance helpers, redaction (uses contract)
  system-model/   in-memory model ops: graph queries, diff, ID derivation (uses contract)
  saa-core/       intake, revision identity, boundaries, entry points, tracer, workflow composer,
                  rules/roles/states, cross-validation, completeness, docs renderer, package exporter
  saa-adapters/   adapter host + protocol (ADR-009); adapters: js-ts, sql, config-deploy
  qaa-core/       import/readiness, planning, techniques, scenario generation/critic, review/approval,
                  staleness, coverage, manual runs, defects, reporting, correlation
  runtime-observer/ scope-enforcing proxy, worker launcher (native L2, container L3), discovery crawler,
                  form classifier, observed-model builder
  test-runner/    constrained action/assertion executor inside L3 containers
  app-services/   use-case layer shared by every interface (SYS-005)
skills/
  sys2qa-analyst/ Skill package (Claude Code primary conformance target, OD-19)
schemas/          canonical JSON Schemas (source of truth for structure, ADR-003)
fixtures/         contract fixtures (valid/invalid) and benchmark fixtures (OD-20)
tests/            cross-package integration, parity, security, end-to-end, benchmark harness
```

### 4.1 Dependency rules (enforced by dependency-cruiser, IMP-002)

```text
apps/*            → app-services, contract (types only)
app-services      → saa-core, qaa-core, runtime-observer, platform, contract
saa-core          → saa-adapters (host API only), system-model, evidence, platform (ports), contract
qaa-core          → system-model, evidence, platform (ports), contract
runtime-observer  → evidence, platform (ports), contract
saa-adapters      → contract
test-runner       → contract (runs inside the container; no other imports)
system-model, evidence → contract
platform          → contract
contract          → (nothing internal)
```

Forbidden, among others:
- `saa-core ↔ qaa-core` (they communicate only through packages and the contract);
- any `apps/*` → domain modules directly;
- any module other than `runtime-observer` → Playwright, sockets or HTTP clients toward targets (SEC-025);
- any module other than `platform` → LLM SDKs;
- any module other than `contract` declaring contract types or validators (CON-027).

Enforcement (IMP-002): `scripts/dependency-rules.mjs`, run by `pnpm deps:check` in CI stage 1 and proven by `tests/architecture/dependency-rules.test.ts` against the fixture tree `fixtures/dependency-rules/`. The rules as implemented:

| Rule | Meaning |
|---|---|
| `<module>-allowed-modules` | One rule per package, generated from the table above |
| `apps-only-app-services`, `apps-contract-types-only`, `apps-independent` | Apps import only `app-services`, and `contract` with `import type`; apps never import each other |
| `public-entry-only` | Another module is imported only through its public entry `src/index.ts` (what `@sys2qa/<name>` resolves to). "Host API only" and "ports only" above are therefore decided by what `saa-adapters` and `platform` export from their entry points |
| `network-only-in-runtime-observer` | `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns` and HTTP/WebSocket client packages. A loopback HTTP server uses Fastify, which is not affected |
| `browser-only-in-runtime-observer-and-test-runner` | Playwright. `test-runner` is included because it drives the browser inside L3 containers |
| `llm-sdk-only-in-platform` | Known LLM SDK packages |
| `contract-validation-only-in-contract` | `ajv`, `ajv-formats`, `json-schema-to-typescript` |
| `no-process-spawn-in-analysis` | `child_process` and `cluster` in the sources of `saa-core`, `system-model`, `evidence`, `qaa-core` and `contract` (tests may spawn): analysis never starts a process (SEC-002). Processes are started only by `platform` (job workers, doctor probes), `saa-adapters` (adapter host), `runtime-observer` and `test-runner` |
| `no-circular`, `not-to-unresolvable` | No import cycles; every import resolves |

### 4.2 Ports and adapters inside the host

`platform` defines ports for storage (operational state and index), artifact store (filesystem), secret store, LLM, clock, ID generation, and the job queue. Domain modules depend on ports only, so a T2 server topology replaces adapters, not domain logic (ADR-001).

## 5. Key components

| Component | Module | Responsibility | Key requirements |
|---|---|---|---|
| Project & declaration service | platform | Projects, evidence sources, scoped authorization declarations, scope policies (versioned) | SYS-001, SEC-005 |
| Policy engine | platform | Decides permission level per operation (L0–L4), local owner mode, production refusal; pure code | §9.5, SEC-006, SEC-008, SEC-009 |
| Job orchestrator | platform | Persistent queue, states, timeouts, cancellation, retries, worker supervision | QAA-FR-066, QAA-FR-102, NFR-004 |
| Audit & logging | platform | Append-only audit; structured logs with redaction | SEC-004, SEC-014, OBS-002 |
| Secret store | platform | Secret references; OS credential store backend, with an encrypted-file fallback | SEC-011 |
| LLM port | platform | ADR-008 | OD-07, OSS-009 |
| i18n & glossary | platform | Locale resolution, versioned glossary | LOC-* |
| Contract library | contract | Schemas, types, validators, semantic rules, error codes | CON-* |
| Source intake | saa-core | Root sandbox, ignore rules, streaming inventory and budgets, secret detection, revision identity (in-process Git reading, ADR-012) | SAA-FR-001, SEC-001, CON-006 |
| Adapter host | saa-adapters | Launch, protocol, budgets, output validation | ADR-009 |
| Tracer & composer | saa-core | Entry points → component traces → workflows → catalog with statuses | SAA-FR-040, 041, 046 |
| Synthesis | saa-core | Rules, roles, states, contradictions, completeness, docs, package export | SAA-FR-010–013, 029–036, 045 |
| Package import & readiness | qaa-core | Validate, store original, normalize, freshness, readiness per activity | QAA-FR-009–018, CON-022 |
| QA design | qaa-core | Plan, conditions, techniques, scenarios (basis, oracle, objective), critic | QAA-FR-030–048, 110, 111 |
| Review & approval | qaa-core | Versions, baseline binding, state-changing approval, revalidation | QAA-FR-050–057, 046, 047 |
| Manual testing & defects | qaa-core | Runs, packs, results import, defect lifecycle | QAA-FR-080–089, 112 |
| Reporting | qaa-core | Reports and exports (JSON/Markdown; HTML/CSV in P1) | QAA-FR-090–096 |
| Correlation | qaa-core | Mode C correlation report | QAA-FR-115, CON-026 |
| Scope-enforcing proxy | runtime-observer | ADR-007 | SEC-007, SEC-008, SEC-020, SEC-025 |
| Worker launcher | runtime-observer | Native L2 workers; L3 containers | ADR-005 |
| Discovery crawler | runtime-observer | Pages, navigation, forms, SPA routes, trap control, form-interaction policy | QAA-FR-021–029, 114, SEC-024 |
| Observed-model builder | runtime-observer | Observations → observed model, catalog, completeness → QAA package | QAA-FR-114, 116 |
| Executor | test-runner | Constrained actions and assertions; evidence capture; failure categories | QAA-FR-060–071 |

## 6. Data flows by starting mode

### 6.1 Mode A — Repository

```text
CLI/UI ─ start(repo path) ─► app-services ─► platform: declaration + scope (L0–L1)
   └► job: saa.analyze
        source intake ─► adapter workers (js-ts, sql, config) ─► facts+evidence (validated)
        ─► tracer/composer ─► rules/roles/states ─► cross-validation ─► completeness
        ─► SKB (JSON partitions) + index (SQLite) ─► docs (en/id) ─► package export (validated)
   └► job: qaa.import(package) ─► readiness per activity ─► plan ─► scenarios ─► review
```

### 6.2 Mode B — URL

```text
start(url) ─► declaration + scope policy (hosts, paths, L2, read-only submissions?)
   └► job: qaa.discover
        runtime-observer: proxy up (per-job credential) ─► L2 worker (native Playwright)
        ─► crawl under form-interaction policy ─► observations (runtime_observation evidence)
        ─► observed model + catalog + completeness ─► QAA package (producer QAA, validated)
   └► job: qaa.import(package) ─► same QA path as Mode A (characterization/exploratory focus)
```

### 6.3 Mode C — Repository + URL

Runs 6.1 and 6.2 (in either order), then `qaa.correlate(saaPkg, qaaPkg)`, which produces a correlation report (CON-026) with revision correspondence. QA design reads both packages through the correlation report.

### 6.4 Mode D — Package

`qaa.import(package)` only; no repository or environment needed.

### 6.5 Automated execution (L3)

```text
run(suite, environment) ─► app-services: policy (L3) + approval/baseline checks (QAA-FR-054)
   └► job: qaa.execute ─► runtime-observer: proxy + L3 container (per job)
        ─► test-runner executes approved scenario versions ─► step results + evidence
        ─► cleanup ─► host validates results (contract) ─► results stored ─► report
```

Checks happen at enqueue time **and** inside the worker before the first action (PRD §17.1).

## 7. Cross-cutting concerns

| Concern | Approach |
|---|---|
| Validation | Every artifact crossing a boundary (adapter → host, worker → host, import, export) is validated by `contract` |
| Identity | Semantic IDs per contract rules; ULIDs for operational records (Data Model §3) |
| Atomicity | Artifacts: temp file + fsync + rename. State: SQLite transactions. A package is visible only once complete |
| Cancellation | Cooperative cancel → grace period → SIGKILL or container kill; cleanup job always scheduled. Worker processes receive only an allowlisted environment (`PATH`, temp directories, locale), never the host's credentials; secrets reach a job only through per-job injection (IMP-010) |
| Budgets | Per-job time, memory, file count, page count and token budgets enforced by the orchestrator and workers |
| Localization | Enum codes stored; text rendered through the versioned glossary (`packages/platform/i18n/glossary.<locale>.json`, referenced on exports as `<locale>@<version>`; a new locale is a new file); artifacts carry language tags; language resolved per dimension (override → project → user → `en`); a missing language is shown with a `fallback_language` marker; every machine translation passes the invariant check (protected tokens, numbers, negations) before it is stored (LOC-006) |
| Observability | Structured JSON logs (redacted); audit table; metrics computed from persisted state (`system.metrics`, `sys2qa metrics [--prometheus]`, `GET /api/v1/metrics` in Prometheus text format; producers that do not exist yet are reported as not collected); health checks (`system.health`: state integrity, schema version, audit chain, stuck jobs, disk space; HTTP 503 when failing); anonymous aggregate telemetry off by default, opt-in via an audited setting, with an allowlisted payload and no bundled transport (OBS-001–006) |
| Errors | One error catalog (code, severity, context, remediation) in `contract`, used by all interfaces |
| Configuration | Layered: defaults → `<home>/config.json` → `SYS2QA_*` environment variables → command-line overrides, each validated against `CONFIG_SCHEMA`; `sys2qa config show` prints the effective values, the source of each, and the model provider disclosure. Project-level settings (languages, environments, scope) live in the state database, never in a file inside the analyzed repository. Secrets only as `secretref:` references; a config file that contains a secret is refused (`CONFIG_SECRET_SUSPECTED`). `sys2qa doctor` checks Node.js, the SQLite driver, the home directory, disk space, Git, the configuration, the model provider, the browser runtime and the container runtime; it runs without a host and exits 6 when a check fails |

## 8. Interfaces

- **CLI:** commands per PRD §23.4; every command maps to one application service call; `--json` returns the same DTOs as the HTTP API.
- **Local HTTP API:** Fastify on loopback with a random port and a per-session token; used by the web UI only; CORS locked to the served origin.
- **Web UI:** React SPA; no domain logic; all decisions come from the API.
- **MCP:** tools mirror application services with narrow typed inputs; side-effect level declared per tool; L3 tools require an approval ID created through the review workflow.
- **Skill:** instructions that call the CLI/MCP; it declares its expected capability version (SAA-FR-016).

Parity is verified by running the same scripted scenarios through CLI, HTTP API and MCP and comparing decisions, states and error codes (SYS-005, IMP-902).

Implementation (IMP-016):
- **Application services** (`@sys2qa/app-services`): an operation catalog (name, permission level, read/write effect, JSON Schema input). Every interface calls `AppServices.execute(name, input, caller)`, which validates the input, runs the operation, logs `service.call`, and returns `{ok, data}` or `{ok: false, error}`. The error is `{code, kind, message, remediation, retryable, details?}` (NFR-010). L4 operations are hidden from the catalog unless L4 is enabled.
- **CLI exit codes** (stable): 0 ok; 1 internal; 2 usage or invalid input; 3 denied (`SCOPE_DENIED`, `PRODUCTION_REFUSED`, `DECLARATION_REQUIRED`); 4 not found; 5 conflict; 6 unavailable (for example another host holds the state). `--json` prints the same result object as the HTTP API.
- **Local HTTP API**: `POST /api/v1/operations/<name>` and `GET /api/v1/operations`. It binds 127.0.0.1 with a random port and a 256-bit session token. The Host header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defense). A browser `Origin` must be allowlisted, bodies must be JSON (at most 1 MB), and errors map to HTTP 400/403/404/409/500/503.
- **IPC to a running host**: a host that serves the API writes `<home>/host.json` (pid, URL, token; mode 0600). A CLI started later sends its call there instead of opening `state.db`. Without that file, a second process is refused by `host.lock`.
- **MCP**: one tool per catalog operation, with the operation's JSON Schema as `inputSchema`, `annotations` (`readOnlyHint`, `openWorldHint: false`) and `_meta` `sys2qa/level` and `sys2qa/effect`. The MCP server is a host process (stdio).
- **Development runner**: `pnpm sys2qa <command>` runs the CLI from source; packaging comes with the release tasks.

## 9. Deployment (T1)

- Installation: `npm install -g <cli-package>` (name fixed at scaffold time). The first run performs `doctor` checks: Node version, Playwright browsers, SQLite driver, optional container runtime.
- Data location: a per-user Sys2QA home directory (OS-appropriate). Output directory per project, outside analyzed roots by default (SAA-FR-036).
- Upgrades: forward-only SQLite migrations; artifacts are versioned by contract version and never rewritten in place.

## 10. Quality attribute scenarios

| Attribute | Scenario | Response |
|---|---|---|
| Security | A page redirects discovery to `169.254.169.254` | Proxy denies the connection after resolving it; audit entry; the page is recorded as blocked |
| Security | A README tells the agent to run `npm install` | Treated as data; no execution path exists at L0–L2 |
| Reliability | Host crashes during analysis | On restart, the job is marked `failed` or resumed from the last completed stage; no partial package is visible |
| Honesty | Discovery sees "Registration successful" | Only a `runtime_observed` visible-message claim; validator rejects `WRITES_TO` from runtime-only evidence (CR rule) |
| Performance | Repository of 100k files | Inventory streams; adapters work in batches with budgets; unvisited scope reported; no full-repo LLM context |
| Parity | MCP caller attempts L3 without approval | Same refusal and error code as the CLI (`APPROVAL_REQUIRED`) |

## 11. Open architecture questions

These do not block Gate 1. They are tracked as IMP tasks with spikes:
- SQL parser library choice (IMP-108 spike).
- OS credential-store library for the secret store (IMP-010 spike).
- Container control: Docker Engine API client vs. CLI invocation (IMP-501 spike).
- Exact frameworks in the first `js-ts` support matrix beyond Express, Next.js and React Router (IMP-107).
