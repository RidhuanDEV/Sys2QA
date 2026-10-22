import { describe, expect, it } from "vitest";
import { checkBrowserRuntime, checkContainerRuntime } from "../src/index.js";

describe("runtime prerequisites [@req NFR-007]", () => {
  it("reports the browser and container runtimes as optional, with remediation when missing", async () => {
    for (const check of [await checkBrowserRuntime(), checkContainerRuntime()]) {
      expect(["ok", "warn"]).toContain(check.status);
      expect(check.required_for.length).toBeGreaterThan(0);
      if (check.status === "warn") expect(check.remediation).toBeTruthy();
    }
  }, 20_000);
});
