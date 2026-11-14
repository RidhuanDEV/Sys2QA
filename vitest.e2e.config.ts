import { defineConfig } from "vitest/config";

// Web UI end-to-end tests (Test Strategy §3): a real Chromium against the host's loopback API and the built UI.
export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    passWithNoTests: false,
    testTimeout: 180_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
