# Contract changelog

Governance: Contract Specification §11 (OD-15). Every change lists the schemas touched, the version bump, and the fixtures added.

## 1.0.0 — 2026-10-22 (IMP-003)

Initial contract release. 18 schemas: `common`, `package-manifest`, `system-model`, `evidence-index`, `diff-report`, `correlation-report`, `analysis-request`, `analysis-response`, `completeness-report`, `readiness-assessment`, `test-plan`, `scenario`, `approval`, `manual-test-pack`, `run-result`, `defect`, `adapter-protocol`, `error`.

Structural rules enforced by the schemas themselves (semantic rules that need cross-document checks arrive with IMP-004):
- evidence profile ↔ `repository` / `observed_environments` consistency (part of CR-021);
- production environments rejected (SEC-009);
- workflow `discovery_status` ↔ `unresolved_hops` (CR-040, CR-041);
- oracle class derived from expected-result basis (CR-052); `saa_status` required for `saa_documented` (part of CR-053);
- inferred items need a rationale; unresolved items need a gap (part of CR-001);
- manual results tester-reported; automated runs and approvals need a configured environment (part of CR-055);
- readiness assessments carry no aggregate score (CON-028); completeness counts are scoped (CR-043).

Amendment before release (IMP-004): `system-model` gap gained the optional `coverage_category` so that CR-030 can match gaps to coverage categories. No released artifact exists yet, so this stays 1.0.0.

Fixtures (IMP-005): every schema has a canonical example, in `fixtures/contract/valid/` or as part of the two valid packages in `fixtures/contract/packages/valid/`. `fixtures/contract/invalid/` holds the conformance cases, one or more per contract-detected error code and per semantic rule (Contract Specification §12).

Validator change before release (IMP-009): secret detection (CR-060) gained the `bearer_token` detector (`Bearer` followed by at least 16 token characters). `redactSecrets` reuses the detectors for redaction and masks a private key through its END marker. No schema changed.
