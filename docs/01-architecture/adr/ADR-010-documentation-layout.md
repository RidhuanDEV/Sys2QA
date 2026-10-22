# ADR-010: Documentation layout and sources of truth

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Claude under maintainer delegation |
| PRD links | PRD §1.4 |

## Context
A large project needs more than a PRD, but duplicated documents drift.

## Decision
- The PRD stays at `docs/PRD.md`. Moving it would break existing links and history.
- Engineering documents live under numbered folders in `docs/`. Each type of information has exactly one source of truth, listed in `docs/README.md`.
- Documents are created when they have real content. Empty placeholders are not created.
- Machine-checkable artifacts (JSON Schemas, fixtures) live outside `docs/` (`schemas/`, `fixtures/`) and are the source of truth for structure. Markdown explains semantics and links to them.
- The original source PRDs (`SAA_PRD.md`, `QAA-PRD-SAA-QAA-collaboration.md`) stay at the repository root for historical traceability.

## Consequences
- Positive: one place to look for each answer; no placeholder sprawl.
- Negative: cross-references must be maintained; a docs link check runs in CI (IMP-001).
