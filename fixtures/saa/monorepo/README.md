# Monorepo fixture (IMP-104)

A pnpm workspace used to check project boundary detection (SAA-FR-002) and the stack inventory (SAA-FR-003).
`expected.json` lists the boundaries that `detectStack` must produce, with the reason for each:

- `apps/web`, `apps/api`, `packages/shared`: declared workspace members.
- `packages/legacy-billing`: excluded by the `!packages/legacy-*` pattern, so it is a nested, inferred candidate.
- `services/worker`: a Python project outside the declared members, also nested and inferred.
- The root: a workspace root that also owns the loose files (`docs/`, `infra/`).
- `infra/terraform/main.tf` has no known format and must be reported as unknown (`.tf`), not mislabeled.
