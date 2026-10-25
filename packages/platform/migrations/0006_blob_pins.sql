-- Evidence blobs kept beyond retention (IMP-019, Data Model §8): pinned by a defect, an exported report or a person.
CREATE TABLE blob_pins (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK (reason IN ('defect', 'export', 'manual')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, sha256, reason)
) STRICT;
