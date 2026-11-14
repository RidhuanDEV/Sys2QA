import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../apps/cli/src/index.js";
import type { ServiceResult } from "../../packages/app-services/src/index.js";
import { apiRunner, cliRunner, mcpRunner, type Runner } from "./harness.js";

const PACKAGE = fileURLToPath(new URL("../../fixtures/contract/packages/valid/mode-a-saa/", import.meta.url)).replace(
  /[\\/]$/,
  "",
);
const data = (r: ServiceResult | undefined) => (r?.ok ? (r.data as Record<string, unknown>) : {});
const stored = (r: ServiceResult[]) => (data(r[1]).package as { path: string }).path;

/** Mode D (SYS-001): a project that starts from an imported package, through every interface (QAA-FR-009, SYS-005). */
type Step = [operation: string, input: (results: ServiceResult[]) => unknown, human?: "human"];
const SCRIPT: Step[] = [
  ["project.create", () => ({ name: "Imported portal" })],
  // Importing from a new local path is a person's step: MCP clients may not name paths outside approved roots.
  ["package.import", (r) => ({ project_id: data(r[0]).id, path: PACKAGE, language: "fr" }), "human"],
  // The stored copy lies inside the home, so every interface may name it: the same version is unchanged.
  ["package.import", (r) => ({ project_id: data(r[0]).id, path: stored(r) })],
  ["package.list", (r) => ({ project_id: data(r[0]).id })],
  [
    "package.show",
    (r) => ({
      project_id: data(r[0]).id,
      package_id: (data(r[1]).package as { package_id: string }).package_id,
      version: (data(r[1]).package as { version: number }).version,
    }),
  ],
  [
    "package.show",
    (r) => ({
      project_id: data(r[0]).id,
      package_id: (data(r[1]).package as { package_id: string }).package_id,
      version: 999,
    }),
  ],
  ["package.import", (r) => ({ project_id: data(r[0]).id, path: `${stored(r)}-missing` })],
  ["project.get", (r) => ({ project_id: data(r[0]).id })],
];

async function runScript(runner: Runner & { home: string }) {
  const results: ServiceResult[] = [];
  const exitCodes: Array<number | undefined> = [];
  for (const [operation, input, human] of SCRIPT) {
    const { result, exitCode } = await (human
      ? runner.human(operation, input(results))
      : runner.run(operation, input(results)));
    results.push(result);
    exitCodes.push(exitCode);
  }
  // Homes differ per runner; everything else must be identical.
  const normalized = JSON.parse(
    JSON.stringify(results).split(JSON.stringify(runner.home).slice(1, -1)).join("<home>"),
  ) as ServiceResult[];
  return { results, normalized, exitCodes };
}

describe("package import parity, Mode D [@req QAA-FR-009] [@req QAA-FR-012] [@req SYS-005] [@req SYS-001]", () => {
  const runs: Record<string, Awaited<ReturnType<typeof runScript>>> = {};
  const runners: Array<Runner & { home: string }> = [];
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

  it("imports, lists, shows and re-imports a package, with refusals", () => {
    const api = runs.api!.results;
    expect(api.map((r) => (r.ok ? "ok" : r.error.code))).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "NOT_FOUND",
      "PKG_NOT_FOUND",
      "ok",
    ]);
    expect(data(api[1])).toMatchObject({
      status: "imported",
      import_id: expect.stringMatching(/^import:/),
      evidence_mode: "D",
      original: { kind: "directory", sha256: expect.stringMatching(/^sha256:/) },
      provenance: { producer: { name: "SAA" }, package_schema_version: "1.0.0" },
    });
    expect((data(api[1]).issues as Array<{ code: string }>).map((i) => i.code)).toContain("PKG_LANGUAGE_UNAVAILABLE");
    expect(data(api[2])).toMatchObject({ status: "unchanged", import_id: null });
    expect(data(api[3]).packages).toEqual([
      expect.objectContaining({ origin: "imported", version: (data(api[1]).package as { version: number }).version }),
    ]);
    expect(data(api[4])).toMatchObject({
      package: { origin: "imported" },
      provenance: { repository: expect.objectContaining({ revision: expect.anything() }) },
      artifacts: expect.arrayContaining([expect.objectContaining({ role: "system_model" })]),
    });
    expect(data(api[7])).toMatchObject({ evidence_mode: "D" });
  });

  it("CLI, HTTP API and MCP return identical results", () => {
    expect(runs.cli!.normalized).toEqual(runs.api!.normalized);
    expect(runs.mcp!.normalized).toEqual(runs.api!.normalized);
  });

  it("maps refusals to the stable CLI exit codes", () => {
    expect(runs.cli!.exitCodes[5]).toBe(EXIT_CODES.not_found);
    expect(runs.cli!.exitCodes[6]).toBe(EXIT_CODES.not_found);
  });

  it("refuses an MCP import from a path outside the approved roots", async () => {
    const mcp = runners.find((r) => r.name === "mcp")!;
    const project = (await mcp.run("project.create", { name: "Scoped" })).result as { data: { id: string } };
    const result = (await mcp.run("package.import", { project_id: project.data.id, path: PACKAGE })).result;
    expect(result.ok ? "ok" : result.error.code).toBe("SCOPE_DENIED");
  });
});
