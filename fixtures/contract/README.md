# Contract fixtures

Authoritative examples of the contract; the inline examples in the PRD are illustrative (PRD §13.1). Layout and rules: Contract Specification §12.

- `valid/<schema>.<case>.json`: canonical single documents, maintained by hand.
- `packages/valid/<case>/`: complete Documentation Packages (`mode-a-saa`, `mode-b-qaa`), maintained by hand. Run `pnpm fixtures` after editing one, to rewrite its manifest checksums.
- `invalid/<error-code>/<case>/`: conformance cases, **generated** by `pnpm fixtures` from the valid fixtures. Do not edit them by hand; change `packages/contract/scripts/fixtures.mjs` instead. `expected.json` states the validator (`kind`), the code, the rule, the severity and whether the input is still accepted (`ok`).

`pnpm fixtures:check` (part of `pnpm verify` and CI) fails when anything generated is out of date.
