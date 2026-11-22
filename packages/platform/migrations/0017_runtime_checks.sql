-- QAA's targeted runtime verification (IMP-408, QAA-FR-029): chosen package items checked in an L2 browser worker
-- within a page and time budget. Kept in the QAA store as `targeted_runtime_check` evidence, never written into a
-- package. A record whose budget ran out is `partial` and lists the items left unverified.
CREATE TABLE runtime_checks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  package_version INTEGER NOT NULL CHECK (package_version >= 1),
  environment_id TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  job_id TEXT NOT NULL CHECK (job_id LIKE 'job:%'),
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX runtime_checks_package ON runtime_checks (project_id, package_id, package_version);
