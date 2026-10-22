-- Index schema (class C), Data Model §5. Rebuildable: it is not migrated but dropped and recreated whenever
-- INDEX_SCHEMA_VERSION in src/storage/index-schema.ts changes, after which the index is rebuilt from artifacts (IMP-115).
-- Every object in this file must be named idx_*.

CREATE TABLE idx_entities (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  boundary TEXT,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
) STRICT;
CREATE INDEX idx_entities_kind ON idx_entities (kind, run_id);

CREATE VIRTUAL TABLE idx_entities_fts USING fts5 (id UNINDEXED, run_id UNINDEXED, name, description);

CREATE TABLE idx_edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT NOT NULL
) STRICT;
CREATE INDEX idx_edges_from ON idx_edges (run_id, from_id);
CREATE INDEX idx_edges_to ON idx_edges (run_id, to_id);

CREATE TABLE idx_workflows (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  category TEXT NOT NULL,
  discovery_status TEXT NOT NULL,
  completion TEXT NOT NULL,
  rank INTEGER,
  PRIMARY KEY (run_id, id)
) STRICT;

CREATE TABLE idx_claims (
  id TEXT NOT NULL,
  subject_id TEXT,
  status TEXT NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
) STRICT;
CREATE INDEX idx_claims_subject ON idx_claims (run_id, subject_id);

CREATE TABLE idx_evidence (
  id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  path_or_url TEXT,
  run_id TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
) STRICT;
