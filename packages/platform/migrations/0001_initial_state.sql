-- Operational state schema (class B), Data Model §4. Forward-only: never edit after release; add a new migration.
-- Conventions: STRICT tables; IDs are TEXT `<kind>:<id>`; timestamps are RFC 3339 UTC TEXT; *_json columns hold valid JSON.
-- Append-only tables reject UPDATE always, and DELETE unless their project has a project_deletions tombstone (IMP-019).

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK (id LIKE 'project:%'),
  name TEXT NOT NULL CHECK (length(name) > 0),
  default_languages_json TEXT NOT NULL CHECK (json_valid(default_languages_json) AND json_type(default_languages_json) = 'array'),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Tombstone written before a project is deleted (SEC-015). No foreign key: it outlives the project, so the
-- append-only guards below can still see it while ON DELETE CASCADE removes the project's rows.
CREATE TABLE project_deletions (
  project_id TEXT PRIMARY KEY CHECK (project_id LIKE 'project:%'),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('source_root', 'environment', 'package')),
  ref TEXT NOT NULL CHECK (length(ref) > 0),
  added_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX evidence_sources_project ON evidence_sources (project_id);

CREATE TABLE authorization_declarations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  evidence_source_id TEXT NOT NULL REFERENCES evidence_sources (id) ON DELETE CASCADE,
  declared_by TEXT NOT NULL CHECK (length(declared_by) > 0),
  declared_at TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  operation_level TEXT NOT NULL CHECK (operation_level IN ('L0', 'L1', 'L2', 'L2r', 'L3', 'L4')),
  prohibitions_json TEXT NOT NULL CHECK (json_valid(prohibitions_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX authorization_declarations_source ON authorization_declarations (evidence_source_id, declared_at);

CREATE TABLE environments (
  id TEXT PRIMARY KEY CHECK (id LIKE 'env:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  base_url TEXT NOT NULL CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
  -- 'production' is recordable so that the policy engine can refuse it explicitly (SEC-009, PRODUCTION_REFUSED).
  classification TEXT NOT NULL CHECK (classification IN ('development', 'staging', 'production')),
  state TEXT NOT NULL CHECK (state IN ('configured', 'validated', 'unreachable', 'disabled')),
  local_owner_mode INTEGER NOT NULL DEFAULT 0 CHECK (local_owner_mode IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX environments_project ON environments (project_id);

CREATE TABLE scope_policies (
  environment_id TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (environment_id, version)
) STRICT;

CREATE TABLE credential_profiles (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  role_name TEXT NOT NULL CHECK (length(role_name) > 0),
  -- Only a reference; the value lives in the secret store (class F, SEC-011).
  secret_ref TEXT NOT NULL CHECK (secret_ref LIKE 'secretref:%'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (environment_id, role_name)
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK (id LIKE 'job:%'),
  type TEXT NOT NULL CHECK (length(type) > 0),
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
  idempotency_key TEXT UNIQUE,
  lease_owner TEXT,
  lease_expires_at TEXT,
  cancel_requested_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
) STRICT;
CREATE INDEX jobs_queue ON jobs (state, priority DESC, created_at);
CREATE INDEX jobs_project ON jobs (project_id);

CREATE TABLE job_events (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  event TEXT NOT NULL CHECK (length(event) > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
) STRICT;

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY CHECK (id LIKE 'run:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  producer TEXT NOT NULL CHECK (producer IN ('SAA', 'QAA')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_limitations', 'partial', 'failed', 'cancelled')),
  artifact_path TEXT,
  revision_json TEXT CHECK (revision_json IS NULL OR json_valid(revision_json)),
  coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX analysis_runs_project ON analysis_runs (project_id, created_at);

CREATE TABLE packages (
  package_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  producer TEXT NOT NULL CHECK (producer IN ('SAA', 'QAA')),
  path TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 LIKE 'sha256:%' AND length(manifest_sha256) = 71),
  imported_from_import_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (package_id, version)
) STRICT;

CREATE TABLE readiness_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  package_ref_json TEXT NOT NULL CHECK (json_valid(package_ref_json)),
  activity TEXT NOT NULL CHECK (activity IN ('scenario_design', 'manual_preparation', 'automated_execution')),
  readiness TEXT NOT NULL CHECK (readiness IN ('ready', 'ready_with_gaps', 'review_only', 'blocked')),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE test_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  baseline_json TEXT NOT NULL CHECK (json_valid(baseline_json)),
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE test_conditions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES test_plans (id) ON DELETE CASCADE,
  basis_refs_json TEXT NOT NULL CHECK (json_valid(basis_refs_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE scenarios (
  scenario_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  display_key TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, display_key)
) STRICT;

CREATE TABLE scenario_versions (
  scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  status TEXT NOT NULL CHECK (status IN ('draft', 'needs_clarification', 'pending_review', 'approved', 'rejected', 'deferred', 'superseded')),
  freshness TEXT NOT NULL CHECK (freshness IN ('current', 'potentially_stale', 'stale')),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 LIKE 'sha256:%' AND length(content_sha256) = 71),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scenario_id, version)
) STRICT;

-- An approved scenario version is immutable (QAA-FR-052); only its status and freshness may change.
CREATE TRIGGER scenario_versions_immutable_once_approved
BEFORE UPDATE OF scenario_id, version, doc_json, content_sha256 ON scenario_versions
WHEN OLD.status IN ('approved', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'scenario version is immutable once approved');
END;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY CHECK (id LIKE 'approval:%'),
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'automated')),
  state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'invalidated', 'superseded', 'revoked')),
  approver TEXT NOT NULL CHECK (length(approver) > 0),
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (scenario_id, version) REFERENCES scenario_versions (scenario_id, version) ON DELETE CASCADE
) STRICT;
CREATE INDEX approvals_scenario ON approvals (scenario_id, version);

CREATE TABLE runs (
  id TEXT PRIMARY KEY CHECK (id LIKE 'run:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'automated')),
  state TEXT NOT NULL CHECK (state IN ('created', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'blocked', 'abandoned')),
  environment_ref TEXT NOT NULL,
  baseline_json TEXT NOT NULL CHECK (json_valid(baseline_json)),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX runs_project ON runs (project_id, created_at);

CREATE TABLE case_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  -- Corrections create a new record that supersedes the old one (append-only).
  supersedes TEXT REFERENCES case_results (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX case_results_run ON case_results (run_id, scenario_id);

CREATE TABLE step_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  supersedes TEXT REFERENCES step_results (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX step_results_run ON step_results (run_id, scenario_id, step_id);

CREATE TABLE defects (
  id TEXT PRIMARY KEY CHECK (id LIKE 'defect:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('new', 'triaged', 'confirmed', 'rejected', 'duplicate', 'needs_info', 'fixed', 'ready_for_retest', 'closed', 'reopened')),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'major', 'minor', 'trivial')),
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  links_json TEXT NOT NULL CHECK (json_valid(links_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE defect_transitions (
  defect_id TEXT NOT NULL REFERENCES defects (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (defect_id, seq)
) STRICT;

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY,
  -- NULL for installation-wide events, which survive project deletion.
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) > 0),
  target TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  -- Hash chain for tamper evidence (filled by the audit service, IMP-009).
  prev_hash TEXT,
  hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX audit_events_project ON audit_events (project_id, seq);

CREATE TABLE model_usage (
  id INTEGER PRIMARY KEY,
  job_id TEXT REFERENCES jobs (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  tokens_in INTEGER NOT NULL CHECK (tokens_in >= 0),
  tokens_out INTEGER NOT NULL CHECK (tokens_out >= 0),
  cost REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Append-only guards (Data Model §4). DELETE is allowed only for rows of a project with a deletion tombstone.
CREATE TRIGGER project_deletions_no_update BEFORE UPDATE ON project_deletions
BEGIN SELECT RAISE(ABORT, 'project_deletions is append-only'); END;
CREATE TRIGGER project_deletions_no_delete BEFORE DELETE ON project_deletions
BEGIN SELECT RAISE(ABORT, 'project_deletions is append-only'); END;

CREATE TRIGGER authorization_declarations_no_update BEFORE UPDATE ON authorization_declarations
BEGIN SELECT RAISE(ABORT, 'authorization_declarations is append-only'); END;
CREATE TRIGGER authorization_declarations_no_delete BEFORE DELETE ON authorization_declarations
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'authorization_declarations is append-only'); END;

CREATE TRIGGER scope_policies_no_update BEFORE UPDATE ON scope_policies
BEGIN SELECT RAISE(ABORT, 'scope_policies is append-only'); END;
CREATE TRIGGER scope_policies_no_delete BEFORE DELETE ON scope_policies
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'scope_policies is append-only'); END;

CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;

CREATE TRIGGER case_results_no_update BEFORE UPDATE ON case_results
BEGIN SELECT RAISE(ABORT, 'case_results is append-only'); END;
CREATE TRIGGER case_results_no_delete BEFORE DELETE ON case_results
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'case_results is append-only'); END;

CREATE TRIGGER step_results_no_update BEFORE UPDATE ON step_results
BEGIN SELECT RAISE(ABORT, 'step_results is append-only'); END;
CREATE TRIGGER step_results_no_delete BEFORE DELETE ON step_results
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'step_results is append-only'); END;

CREATE TRIGGER defect_transitions_no_update BEFORE UPDATE ON defect_transitions
BEGIN SELECT RAISE(ABORT, 'defect_transitions is append-only'); END;
CREATE TRIGGER defect_transitions_no_delete BEFORE DELETE ON defect_transitions
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'defect_transitions is append-only'); END;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
