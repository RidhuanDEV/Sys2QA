import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript sources under the "source" condition,
// so tests run against src/ without a build step (see tsconfig.base.json customConditions).
export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    passWithNoTests: false,
  },
});
