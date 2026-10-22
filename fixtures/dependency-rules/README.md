# Dependency-rule fixtures

A miniature `apps/` + `packages/` tree in which each file breaks (or, for the clean files, respects) one rule of `scripts/dependency-rules.mjs`. `tests/architecture/dependency-rules.test.ts` cruises it and compares the violations per file with `expected.json` (IMP-002). These files are never built, type-checked or imported by product code.
