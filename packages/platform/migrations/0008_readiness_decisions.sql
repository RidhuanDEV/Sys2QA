-- People's readiness decisions (IMP-202, PRD §13.9, OD-04). Both are append-only: the latest row applies.
-- A baseline confirmation states that the target runs the package's working tree (dirty or non-Git revision).
CREATE TABLE baseline_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  package_version INTEGER NOT NULL CHECK (package_version >= 1),
  confirmed_by TEXT NOT NULL CHECK (length(confirmed_by) > 0),
  statement TEXT NOT NULL CHECK (length(statement) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX baseline_confirmations_package ON baseline_confirmations (project_id, package_id, package_version);

-- A materiality override marks a gap material or not material for the project's QA scope, with a reason.
CREATE TABLE materiality_overrides (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  gap_id TEXT NOT NULL CHECK (length(gap_id) > 0),
  material INTEGER NOT NULL CHECK (material IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  overridden_by TEXT NOT NULL CHECK (length(overridden_by) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX materiality_overrides_gap ON materiality_overrides (project_id, gap_id, created_at);

CREATE TRIGGER baseline_confirmations_no_update BEFORE UPDATE ON baseline_confirmations
BEGIN SELECT RAISE(ABORT, 'baseline_confirmations is append-only'); END;
CREATE TRIGGER baseline_confirmations_no_delete BEFORE DELETE ON baseline_confirmations
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'baseline_confirmations is append-only'); END;

CREATE TRIGGER materiality_overrides_no_update BEFORE UPDATE ON materiality_overrides
BEGIN SELECT RAISE(ABORT, 'materiality_overrides is append-only'); END;
CREATE TRIGGER materiality_overrides_no_delete BEFORE DELETE ON materiality_overrides
WHEN NOT EXISTS (SELECT 1 FROM project_deletions WHERE project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'materiality_overrides is append-only'); END;
