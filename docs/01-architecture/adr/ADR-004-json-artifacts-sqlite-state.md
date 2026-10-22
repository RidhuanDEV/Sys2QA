# ADR-004: Partitioned JSON artifacts and SQLite for index and operational state

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Maintainer (OD-08); driver choice under maintainer delegation |
| PRD links | OD-08, OD-01, NFR-003, NFR-004, SEC-015 |

## Context
Analysis output must be inspectable, diffable and exportable. Operational state (jobs, approvals, runs, audit) must be transactional and authoritative (PRD §15.2).

## Decision
- **Analysis artifacts** (SKB partitions, packages, documentation) are JSON and Markdown files written atomically (temp file + fsync + rename). They are canonical.
- **SQLite** holds:
  1. a **rebuildable index** over artifacts, for query and search;
  2. **authoritative operational state**: projects, declarations, scope policies, jobs, approvals, runs, results, defects and audit.
  
  The two groups are separate schemas in one database file per installation. Only the index group may be dropped and rebuilt.
- Driver: `better-sqlite3`, chosen for its synchronous API and prebuilt binaries. `node:sqlite` is re-evaluated when it is stable in the pinned Node LTS.
- WAL mode; one writer (the host); migrations are versioned and forward-only.

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| SQLite only | Packages would be exported views rather than canonical artifacts; harder to inspect and diff |
| JSON only | No transactions for approvals and jobs; slow queries |
| PostgreSQL | Requires a server (contradicts OD-01) |

## Consequences
- Positive: auditable artifacts, transactional state, single-file backup of state.
- Negative: two persistence mechanisms to keep consistent (index rebuild path required, IMP-115).
- Follow-up: IMP-007, IMP-115.

## Verification
Rebuilding the index from artifacts produces identical query results (test); crash-during-write tests leave no partial artifact visible.
