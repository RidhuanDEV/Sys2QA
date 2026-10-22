-- Model usage per project, job and agent (NFR-011, IMP-011).
ALTER TABLE model_usage ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE CASCADE;
ALTER TABLE model_usage ADD COLUMN agent TEXT CHECK (agent IS NULL OR agent IN ('SAA', 'QAA'));
ALTER TABLE model_usage ADD COLUMN purpose TEXT;
ALTER TABLE model_usage ADD COLUMN outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error'));
ALTER TABLE model_usage ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0);
CREATE INDEX model_usage_project ON model_usage (project_id, created_at);
CREATE INDEX model_usage_job ON model_usage (job_id);
