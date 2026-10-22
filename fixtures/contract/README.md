# Contract fixtures

- `valid/<schema>.<case>.json`: canonical, schema-valid example documents. They are validated in CI (`packages/contract/test`) and are the authoritative version of the abbreviated examples in the PRD.
- `invalid/<error-code>/…`: added in IMP-005, one or more per error code and semantic rule (Contract Specification §12).
