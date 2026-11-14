# ADR-002: TypeScript pnpm monorepo

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-22 |
| Decided by | Maintainer (OD-05 language, OD-10 npm distribution); tooling choices under maintainer delegation |
| PRD links | OD-05, OD-10, §9.8, §31.5, NFR-008 |

## Context
OD-05 chose a TypeScript monorepo. OD-10 chose npm distribution. Tooling must keep module boundaries enforceable and builds reproducible.

## Decision
- **Language:** TypeScript in strict mode, ES modules.
- **Runtime:** Node.js Active LTS at monorepo creation; the minimum version is pinned in `engines` and tested in CI. At the time of writing the 24.x line is LTS; verify before pinning.
- **Workspace:** pnpm workspaces with a committed lockfile.
- **Tests:** Vitest for unit and integration tests; Playwright Test for browser-level tests.
- **Lint and format:** ESLint (typescript-eslint) and Prettier.
- **Boundaries:** dependency-cruiser rules in CI (IMP-002).
- **Web UI:** React with Vite, served locally by the host.
- **Local HTTP API for the web UI:** Fastify, bound to loopback only.
- **Published packages:** the CLI package is the npm entry point. Internal packages are bundled or published under one scope; final names are chosen at scaffold time.

## Alternatives considered
| Alternative | Why not chosen |
|---|---|
| npm or Yarn workspaces | pnpm's strict node_modules layout surfaces undeclared dependencies, which supports boundary enforcement |
| Jest | Vitest is faster with ESM and TypeScript and needs less configuration |
| Next.js for the web UI | The UI is a local single-page app served by the host; server rendering adds nothing |

## Consequences
- Positive: one toolchain for core, CLI, UI, MCP and Playwright.
- Negative: native modules (SQLite driver) need prebuilt binaries per OS (tested in IMP-901).
- Follow-up: IMP-001, IMP-002.

## Verification
CI runs on Linux, macOS and Windows; clean-machine install tests (IMP-901).

## Amendment 2026-11-14 (IMP-211)
- **Web UI build:** esbuild (already used to bundle adapters) bundles the React SPA into static files; Vite is not
  added. The UI is served by the host and needs no development server or plugin pipeline; switching to Vite later
  changes only `scripts/web-bundle.mjs`.
- **Browser-level tests:** the Playwright library (Chromium) driven from Vitest (`vitest.e2e.config.ts`) instead of the
  Playwright Test runner. One runner and one JSON report feed the traceability report and the gate report; the
  browser engine and its automation API are the same.
