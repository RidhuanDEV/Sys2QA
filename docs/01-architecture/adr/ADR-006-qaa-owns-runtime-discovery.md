# ADR-006: QAA owns runtime discovery; two producers, one contract

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-21 |
| Decided by | Maintainer (OD-24) |
| PRD links | OD-24, QAA-FR-114–116, CON-025, CON-026, CON-027, SAA-FR-042/044 (withdrawn) |

## Context
URL-only users need whole-application discovery. The consolidation recommended SAA as the single producer of system models. The maintainer chose QAA.

## Decision
- QAA performs runtime discovery and publishes the observed model as a Documentation Package with producer `QAA`.
- SAA publishes source-based packages with producer `SAA`.
- Both use the same `contract` library and validator (CON-027). Producer constraints are enforced (CON-025).
- In Mode C, the packages stay separate; QAA writes a correlation report (CON-026).

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| SAA produces runtime packages | Maintainer decision OD-24 |
| QAA keeps observations as internal state | Hidden state could not be inspected, versioned or reused as Mode D |

## Consequences
- Positive: QAA's discovery output is inspectable and reusable; the source and observed models stay distinguishable.
- Negative: two producers of system models, which risks semantic drift. Mitigated by CON-027 and joint governance (OD-15).
- Follow-up: IMP-404–IMP-407.

## Verification
Both producers' packages pass the same conformance suite; cross-producer fixtures are rejected (`PKG_EVIDENCE_PROFILE_INCONSISTENT`).
