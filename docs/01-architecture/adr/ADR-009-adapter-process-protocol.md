# ADR-009: Analyzer adapters behind a versioned process protocol

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Maintainer (OD-05 boundary); protocol details under maintainer delegation |
| PRD links | OD-05, OD-06, SAA-FR-047, OSS-004, OSS-005, SEC-001, SEC-002 |

## Context
Adapters parse untrusted code and may later be rewritten in Go or Rust for performance. They must not gain privileges by being registered.

## Decision
- Each adapter runs as a **separate worker process**, speaking **JSON-RPC 2.0 over stdio**, with protocol version negotiation.
- Messages: `initialize` (capabilities, support matrix, protocol version), `analyze` (file batch, budget), `progress`, `result` (facts plus evidence, in contract schema), `cancel`.
- The host gives adapters **file contents or paths inside the sandboxed root only**. Adapters get no network, no environment secrets, and no write access outside a scratch directory. The host enforces limits (time, memory, output size).
- Adapter output is validated by the `contract` package before entering the SKB.
- First adapters (TypeScript): `js-ts`, `sql`, `config-deploy` (OD-06), each with a support matrix (SAA-FR-047).

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| In-process plug-ins | No isolation; a crash or hostile input affects the host |
| gRPC | Heavier toolchain for little benefit locally |

## Consequences
- Positive: isolation, language independence, independent versioning.
- Negative: serialization overhead; large repositories need batching (IMP-105).
- Follow-up: IMP-105–IMP-109.

## Verification
Protocol conformance tests; a malicious-adapter fixture cannot write outside scratch or open sockets; adapter crash yields `partial` with coverage records.
