# ADR-008: Provider-neutral LLM adapter with deterministic-only mode

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Maintainer (OD-07) |
| PRD links | OD-07, OSS-009, SEC-003, SEC-018, NFR-011 |

## Context
Users choose their model provider or none. Repository and web content are untrusted (SEC-003). Determinism matters for canonical facts (NFR-003).

## Decision
- One `LlmPort` interface in `platform`: structured generation with a JSON Schema for the output, optional tool calls, timeout, token and cost accounting, and error normalization.
- Backends: configured hosted provider, local endpoint, or **none**. With none, the system runs **deterministic-only**: inventory, parsing, graphs, validation and catalog structure still work; narrative text and LLM-assisted scenario wording are marked unavailable.
- **The LLM never decides policy**: scope, permissions, approvals, egress and form submission are decided in code. LLM output is always schema-validated and treated as untrusted.
- Canonical facts (entities, relationships, IDs) come from deterministic extractors. The LLM may propose interpretations, which are stored as `inferred` claims.
- Every call records provider, model, version, prompt-template version, token usage and the job ID (audit-safe: no secrets, excerpts per redaction policy).

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| Single bundled provider | Lock-in; violates local-first and privacy goals |
| LLM-driven exploration loops | Non-deterministic, hard to bound, policy risks |

## Consequences
- Positive: works offline; clear separation of facts and interpretations.
- Negative: scenario wording quality varies by provider; provider conformance tests are needed.
- Follow-up: IMP-011.

## Verification
The full Gate 1 suite runs in deterministic-only mode; a provider conformance suite runs per supported backend.
