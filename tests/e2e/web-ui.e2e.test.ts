import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const work = mkdtempSync(join(tmpdir(), "sys2qa-e2e-"));
const repo = join(work, "acme-portal");
let host: Host;
let server: ApiServer;
let browser: Browser;
let link: string;
let planUrl: string;
let packagePath: string;
const a11y: Array<{ screen: string; violations: string[] }> = [];

/** Runs axe-core on the current page (WCAG 2.x A and AA rules) under the UI's own content security policy. */
async function axe(page: Page, screen: string): Promise<string[]> {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: unknown,
          ) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: unknown }> }> }>;
        };
      }
    ).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    });
    return result.violations.map((v) => `${v.id} (${v.impact}): ${JSON.stringify(v.nodes.map((n) => n.target))}`);
  });
  a11y.push({ screen, violations });
  return violations;
}

/** The accessible name of the focused element. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const e = document.activeElement as HTMLElement | null;
    if (!e) return "";
    const label =
      e.getAttribute("aria-label") ?? (e as HTMLInputElement).labels?.[0]?.textContent ?? e.textContent ?? "";
    return `${e.tagName.toLowerCase()}:${label.trim()}`;
  });

/** Moves focus with Tab only until the focused element's name matches. */
async function tabTo(page: Page, name: RegExp): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await page.keyboard.press("Tab");
    if (name.test(await focused(page))) return;
  }
  throw new Error(`Tab never reached ${name}`);
}

beforeAll(async () => {
  cpSync(F1, repo, { recursive: true });
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  server = await startApiServer(new AppServices(host), { webUi: { root: await bundleWebUi(join(work, "web")) } });
  link = `${server.url}/#token=${server.token}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  // Evidence for the gate report: every screen checked and what axe found on it.
  const reports = fileURLToPath(new URL("../../reports/e2e/", import.meta.url));
  mkdirSync(reports, { recursive: true });
  writeFileSync(
    join(reports, "accessibility.json"),
    `${JSON.stringify({ checked_at: new Date().toISOString(), screens: a11y }, null, 2)}\n`,
  );
  await browser?.close();
  await server?.close();
  host?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("web UI flows [@req SYS-002] [@req SYS-004]", () => {
  it("Mode A: the wizard asks only what the developer has, analyzes, and shows the evidence profile, readiness and system map", async () => {
    const page = await browser.newPage();
    await page.goto(link);
    await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe("Projects");
    await page.getByRole("link", { name: "Start a project" }).first().click();
    await page.getByRole("radio", { name: /Mode A/ }).waitFor();
    expect(await axe(page, "start wizard: starting point")).toEqual([]);
    await page.getByRole("radio", { name: /Mode A/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    // Every question of the wizard is about what the user has: no workflow, architecture or rule (SYS-002).
    const asked = await page.locator("main label").allTextContents();
    expect(asked).toEqual(["Project name (required)", "Repository path (required)"]);
    expect(await axe(page, "start wizard: what you have")).toEqual([]);
    await page.getByLabel("Project name (required)").fill("Acme portal");
    await page.getByLabel("Repository path (required)").fill(repo);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => page.locator("main").textContent()).toContain(`Read-only static analysis of ${repo}`);
    expect(await axe(page, "start wizard: authorization declaration")).toEqual([]);
    await page.getByLabel("Your name (required)").fill("QA Lead");
    await page.getByLabel(/I am authorized/).check();
    await page.getByRole("button", { name: "Declare and analyze" }).click();
    await page.getByRole("heading", { level: 1, name: /^Package pkg:/ }).waitFor({ timeout: 120_000 });

    const main = page.locator("main");
    await expect.poll(() => main.textContent(), { timeout: 30_000 }).toContain("What this evidence cannot establish");
    const text = (await main.textContent()) ?? "";
    expect(text).toContain("Behavior of any running environment");
    expect(text).toMatch(/source analysis: available/);
    expect(text).toMatch(/runtime observation: unavailable/);
    await page.getByRole("table", { name: /Readiness per activity/ }).waitFor();
    await page.getByRole("heading", { name: /System map: 8 workflow\(s\)/ }).waitFor();
    expect(await axe(page, "package: evidence profile, readiness, system map")).toEqual([]);

    await page.getByRole("button", { name: "Create a test plan from this package" }).click();
    await page.getByRole("heading", { level: 1, name: "Test plan" }).waitFor();
    planUrl = page.url();
    await page.getByRole("button", { name: "Generate and check scenarios" }).click();
    await page.getByRole("table", { name: /scenario\(s\); select the ones to approve/ }).waitFor({ timeout: 60_000 });
    expect(await axe(page, "plan: coverage and scenario review")).toEqual([]);
    await page.close();
  });

  it("review and approval: a decision is recorded, and nothing is approved before its exact versions and binding are shown", async () => {
    const page = await browser.newPage();
    await page.goto(link);
    await page.goto(planUrl);
    await page.getByLabel("Show scenarios with status").selectOption("pending_review");
    await page.getByRole("table", { name: /scenario\(s\)/ }).waitFor();

    await page
      .getByRole("button", { name: /Sign in as CUSTOMER and request the guarded action/ })
      .first()
      .click();
    const detail = page.getByRole("heading", { level: 3, name: /^TC-/ });
    await detail.waitFor();
    expect(await detail.evaluate((h) => h === document.activeElement)).toBe(true);
    await page.getByLabel("Decision").selectOption("defer");
    await page.getByLabel("Reason (required)").fill("Customer access is reviewed next sprint.");
    await page.getByRole("button", { name: "Record decision" }).click();
    await expect.poll(() => page.getByRole("status").textContent()).toBe("Decision recorded.");
    expect(await axe(page, "plan: scenario detail and decision")).toEqual([]);

    await page.getByLabel("Select TC-ADMIN-001").check();
    await page.getByLabel("Select TC-ADMIN-003").check();
    await page.getByLabel("Environment the tests will run in (required)").fill("tester laptop");
    await page.getByRole("button", { name: "Preview approval" }).click();
    await page.getByRole("heading", { name: "You are about to approve 2 scenario version(s)" }).waitFor();
    const preview = (await page.locator(".panel").last().textContent()) ?? "";
    expect(preview).toContain("tester laptop");
    expect(preview).toMatch(/pkg:\S+ version 1/);
    expect(preview).toContain("TC-ADMIN-001");
    expect(preview).toContain("TC-ADMIN-003");
    expect(await axe(page, "plan: approval preview")).toEqual([]);
    await page.getByRole("button", { name: "Approve 2 scenario(s)" }).click();
    await expect.poll(() => page.getByRole("status").textContent()).toBe("2 scenario(s) approved.");

    const approved = host.state.db
      .prepare("SELECT scenario_id, state FROM approvals WHERE state = 'active' ORDER BY scenario_id")
      .all() as Array<{ scenario_id: string; state: string }>;
    expect(approved.map((a) => a.scenario_id.split(".").slice(1).join("."))).toEqual([
      "admin.users_access.allowed-admin",
      "admin.users_access.denied-anonymous",
    ]);
    const deferred = host.state.db
      .prepare("SELECT COUNT(*) AS n FROM scenario_versions WHERE status = 'deferred'")
      .get() as { n: number };
    expect(deferred.n).toBe(1);
    // Coverage follows the approval: admin on the user list now has an allowed and a denied case.
    await expect
      .poll(() => page.getByRole("row", { name: /Role-permission pairs/ }).textContent())
      .toMatch(/1 of 2 \(50%\)$/);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await axe(page, "plan in the dark color scheme")).toEqual([]);
    await page.close();
  });

  it("Mode D: an exported package is imported into a new project and shows its evidence profile", async () => {
    packagePath = (host.state.db.prepare("SELECT path FROM packages LIMIT 1").get() as { path: string }).path;
    const page = await browser.newPage();
    await page.goto(link);
    await page.goto(`${server.url}/#/start`);
    await page.getByRole("radio", { name: /Mode D/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    expect(await page.locator("main label").allTextContents()).toEqual([
      "Project name (required)",
      "Package path (required)",
    ]);
    await page.getByLabel("Project name (required)").fill("Imported Acme");
    await page.getByLabel("Package path (required)").fill(packagePath);
    await page.getByRole("button", { name: "Import package" }).click();
    await page.getByRole("heading", { level: 1, name: /^Package pkg:/ }).waitFor({ timeout: 60_000 });
    await page.getByRole("heading", { name: "Evidence profile" }).waitFor();
    await page.getByRole("heading", { name: /System map/ }).waitFor();
    await page.close();
  });

  it("Mode B: a URL is recorded with the scope its declaration shows, and the project lists it", async () => {
    const page = await browser.newPage();
    await page.goto(link);
    await page.goto(`${server.url}/#/start`);
    await page.getByRole("radio", { name: /Mode B/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    expect(await page.locator("main label").allTextContents()).toEqual([
      "Project name (required)",
      "Environment URL (required)",
      "Kind of environment",
    ]);
    await page.getByLabel("Project name (required)").fill("Acme staging");
    await page.getByLabel("Environment URL (required)").fill("https://staging.acme.example/");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => page.locator("main").textContent()).toContain("limited to the host staging.acme.example");
    await page.getByLabel("Your name (required)").fill("QA Lead");
    await page.getByLabel(/I am authorized/).check();
    await page.getByRole("button", { name: "Declare" }).click();
    await page.getByRole("heading", { level: 1, name: "Acme staging" }).waitFor();
    expect(await page.locator("main").textContent()).toContain("Environment: https://staging.acme.example/");
    expect(await axe(page, "project overview")).toEqual([]);
    await page.goto(`${server.url}/#/`);
    await page.getByRole("table", { name: "Your projects" }).waitFor();
    expect(await axe(page, "projects")).toEqual([]);
    await page.close();
  });

  it("without the session link, the page reads nothing and explains how to open it", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.url}/`);
    await page.getByRole("heading", { level: 1, name: "Open Sys2QA from the launcher" }).waitFor();
    expect(await axe(page, "no session")).toEqual([]);
    await context.close();
  });
});

describe("keyboard-only use of setup, review and approval [@req NFR-009]", () => {
  it("starts a project and approves a scenario with the keyboard alone, with focus following each step", async () => {
    const page = await browser.newPage();
    await page.goto(link);
    await page.getByRole("heading", { level: 1, name: "Projects" }).waitFor();
    // Each page puts focus on its heading; the skip link comes first in the tab order of the page.
    await expect.poll(() => focused(page)).toBe("h1:Projects");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    expect(await focused(page)).toBe("a:Skip to content");
    await page.keyboard.press("Enter");
    expect(await focused(page)).toMatch(/^main:/);
    await tabTo(page, /^a:Start a project$/);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { level: 1, name: "Start a project" }).waitFor();
    expect(await focused(page)).toBe("h1:Start a project");
    await tabTo(page, /^input:Mode A/);
    await page.keyboard.press("Space");
    await tabTo(page, /^button:Continue$/);
    await page.keyboard.press("Enter");
    await tabTo(page, /^input:Project name/);
    await page.keyboard.type("Keyboard project");
    await page.keyboard.press("Tab");
    await page.keyboard.type(repo);
    await page.keyboard.press("Enter");
    await tabTo(page, /^input:Your name/);
    await page.keyboard.type("QA Lead");
    await tabTo(page, /^input:I am authorized/);
    await page.keyboard.press("Space");
    await tabTo(page, /^button:Declare and analyze$/);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { level: 1, name: /^Package pkg:/ }).waitFor({ timeout: 120_000 });
    expect(await focused(page)).toMatch(/^h1:Package pkg:/);

    // Review and approve on the plan created earlier.
    await page.goto(planUrl);
    await page.getByRole("table", { name: /scenario\(s\)/ }).waitFor();
    await tabTo(page, /^button:Sign in as ADMIN and request the guarded action/);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { level: 3, name: /^TC-/ }).waitFor();
    expect(await focused(page)).toMatch(/^h3:TC-/);
    await page.keyboard.press("Shift+Tab");
    await tabTo(page, /^input:Select TC-AUTH-001$/);
    await page.keyboard.press("Space");
    await tabTo(page, /^input:Environment the tests will run in/);
    await page.keyboard.type("tester laptop");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "You are about to approve 1 scenario version(s)" }).waitFor();
    await tabTo(page, /^button:Approve 1 scenario\(s\)$/);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.getByRole("status").textContent()).toBe("1 scenario(s) approved.");
    const approved = host.state.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE state = 'active' AND scenario_id LIKE '%auth%'")
      .get() as { n: number };
    expect(approved.n).toBe(1);
    await page.close();
  });

  it("has no automated accessibility violation on any screen it visited", () => {
    expect(a11y.length).toBeGreaterThanOrEqual(11);
    expect(a11y.filter((s) => s.violations.length > 0)).toEqual([]);
  });
});
