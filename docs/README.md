# Sys2QA Documentation

Each type of information has **one** source of truth (ADR-010). Documents link to each other instead of copying content.

## Building Sys2QA (engineering documents)

| Document | Answers | Source of truth for | Status |
|---|---|---|---|
| [PRD](PRD.md) | What do we build, and why? | Requirements, priorities, product behavior, decisions (§31.4) | Approved baseline 1.0.0 |
| [Implementation Plan & Backlog](00-project/implementation-plan.md) | In what order, and when is a task done? | Tasks, dependencies, requirement → task mapping, status | Baseline 1.0 |
| [Software Architecture](01-architecture/software-architecture.md) | How is the system structured? | Modules, dependency rules, process model, data flows | Baseline 1.0 |
| [ADRs](01-architecture/adr/README.md) | Why was it decided this way? | Decision rationale and consequences | ADR-001 … ADR-010 accepted |
| [Contract Specification](02-contracts/contract-specification.md) | How do components exchange data without misunderstanding? | Fields, enumerations, semantic rules CR-xxx, error codes, versioning, governance | Baseline 1.0; schemas pending (IMP-003) |
| [Data Model & Storage](03-design/data-model.md) | How is data stored, identified and recovered? | On-disk layout, SQLite schema, identity, transactions, retention, recovery | Baseline 1.0 |
| [Threat Model & Security Architecture](04-security/threat-model.md) | What can go wrong and what stops it? | Assets, trust boundaries, threats, controls, security tests ST-xx | Baseline 1.0 |
| [Test Strategy & Verification Plan](05-quality/test-strategy.md) | How do we prove it works? | Traceability, test levels, fixtures, metrics, CI, gate acceptance | Baseline 1.0 |

### Planned (written when there is real content to put in them)

| Document | When | Folder |
|---|---|---|
| Agent Behavior Specification (SAA and QAA operational rules, LLM prompt templates and their tests) | During Gates 1–2 | `03-design/` |
| API & Interface Specification (application services, CLI, HTTP API, MCP tools, Skill) | Grows from IMP-016; complete before the RC | `06-interfaces/` |
| Operational & Job Lifecycle Specification | With IMP-008 | `07-operations/` |
| Developer Setup & Contribution Guide | With IMP-001 | `08-guides/` |
| User Guide, CLI/MCP/Skill reference, Compatibility Matrix, Known Limitations, Packaging | Before the release candidate (IMP-901, IMP-903) | `08-guides/`, `09-release/` |

Machine-checkable artifacts live outside `docs/`: `schemas/` (JSON Schemas, canonical structure) and `fixtures/` (contract and benchmark fixtures).

## Output that Sys2QA generates (product output, not project docs)

Documentation Packages, workflow catalogs, completeness reports, readiness assessments, test plans, scenarios, manual test packs, run results, defect reports and QA reports are **product outputs** for the analyzed application. Their formats are defined in the Contract Specification and PRD §12–§15, not in this folder.

## Historical sources

`../SAA_PRD.md` and `../QAA-PRD-SAA-QAA-collaboration.md` are the original PRDs, kept unchanged for traceability (PRD §1.2).
