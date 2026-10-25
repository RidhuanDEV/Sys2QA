# F3 — Combined: ground truth

Source: F1 (`../../F1-repository-only/repo/`). Runtime: `../runtime/server.mjs` (`startF3Runtime()`), which renders F1's pages as deployed, with three deliberate discrepancies. The source-side files (`entities.json`, `workflows.json`, `gaps.json`, `scenarios-expected.json`) are copies of F1's ground truth; `forbidden-claims.json` adds two runtime traps; `correlation.json` is specific to F3.

**Deviation from Test Strategy §4:** the runtime is a simulator rather than F1 itself, because F1 needs PostgreSQL and third-party packages that CI does not install. The simulator renders the same pages and forms; behaviors behind the API are out of scope for F3, which tests correlation.

## Expected correlation (`correlation.json`)

| Item | Expected |
|---|---|
| NIB constraint | `constraint_mismatch`: browser `pattern="[0-9]{16}"`, source `^[0-9]{13}$` (zod schema and DB CHECK) |
| `/admin/users` | In source, 404 at runtime: reported as a discrepancy and an unmatched source item, never as observed |
| `/promo` | Observed, with no source route: unmatched observed item; no invented source link |
| Revision correspondence | `unconfirmed`: nothing ties the deployment to the analyzed commit unless the user confirms it |

## Review

| Reviewer | Date | Result |
|---|---|---|
| _pending second-person review (IMP-013)_ | | |
