# Architecture Decision Records

ADRs record **why** a decision was made. The current architecture is described in `../software-architecture.md`. ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the old one, and update the PRD decision table (PRD §31.4).

| ADR | Title | Status | PRD |
|---|---|---|---|
| [ADR-001](ADR-001-local-single-user-modular-monolith.md) | Local single-user modular monolith with isolated workers | Accepted | OD-01 |
| [ADR-002](ADR-002-typescript-pnpm-monorepo.md) | TypeScript pnpm monorepo | Accepted | OD-05, OD-10 |
| [ADR-003](ADR-003-json-schema-canonical-contract.md) | JSON Schema as the canonical contract source | Accepted | CON-027, OD-15 |
| [ADR-004](ADR-004-json-artifacts-sqlite-state.md) | Partitioned JSON artifacts and SQLite for index and operational state | Accepted | OD-08 |
| [ADR-005](ADR-005-browser-worker-isolation.md) | Browser worker isolation: containers for L3, native processes for L2 | Accepted | OD-16, OD-30 |
| [ADR-006](ADR-006-qaa-owns-runtime-discovery.md) | QAA owns runtime discovery; two producers, one contract | Accepted | OD-24 |
| [ADR-007](ADR-007-egress-enforcing-local-proxy.md) | Egress enforcement through a local scope-enforcing proxy | Accepted | SEC-007, SEC-025 |
| [ADR-008](ADR-008-llm-provider-modes.md) | Provider-neutral LLM adapter with deterministic-only mode | Accepted | OD-07 |
| [ADR-009](ADR-009-adapter-process-protocol.md) | Analyzer adapters behind a versioned process protocol | Accepted | OD-05, SAA-FR-047 |
| [ADR-010](ADR-010-documentation-layout.md) | Documentation layout and sources of truth | Accepted | PRD §1.4 |
| [ADR-011](ADR-011-secret-store.md) | OS credential store through @napi-rs/keyring, with a passphrase-encrypted file fallback | Accepted | SEC-011 |
