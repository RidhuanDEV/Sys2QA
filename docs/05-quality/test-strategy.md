# Sys2QA — Test Strategy & Verification Plan

| Field | Value |
|---|---|
| Status | Baseline 1.0 |
| Last updated | 2026-10-22 |
| Source of truth for | How requirements, contracts, security controls and release gates are proven |
| Related | PRD §26 (evaluation), §29 (gate checklists); Threat Model §6 (security tests); Contract Spec §12 (fixtures); Implementation Plan |

Principle: **a requirement is done when an automated test or recorded acceptance evidence proves it, not when code exists** (PRD §29.2). Sys2QA is tested with the methods it promotes.

---

## 1. Traceability

```text
PRD requirement (e.g. SAA-FR-040)
  → implementation task (IMP-111)
    → code (packages/saa-core/…)
      → automated tests tagged @req SAA-FR-040
        → acceptance evidence (gate run report)
          → release gate (Gate 1 checklist item)
```

- **Requirement → task:** maintained in the Implementation Plan (§4 there).
- **Requirement → test:** every test that proves a requirement carries a tag in its title, e.g. `[@req SAA-FR-040]`. One test may carry several tags.
- **Traceability report** (`pnpm trace`, IMP-017): parses PRD IDs and test tags and produces `reports/traceability.md`. The report lists:
  - each P0 requirement without a passing tagged test (a **gate blocker** for the gate that owns it);
  - tags that reference unknown IDs (a CI failure);
  - requirements covered only by manual acceptance evidence (allowed only where listed in §8).

The report is generated, never hand-edited. That keeps requirement-test mapping in one place: the tests.

Implementation (`scripts/traceability.mjs`):
- Requirements are the rows of PRD tables headed `ID | Requirement | … | Pri | St`; withdrawn rows (`St = W`) are skipped, and a mixed priority such as "P0 (propagation) / P1 (diff)" counts as P0.
- A requirement's owning gate is the earliest gate in the Implementation Plan backlog whose task lists it. A test checks that every P0 requirement has an owner.
- Tags may also name contract rules (`CR-xxx`, Contract Specification §8). Tags may sit on a `describe` block or on a test.
- `pnpm trace` runs the tests with Vitest's JSON reporter and counts only passing tests. CI runs it in one test cell (Ubuntu, Node 24) and uploads `reports/` as the `traceability` artifact. `pnpm trace:check` (in `verify` and CI stage 1) scans tags without running tests and fails on unknown tags.
- Process tooling that implements no requirement (such as this report) has untagged tests.

## 2. Test levels

| Level | ID prefix | Scope | Tooling | Runs |
|---|---|---|---|---|
| Unit | UT | Pure functions, state machines, ID derivation, risk scoring, translation invariants | Vitest | Every push |
| Contract | CT | Schemas, semantic rules CR-xxx, error codes, fixtures, producer and consumer conformance | Vitest + Ajv | Every push |
| Integration | IT | Module combinations with real SQLite, filesystem, adapter workers, proxy | Vitest | Every push |
| Parity | PT | Same operation via CLI, HTTP API and MCP yields identical decisions, states and errors (SYS-005) | Vitest harness | Every push |
| Security | ST | Threat Model §6 tests | Vitest + fixture servers | Every push (fast set); full set nightly |
| End-to-end | E2E | Full pipeline per starting mode on benchmark fixtures; web UI flows | Playwright Test | Nightly + release candidate |
| Benchmark | BM | Quality metrics against ground truth (§5) | Benchmark harness (IMP-014) | Nightly; results archived |
| Acceptance | AT | Gate checklists (PRD §29.1) assembled from the above | Gate runner script | At each gate and release candidate |

Coverage targets (line and branch) are not used as gates; requirement traceability is. Line coverage is reported for information only.

## 3. Determinism and LLM-dependent behavior

- **Deterministic-only mode** (ADR-008) runs all of CT, IT, ST and most of E2E without any model.
- **LLM-assisted paths** run in CI against **recorded responses** (record/replay keyed by a hash of the exact messages sent, which include the template and its input; `fixtures/llm/cassettes/`, `ReplayBackend`). Changing a template invalidates its recordings, and CI fails with `LLM_REPLAY_MISSING` until they are re-recorded (`SYS2QA_RECORD_LLM=1`) and reviewed.
- **Live provider conformance** runs nightly per configured backend and checks schema-valid output, refusal handling, timeouts and usage accounting. Live results never gate a push, but they are reviewed before a release candidate.
- **Live Skill conformance** (`pnpm skill:conformance`) runs the Analyst Skill in headless Claude Code against F1 and scores the session; the static Skill checks run on every push. Records: [Analyst Skill conformance](skill-conformance.md).
- Assertions on LLM output check **structure and rules**: basis, oracle, objective consistency, no over-claiming. They never check wording.

## 4. Benchmark fixtures (OD-20)

Four synthetic fixtures with human-reviewed ground truth live in `fixtures/benchmarks/`. They are built in IMP-013 and are the first thing built, alongside the contract.

| Fixture | Content | Runnable app? | Purpose |
|---|---|:-:|---|
| **F1 — Repository-only** | Undocumented JS/TS web app (Express API + React Router frontend + SQL migrations + Prisma). Includes: ≥ 6 workflows (registration, login, password reset, order approval with state machine, admin role check, scheduled cleanup job), validation rules with boundaries, one dynamically registered route, one external email integration, dead code, generated files, a planted secret and an injection comment | Yes (used by F3) | Discovery without names; boundaries; rules; gaps; honesty |
| **F2 — URL-only** | Dev website (served by the harness) with ≥ 12 pages: navigation, forms with visible constraints, validation errors, a login wall, a read-only search, a destructive form, a crawler trap (calendar), an off-scope redirect, a page with prompt-injection text, a success message with no visible persistence | Yes | Runtime discovery, form policy, scope, honesty |
| **F3 — Combined** | F1 source + F1 running with **deliberate discrepancies**: one route present in source but disabled at runtime, one field constraint differing (13 vs 16 digits), one page served without a source route | Yes | Correlation, discrepancy detection, revision correspondence |
| **F4 — Incomplete evidence** | Frontend-only repository calling an unavailable backend; a queue consumer living in a missing repository; a feature behind runtime config | Partially | Where analysis stops; `known_not_traceable`; completeness reporting |

Later (after Gate 5): licensed open-source projects added with reviewed ground truth (OD-20).

F3 deviation (IMP-013): F3's runtime is a simulator (`F3-combined/runtime/server.mjs`) that renders F1's pages with the three discrepancies, because running F1 needs PostgreSQL and third-party packages. F3 adds `ground-truth/correlation.json` (expected links, discrepancies, unmatched items, revision correspondence).

### 4.1 Ground-truth format

`fixtures/benchmarks/<F>/ground-truth/`:
- `entities.json`: expected entities by natural key (kind, boundary, key). Matching is by natural key, never by generated ID.
- `workflows.json`: expected workflows with a canonical step list (entry point, ordered entity keys, branches, expected stop points with reason codes).
- `gaps.json`: expected gaps and contradictions.
- `forbidden-claims.json`: claims that must **not** appear (e.g. `WRITES_TO` from runtime-only evidence; "email delivered").
- `scenarios-expected.json`: the minimum justified scenarios (by condition and technique) and **forbidden expectations**.
- `README.md`: the rationale for each item, reviewed by a second person.

## 5. Quality metrics (PRD §26.4)

Numeric targets are set after the first baseline run. Until then, metrics are reported and trended, not gated, **except** the gate rules marked ✓.

| Metric | Definition | Gate rule |
|---|---|---|
| Discovery recall | Matched expected workflows ÷ expected workflows. A workflow matches if its entry point matches and ≥ 50% of the canonical steps match in order. Gap records never count as matches | Reported |
| Discovery precision | Matched discovered workflows ÷ discovered workflows (excluding items marked `excluded`) | Reported |
| Reconstruction quality | For matched workflows: step-sequence F1, branch recall, stop-point accuracy (correct reason code), external-boundary labeling accuracy | Reported |
| Uncertainty-reporting accuracy | (a) Reported gaps that are true gaps ÷ reported gaps; (b) missed expected workflows that lie in areas reported as unexplored, unsupported or excluded ÷ missed expected workflows | Reported |
| Over-claiming | Count of `forbidden-claims.json` items present | ✓ must be **0** |
| Evidence traceability | Material claims with valid, resolvable evidence at the right revision ÷ material claims | ✓ must be **100%** (CON-004) |
| Scenario validity | Expected scenarios covered; forbidden expectations present | ✓ forbidden expectations must be **0** |
| Scenario acceptance rate, duplicate rate, false-failure rate, automation reliability, evidence completeness, time to first useful suite, cost per accepted scenario | PRD §18.3 definitions | Reported |
| Runtime discovery | Page and form recall within scope; forms correctly withheld from submission | ✓ withheld-form errors must be **0** |

Implementation (IMP-014): `tests/benchmark/harness/` with `pnpm bench`. The ground truth refers to entities by semantic ID, which is deterministic from kind, boundary and natural key (Data Model §3), so matching never depends on generated IDs. Step sequences are compared by longest common subsequence. A metric that cannot be measured yet (no scenarios, no runtime discovery) is reported as not measured and does not fail a gate. Results: `reports/benchmarks/<fixture>/<producer>.{json,md}` and `reports/benchmarks/trend.jsonl`. The stub producer, which echoes the ground truth, checks the harness itself. From IMP-111 the SAA producer (`saa-producer.ts`: inventory, stack, structural analysis, traces and the workflow catalog) is measured on F1 and F4; it emits no claims yet, so evidence traceability is not measured for it. A `known_not_traceable` workflow never counts as discovered. A missed workflow counts as honestly reported when its area is unexplored or excluded in the coverage or the completeness report, its entry point is listed as unexplored, or the producer listed a workflow with that entry point as `known_not_traceable` or `excluded` (IMP-114).

## 6. Security testing

The ST-01–ST-20 suite is defined in Threat Model §6. Rules:
- The ST subset for an operation must pass before that operation is enabled in any build (PRD §27.4).
- Security tests are **never** quarantined or skipped. A failing security test blocks merging.
- Each fixed security defect adds a regression test.

## 7. CI pipeline

| Stage | Contents | Trigger | OS |
|---|---|---|---|
| 1. Static | Typecheck, lint, format, dependency rules (IMP-002), generated-type freshness, docs link check | Every push | Linux |
| 2. Fast tests | UT, CT, IT, PT, fast ST | Every push | Linux, macOS, Windows |
| 3. Traceability | Unknown-tag check; P0-without-test report (informational until each gate opens, then blocking for that gate's requirements) | Every push | Linux |
| 4. Nightly | Full ST, E2E, BM, live-provider conformance | Nightly | Linux; E2E also on macOS and Windows (native L2), L3 containers on all three |
| 5. Gate run | AT for the gate, plus archived evidence (reports, metrics, logs) | Manual trigger at gate | All three |
| 6. Release candidate | All gates; clean-machine install tests; SBOM; license check | Manual | All three (clean VMs) |

**Flaky-test policy.** A flaky non-security test may be quarantined for at most 7 days, with an issue and an owner. Quarantined tests are listed in the gate report. Contract, security and parity tests are never quarantined. Retries in CI are allowed only for documented infrastructure failures, never for assertions.

## 8. Acceptance per gate

Each gate's checklist (PRD §29.1) maps to an AT suite. The suite produces `reports/gates/<gate>/<date>/`, containing:
- the traceability report filtered to that gate's requirements;
- test results;
- benchmark metrics against ground truth;
- for UI-only checks, short recorded evidence: Playwright traces or screenshots, plus a reviewer's sign-off note.

The only items accepted with manual evidence are:
- web UI usability checks (keyboard navigation, readability without color — NFR-009), which also have automated a11y checks;
- localization quality review for `id` (LOC-002);
- the human ground-truth review of benchmark fixtures.

A gate passes only when every checklist item has passing evidence and the traceability report shows no P0 requirement of that gate without a passing tagged test.

Implementation (IMP-121): `tests/acceptance/gate-<n>.test.ts` holds one `describe` per checklist item (`Gate <n> item <k>: …`), tagged with the item's requirements. `pnpm gate <n>` (`scripts/gate-report.mjs`) runs the whole suite and the benchmarks and writes `reports/gates/gate-<n>/<date>/` with the test results, the traceability report, the benchmark results and `report.md`, which maps each checklist item to its tests and lists the gate's requirements (PRD §27.2 and, for Gate 1, the L0–L1 security gate of §27.4), deferring those whose acceptance criterion a later gate's backlog owns, the earlier gates' uncovered P0 requirements, the manual evidence and any quarantined test. The verdict is `PASSED`, `PASSED on automated evidence; manual evidence pending` or `FAILED`; the script exits 1 only on a failure. The `gate` workflow (manual dispatch) runs it on all three operating systems and archives the reports as artifacts; each gate's record is kept in `docs/05-quality/gates/`.

## 9. Release-candidate criteria

All of the following:
1. Gates 1–5 passed on the same commit (OD-26).
2. Release-wide checklist (PRD §29.1) passed.
3. No open defect of severity `critical` or `major` in Sys2QA itself.
4. ST full suite green on all OSs; SBOM and license check clean.
5. Clean-machine installs pass for every capability the published OS support matrix claims.
6. Benchmark results and known limitations are written up for publication.
