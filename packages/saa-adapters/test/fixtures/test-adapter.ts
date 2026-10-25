// Protocol test adapter built on the SDK. The first argument selects a behavior the host must handle.
import { readFileSync } from "node:fs";
import { serveAdapter } from "../../src/sdk.js";

const mode = process.argv[2] ?? "normal";

void serveAdapter({
  initialize: () => ({
    adapter_id: mode === "wrong-id" ? "someone-else" : "test-adapter",
    adapter_version: "1.0.0",
    protocol_version: mode === "v2" ? "2.0.0" : "1.1.0",
    support_matrix: {
      languages: [{ name: "typescript", versions: ">=4" }],
      scanned_only_languages: ["markdown"],
      frameworks: [
        {
          name: "express",
          versions: "4.x",
          entities: ["route", "api"],
          relations: ["EXPOSES", "CALLS"],
          workflow_tracing: "partial",
          fixtures: ["fixtures/benchmarks/F1-repository-only"],
        },
      ],
      prerequisites: [],
      limitations: ["dynamic route registration is unresolved"],
    },
  }),
  analyze: async (params, context) => {
    if (mode === "crash") process.exit(3);
    if (mode === "garbage") process.stdout.write("this is not a protocol message\n");
    if (mode === "invalid")
      return { entities: [{ id: "no kind" }], relationships: [], evidence: [], coverage: [] } as never;
    if (mode === "flood")
      return {
        entities: [],
        relationships: [],
        evidence: [],
        coverage: [{ area: "x".repeat(2_000_000), status: "analyzed" }],
      };
    if (mode === "hang") await new Promise(() => undefined);
    if (mode === "cooperative")
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    if (mode === "fail") throw new Error("parser exploded on DB_PASSWORD=hunter2hunter2");
    const coverage = params.files.map((file, i) => {
      context.progress(i + 1, params.files.length);
      const lines = readFileSync(file.path, "utf8").split("\n").length;
      return { area: file.path, status: "analyzed" as const, reason: `${lines} lines` };
    });
    return { entities: [], relationships: [], evidence: [], coverage };
  },
});
