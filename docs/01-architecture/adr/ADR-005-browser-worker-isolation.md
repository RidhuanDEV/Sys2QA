# ADR-005: Browser worker isolation — containers for L3, native processes for L2

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Maintainer (OD-16, L3); Claude under maintainer delegation (OD-30, L2) |
| PRD links | OD-16, OD-30, SEC-012, SEC-007, SEC-025, X-22, MD-6 |

## Context
Browsers process untrusted web content. Automated execution (L3) may submit data and run long suites. Discovery (L2) only observes by default (OD-25). MD-6 requires a path to value without infrastructure work.

## Decision
- **L3 automated execution:** each job runs in a **disposable Linux container**, on every host OS, using a Docker-compatible runtime (WSL2-based on Windows). The container has:
  - no host filesystem mounts except a per-job output directory;
  - no credentials except those injected for the job;
  - network access **only to the host's scope-enforcing proxy** (ADR-007).
- **L2 discovery and targeted verification:** **native Playwright** in a dedicated worker process per job, with a fresh browser context, a per-job temporary profile, no shared storage state between projects, and all traffic forced through the scope-enforcing proxy.
- The runtime observation service is the only component that can start either kind of worker (SEC-025).

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| Containers for L2 too | Makes a container runtime a prerequisite for URL-only users (contradicts MD-6) |
| Native processes for L3 | Rejected by the maintainer (OD-16) in favor of stronger isolation for data-submitting runs |
| Browser in the host process | No isolation from host memory, secrets or the filesystem |

## Consequences
- Positive: strong isolation where state changes happen; URL-only users need no infrastructure.
- Negative: L3 needs a container runtime (documented X-22 exception); two worker launch paths to maintain.
- Follow-up: IMP-401, IMP-402, IMP-501.

## Verification
Security suite: a container cannot reach any destination except the proxy; an L2 worker cannot read another project's profile; cancellation kills workers and containers within the configured grace period.
