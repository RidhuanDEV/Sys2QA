-- Environment scope inputs (IMP-006): allowed hosts and path prefixes the scope policy is derived from (QAA-FR-002).
ALTER TABLE environments ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json));
