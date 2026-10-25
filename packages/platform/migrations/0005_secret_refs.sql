-- Secret references (IMP-010, ADR-011): which project owns each `secretref:`. Values are never stored here; they live in
-- the OS credential store or the encrypted fallback file.
CREATE TABLE secret_refs (
  ref TEXT PRIMARY KEY CHECK (ref LIKE 'secretref:%'),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) > 0),
  backend TEXT NOT NULL CHECK (backend IN ('os', 'file', 'memory')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
) STRICT;
