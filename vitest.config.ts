import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript sources under the "source" condition,
// so tests run against src/ without a build step (see tsconfig.base.json customConditions).
export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    // Browser end-to-end tests need Chromium; they run with `pnpm e2e` (vitest.e2e.config.ts).
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    passWithNoTests: false,
    // Many tests run real flows (SQLite, files, child processes). Windows CI runners are several times slower than
    // Linux ones and repeatedly pushed such tests past Vitest's 5 s default; 30 s still catches a hang.
    testTimeout: 30_000,
  },
});
