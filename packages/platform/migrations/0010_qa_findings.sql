-- What the critic found (IMP-206, PRD §15.13, QAA-FR-016/034/035): checklist results and duplicates per scenario
-- version, and conflict records between sources. A new critique replaces the findings of the scenarios it checked.
CREATE TABLE qa_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('checklist', 'duplicate', 'conflict')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  version INTEGER,
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX qa_findings_subject ON qa_findings (project_id, kind, subject_id);
