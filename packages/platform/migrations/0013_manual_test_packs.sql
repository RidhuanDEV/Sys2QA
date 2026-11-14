-- Manual test packs (IMP-302, QAA-FR-112): approved scenarios exported for execution without a configured environment.
-- Each pack names the run ID its result template carries, so filled-in results import back once, into that run.
CREATE TABLE manual_test_packs (
  id TEXT PRIMARY KEY CHECK (id LIKE 'mpack:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE CHECK (run_id LIKE 'mrun:%'),
  language TEXT NOT NULL,
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  path TEXT NOT NULL,
  imported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX manual_test_packs_project ON manual_test_packs (project_id, created_at);
