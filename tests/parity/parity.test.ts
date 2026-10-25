import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../apps/cli/src/index.js";
import { OPERATIONS, type ServiceResult } from "../../packages/app-services/src/index.js";
import { apiRunner, cliRunner, mcpRunner, type Runner } from "./harness.js";

const ROOT = resolve("/work/acme-portal");
const PACKAGE = fileURLToPath(new URL("../../fixtures/contract/packages/valid/mode-a-saa/", import.meta.url));
const data = (r: ServiceResult) => (r.ok ? (r.data as Record<string, unknown>) : {});

/** One onboarding script (Modes A then C), with failures, run through every interface (SYS-005, IMP-902 grows it). */
type Step = [operation: string, input: (results: ServiceResult[]) => unknown];
const SCRIPT: Step[] = [
  ["system.info", () => ({})],
  ["project.create", () => ({ name: "Acme portal", languages: ["en", "id"] })],
  ["project.create", () => ({ name: "" })],
  ["project.add_source", (r) => ({ project_id: data(r[1]!).id, kind: "source_root", ref: ROOT })],
  [
    "policy.check",
    (r) => ({ source_id: data(r[3]!).id, operation: "static_read", target_path: join(ROOT, "src", "app.ts") }),
  ],
  ["project.declare", (r) => ({ source_id: data(r[3]!).id, declared_by: "owner@example.com", operation_level: "L1" })],
  [
    "policy.check",
    (r) => ({ source_id: data(r[3]!).id, operation: "static_read", target_path: join(ROOT, "src", "app.ts") }),
  ],
  [
    "project.add_source",
    (r) => ({ project_id: data(r[1]!).id, kind: "environment", ref: "https://staging.acme.example/" }),
  ],
  [
    "project.configure_environment",
    (r) => ({
      source_id: data(r[7]!).id,
      base_url: "https://staging.acme.example/",
      classification: "staging",
      allowed_hosts: ["staging.acme.example"],
    }),
  ],
  ["project.declare", (r) => ({ source_id: data(r[7]!).id, declared_by: "owner@example.com", operation_level: "L2" })],
  [
    "project.configure_environment",
    (r) => ({
      source_id: data(r[7]!).id,
      base_url: "https://staging.acme.example/",
      classification: "staging",
      allowed_hosts: ["staging.acme.example"],
    }),
  ],
  [
    "policy.check",
    (r) => ({ source_id: data(r[7]!).id, operation: "observe", target_url: "https://staging.acme.example/registrasi" }),
  ],
  [
    "policy.check",
    (r) => ({
      source_id: data(r[7]!).id,
      operation: "execute_test",
      target_url: "https://staging.acme.example/registrasi",
    }),
  ],
  ["project.get", (r) => ({ project_id: data(r[1]!).id })],
  ["project.get", () => ({ project_id: "project:missing" })],
  ["project.list", () => ({})],
  ["package.validate", () => ({ path: PACKAGE })],
  ["no.such.operation", () => ({})],
];

async function runScript(runner: Runner) {
  const results: ServiceResult[] = [];
  const exitCodes: Array<number | undefined> = [];
  for (const [operation, input] of SCRIPT) {
    const { result, exitCode } = await runner.run(operation, input(results));
    results.push(result);
    exitCodes.push(exitCode);
  }
  return { results, exitCodes };
}

describe("interface parity [@req SYS-005] [@req NFR-010]", () => {
  const runs: Record<string, Awaited<ReturnType<typeof runScript>>> = {};
  const runners: Runner[] = [];
  beforeAll(async () => {
    for (const make of [cliRunner, apiRunner, mcpRunner]) {
      const runner = await make();
      runners.push(runner);
      runs[runner.name] = await runScript(runner);
    }
  }, 60_000);
  afterAll(async () => {
    for (const r of runners) await r.close();
  });

  it("the script exercises successes, refusals and errors", () => {
    const outcomes = runs.api!.results.map((r) => (r.ok ? "ok" : r.error.code));
    expect(outcomes).toEqual([
      "ok",
      "ok",
      "INPUT_INVALID",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "DECLARATION_REQUIRED",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "NOT_FOUND",
      "ok",
      "ok",
      "OPERATION_UNKNOWN",
    ]);
    expect((runs.api!.results[4] as { data: { allowed: boolean; reason: string } }).data).toMatchObject({
      allowed: false,
      reason: "no_declaration",
    });
    expect((runs.api!.results[12] as { data: { allowed: boolean; reason: string } }).data).toMatchObject({
      allowed: false,
      reason: "level_not_declared",
    });
    expect((runs.api!.results[16] as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  it("CLI, HTTP API and MCP return identical decisions, states and errors", () => {
    expect(runs.cli!.results).toEqual(runs.api!.results);
    expect(runs.mcp!.results).toEqual(runs.api!.results);
  });

  it("every error states what failed and the next action", () => {
    for (const r of runs.api!.results) if (!r.ok) expect(r.error.remediation.length, r.error.code).toBeGreaterThan(20);
  });

  it("the CLI maps each outcome to its stable exit code", () => {
    const expected = runs.api!.results.map((r) => (r.ok ? EXIT_CODES.ok : EXIT_CODES[r.error.kind]));
    expect(runs.cli!.exitCodes).toEqual(expected);
  });
});

describe("MCP tool registry [@req SEC-006]", () => {
  it("lists one tool per operation with its permission level and side effect", async () => {
    const runner = await mcpRunner();
    try {
      const { tools } = await runner.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        OPERATIONS.filter((o) => !o.interfaces || o.interfaces.includes("mcp"))
          .map((o) => o.name)
          .sort(),
      );
      // Credential values never pass through an AI client's context (ADR-011).
      expect(tools.map((t) => t.name)).not.toContain("secret.put");
      const validate = tools.find((t) => t.name === "package.validate")!;
      expect(validate._meta).toEqual({ "sys2qa/level": "L0", "sys2qa/effect": "read" });
      expect(validate.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tools.find((t) => t.name === "project.create")!.annotations?.readOnlyHint).toBe(false);
    } finally {
      await runner.close();
    }
  });
});
