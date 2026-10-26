import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import { EXIT_CODES, main, type CliIo } from "../src/index.js";

const F4 = fileURLToPath(new URL("../../../fixtures/benchmarks/F4-incomplete-evidence/repo", import.meta.url));
let work: string;
let home: string;
let adapters: Array<{ id: string; entry: string }>;
let out = "";
let err = "";
const io = (): CliIo => ({
  stdout: (t) => (out += t),
  stderr: (t) => (err += t),
  cwd: work,
  env: {},
  host: { logSink: () => {}, adapters },
});
async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  out = "";
  err = "";
  const code = await main([...args, "--home", home], io());
  return { code, out, err };
}
const json = (r: { out: string }) => (JSON.parse(r.out) as { data: Record<string, unknown> }).data;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "sys2qa-cli-saa-"));
  home = join(work, "home");
  adapters = [];
  for (const id of ["js-ts", "sql", "config", "docs"])
    adapters.push({
      id,
      entry: await bundleAdapter({
        entry: fileURLToPath(new URL(`../../../packages/saa-adapters/src/adapters/${id}/main.ts`, import.meta.url)),
        outfile: join(work, "bundle", `${id}.mjs`),
      }),
    });
}, 60_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("SAA CLI commands [@req SAA-FR-014]", () => {
  it("runs the guided flow with paths and generated IDs only, in human and JSON output", async () => {
    const started = await cli("start", "Acme shop", F4, "--json");
    expect(started.code).toBe(EXIT_CODES.ok);
    const { project, source, next } = json(started) as {
      project: { id: string };
      source: { id: string };
      next: string[];
    };
    expect(next[0]).toContain(`declare ${source.id}`);
    // Without a declaration the analysis is refused with the next action.
    const refused = await cli("analyze", source.id);
    expect(refused.code).toBe(EXIT_CODES.denied);
    expect(refused.err).toMatch(/^error DECLARATION_REQUIRED: .+\n {2}next: /);
    expect((await cli("declare", source.id, "--level", "L1", "--by", "owner@example.com")).code).toBe(EXIT_CODES.ok);
    const analyzed = await cli("analyze", source.id, "--profile", "standard", "--json");
    expect(analyzed.code).toBe(EXIT_CODES.ok);
    const runId = json(analyzed).run_id as string;

    const listed = await cli("workflows", "list", runId);
    expect(listed.out).toMatch(/3 workflow\(s\) within the examined scope:/);
    expect(listed.out).toContain("workflow:page:app:/cart");
    const shown = await cli("workflows", "show", runId, "workflow:page:app:/cart");
    expect(shown.out).toMatch(/^# Workflow: Page \/cart/);
    const traced = await cli("trace", runId, "workflow:page:app:/cart", "--deepen", "--json");
    expect(json(traced).workflow).toMatchObject({ deepened: true });
    expect((await cli("status", project.id, "--json")).code).toBe(EXIT_CODES.ok);

    const exported = await cli("export", runId);
    expect(exported.code).toBe(EXIT_CODES.ok);
    expect(exported.out).toMatch(/^warning: This package describes the system's internal structure/);
    const again = await cli("export", runId, "--json");
    expect(json(again)).not.toHaveProperty("warning");
    const path = json(again).path as string;
    expect((await cli("validate", path, "--json")).out).toContain('"stage": "complete"');
    const inside = await cli("export", runId, "--output", join(F4, ".saa"));
    expect(inside.code).toBe(EXIT_CODES.conflict);
    expect(inside.err).toMatch(/^error EXPORT_REFUSED: /);
  }, 120_000);

  it("refuses to analyze when no analyzer is built", async () => {
    adapters = [];
    const started = json(await cli("start", "Empty", F4, "--json")) as { source: { id: string } };
    await cli("declare", started.source.id, "--level", "L1", "--by", "owner@example.com");
    const result = await cli("analyze", started.source.id);
    expect(result.code).toBe(EXIT_CODES.unavailable);
    expect(result.err).toMatch(/ADAPTERS_UNAVAILABLE[\s\S]*pnpm build:adapters/);
  }, 60_000);
});
