# ADR-001: Local single-user modular monolith with isolated workers

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Maintainer (OD-01); shape detailed under maintainer delegation |
| PRD links | OD-01, MD-2, MD-6, §9.6, §9.8, SYS-005 |

## Context
The first release targets individual developers working locally (topology T1). Sys2QA must not clone repositories (MD-2) and must not require infrastructure work (MD-6). The QAA source PRD proposed PostgreSQL, Redis/BullMQ and object storage, which assume a server deployment.

## Decision
Sys2QA runs as **one local application process** (the *host*), structured as a modular monolith:
- domain modules `saa-core`, `qaa-core` and `platform`, with enforced dependency rules;
- one application-service layer used by every interface (CLI, local web UI, MCP, Skill);
- **isolated worker processes** for analyzer adapters, browser discovery and targeted verification;
- **container workers** for automated execution (ADR-005).

The host uses an embedded database and an in-process job queue persisted in that database (ADR-004). Business logic does not depend on storage or transport implementations; they sit behind ports so that a T2 server topology can be added without rewriting SAA or QAA.

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| Microservices (SAA, QAA, runner as services) | Network, deployment and versioning complexity with no first-release benefit; contradicts MD-6 |
| Server-first (PostgreSQL + Redis + S3) | Requires provisioning; T2 is deferred |
| Single process without workers | Untrusted parsing and browsing would share memory and privileges with the host |

## Consequences
- Positive: installs with npm, works offline, simple debugging, one place for policy enforcement.
- Negative: no multi-user collaboration in the first release; the host must stay responsive while workers run (job orchestration, IMP-008).
- Follow-up: IMP-001, IMP-007, IMP-008, IMP-016.

## Verification
Dependency-rule checks in CI (IMP-002); end-to-end tests run the whole pipeline on one machine; parity tests across interfaces (SYS-005).
