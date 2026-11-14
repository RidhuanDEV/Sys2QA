import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument } from "../../packages/contract/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Report {
  report_id: string;
  language: string;
  glossary: string;
  evidence_profiles: Array<{ package_id: string; profile: { source_analysis: string; cannot_establish: string[] } }>;
  qa_objectives: Record<string, number>;
  summary: Record<string, number>;
  results: Array<{
    scenario_id: string;
    version: number;
    run_id: string;
    outcome: string;
    label: string;
    reported_by: string;
    environment: { declared?: { name: string } };
    packages: Array<{ package_id: string; package_version: number }>;
    revision: { kind: string; value: string };
    evidence: Array<{ ref: string; sha256: string | null }>;
    started_at: string;
    finished_at: string;
    defect_ids: string[];
    qa_objective: string;
  }>;
  defects: Array<Record<string, unknown>>;
  coverage: Array<{ plan_id: string; report: { execution: { executed: number } } }>;
  limitations: {
    analysis: string[];
    cannot_establish: string[];
    unresolved_assumptions: string[];
    coverage_gaps: string[];
    unsupported_operations: string[];
  };
  documents: { scenarios: unknown[]; runs: unknown[] };
}

vi.setConfig({ testTimeout: 60_000 });

const work = mkdtempSync(join(tmpdir(), "sys2qa-reports-"));
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok)
    throw new Error(`${operation}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data as T;
}

let projectId: string;
let planId: string;
let ids: string[];
let defectId: string;

async function manualRun(scenarios: string[], fail: string | null, finish: "submit" | "abandon") {
  const shown = await call<{
    run: { run_id: string };
    cases: Array<{ scenario_id: string; steps: Array<{ step_id: string }> }>;
  }>("runs.start_manual", { project_id: projectId, scenario_ids: scenarios, declared_environment: "tester laptop" });
  const runId = shown.run.run_id;
  for (const c of shown.cases)
    for (const s of c.steps) {
      if (finish === "abandon" && s.step_id !== "S1") continue;
      const failing = c.scenario_id === fail && s.step_id === "S3";
      let evidence: string[] = [];
      if (failing)
        evidence = [
          (
            await call<{ evidence_ref: string }>("runs.attach", {
              run_id: runId,
              scenario_id: c.scenario_id,
              step_id: "S3",
              name: "screenshot.png",
              content_base64: PNG.toString("base64"),
            })
          ).evidence_ref,
        ];
      await call("runs.record_step", {
        run_id: runId,
        scenario_id: c.scenario_id,
        step_id: s.step_id,
        status: failing ? "fail" : "pass",
        ...(failing ? { actual: "Error page.", evidence_refs: evidence } : {}),
      });
      if (failing)
        defectId = (
          await call<{ defect: { defect_id: string } }>("defects.create", {
            run_id: runId,
            scenario_id: c.scenario_id,
            step_id: "S3",
            title: "Admin list fails",
            severity: "major",
            priority: "high",
          })
        ).defect.defect_id;
    }
  if (finish === "submit") await call("runs.submit", { run_id: runId });
  else await call("runs.abandon", { run_id: runId, reason: "Staging went down." });
  return runId;
}

beforeAll(async () => {
  const repo = join(work, "acme-portal");
  cpSync(F1, repo, { recursive: true });
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
    name: "Acme",
    root: repo,
  });
  projectId = started.project.id;
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  planId = (
    await call<{ plan: { plan_id: string } }>("plan.create", {
      project_id: projectId,
      package_id: exported.package_id,
      version: exported.version,
    })
  ).plan.plan_id;
  await call("scenarios.generate", { plan_id: planId });
  await call("scenarios.critique", { plan_id: planId });
  const pending = (
    await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
      project_id: projectId,
      status: "pending_review",
    })
  ).scenarios.map((s) => s.scenario_id);
  ids = ["allowed-admin", "denied-customer", "denied-anonymous"].map((item) =>
    pending.find((id) => id.endsWith(`admin.users_access.${item}`))!,
  );
  const preview = await call<{ preview_token: string }>("approvals.preview", {
    project_id: projectId,
    scenario_ids: ids,
    ...DECLARED,
  });
  await call("approvals.approve", {
    project_id: projectId,
    scenario_ids: ids,
    ...DECLARED,
    preview_token: preview.preview_token,
  });
  // Run 1: allowed-admin fails (with evidence and a defect), denied-customer passes.
  await manualRun([ids[0]!, ids[1]!], ids[0]!, "submit");
  // Run 2: denied-customer and denied-anonymous, abandoned after S1: their latest outcomes are inconclusive.
  await manualRun([ids[1]!, ids[2]!], null, "abandon");
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const generate = async (input: Record<string, unknown>) => {
  const r = await call<{ path: string; summary: Record<string, number> }>("reports.generate", {
    project_id: projectId,
    ...input,
  });
  return {
    ...r,
    json: JSON.parse(readFileSync(join(r.path, "report.json"), "utf8")) as Report,
    md: readFileSync(join(r.path, "report.md"), "utf8"),
  };
};

describe("QA report counts and links [@req QAA-FR-090] [@req QAA-FR-091]", () => {
  it("counts reconcile with the stored records", async () => {
    const { json } = await generate({ plan_id: planId });
    const db = host.state.db;
    const n = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    expect(json.summary.proposed).toBe(json.documents.scenarios.length);
    expect(json.summary.proposed).toBe(n("SELECT COUNT(*) AS n FROM scenarios WHERE project_id = ?", projectId));
    expect(json.summary.approved).toBe(
      n("SELECT COUNT(DISTINCT scenario_id) AS n FROM approvals WHERE state = 'active'"),
    );
    expect(json.summary.executed).toBe(
      n("SELECT COUNT(DISTINCT scenario_id) AS n FROM case_results WHERE project_id = ?", projectId),
    );
    // Latest outcomes: allowed-admin failed; denied-customer and denied-anonymous inconclusive (run 2 was abandoned after S1).
    expect(json.summary).toMatchObject({
      approved: 3,
      executed: 3,
      failed: 1,
      inconclusive: 2,
      not_run: 0,
      passed: 0,
      blocked: 0,
    });
    expect(json.results).toHaveLength(n("SELECT COUNT(*) AS n FROM case_results WHERE project_id = ?", projectId));
  });

  it("links every result to its scenario version, run, environment, package version, revision, evidence, times and defects", async () => {
    const { json } = await generate({});
    for (const r of json.results) {
      expect(r).toMatchObject({ version: 1, label: "tester-reported", reported_by: "tester" });
      expect(r.run_id).toMatch(/^mrun:/);
      expect(r.environment.declared?.name).toBe("tester laptop");
      expect(r.packages[0]!.package_version).toBe(1);
      expect(r.revision.kind).toBe("content_fingerprint");
      expect(Date.parse(r.started_at)).toBeLessThanOrEqual(Date.parse(r.finished_at));
      expect(r.qa_objective).toBe("implementation_conformance");
    }
    const failed = json.results.find((r) => r.outcome === "failed")!;
    expect(failed.evidence).toEqual([
      { ref: expect.stringMatching(/^qevid:/), sha256: expect.stringMatching(/^sha256:/), media_type: "image/png" },
    ]);
    expect(failed.defect_ids).toEqual([defectId]);
    // Evidence named by an exported report is kept from retention.
    const pins = host.state.db.prepare("SELECT sha256 FROM blob_pins WHERE reason = 'export'").all() as Array<{
      sha256: string;
    }>;
    expect(pins.map((p) => `sha256:${p.sha256}`)).toContain(failed.evidence[0]!.sha256);
  });
});

describe("QA report sections [@req QAA-FR-092] [@req QAA-FR-093] [@req SYS-004] [@req QAA-FR-111]", () => {
  it("states the evidence profile, QA objectives, coverage and every limitation section, and embeds valid contract documents", async () => {
    const { json, md } = await generate({ plan_id: planId });
    expect(json.evidence_profiles[0]!.profile.source_analysis).toBe("available");
    expect(json.limitations.cannot_establish).toContain("Behavior of any running environment");
    expect(json.qa_objectives.implementation_conformance).toBeGreaterThan(0);
    expect(json.coverage[0]!.report.execution.executed).toBe(3);
    expect(json.limitations.unresolved_assumptions.join("\n")).toMatch(/needs clarification/);
    expect(json.limitations.coverage_gaps.length).toBeGreaterThan(0);
    expect(json.limitations.unsupported_operations.join("\n")).toMatch(/manual_only/);
    for (const section of [
      "## Evidence profile",
      "What this evidence cannot establish",
      "## QA objectives",
      "## Summary",
      "## Results",
      "## Defects",
      "## Coverage relative to the model",
      "### Analysis limitations",
      "### Unresolved assumptions",
      "### Coverage gaps",
      "### Unsupported operations",
    ])
      expect(md).toContain(section);
    for (const run of json.documents.runs) expect(validateDocument("run-result", run).issues).toEqual([]);
    for (const d of json.defects) expect(validateDocument("defect", d).issues).toEqual([]);
  });

  it("keeps every section in an empty project, saying none recorded", async () => {
    const empty = await call<{ id: string }>("project.create", { name: "Nothing yet" });
    const r = await call<{ path: string }>("reports.generate", { project_id: empty.id });
    const md = readFileSync(join(r.path, "report.md"), "utf8");
    for (const section of [
      "## Results",
      "## Defects",
      "### Unresolved assumptions",
      "### Coverage gaps",
      "### Unsupported operations",
    ])
      expect(md).toContain(section);
    expect(md.match(/None recorded\./g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("writes the report in Indonesian with identifiers, numbers and status codes unchanged [@req LOC-006]", async () => {
    const en = await generate({ plan_id: planId, language: "en" });
    const id = await generate({ plan_id: planId, language: "id" });
    expect(id.md.startsWith("# Laporan QA: Acme")).toBe(true);
    expect(id.md).toContain("Gagal (`failed`)");
    expect(id.json.glossary).toMatch(/^id@/);
    const identifiers = (text: string) => [...text.matchAll(/`([a-z]+:[^`]+)`/g)].map((m) => m[1]).sort();
    expect(identifiers(id.md).filter((x) => !x!.startsWith("report:"))).toEqual(
      identifiers(en.md).filter((x) => !x!.startsWith("report:")),
    );
    expect(id.json.summary).toEqual(en.json.summary);
  });

  it("never writes a report into the analyzed repository", async () => {
    const r = await raw("reports.generate", { project_id: projectId, output_dir: join(work, "acme-portal", "qa") });
    expect(r.ok ? "ok" : r.error.code).toBe("EXPORT_REFUSED");
  });
});
