# Sys2QA — Data Model & Storage Specification

| Field | Value |
|---|---|
| Status | Baseline 1.0 |
| Last updated | 2026-10-22 |
| Source of truth for | Internal persistence: on-disk layout, SQLite schema (operational state and index), identity, transactions, retention, recovery, migrations |
| Related | ADR-004 (JSON + SQLite), Contract Specification (exchange formats), PRD §20 (conceptual entities and lifecycles) |

**The contract defines how data is exchanged; this document defines how it is stored and managed.** Stored artifacts that are also exchange documents (packages, scenarios) are stored in contract form.

---

## 1. Storage classes

| Class | Store | Canonical? | Rebuildable? | Examples |
|---|---|:-:|:-:|---|
| A. Analysis artifacts | JSON/Markdown files | ✓ | — | SKB partitions, Documentation Packages, correlation reports, docs |
| B. Operational state | SQLite `state` schema | ✓ | ✗ | Projects, declarations, scope policies, jobs, scenario versions, approvals, runs, results, defects, audit |
| C. Index | SQLite `idx` tables | ✗ | ✓ | Entity and claim search, graph adjacency, package catalog |
| D. Evidence blobs | Files | ✓ | — | Screenshots, traces, manual attachments |
| E. Caches | Files | ✗ | ✓ | Parser caches, adapter result cache keyed by fingerprint |
| F. Secrets | OS credential store or encrypted file (ADR-011) | ✓ | ✗ | Credential values behind `secretref:` IDs |

Rules:
- Classes A, B, D and F must be backed up together for a consistent restore.
- Class C may be dropped at any time (`sys2qa index rebuild`).
- Class E may be deleted at any time (`sys2qa cache clear`). Deleting it also removes cached source excerpts (SEC-015).

## 2. On-disk layout

```text
<sys2qa-home>/                       per user; OS default (e.g. ~/.local/share/sys2qa,
│                                    ~/Library/Application Support/Sys2QA, %LOCALAPPDATA%\Sys2QA)
├── state.db                         SQLite (classes B and C), WAL mode
├── config.json                      user-level configuration (no secrets)
├── secrets.enc                      only if the OS credential store is unavailable (class F fallback)
├── projects/<project-ulid>/
│   ├── skb/<run-id>/                class A, SAA canonical SKB partitions
│   │   ├── manifest.json
│   │   ├── entities/<kind>/<shard>.json
│   │   ├── relationships/<shard>.json
│   │   ├── claims/<shard>.json
│   │   ├── evidence/<shard>.json
│   │   ├── workflows/<shard>.json
│   │   └── coverage.json, completeness.json, gaps.json
│   ├── observed/<run-id>/           class A, QAA observed model (same partition layout)
│   ├── packages/<package-id>/<version>/   class A, exported or imported packages (immutable)
│   ├── imports/<import-ulid>/original/    class A, imported package stored byte-for-byte (CON-010)
│   ├── correlation/<report-id>.json       class A
│   ├── blobs/<sha256-prefix>/<sha256>     class D, content-addressed
│   └── cache/                        class E
└── logs/                            structured logs (rotated, redacted)
```

Directory and file names use the local part of an ID (`project:01J…` → `01J…`, `run:01J…` → `01J…`), never the full ID, because `:` is not allowed in Windows paths (`localIdPart`, `projectDirectory`, `runDirectory`).

The **user-visible output directory** (SAA-FR-036) is separate and configurable. Exports are copied there; the home directory remains the system of record.

Sharding: entity and relationship files are sharded by a hash of the ID (target ≤ 5,000 records or ≤ 8 MB per shard), so that diffs and partial reloads stay cheap.

## 3. Identity

| Identity | Format | Derivation |
|---|---|---|
| Semantic entity ID | `<kind>:<local-id>` (contract) | Deterministic from kind + boundary + natural key, e.g. `route:POST:/api/registrations`. Never from line numbers or ordering |
| Module and symbol IDs (js-ts, IMP-106) | `module:<key>`, `function:<key>.<name>`, `class:<key>.<name>`; outside the root boundary `module:<boundary-path>:<key>`; packages `module:pkg:<name>`, built-ins `module:node:<name>` | `<key>` is the path inside the boundary without a leading `src/`, the extension and a trailing `/index`, with `.` separators (`src/server/plugins/index.ts` → `module:server.plugins`) |
| Data-model IDs (sql, IMP-108) | `table:<name>`, `column:<table>.<column>`, `orm_model:<Model>`, `entity:<snake_case of the model or table>`; outside the root boundary `<kind>:<boundary-path>:<key>` | Table names as written (default schemas `public`, `main`, `dbo` dropped); `PasswordResetToken` → `entity:password_reset_token` |
| API and UI IDs (js-ts frameworks, IMP-107) | `api:<METHOD>:<path>`, `page:<namespace>:<path>`, `form:<namespace>:<path>#<form>`, `field:<namespace>:<path>#<form>.<field>` | Parameters as `{name}`; the page namespace is the router module's top directory (`src/web/main.tsx` → `web`), a non-root boundary's last segment, or `app` |
| Trace IDs (IMP-110) | `job:<module-last-segment>.<schedule label>`, `integration:<module-last-segment>.provider` or `integration:<host>`, `trace:<entry point ID>` | Schedule label from the cron expression: `nightly` (daily before 06:00), `daily`, `weekly`, `hourly`, else `scheduled` (`0 3 * * *` in `cleanup` → `job:cleanup.nightly`). An integration is named after the module that sends to a non-literal URL, or the literal URL's host |
| Workflow IDs (IMP-111) | `workflow:<entry point ID>`, steps `step:<entry point ID>#<n>`; `queue_topic:<topic>`; gaps `gap:consumer:<topic>`, `gap:route-condition:<namespace>:<path>` | One workflow per entry point, so IDs stay stable across runs. A topic is named by a literal `topic` property. A computed request target is named by the host of the URL literal in the base-URL constant it starts with (`const API = env.X ?? "https://api.shop.example"` → `integration:api.shop.example`) |
| Rule, role and state IDs (IMP-112) | `business_rule:<schema>.<field>_<constraint>`, `actor_role:<snake_case role>`, `permission:<name>`, `state_machine:<subject>.<field>`; gaps `gap:state-machine:<entity>`, `gap:authorization` | The schema key drops a `Schema`/`Validator`/`Validation` suffix (`registrationSchema` → `registration`). Constraint keys: `<n>_digits`, `pattern`, `<format>_format`, `required` (string min 1), `min_<n>_characters`, `max_<n>_characters`, `<a>_to_<b>_characters`, `exactly_<n>_characters`, and for numbers `<a>_to_<b>`, `min_<a>`, `max_<b>`, `integer`. A state machine is named after its table's key type (`OrderStatus` → `order.status`); a 403 middleware argument in capitals, or a value of a role enum, is a role, anything else a permission |
| Cross-validation IDs (IMP-113) | gaps `gap:contradiction:<rule local ID>`; claims `claim:<hash of subject and text>` | One contradiction gap per rule; the claim ID is stable while its subject and wording are |
| Evidence ID | `evidence:<hash>` | `sha256(source_type, path or url, range or subtype, revision or window, extractor version)` truncated to 16 hex characters. Deterministic, so re-runs yield identical IDs (NFR-003) |
| Operational record IDs | `<kind>:<ULID>` | Generated by the platform ID port (testable clock) |
| Run ID | `run:<ULID>` | One per analysis or discovery job |
| Revision | `git_commit` SHA / `content_fingerprint` / `observation_window` | Content fingerprint = sha256 over a sorted list of `(path, file sha256)` for included files |
| Scope policy version | Integer per environment | Incremented on any change; approvals bind to it |

Collision rule: if two different natural keys derive the same local ID, the deriver appends `~<8-hex>` from the full key hash and records an `ambiguity` gap.

## 4. Operational state schema (SQLite `state`)

The DDL is in `packages/platform/migrations/0001_initial_state.sql` (IMP-007); this table summarizes it. All tables are `STRICT` and have `created_at` and `updated_at`; enumerations from the PRD and contract are `CHECK` constraints; `*_json` columns must hold valid JSON. Append-only tables are marked: their triggers reject `UPDATE` always, and `DELETE` unless the row's project has a `project_deletions` tombstone. For that, every append-only table carries `project_id` (nullable where a row can be installation-wide).

| Table | Key columns | Notes |
|---|---|---|
| `projects` | `id`, `name`, `default_languages_json`, `archived_at` | |
| `project_deletions` | `project_id`, `requested_by`, `requested_at` | **Append-only** tombstone written before deleting a project; no foreign key, so it outlives the project and authorizes the cascade through append-only tables (IMP-019) |
| `evidence_sources` | `id`, `project_id`, `kind ∈ {source_root, environment, package}`, `ref`, `added_at` | A project's starting mode is derived from its sources (SYS-001) |
| `authorization_declarations` | `id`, `project_id`, `declared_by`, `declared_at`, `scope_json`, `operation_level`, `prohibitions_json` | **Append-only**; latest active per source |
| `environments` | `id` (= its `environment` evidence source), `project_id`, `base_url`, `classification`, `state`, `local_owner_mode`, `scope_json` | `classification = production` ⇒ refused by policy. `scope_json` (allowed hosts, path prefixes; migration 0003) is the input the scope policy is derived from; configuration requires a declaration, and the base URL must be inside the scope (QAA-FR-002) |
| `scope_policies` | `environment_id`, `version`, `project_id`, `policy_json` | **Append-only** versions. The policy combines the environment scope with the latest declaration (level ceiling, state-changing permission, prohibitions); a new version is written only when that combination changes |
| `credential_profiles` | `id`, `environment_id`, `role_name`, `secret_ref` | Values live in class F |
| `secret_refs` | `ref`, `project_id`, `name`, `backend` | Owner of each `secretref:` (migration 0005); no values. Deleting a project deletes the values in class F first (ADR-011, IMP-019) |
| `jobs` | `id`, `type`, `project_id?`, `state ∈ {queued, running, cancelling, completed, failed, cancelled}`, `priority`, `payload_json`, `budget_json`, `attempt`, `max_attempts`, `idempotency_key UNIQUE`, `lease_owner`, `lease_expires_at`, `cancel_requested_at`, `run_after?`, `last_progress_at?`, `error_json` | Queue and history; see Operational notes §7. `run_after` and `last_progress_at` added by migration 0002 |
| `job_events` | `job_id`, `seq`, `at`, `event`, `data_json` | **Append-only** progress and state changes |
| `analysis_runs` | `id`, `project_id`, `producer`, `status`, `artifact_path`, `revision_json`, `coverage_json` | |
| `packages` | `package_id`, `version`, `producer`, `path`, `manifest_sha256`, `imported_from_import_id?` | Immutable rows |
| `readiness_assessments` | `id`, `package_ref`, `activity`, `readiness`, `reasons_json` | |
| `test_plans` | `id`, `project_id`, `baseline_json`, `doc_json` | |
| `test_conditions` | `id`, `plan_id`, `basis_refs_json` | |
| `scenarios` | `scenario_id`, `project_id`, `display_key`, `latest_version` | |
| `scenario_versions` | `scenario_id`, `version`, `doc_json`, `status`, `freshness`, `content_sha256` | Approved versions are immutable (trigger prevents UPDATE of `doc_json`) |
| `approvals` | `id`, `scenario_id`, `version`, `binding_json`, `mode`, `state`, `approver`, `approved_at` | State changes recorded in `audit_events` |
| `runs` | `id`, `kind`, `state`, `environment_ref`, `baseline_json`, `started_at`, `finished_at` | Manual and automated |
| `case_results` / `step_results` | `run_id`, `scenario_id`, `version`, `step_id`, `doc_json` | **Append-only**; corrections create new records with `supersedes` |
| `defects` | `id`, `state`, `severity`, `priority`, `links_json` | |
| `defect_transitions` | `defect_id`, `seq`, `from`, `to`, `by`, `at`, `reason` | **Append-only** |
| `audit_events` | `seq`, `project_id?`, `at`, `actor`, `action`, `target`, `details_json`, `prev_hash`, `hash` | **Append-only**; details pass through the redactor, and fields it replaced are listed in `details.redacted_paths` (SEC-004, SEC-014). One hash chain per project and one for installation-wide events (`project_id` NULL): `hash = sha256(canonical JSON of the event and prev_hash)`. Deleting a project removes its chain; the installation-wide `project.deleted` event records that chain's last hash. Actions are the catalog `AUDIT_ACTIONS` in `@sys2qa/platform` |
| `model_usage` | `job_id?`, `project_id?`, `agent?`, `purpose`, `provider`, `model`, `prompt_template_version`, `tokens_in`, `tokens_out`, `cost?`, `outcome`, `duration_ms` | NFR-011; one row per LLM call, including failed calls (no prompt or output content). Attribution columns added by migration 0004 |
| `blob_pins` | `project_id`, `sha256`, `reason` | Evidence blobs kept beyond retention (migration 0006) |
| `settings` | `key`, `value_json` | Installation settings, including the administrator switches `l4_enabled` and `local_owner_mode_enabled` (both off by default; changes are audited as `settings.changed`), and `index_schema_version` |
| `schema_migrations` | `version`, `applied_at` | |

## 5. Index schema (SQLite `idx`, rebuildable)

| Table | Purpose |
|---|---|
| `idx_entities(id, run_id, kind, name, boundary, status, origin)` | Lookup and filter |
| `idx_entities_fts` | FTS5 over names and descriptions (search) |
| `idx_edges(from_id, to_id, type, status, run_id)` | Graph traversal (dependencies, impact) |
| `idx_workflows(id, run_id, category, discovery_status, completion, rank)` | Catalog views |
| `idx_claims(id, subject_id, status, run_id)` | Evidence drill-down |
| `idx_evidence(id, source_type, path_or_url, run_id)` | Evidence navigation |

Implementation (IMP-115, `packages/platform/src/skb/`): `writeSkbRun` writes canonical-JSON shards (`entities/<kind>/<nnn>.json`, `<collection>/<nnn>.json`, run documents `<name>.json`) atomically and `manifest.json` last with each file's record count and SHA-256; `readSkbRecords` verifies every file against the manifest; `indexSkbRun` validates each record against its contract schema and indexes the run in one transaction (counts must equal the manifest's); `rebuildIndex` clears the index and re-indexes every complete run, skipping and reporting a failing one; `queryEntities` (kind or quoted full-text terms), `queryEdges`, `queryWorkflows`. saa-core's `persistSkbRun` redacts the whole run (`redactOutput`) before handing it over. The adapter result cache (class E) lives in `<project>/cache/adapters/<key>.json`; the key hashes the adapter ID, version and protocol, the boundary, the batch's paths and fingerprints, and the root's list of included paths (import resolution depends on which files exist); `StructureResult.cache` reports hits and misses.

Rebuild procedure: drop `idx_*` → stream every `skb/` and `observed/` partition through the contract validator → insert in batches inside one transaction per run → verify counts against `manifest.json`.

## 6. Writes, transactions and consistency

1. **Artifacts.** Write to `<target>.tmp-<ulid>`, fsync, rename. A run directory becomes visible only when its `manifest.json` is renamed in **last**. Readers ignore directories without a manifest.
2. **Packages** are written to a staging directory, validated, checksummed, and then moved into `packages/` in one rename. They are never modified afterwards.
3. **State.** Every application-service command runs in one SQLite transaction (`BEGIN IMMEDIATE`). The audit event for the command is written in the same transaction.
4. **Cross-store ordering.** Artifacts are written first; the state row referencing them is committed second. Orphan artifacts (no referencing row) are removed by the recovery sweep. Rows never reference missing artifacts.
5. **Single writer.** Only the host writes `state.db`. Workers return results to the host; they never open the database. One host per home directory is enforced by `<sys2qa-home>/host.lock` (pid and hostname); a lock whose process no longer exists on this machine is taken over, and a lock from another hostname is always respected.

## 7. Operational notes for jobs (detail in a later Job Lifecycle spec)

- States: `queued` → `running` → `completed` | `failed`; `cancel` moves `queued` to `cancelled` and `running` to `cancelling`, then `cancelled` once the worker has stopped. Being leased is recorded by `lease_owner` and `lease_expires_at`, not by a separate state.
- Leasing: the host leases a job (`lease_owner`, `lease_expires_at`) and renews the lease while the worker reports progress.
- On host start, jobs with expired leases are marked `failed` (reason `host_restart`) or re-queued if their type is marked resumable and `attempt < max_attempts`.
- Idempotency: enqueue uses `idempotency_key`, so repeated requests reuse the existing job (NFR-004).
- Retries only for transient infrastructure errors; never for steps that are not idempotent (QAA-FR-067). A job type opts in with `retry: "transient"`; then only `TransientJobError` and worker crashes are retried, after `run_after` (exponential backoff, at most 60 s), while `attempt < max_attempts`. Every other failure is final.
- Cancellation: a queued job becomes `cancelled` at once. A running job becomes `cancelling`, its handler's `AbortSignal` fires (worker processes receive a `cancel` message), and after the grace period a worker process is killed. An in-process handler that ignores the signal is settled as `cancelled` and its later output is discarded, because its lease is gone. A job that finishes while `cancelling` still ends `cancelled`.
- Budgets (NFR-002): `budget_json` holds per-job limits. The orchestrator enforces `max_duration_ms` and passes `max_memory_mb` to worker processes as `--max-old-space-size`; handlers count other resources (`max_pages`, `max_files`, `max_tokens`, …). An exceeded budget fails the job with `BUDGET_EXHAUSTED`; a partial job is never `completed`.
- Stuck jobs (QAA-FR-102): a `running` or `cancelling` job whose lease expired, or which reported no progress (`last_progress_at`) within the configured window, is reported as stuck. Detection never cancels by itself.
- Error codes in `error_json`: `JOB_FAILED`, `JOB_CANCELLED`, `BUDGET_EXHAUSTED`, `WORKER_CRASHED`, `LEASE_EXPIRED`, `JOB_TYPE_UNKNOWN`.

## 8. Retention and deletion (SEC-015, OD-14)

| Data | Default retention | Configurable |
|---|---|:-:|
| SKB runs and observed models | Last 5 runs per project, plus any run referenced by a package | ✓ |
| Packages and imported originals | Kept until the project is deleted | ✓ |
| Evidence blobs (screenshots, traces) | 30 days, unless referenced by a defect or exported report | ✓ |
| Manual attachments | Kept with their run | ✓ |
| Caches | Evicted when larger than 2 GB (LRU) | ✓ |
| Logs | 14 days, rotated | ✓ |
| Audit events | Kept until the project is deleted; exportable | ✓ (min 90 days) |

These defaults are conservative initial values to be reviewed after Gate 3 feedback. They are not measured requirements.

Project deletion removes: the state rows (in one transaction), `projects/<id>/`, the project's secret references in class F, and index rows. A final audit event is written to a global audit table.

Implementation (IMP-019):
- **Deletion** (`deleteProjectEverywhere`, operation `project.delete`, which requires the project name as confirmation and is not available through MCP) runs in this order:
  1. writes the `project_deletions` tombstone;
  2. deletes the project's credential values (class F);
  3. removes `projects/<ulid>/`;
  4. deletes the index rows of the project's runs;
  5. deletes the state rows, plus the installation-wide `project.deleted` event carrying the head of the project's audit chain, in one transaction.

  Every step is idempotent. If a step fails (for example a locked secret store), the tombstone stays, `pendingDeletions` lists the project, and the next `system.retention_run` finishes it.
- **Retention** (`runRetention`, operation `system.retention_run`, `sys2qa retention run`) removes:
  - log files older than `log_days`;
  - evidence blobs whose modification time is older than `blob_days`, unless a defect's `links_json` names their hash or a `blob_pins` row (migration 0006: `defect`, `export` or `manual`) keeps them;
  - the least recently used cache files while a project's `cache/` exceeds `cache_max_bytes`.

  It never deletes audit events, packages or imported originals. Removal counts, without paths, are audited as `data.deleted`. Defaults are in the configuration (`retention`).
- SKB run retention: `sweepSkbRuns` (IMP-115) keeps the newest 5 complete runs per project plus the runs it is told are protected, and removes run directories without a manifest and `*.tmp-*` files. **Not yet wired** into `runRetention`: the list of runs a package references arrives with the package exporter (IMP-117).

## 9. Recovery

On every host start:
1. Run the integrity check (`PRAGMA quick_check`); on failure, refuse to start (`STATE_INTEGRITY_FAILED`) and print restore guidance. It runs before migrations so that a damaged file is never migrated.
2. Run migrations (forward-only).
3. Recover jobs with expired leases (§7).
4. Sweep `*.tmp-*` files and orphan run directories.
5. Rebuild the index if its version differs from the code's index version.

## 10. Migrations

- Numbered SQL migrations `NNNN_name.sql` in `packages/platform/migrations/`, contiguous from 0001; each runs in one `BEGIN IMMEDIATE` transaction and is recorded in `schema_migrations` with a sha256 of its text (line endings normalized). Each is tested on a fixture database from the previous version.
- The host refuses to start on a database that has a migration it does not know (`STATE_NEWER_THAN_CODE`, i.e. a downgrade) or whose applied migration text has changed (`STATE_MIGRATION_INVALID`).
- The index (class C) is not migrated: `migrations/index-schema.sql` is versioned by `INDEX_SCHEMA_VERSION`; on a mismatch every `idx_*` table is dropped and recreated empty, and the host rebuilds the index from artifacts (IMP-115).
- Connection settings: `journal_mode = WAL`, `synchronous = FULL` (authoritative state favors durability over write speed), `foreign_keys = ON`, `busy_timeout = 5000`.
- Artifact formats are never migrated in place. Reading an older contract version uses the contract library's compatibility rules (Contract Spec §10).
