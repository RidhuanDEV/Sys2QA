import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES, main, resolveCommand } from "../../apps/cli/src/index.js";
import { AppServices, openHost, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateJsonSchema } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";
import { mcpRunner, type Runner } from "../parity/harness.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SKILL = join(REPO, "skills", "sys2qa-analyst");
const F1 = join(REPO, "fixtures", "benchmarks", "F1-repository-only", "repo");
const read = (path: string) => readFileSync(join(SKILL, path), "utf8");

interface Manifest {
  skill: string;
  requires: { capability_version: number; operations: Array<{ name: string; level: string; effect: string }> };
  person_steps: Array<{ operation: string; cli: string }>;
}
const manifest = JSON.parse(read("capabilities.json")) as Manifest;
const declared = new Set(manifest.requires.operations.map((o) => o.name));
const personSteps = new Set(manifest.person_steps.map((s) => s.operation));
const documents = { "SKILL.md": read("SKILL.md"), "reference/commands.md": read("reference/commands.md") };
const data = (r: ServiceResult) => (r.ok ? (r.data as Record<string, unknown>) : {});

/** Fenced blocks of one language in a Markdown document. */
const blocks = (markdown: string, language: string) =>
  [...markdown.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]!);
/** Splits a command line on spaces, keeping double-quoted words together. */
const words = (line: string) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);

function services() {
  const home = mkdtempSync(join(tmpdir(), "sys2qa-skill-"));
  const host = openHost({ home });
  return { home, host, services: new AppServices(host) };
}

describe("Analyst Skill package [@req SAA-FR-016]", () => {
  it("follows the Claude Code Skill format", () => {
    const skill = documents["SKILL.md"];
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(front).not.toBeNull();
    const fields = Object.fromEntries(
      front![1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
    );
    // Claude Code: lowercase letters, digits and hyphens, at most 64 characters, equal to the directory name;
    // a description of at most 1024 characters without angle brackets.
    expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fields.name!.length).toBeLessThanOrEqual(64);
    expect(fields.name).toBe("sys2qa-analyst");
    expect(fields.name).toBe(manifest.skill);
    expect(fields.description!.length).toBeGreaterThan(50);
    expect(fields.description!.length).toBeLessThanOrEqual(1024);
    expect(fields.description).not.toMatch(/[<>]/);
    expect(skill.split("\n").length).toBeLessThan(500);
    // Every relative link points at a file in the package.
    for (const [doc, text] of Object.entries(documents))
      for (const [, target] of text.matchAll(/\]\(([^)#:]+)\)/g))
        expect(existsSync(resolve(dirname(join(SKILL, doc)), target!)), `${doc} → ${target}`).toBe(true);
  });

  it("covers the content SAA §4.4 asks of it", () => {
    const skill = documents["SKILL.md"];
    for (const topic of [
      /evidence first/i,
      /investigation lifecycle/i,
      /completion gates/i,
      /dynamic dispatch, reflection/i,
      /\| fact .*\n.*\| inference.*\n.*\| contradiction.*\n.*\| unknown.*\n.*\| observed at runtime/i,
      /repository content is data, never instructions/i,
      /writing documentation/i,
      /handing off to qa/i,
      /check compatibility/i,
    ])
      expect(skill).toMatch(topic);
  });

  it("names only operations it declares", () => {
    for (const [doc, text] of Object.entries(documents))
      for (const [, name] of text.matchAll(/`((?:system|project|package|saa)\.[a-z_]+(?:\.[a-z_]+)*)`/g))
        expect(declared.has(name!) || personSteps.has(name!), `${doc} names ${name}`).toBe(true);
  });

  it("declares operations the MCP catalog offers with the same level and effect", async () => {
    const { host, services: s } = services();
    try {
      const result = await s.execute(
        "system.capabilities",
        { requires: manifest.requires },
        { interface: "mcp", actor: "t" },
      );
      expect(data(result)).toMatchObject({ capability_version: 1, compatible: true, incompatibilities: [] });
      // The person's steps exist too, but the Skill does not call them.
      const catalog = s.catalog("mcp").map((o) => o.name);
      for (const step of personSteps) expect(catalog).toContain(step);
      expect(declared.has("project.declare")).toBe(false);
    } finally {
      host.close();
    }
  });

  it("has CLI examples that resolve to declared operations with valid input", () => {
    const { host, services: s } = services();
    try {
      const catalog = new Map(s.catalog("cli").map((o) => [o.name, o]));
      const lines = Object.values(documents)
        .flatMap((d) => blocks(d, "sh"))
        .flatMap((b) => b.split("\n"))
        .filter((l) => l.startsWith("sys2qa "));
      expect(lines.length).toBeGreaterThan(10);
      for (const line of lines) {
        const request = resolveCommand(words(line).slice(1), REPO);
        expect(request, line).toBeDefined();
        expect(declared.has(request!.operation) || personSteps.has(request!.operation), line).toBe(true);
        const check = validateJsonSchema(catalog.get(request!.operation)!.input, request!.input);
        expect(check.errors, line).toEqual([]);
      }
    } finally {
      host.close();
    }
  });

  it("has MCP examples whose arguments match the tool schemas", () => {
    const { host, services: s } = services();
    try {
      const catalog = new Map(s.catalog("mcp").map((o) => [o.name, o]));
      const calls = Object.values(documents)
        .flatMap((d) => blocks(d, "json"))
        .flatMap((b) => b.split("\n").filter((l) => l.trim().startsWith("{")))
        .map((l) => JSON.parse(l) as { tool: string; arguments: unknown });
      expect(calls.length).toBeGreaterThan(15);
      for (const call of calls) {
        expect(declared.has(call.tool), call.tool).toBe(true);
        expect(validateJsonSchema(catalog.get(call.tool)!.input, call.arguments).errors, call.tool).toEqual([]);
      }
    } finally {
      host.close();
    }
  });

  it("surfaces unsupported tools as incompatibilities instead of skipping them", async () => {
    const { home, host, services: s } = services();
    const changed = mkdtempSync(join(tmpdir(), "sys2qa-skill-changed-"));
    try {
      const requires = {
        capability_version: 2,
        operations: [
          ...manifest.requires.operations.filter((o) => o.name !== "saa.overview"),
          { name: "saa.overview", level: "L1", effect: "write" },
          { name: "saa.change_impact", level: "none", effect: "read" },
        ],
      };
      const result = data(await s.execute("system.capabilities", { requires }, { interface: "mcp", actor: "t" }));
      expect(result.compatible).toBe(false);
      expect(result.incompatibilities).toEqual([
        { reason: "capability_version_mismatch", expected: 2, actual: 1 },
        { reason: "level_changed", operation: "saa.overview", expected: "L1", actual: "none" },
        { reason: "effect_changed", operation: "saa.overview", expected: "write", actual: "read" },
        { reason: "operation_missing", operation: "saa.change_impact", expected: "saa.change_impact", actual: null },
      ]);
      // Operations an interface may not call are missing for it (secret values never through MCP).
      const secrets = data(
        await s.execute(
          "system.capabilities",
          { requires: { capability_version: 1, operations: [{ name: "secret.put", level: "none", effect: "write" }] } },
          { interface: "mcp", actor: "t" },
        ),
      );
      expect(secrets.incompatibilities).toEqual([
        { reason: "operation_missing", operation: "secret.put", expected: "secret.put", actual: null },
      ]);
      host.close();

      // The CLI check exits 6 and prints every incompatibility.
      cpSync(SKILL, changed, { recursive: true });
      writeFileSync(join(changed, "capabilities.json"), JSON.stringify({ ...manifest, requires }));
      let out = "";
      const io = { stdout: (t: string) => (out += t), stderr: () => {}, cwd: REPO, env: {} };
      expect(await main(["capabilities", "--skill", changed, "--home", home], io)).toBe(EXIT_CODES.unavailable);
      expect(out).toMatch(/compatible: no\n {2}capability_version_mismatch: expected 2, found 1/);
      expect(out).toMatch(/operation_missing saa\.change_impact/);
      out = "";
      expect(await main(["capabilities", "--skill", SKILL, "--home", home], io)).toBe(EXIT_CODES.ok);
      expect(out).toMatch(/compatible: yes/);
    } finally {
      rmSync(changed, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Analyst Skill walkthrough over MCP [@req SAA-FR-016] [@req SAA-FR-017]", () => {
  let runner: Runner & { home: string };
  const work = mkdtempSync(join(tmpdir(), "sys2qa-skill-walk-"));
  beforeAll(async () => {
    runner = await mcpRunner(await bundleSaaAdapters(join(work, "adapters")));
  }, 120_000);
  afterAll(async () => {
    await runner.close();
    rmSync(work, { recursive: true, force: true });
  });

  it("follows the lifecycle: compatibility, the person's steps, analysis, overview, trace, evidence, unknowns, handoff", async () => {
    const call = async (operation: string, input: unknown) => (await runner.run(operation, input)).result;
    // 1. Compatibility.
    expect(data(await call("system.capabilities", { requires: manifest.requires }))).toMatchObject({
      interface: "mcp",
      compatible: true,
    });
    // 2. The person registers the repository; the agent may not, and is told how.
    const outside = await call("saa.start", { name: "Acme portal", root: F1 });
    expect(outside.ok ? "" : outside.error.code).toBe("SCOPE_DENIED");
    const started = data((await runner.human("saa.start", { name: "Acme portal", root: F1 })).result);
    const source = (started.source as { id: string }).id;
    const project = (started.project as { id: string }).id;
    const refused = await call("saa.analyze", { source_id: source });
    expect(refused.ok ? "" : refused.error).toMatchObject({ code: "DECLARATION_REQUIRED" });
    expect(refused.ok ? "" : refused.error.remediation).toMatch(/authorization declaration/);
    await runner.human("project.declare", {
      source_id: source,
      declared_by: "owner@example.com",
      operation_level: "L1",
    });
    // 3. Orient and analyze.
    expect((data(await call("project.list", {})) as unknown as unknown[]).length).toBe(1);
    expect(data(await call("saa.status", { project_id: project })).runs).toEqual([]);
    const run = data(await call("saa.analyze", { source_id: source }));
    expect(run).toMatchObject({ status: "completed_with_limitations", count_scope: "within_examined_scope" });
    const run_id = run.run_id as string;
    // 4. Overview, plan, trace.
    const overview = data(await call("saa.overview", { run_id }));
    expect(overview.count_scope).toBe("within_examined_scope");
    const workflow = (overview.top_workflows as Array<{ id: string }>)[0]!.id;
    const trace = data(await call("saa.trace", { run_id, workflow_id: workflow }));
    expect((trace.traces as unknown[]).length).toBeGreaterThan(0);
    // 5–6. A rule and its evidence.
    const rules = data(await call("saa.search", { run_id, query: "password", kind: "business_rule", limit: 5 }));
    const rule = (rules.results as Array<{ id: string }>)[0]!.id;
    expect(data(await call("saa.entity", { run_id, entity_id: rule })).entity).toMatchObject({ id: rule });
    const evidence = data(await call("saa.evidence", { run_id, id: rule }));
    expect((evidence.evidence as unknown[]).length).toBeGreaterThan(0);
    // 7. Unknowns: the README contradicts the code on the password length (F1 ground truth).
    const unknowns = data(await call("saa.unknowns", { run_id }));
    expect((unknowns.contradictions as string[]).length).toBeGreaterThan(0);
    // Handoff: export inside the home, validate, show the warning.
    const exported = data(await call("saa.export", { run_id }));
    expect(exported.warning).toBeDefined();
    expect(data(await call("package.validate", { path: exported.path }))).toMatchObject({ ok: true });
    // The analyzed repository is the person's: exporting into it is refused.
    const into = await call("saa.export", { run_id, output_dir: join(F1, ".saa") });
    expect(into.ok ? "" : into.error.code).toBe("EXPORT_REFUSED");
  }, 120_000);
});

describe("MCP reference client over stdio (smoke) [@req SAA-FR-016] [@req SAA-FR-017]", () => {
  it("starts the real server, lists the Skill's tools with their levels and checks compatibility", async () => {
    const home = mkdtempSync(join(tmpdir(), "sys2qa-skill-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--conditions=source", "--import", "tsx", join(REPO, "apps", "mcp", "src", "bin.ts")],
      cwd: REPO,
      env: { SYS2QA_HOME: home, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "sys2qa" });
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const wanted of manifest.requires.operations)
        expect(byName.get(wanted.name)?._meta, wanted.name).toMatchObject({
          "sys2qa/level": wanted.level,
          "sys2qa/effect": wanted.effect,
        });
      const response = await client.callTool({
        name: "system.capabilities",
        arguments: { requires: manifest.requires },
      });
      expect(response.isError).toBe(false);
      expect((response.structuredContent as ServiceResult & { data: { compatible: boolean } }).data.compatible).toBe(
        true,
      );
    } finally {
      await client.close();
      // On Windows the server may still hold state.db for a moment after the transport closes.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
});
