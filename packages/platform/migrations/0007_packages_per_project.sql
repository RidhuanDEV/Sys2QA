-- Packages are keyed per project (IMP-201): the same package version can be imported into several projects, and a
-- stored package row never changes (Data Model §4, "immutable rows").
CREATE TABLE packages_new (
  package_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  producer TEXT NOT NULL CHECK (producer IN ('SAA', 'QAA')),
  path TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 LIKE 'sha256:%' AND length(manifest_sha256) = 71),
  imported_from_import_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, package_id, version)
) STRICT;

INSERT INTO packages_new
  SELECT package_id, version, project_id, producer, path, manifest_sha256, imported_from_import_id, created_at, updated_at
  FROM packages;
DROP TABLE packages;
ALTER TABLE packages_new RENAME TO packages;

CREATE TRIGGER packages_no_update BEFORE UPDATE ON packages
BEGIN SELECT RAISE(ABORT, 'packages are immutable'); END;
