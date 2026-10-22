-- Job scheduling (IMP-008): a retried job waits until run_after (bounded retries with backoff, NFR-004, QAA-FR-067),
-- and last_progress_at lets the host detect stuck jobs (QAA-FR-102).
ALTER TABLE jobs ADD COLUMN run_after TEXT;
ALTER TABLE jobs ADD COLUMN last_progress_at TEXT;
DROP INDEX jobs_queue;
CREATE INDEX jobs_queue ON jobs (state, priority DESC, created_at, id);
