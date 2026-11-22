-- Runtime discovery runs (IMP-404, QAA-FR-021–026): one bounded walk of an environment by an L2 worker. The full
-- observation set is a class A artifact under the project's discovery/ directory; this row holds its summary.
CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY CHECK (id LIKE 'job:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  scope_policy_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'completed_with_limitations', 'stopped', 'failed')),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  artifact_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX discovery_runs_environment ON discovery_runs (environment_id, created_at);
ALTER TABLE credential_profiles ADD COLUMN login_url TEXT;
