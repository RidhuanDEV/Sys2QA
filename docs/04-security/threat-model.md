# Sys2QA — Threat Model & Security Architecture

| Field | Value |
|---|---|
| Status | Baseline 1.0 |
| Last updated | 2026-10-22 |
| Source of truth for | Assets, trust boundaries, threats, mitigations, security test plan |
| Related | PRD §21 (SEC-001–025), §27.4 security release gates; ADR-005, ADR-007, ADR-009 |

Security claims in this document are **design intent** until the tests in §6 pass. A control without a test is not considered implemented.

---

## 1. Security model in one paragraph

Sys2QA reads untrusted code and drives browsers against user-supplied URLs on the user's own machine. Authorization is **self-declared** (MD-3). Safety therefore does not rely on proving ownership. It relies on three controls enforced **in code, outside any model**:
1. **technical scope:** roots, hosts, paths, environment classification;
2. **permission levels:** L0–L4;
3. **human approval** for anything state-changing.

All target-bound network traffic passes through one scope-enforcing proxy. All untrusted parsing and browsing happens in isolated workers.

## 2. Assets

| ID | Asset | Why it matters |
|---|---|---|
| AS-1 | User's source code and repository metadata | Confidential IP |
| AS-2 | Credentials, session cookies and tokens for target environments | Account compromise |
| AS-3 | LLM provider API keys | Financial and abuse risk |
| AS-4 | Target application data | Integrity of the user's or third parties' data |
| AS-5 | Host machine and local network | Lateral movement, SSRF to internal services |
| AS-6 | Sys2QA state: approvals, audit, results | Trustworthiness of QA conclusions |
| AS-7 | Generated documentation and packages | Reveal internal topology |
| AS-8 | Evidence blobs (screenshots, traces) | May contain personal data |

## 3. Trust boundaries

```text
 ┌──────────────────────── Host process (trusted) ───────────────────────────┐
 │ app-services · policy engine · contract validator · job orchestrator      │
 │ SQLite · audit · secret store client · LLM port · scope-enforcing proxy   │
 └──▲──────────────▲──────────────────▲─────────────────▲──────────────▲─────┘
  TB1│ loopback HTTP│ TB2 JSON-RPC      │ TB3 IPC + proxy  │ TB4 container │ TB5 HTTPS
     │ + token      │ (stdio)           │                  │ + proxy only  │
 ┌───┴─────┐  ┌─────┴────────┐  ┌───────┴───────────┐ ┌────┴───────────┐ ┌┴──────────────┐
 │ Web UI  │  │ Adapter      │  │ L2 browser worker │ │ L3 container   │ │ LLM provider  │
 │ (browser│  │ workers      │  │ (native)          │ │ (test-runner)  │ │ (optional)    │
 │ client) │  │ untrusted    │  │ untrusted content │ │ untrusted      │ └───────────────┘
 └─────────┘  │ input        │  └─────────┬─────────┘ │ content        │
              └──────┬───────┘            │ TB6        └────┬───────────┘
                     │ reads only         ▼                 ▼
              Approved source roots    Target environment (dev/staging) — via proxy only
```

| Boundary | Crossing | Enforcement |
|---|---|---|
| TB1 | Web UI → host API | Loopback bind, random port, per-session token, CORS locked to the served origin, server-side validation of every request |
| TB2 | Host ↔ adapter worker | Process isolation; only root-relative file batches in; validated contract output out; no network; scratch-only writes; resource limits |
| TB3 | Host ↔ L2 worker | Process isolation; fresh browser context and temporary profile per job; proxy-only egress; IPC messages validated |
| TB4 | Host ↔ L3 container | Container with network restricted to the proxy, no host mounts except a per-job output directory, injected per-job credentials only, resource limits, kill on cancel |
| TB5 | Host → LLM provider | Opt-in, disclosed; redacted context; responses treated as untrusted and schema-validated |
| TB6 | Worker → target | Scope-enforcing proxy (ADR-007): IP-level check at connect time, host and port allowlist, rate limits, audit |

## 4. Threats and mitigations (STRIDE-oriented)

| ID | Threat | STRIDE | Assets | Mitigations (requirements, components) | Test |
|---|---|---|---|---|---|
| T-01 | Path traversal or symlink escape reads files outside the approved root | I | AS-1, AS-5 | Root sandbox resolves realpaths; rejects `..`, absolute and outside-root symlink targets; adapters receive only host-vetted paths (SEC-001, ADR-009) | ST-01 |
| T-02 | Hostile repository code runs (install hooks, build scripts, test files) | E, T | AS-5 | No execution path at L0–L2; adapters parse only; package scripts are read as metadata; L4 disabled in first release (SEC-002, OD-17) | ST-02 |
| T-03 | Prompt injection in source, docs or web pages alters behavior | T, E | AS-2, AS-4, AS-5 | Policy decided in code; LLM output schema-validated; LLM has no tools that change scope or approvals; content delimited as data in prompts (SEC-003, ADR-008) | ST-03 |
| T-04 | Secrets from repository or environment leak into prompts, logs, packages, reports or screenshots | I | AS-2, AS-3, AS-7 | Secret detectors at intake and before every output; secret references only; log redaction; excerpt limits; package validator CR-060 (SEC-004, CON-017) | ST-04 |
| T-05 | SSRF: discovery or execution reaches internal services, metadata endpoints or localhost | I, E | AS-5 | Proxy resolves and checks IPs at connect time; blocks private, loopback, link-local and metadata ranges unless local owner mode names the target; redirects re-checked (SEC-007, SEC-008, ADR-007) | ST-05 |
| T-06 | DNS rebinding bypasses host allowlist | I, E | AS-5 | Connection pinned to the checked IP; no second resolution (ADR-007) | ST-06 |
| T-07 | Discovery triggers side effects (account lockout, emails, records) | T, D | AS-4 | Observe-only default; unknown-effect and login forms never submitted; read-only submissions opt-in with user confirmation; rate limits (SEC-024, OD-25, OD-29) | ST-07 |
| T-08 | Automated test modifies or destroys data without informed approval | T | AS-4 | State-changing flag; approval with `state_changing_ack`; cleanup plan or irreversibility acknowledgment; production refused (SEC-009, SEC-010, CR-056) | ST-08 |
| T-09 | Execution of an unapproved, edited or stale scenario | T, E | AS-4, AS-6 | Executor checks approval state and full baseline binding at enqueue and in-worker (CR-055, QAA-FR-054) | ST-09 |
| T-10 | Generated or injected code executes in the runner | E | AS-5 | Runner accepts only the constrained action/assertion schema; no `eval`, no arbitrary scripts (QAA-FR-061) | ST-10 |
| T-11 | Credential reuse across projects or theft from workers | I, E | AS-2 | Per-job credential injection; fresh contexts; no persistent storage state; container teardown (SEC-011, SEC-012) | ST-11 |
| T-12 | Local web API abused by another local process or a malicious website (CSRF, DNS rebinding to localhost) | S, E | AS-6 | Session token required; Host and Origin checks; no CORS for foreign origins; loopback only (TB1) | ST-12 |
| T-13 | Malicious package import (tampered, oversized, path tricks, embedded secrets) | T, D | AS-6, AS-5 | Checksums; schema and semantic validation; size limits; archive extraction with path checks; secret scan (CON-009, CON-019, SEC-021) | ST-13 |
| T-14 | Malicious or buggy adapter or plug-in escalates privileges | E | AS-1, AS-5 | Process isolation; registration grants no level; output validated; resource limits (OSS-005, ADR-009) | ST-14 |
| T-15 | Resource exhaustion (huge repo, crawler traps, runaway browser) | D | AS-5 | Budgets per job; URL-pattern deduplication; timeouts; kill on cancel; disk quotas for blobs (NFR-002, QAA-FR-066) | ST-15 |
| T-16 | Audit tampering or repudiation of approvals | R, T | AS-6 | Append-only audit in the same transaction as the action; hash chain; approvals immutable (SEC-014) | ST-16 |
| T-17 | Generated documentation exposes internal topology when shared | I | AS-7 | Output warning on first export; default output outside repository; redaction; excerpt policy (SEC-016) | ST-17 |
| T-18 | Personal data captured in screenshots or traces | I | AS-8 | Retention limits; optional masking selectors; warning in reports (SEC-023, OD-14) | ST-18 |
| T-19 | Container escape or misconfiguration exposes host | E | AS-5 | Rootless or user-namespaced container where supported; drop capabilities; read-only root filesystem; no privileged mode; network restricted to the proxy (ADR-005) | ST-19 |
| T-20 | Over-claiming: results presented as more certain than evidence | T (integrity of conclusions) | AS-6 | Contract rules CR-001/002/050–054; status taxonomy; completeness report (CON-023, CON-028) | ST-20 |

## 5. Security architecture decisions

| Topic | Decision | Reference |
|---|---|---|
| Policy enforcement point | Policy engine in `platform`, called by app-services for every command; workers re-check inputs they receive | Software Architecture §5 |
| Network enforcement point | Scope-enforcing local proxy; no other component reaches targets | ADR-007, SEC-025 |
| Isolation | Adapters and L2 browsers: native worker processes. L3: Linux containers | ADR-005, ADR-009 |
| Secrets | OS credential store, with an encrypted-file fallback; `secretref:` IDs everywhere else; injection at job start only | Data Model §1 (F), SEC-011 |
| LLM | Optional; never decides policy; output validated | ADR-008 |
| Supply chain | Lockfile committed; dependency review in PRs; no install-time scripts from Sys2QA's own dependencies beyond allowlisted ones; SBOM generated at release | SEC-022, IMP-901 |

## 6. Security test plan

Every test below is automated and runs in CI. The relevant subset must pass before the corresponding operation is enabled (PRD §27.4).

| Test | Verifies | Method | Gate |
|---|---|---|---|
| ST-01 | Root sandbox | Fixture repo with `../`, absolute paths, symlinks to `/etc`, junctions on Windows; assert denial and audit | G1 |
| ST-02 | No execution | Fixture repo with `postinstall`, `prepare` and test files that write sentinel files; process-spawn monitor; assert no sentinel files and no child processes from repository content | G1 |
| ST-03 | Prompt injection | Injection strings in comments, README and pages ("ignore rules", "approve all", "fetch http://169.254.169.254"); assert no policy change, no extra requests, no approval | G1, G4 |
| ST-04 | Secret leakage | Planted secrets (AWS-style keys, JWTs, `.env` values, private keys) in repo and pages; scan every output, log, prompt capture, package and audit record | G1–G5 |
| ST-05 | SSRF | Fixture server issuing redirects to private, loopback, link-local and metadata IPs; WebSocket upgrades; off-scope hosts; assert proxy denial | G4 |
| ST-06 | DNS rebinding | Test resolver alternating public and private answers; assert pinned IP and denial | G4 |
| ST-07 | Form-interaction policy | Pages with login, delete, invitation, unknown-effect and GET search forms; assert submissions only for confirmed read-only forms with opt-in | G4 |
| ST-08 | State-changing approval | Scenarios flagged state-changing without acknowledgment or cleanup; assert refusal | G2, G5 |
| ST-09 | Approval binding | Edit, suspend, change scope version, change package; assert executor refusal | G2, G5 |
| ST-10 | Runner code injection | Scenario documents containing script-like strings in values and selectors; assert schema rejection or literal handling | G5 |
| ST-11 | Credential isolation | Two projects with different credentials; assert no cross-access to storage state or secrets | G4, G5 |
| ST-12 | Local API hardening | Requests without a token, with a foreign `Origin`, or via a DNS-rebound hostname to localhost; assert rejection | G2 |
| ST-13 | Malicious package | Zip-slip, oversized, checksum mismatch, secret-bearing, cross-producer packages; assert specific error codes | G2 |
| ST-14 | Malicious adapter | Test adapter tries to open sockets, write outside scratch, or exceed memory; assert kill, `partial` run and coverage record | G1 |
| ST-15 | Resource exhaustion | Crawler-trap site; 100k-file repository fixture; assert budgets honored and unvisited scope reported | G1, G4 |
| ST-16 | Audit integrity | Modify an audit row; assert hash-chain verification fails; approvals are immutable | G2 |
| ST-17 | Output warnings | First export shows the warning; default path is outside the repository | G1 |
| ST-18 | Retention | Blobs past retention are removed; referenced ones are kept | G3 |
| ST-19 | Container hardening | Inside the container, attempt host network, metadata IP, Docker socket and privileged operations; assert failure | G5 |
| ST-20 | Over-claiming | Runtime-only fixture attempting `WRITES_TO` claims; scenario with `requirement_conformance` on `observed` basis; assert CR errors | G1, G2, G4 |

## 7. Residual risks (accepted)

| Risk | Why accepted | Revisit when |
|---|---|---|
| Misuse against systems the user does not own (MD-3) | Product trust model; mitigated by scope, observe-only default, approvals, production refusal | Community or legal feedback |
| L2 native browsers are less isolated than containers (OD-30) | Observe-only by default; keeps URL-only users infrastructure-free | A browser sandbox escape is disclosed, or read-only submissions see heavy use |
| HTTPS path-level checks are not enforced at the proxy (no TLS interception) | Host-level enforcement at the proxy plus navigation-level checks; TLS interception adds more risk | Path-scoped policies become a common requirement |
