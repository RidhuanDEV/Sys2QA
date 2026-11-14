-- QAA's targeted source checks (IMP-209, QAA-FR-017): a package record's evidence compared with the local checkout,
-- read-only. Kept in the QAA store as `targeted_source_check` evidence, never written into a package.
CREATE TABLE source_checks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  package_version INTEGER NOT NULL CHECK (package_version >= 1),
  record_id TEXT NOT NULL CHECK (length(record_id) > 0),
  result TEXT NOT NULL CHECK (result IN ('confirmed', 'not_confirmed', 'unconfirmed')),
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX source_checks_record ON source_checks (project_id, package_id, package_version, record_id);
