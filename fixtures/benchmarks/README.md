# Benchmark fixtures (IMP-013, Test Strategy §4)

| Fixture | Content | Started by the harness |
|---|---|---|
| `F1-repository-only/` | Express + React Router + SQL + Prisma app with only an outdated README (`repo/`), 7 workflows | — |
| `F2-url-only/` | 16-page development site with traps (`site/server.mjs`) | `startF2Site()` |
| `F3-combined/` | F1 source + a runtime with three deliberate discrepancies (`runtime/server.mjs`) | `startF3Runtime()` |
| `F4-incomplete-evidence/` | Frontend-only repository with a missing backend, a missing queue consumer and a runtime feature switch (`repo/`) | — |

Each fixture has `ground-truth/` in the format of Test Strategy §4.1 and a `README.md` with the rationale of every item. `pnpm bench` measures producers against them; `tests/benchmark/fixtures.test.ts` checks that every ground-truth item is consistent and present in its fixture.

These directories imitate third-party code: they are excluded from linting and formatting, contain a planted fake secret and injected instructions on purpose, and must never be executed except through the harness (`postinstall` scripts must never run, ST-02).

**Status:** ground truth is a first version. Test Strategy §4 requires a second person to review every ground-truth file; each fixture README has a review table that is still empty.

## Dependency manifests in fixtures

The `package.json` (and `pyproject.toml`) files inside fixture repositories are analysis input only: they are never
installed or run (SEC-002), and they are outside the pnpm workspace. GitHub's dependency scanning still reads them, so
their version ranges are kept on releases without known advisories (checked with the npm advisory database); bumping
a range changes no ground truth.
