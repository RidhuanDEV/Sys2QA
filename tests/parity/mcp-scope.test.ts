import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceResult } from "../../packages/app-services/src/index.js";
import { mcpRunner } from "./harness.js";

const outside = mkdtempSync(join(tmpdir(), "sys2qa-outside-"));
const code = (r: ServiceResult) => (r.ok ? "ok" : r.error.code);
let runner: Awaited<ReturnType<typeof mcpRunner>>;
let projectId: string;
let registered: string;

beforeAll(async () => {
  runner = await mcpRunner();
  registered = join(runner.home, "..", `${runner.home.split(/[\\/]/).pop()}-repo`);
  mkdirSync(registered, { recursive: true });
  const project = await runner.human("project.create", { name: "Scope" });
  projectId = (project.result as { data: { id: string } }).data.id;
  await runner.human("project.add_source", { project_id: projectId, kind: "source_root", ref: registered });
});
afterAll(async () => {
  await runner.close();
  rmSync(outside, { recursive: true, force: true });
  rmSync(registered, { recursive: true, force: true });
});

describe("MCP path arguments stay inside approved roots [@req SAA-FR-017] [@req SEC-001]", () => {
  it("rejects paths outside the home and registered sources, however they are written", async () => {
    const mcp = async (operation: string, input: unknown) => code((await runner.run(operation, input)).result);
    expect(await mcp("package.validate", { path: outside })).toBe("SCOPE_DENIED");
    expect(await mcp("package.validate", { path: join(runner.home, "..", "elsewhere") })).toBe("SCOPE_DENIED");
    expect(await mcp("package.validate", { path: "relative/dir" })).toBe("SCOPE_DENIED");
    expect(await mcp("saa.start", { name: "New", root: outside })).toBe("SCOPE_DENIED");
    expect(await mcp("project.add_source", { project_id: projectId, kind: "source_root", ref: outside })).toBe(
      "SCOPE_DENIED",
    );
    expect(await mcp("project.add_source", { project_id: projectId, kind: "package", ref: outside })).toBe(
      "SCOPE_DENIED",
    );
    expect(await mcp("saa.export", { run_id: "run:01JANYRUN00000000000000000", output_dir: outside })).toBe(
      "SCOPE_DENIED",
    );
    if (process.platform !== "win32") {
      // A link inside the home that leads out is resolved before the check.
      symlinkSync(outside, join(runner.home, "escape"));
      expect(await mcp("package.validate", { path: join(runner.home, "escape") })).toBe("SCOPE_DENIED");
    }
  });

  it("accepts paths inside the home or a registered source, and URLs are not paths", async () => {
    const mcp = async (operation: string, input: unknown) => code((await runner.run(operation, input)).result);
    // Not refused by scope: the validator runs and reports what it finds.
    expect(await mcp("package.validate", { path: registered })).not.toBe("SCOPE_DENIED");
    expect(await mcp("package.validate", { path: join(runner.home, "projects") })).not.toBe("SCOPE_DENIED");
    expect(
      await mcp("project.add_source", { project_id: projectId, kind: "environment", ref: "https://staging.example/" }),
    ).toBe("ok");
    // A person may still name any path through the CLI.
    expect(code((await runner.human("package.validate", { path: outside })).result)).not.toBe("SCOPE_DENIED");
  });

  it("declares each SAA tool's permission level and side effect", async () => {
    const { tools } = await runner.client.listTools();
    const meta = (name: string) => tools.find((t) => t.name === name)?._meta;
    expect(meta("saa.analyze")).toEqual({ "sys2qa/level": "L1", "sys2qa/effect": "write" });
    expect(meta("saa.export")).toEqual({ "sys2qa/level": "none", "sys2qa/effect": "write" });
    for (const name of [
      "saa.overview",
      "saa.search",
      "saa.entity",
      "saa.evidence",
      "saa.api_contracts",
      "saa.data_model",
      "saa.dependencies",
      "saa.tests_for",
      "saa.unknowns",
      "saa.trace",
      "saa.workflows.list",
      "saa.workflows.show",
      "saa.status",
    ]) {
      expect(meta(name), name).toEqual({ "sys2qa/level": "none", "sys2qa/effect": "read" });
      expect(tools.find((t) => t.name === name)!.annotations?.readOnlyHint, name).toBe(true);
    }
  });
});
