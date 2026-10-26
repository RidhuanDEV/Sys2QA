import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../apps/cli/src/index.js";
import type { ServiceResult } from "../../packages/app-services/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";
import { apiRunner, cliRunner, mcpRunner, type Runner } from "./harness.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const data = (r: ServiceResult | undefined) => (r?.ok ? (r.data as Record<string, unknown>) : {});
const REGISTER = "workflow:page:web:/register";

/** The SAA commands of the CLI (SAA-FR-014), each one operation, with a refusal and errors, through every interface. */
type Step = [operation: string, input: (results: ServiceResult[]) => unknown];
const SCRIPT: Step[] = [
  ["saa.start", () => ({ name: "Acme portal", root: F1 })],
  ["saa.analyze", (r) => ({ source_id: (data(r[0]).source as { id: string }).id })],
  [
    "project.declare",
    (r) => ({
      source_id: (data(r[0]).source as { id: string }).id,
      declared_by: "owner@example.com",
      operation_level: "L1",
    }),
  ],
  ["saa.analyze", (r) => ({ source_id: (data(r[0]).source as { id: string }).id })],
  ["saa.status", (r) => ({ project_id: (data(r[0]).project as { id: string }).id })],
  ["saa.workflows.list", (r) => ({ run_id: data(r[3]).run_id })],
  ["saa.workflows.show", (r) => ({ run_id: data(r[3]).run_id, workflow_id: REGISTER, language: "id" })],
  ["saa.trace", (r) => ({ run_id: data(r[3]).run_id, workflow_id: REGISTER, deepen: true })],
  ["saa.workflows.show", (r) => ({ run_id: data(r[3]).run_id, workflow_id: "workflow:page:web:/missing" })],
  ["saa.export", (r) => ({ run_id: data(r[3]).run_id })],
  ["saa.export", (r) => ({ run_id: data(r[3]).run_id, output_dir: join(F1, ".saa") })],
  ["package.validate", (r) => ({ path: data(r[9]).path })],
  ["saa.workflows.list", () => ({ run_id: "run:01JNOSUCHRUN0000000000000" })],
];

let adapters: Array<{ id: string; entry: string }>;
const work = mkdtempSync(join(tmpdir(), "sys2qa-saa-parity-"));

async function runScript(runner: Runner & { home: string }) {
  const results: ServiceResult[] = [];
  const exitCodes: Array<number | undefined> = [];
  for (const [operation, input] of SCRIPT) {
    const { result, exitCode } = await runner.run(operation, input(results));
    results.push(result);
    exitCodes.push(exitCode);
  }
  // Homes differ per runner and package bytes carry capture times; everything else must be identical.
  const normalized = JSON.parse(
    JSON.stringify(results)
      .split(runner.home)
      .join("<home>")
      .replace(/"manifest_sha256":"sha256:[0-9a-f]{64}"/g, '"manifest_sha256":"<sha>"'),
  ) as ServiceResult[];
  return { results, normalized, exitCodes };
}

describe("SAA command parity [@req SAA-FR-014] [@req SYS-005]", () => {
  const runs: Record<string, Awaited<ReturnType<typeof runScript>>> = {};
  const runners: Array<Runner & { home: string }> = [];
  beforeAll(async () => {
    adapters = await bundleSaaAdapters(join(work, "adapters"));
    for (const make of [cliRunner, apiRunner, mcpRunner]) {
      const runner = await make(adapters);
      runners.push(runner);
      runs[runner.name] = await runScript(runner);
    }
  }, 180_000);
  afterAll(async () => {
    for (const r of runners) await r.close();
    rmSync(work, { recursive: true, force: true });
  });

  it("covers start, analyze, status, workflows, trace, export and validate with refusals and errors", () => {
    const api = runs.api!.results;
    expect(api.map((r) => (r.ok ? "ok" : r.error.code))).toEqual([
      "ok",
      "DECLARATION_REQUIRED",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "NOT_FOUND",
      "ok",
      "EXPORT_REFUSED",
      "ok",
      "RUN_NOT_FOUND",
    ]);
    expect(data(api[3])).toMatchObject({ status: "completed_with_limitations", count_scope: "within_examined_scope" });
    expect((data(api[5]).workflows as Array<{ id: string }>).map((w) => w.id)).toContain(REGISTER);
    expect(data(api[6]).document).toMatch(/^# Alur kerja: Page \/register/);
    expect(data(api[7]).workflow).toMatchObject({ id: REGISTER, deepened: true });
    expect(data(api[9])).toMatchObject({ version: 1, warning: { en: expect.stringContaining("internal structure") } });
    expect(data(api[11])).toMatchObject({ ok: true, stage: "complete" });
    expect((data(api[4]).runs as unknown[]).length).toBe(1);
  });

  it("CLI, HTTP API and MCP return the same results", () => {
    expect(runs.cli!.normalized).toEqual(runs.api!.normalized);
    expect(runs.mcp!.normalized).toEqual(runs.api!.normalized);
  });

  it("the CLI maps each outcome to its stable exit code", () => {
    const expected = runs.api!.results.map((r) => (r.ok ? EXIT_CODES.ok : EXIT_CODES[r.error.kind]));
    expect(runs.cli!.exitCodes).toEqual(expected);
  });
});
