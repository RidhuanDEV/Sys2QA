import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppServices,
  openHost,
  startApiServer,
  type ApiServer,
  type Host,
} from "../../packages/app-services/src/index.js";
import { bundleWebUi } from "../../scripts/web-bundle.mjs";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;

const work = mkdtempSync(join(tmpdir(), "sys2qa-e2e-run-"));
let host: Host;
let server: ApiServer;
let browser: Browser;
let link: string;
let planId: string;
let approved: string[];

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: unknown,
          ) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }>;
        };
      }
    ).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    });
    return result.violations.map((v) => `${v.id}: ${JSON.stringify(v.nodes.map((n) => n.target))}`);
  });
}

beforeAll(async () => {
  const repo = join(work, "acme-portal");
  cpSync(F1, repo, { recursive: true });
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  const services = new AppServices(host);
  const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
  const call = async <T>(operation: string, input: unknown): Promise<T> => {
    const r = await services.execute(operation, input, caller);
    if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  };
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
    name: "Acme",
    root: repo,
  });
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
  planId = (
    await call<{ plan: { plan_id: string } }>("plan.create", {
      project_id: started.project.id,
      package_id: exported.package_id,
      version: exported.version,
    })
  ).plan.plan_id;
  await call("scenarios.generate", { plan_id: planId });
  await call("scenarios.critique", { plan_id: planId });
  approved = (
    await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
      project_id: started.project.id,
      status: "pending_review",
    })
  ).scenarios
    .map((s) => s.scenario_id)
    .filter((id) => /admin\.users_access\.(allowed-admin|denied-customer)$/.test(id));
  const preview = await call<{ preview_token: string }>("approvals.preview", {
    project_id: started.project.id,
    scenario_ids: approved,
    ...DECLARED,
  });
  await call("approvals.approve", {
    project_id: started.project.id,
    scenario_ids: approved,
    ...DECLARED,
    preview_token: preview.preview_token,
  });
  server = await startApiServer(services, { webUi: { root: await bundleWebUi(join(work, "web")) } });
  link = `${server.url}/#token=${server.token}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  host?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("manual runner in the web UI [@req QAA-FR-084] [@req QAA-FR-080] [@req QAA-FR-081] [@req QAA-FR-082] [@req QAA-FR-083] [@req QAA-FR-085] [@req QAA-FR-086] [@req NFR-009]", () => {
  it("runs two approved F1 scenarios step by step with a failure, evidence, pause and resume, and submits them", async () => {
    const page = await browser.newPage();
    await page.goto(link);
    await page.goto(`${server.url}/#/plan/${encodeURIComponent(planId)}`);
    await page.getByLabel("Show scenarios with status").selectOption("approved");
    await page.getByRole("table", { name: /scenario\(s\)/ }).waitFor();
    await page.getByLabel("Select TC-ADMIN-001").check();
    await page.getByLabel("Select TC-ADMIN-002").check();
    await page.getByLabel("Environment you test in (required)").fill("tester laptop");
    await page.getByRole("button", { name: "Start a manual run of 2 scenario(s)" }).click();
    await page.getByRole("heading", { level: 1, name: "Manual run: TC-ADMIN-001" }).waitFor();
    const main = page.locator("main");
    expect(await main.textContent()).toContain("Results are tester-reported");
    expect(await axe(page)).toEqual([]);

    const status = page.getByRole("status");
    const total = approved.length * 3;
    for (let n = 1; n <= total; n++) {
      const heading = (await page
        .getByRole("heading", { level: 3, name: /^Step S\d of TC-ADMIN-00\d/ })
        .textContent())!;
      const failing = heading.startsWith("Step S3 of TC-ADMIN-001");
      if (failing) {
        await page.getByLabel(/^Attach a screenshot or file/).setInputFiles({
          name: "screenshot.png",
          mimeType: "image/png",
          buffer: PNG,
        });
        await page.getByRole("button", { name: "Attach", exact: true }).click();
        await expect.poll(() => status.textContent()).toBe("screenshot.png attached to step S3.");
        await page.getByRole("list", { name: "Attachments of this step" }).waitFor();
        await page.getByLabel("Fail").check();
        await page.getByLabel("Actual result (required)").fill("The user list did not load for the admin.");
      } else {
        // Not applicable is offered only where the step checks no result.
        const na = page.getByLabel(/^Not applicable/);
        if (heading.startsWith("Step S3")) expect(await na.isDisabled()).toBe(true);
        await page.getByLabel("Pass").check();
      }
      await page.getByRole("button", { name: "Record step" }).click();
      await expect.poll(() => status.textContent()).toMatch(/recorded as (Pass|Fail)\.$/);
      if (failing) {
        // The failed step stays open with its defect form (QAA-FR-084).
        await page.getByLabel("Defect title (required)").fill("Admin user list does not load");
        await page.getByLabel("Severity: impact on the system (required)").selectOption("major");
        await page.getByLabel("Priority: urgency to fix (required)").selectOption("high");
        await page.getByLabel("Suspected cause").selectOption("product_defect");
        await page.getByRole("button", { name: "Create defect" }).click();
        await expect.poll(() => status.textContent()).toBe("Defect created and linked to this step.");
        await expect.poll(() => main.textContent()).toMatch(/Defects of TC-ADMIN-001: defect:/);
        expect(await axe(page)).toEqual([]);
        await page.getByRole("button", { name: "Next step" }).click();
      }
      if (n === 3) {
        // Pause, reload the page: the run comes back paused with its progress, and resumes.
        await page.getByRole("button", { name: "Pause run" }).click();
        await expect.poll(() => status.textContent()).toBe("Run paused.");
        await page.reload();
        await page.getByRole("button", { name: "Resume run" }).waitFor();
        expect(await main.textContent()).toContain("Progress: 3 of 6 steps recorded.");
        await page.getByRole("button", { name: "Resume run" }).click();
        await expect.poll(() => status.textContent()).toBe("Run resumed.");
        await page.getByRole("heading", { level: 3, name: /^Step S1 of TC-ADMIN-002/ }).waitFor();
      }
    }
    await page.getByRole("button", { name: "Submit run" }).click();
    await expect.poll(() => status.textContent()).toBe("Run submitted.");
    const outcomes = (await page.getByRole("list", { name: "Outcomes" }).textContent()) ?? "";
    expect(outcomes).toMatch(/admin\.users_access\.allowed-admin: ✕ failed/);
    expect(outcomes).toMatch(/admin\.users_access\.denied-customer: ✓ passed/);
    expect(await axe(page)).toEqual([]);

    const runs = host.state.db.prepare("SELECT id, state FROM runs").all() as Array<{ id: string; state: string }>;
    expect(runs.map((r) => r.state)).toEqual(["completed"]);
    const cases = host.state.db
      .prepare("SELECT doc_json FROM case_results WHERE run_id = ? ORDER BY scenario_id")
      .all(runs[0]!.id) as Array<{ doc_json: string }>;
    const docs = cases.map(
      (c) =>
        JSON.parse(c.doc_json) as { outcome: string; reported_by: string; steps: Array<{ evidence_refs?: string[] }> },
    );
    expect(docs.map((d) => [d.outcome, d.reported_by])).toEqual([
      ["failed", "tester"],
      ["passed", "tester"],
    ]);
    expect(docs[0]!.steps[2]!.evidence_refs?.[0]).toMatch(/^qevid:/);
    const defects = host.state.db.prepare("SELECT doc_json FROM defects").all() as Array<{ doc_json: string }>;
    expect(
      defects.map((d) => (JSON.parse(d.doc_json) as { links: { run_id: string; step_id: string } }).links),
    ).toEqual([expect.objectContaining({ run_id: runs[0]!.id, step_id: "S3" })]);
    await page.close();
  });

  it("exports a manual test pack from the plan, imports its filled-in results and writes the report on the project page [@req QAA-FR-112] [@req QAA-FR-090]", async () => {
    const page = await browser.newPage();
    await page.goto(link);
    await page.goto(`${server.url}/#/plan/${encodeURIComponent(planId)}`);
    await page.getByLabel("Show scenarios with status").selectOption("approved");
    await page.getByRole("table", { name: /scenario\(s\)/ }).waitFor();
    await page.getByLabel("Select TC-ADMIN-001").check();
    await page.getByLabel("Environment you test in (required)").fill("tester laptop");
    await page.getByRole("button", { name: "Export a manual test pack" }).click();
    const note = page.getByRole("note");
    await expect.poll(() => note.textContent()).toMatch(/Manual test pack written to /);
    const dir = /written to (\S+) \(/.exec((await note.textContent()) ?? "")![1]!;
    const template = JSON.parse(readFileSync(joinPath(dir, "result-template.json"), "utf8")) as {
      environment: unknown;
      cases: Array<{ outcome: string; steps: Array<{ status: string }> }>;
    };
    template.environment = { declared: { name: "Rina laptop" } };
    for (const c of template.cases) {
      for (const s of c.steps) s.status = "pass";
      c.outcome = "passed";
    }
    await page.getByRole("link", { name: "Back to the project" }).click();
    await page.getByLabel("Filled-in result-template.json").setInputFiles({
      name: "result-template.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(template)),
    });
    await page.getByRole("button", { name: "Import results" }).click();
    await expect
      .poll(() => page.getByRole("status").textContent())
      .toBe("Manual test pack results imported as tester-reported.");
    await expect.poll(() => page.getByRole("heading", { name: "Manual runs" }).isVisible()).toBe(true);
    // The QA report, in Indonesian, from the project page (QAA-FR-090).
    await page.getByLabel("Report language").selectOption("id");
    await page.getByRole("button", { name: "Generate the QA report" }).click();
    await expect.poll(() => page.getByRole("status").textContent()).toBe("QA report written.");
    const reportDir = /Written to (\S+) \(/.exec((await page.getByRole("note").last().textContent()) ?? "")![1]!;
    expect(readFileSync(joinPath(reportDir, "report.md"), "utf8").startsWith("# Laporan QA")).toBe(true);
    await page.getByRole("table", { name: "Scenario counts" }).waitFor();
    expect(await axe(page)).toEqual([]);
    await page.close();
  });
});
