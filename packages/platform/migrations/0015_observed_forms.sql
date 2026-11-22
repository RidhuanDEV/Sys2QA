-- Forms seen during discovery and people's confirmations of them (IMP-403, SEC-024, OD-29). Heuristics only propose
-- what a form does; a form is submitted as read-only only after a person confirms it, per environment, on first use.
CREATE TABLE observed_forms (
  environment_id TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  form_key TEXT NOT NULL CHECK (form_key LIKE 'form:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,
  proposal TEXT NOT NULL CHECK (proposal IN ('read_only', 'login', 'state_changing', 'unknown')),
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (environment_id, form_key)
) STRICT;

-- Append-only; the latest confirmation of a form decides.
CREATE TABLE form_confirmations (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  form_key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('read_only', 'not_read_only')),
  confirmed_by TEXT NOT NULL CHECK (length(confirmed_by) > 0),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX form_confirmations_form ON form_confirmations (environment_id, form_key, created_at);
