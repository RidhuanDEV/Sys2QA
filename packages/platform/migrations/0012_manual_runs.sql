-- Manual runs (IMP-301, PRD §16, QAA-FR-080–089). The run tables of 0001 were never written by any release; they are
-- replaced so that run IDs follow the QAA kinds (`mrun:` manual, `arun:` automated; PRD §11), a manual run keeps its
-- planned cases and its progress, and attachments are recorded as QAA evidence (`qevid:`).
DROP TABLE step_results;
DROP TABLE case_results;
DROP TABLE runs;

CREATE TABLE runs (
  id TEXT PRIMARY KEY CHECK (id LIKE 'mrun:%' OR id LIKE 'arun:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'automated')),
  state TEXT NOT NULL CHECK (state IN ('created', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'blocked', 'abandoned')),
  environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
  baseline_json TEXT NOT NULL CHECK (json_valid(baseline_json)),
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  language TEXT NOT NULL,
  tester TEXT NOT NULL CHECK (length(tester) > 0),
  -- Set when the project's baseline moved on while the run was open (PRD §16 failure paths).
  baseline_changed INTEGER NOT NULL DEFAULT 0 CHECK (baseline_changed IN (0, 1)),
  abandon_reason TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((id LIKE 'mrun:%') = (kind = 'manual')),
  CHECK (state <> 'abandoned' OR length(abandon_reason) > 0)
) STRICT;
CREATE INDEX runs_project ON runs (project_id, created_at);

-- The scenario versions a run executes, each with the active approval it rests on (QAA-FR-080).
CREATE TABLE run_cases (
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  scenario_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  approval_id TEXT NOT NULL CHECK (approval_id LIKE 'approval:%'),
  PRIMARY KEY (run_id, scenario_id),
  FOREIGN KEY (scenario_id, version) REFERENCES scenario_versions (scenario_id, version)
) STRICT;

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
  -- A step recorded again supersedes its earlier record (append-only).
  supersedes TEXT REFERENCES step_results (id),
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX step_results_run ON step_results (run_id, scenario_id, step_id);

-- Files a tester attached to a step (SEC-019: type- and size-limited), stored as content-addressed blobs.
CREATE TABLE run_attachments (
  id TEXT PRIMARY KEY CHECK (id LIKE 'qevid:%'),
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 LIKE 'sha256:%'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  redacted INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX run_attachments_run ON run_attachments (run_id, scenario_id, step_id);
