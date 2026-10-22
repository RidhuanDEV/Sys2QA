# ADR-003: JSON Schema as the canonical contract source

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Claude under maintainer delegation |
| PRD links | CON-001–028, CON-027, OD-15, ADR-009 |

## Context
SAA and QAA both produce packages (OD-24). Adapters may later be written in other languages (ADR-009). The contract must be implemented once (CON-027) and never maintained by hand in two places.

## Decision
- **JSON Schema (draft 2020-12) files in `schemas/` are the canonical structural contract.** TypeScript types are **generated** from them, never hand-written.
- Validation uses Ajv, compiled once in the `contract` package.
- Semantic rules that JSON Schema cannot express are implemented **only** in the `contract` package as named validators. Examples: a claim's status must be allowed for its evidence types; references must resolve; the evidence profile must be consistent.
- Every rule has an ID (`CR-xxx`) listed in the Contract Specification and is tested by fixtures.
- Schema changes follow joint governance (OD-15): ADR or changelog entry, version bump, valid and invalid fixtures, and producer and consumer conformance runs.

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| Zod (TypeScript-first) with exported JSON Schema | Makes TypeScript the source of truth; non-TypeScript adapters would depend on generated output; export fidelity varies |
| Protocol Buffers | Poor fit for human-inspectable packages; weak expression of optional, evolving documents |
| Hand-written types plus documentation | Drift is guaranteed |

## Consequences
- Positive: language-neutral contract; packages are inspectable; validators shared by producers and consumers.
- Negative: a code-generation step in the build; semantic validators need their own tests.
- Follow-up: IMP-003, IMP-004, IMP-005.

## Verification
CI fails when generated types are stale, when a package other than `contract` declares contract types (dependency rule), or when any fixture's expected result changes.
