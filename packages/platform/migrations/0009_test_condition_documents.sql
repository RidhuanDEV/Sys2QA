-- Test conditions keep their semantic ID and their document (IMP-204, QAA-FR-048): `id` is `<plan-id>#<condition-id>`.
ALTER TABLE test_conditions ADD COLUMN condition_id TEXT NOT NULL DEFAULT '';
ALTER TABLE test_conditions ADD COLUMN doc_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(doc_json));
CREATE UNIQUE INDEX test_conditions_plan_condition ON test_conditions (plan_id, condition_id);
