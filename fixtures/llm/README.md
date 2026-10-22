# LLM cassettes

Recorded model responses for the replay harness (Test Strategy §3, ADR-008). CI replays them through `ReplayBackend`
and never calls a live provider.

- One file per prompt: `cassettes/<key>.json`, where `key` hashes the exact messages and generation settings that
  `LlmService` sends (after redaction and data wrapping). The model is recorded in the file but is not part of the key.
- Changing a prompt template changes the key, so the replay test fails with `LLM_REPLAY_MISSING` until the cassette is
  re-recorded. Re-record by running the affected test with `SYS2QA_RECORD_LLM=1` against the intended backend, review
  the new file, and delete the stale one.
- Tests assert structure (schema validity, fields present), not exact wording.
- Cassettes must not contain secrets; they pass the same redaction as every prompt.
