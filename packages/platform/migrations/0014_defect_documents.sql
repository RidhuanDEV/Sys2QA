-- Defects (IMP-303, QAA-FR-084, QAA-FR-088, PRD §15.12): the contract document of each defect (title, description,
-- suspected type, baseline, environment and links). `links_json` also names the hashes of the evidence blobs it links,
-- so retention keeps them (Data Model §8).
ALTER TABLE defects ADD COLUMN doc_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(doc_json));
CREATE INDEX defects_project ON defects (project_id, state);
