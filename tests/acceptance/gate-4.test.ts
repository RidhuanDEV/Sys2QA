import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateDocument, validatePackage } from "../../packages/contract/src/index.js";
import {
  bundleSaaAdapters,
  computeMetrics,
  loadGroundTruth,
  packageOutput,
  qaaDesign,
} from "../benchmark/harness/index.js";
import { startSsrfFixtureServer, type SsrfFixtureServer } from "../security/harness/index.js";

/**
 * Gate 4 acceptance (IMP-409, PRD §29.1, Test Strategy §8): one block per checklist item, on the F2 site (Mode B, URL
 * only), the F3 runtime with F1's repository (Mode C), a forms fixture and the SSRF fixture, all on loopback. It runs
 * a real Chromium, so it belongs to the browser suite (`vitest.e2e.config.ts`). `scripts/gate-report.mjs --gate 4`
 * maps these blocks to the checklist.
 */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const F1 = join(REPO, "fixtures", "benchmarks", "F1-repository-only", "repo");
const F2 = join(REPO, "fixtures", "benchmarks", "F2-url-only");
const F3 = join(REPO, "fixtures", "benchmarks", "F3-combined");
const TIMEOUT = 300_000;

let work: string;
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "owner@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok)
    throw new Error(`${operation}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data as T;
}

/** An environment for a loopback site (local owner mode), in a new project or the given one. */
async function environment(origin: string, options: { projectId?: string; level?: string; paths?: string[] } = {}) {
  const projectId = options.projectId ?? (await call<{ id: string }>("project.create", { name: `Site ${origin}` })).id;
  const env = await call<{ id: string }>("project.add_source", {
    project_id: projectId,
    kind: "environment",
    ref: origin,
  });
  await call("project.declare", {
    source_id: env.id,
    declared_by: caller.actor,
    operation_level: options.level ?? "L2",
  });
  await call("project.configure_environment", {
    source_id: env.id,
    base_url: `${origin}${options.paths?.[0] ?? "/"}`,
    classification: "development",
    allowed_hosts: [new URL(origin).host],
    local_owner_mode: true,
    ...(options.paths ? { path_prefixes: options.paths } : {}),
  });
  return { projectId, envId: env.id };
}

function filesOf(dir: string, base = dir): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) for (const [k, v] of filesOf(full, base)) out.set(k, v);
    else out.set(relative(base, full).split(sep).join("/"), readFileSync(full));
  }
  return out;
}

const egressDenied = (projectId: string) =>
  (
    host.state.db
      .prepare("SELECT details_json FROM audit_events WHERE project_id = ? AND action = 'egress.decision'")
      .all(projectId) as Array<{ details_json: string }>
  )
    .map((r) => JSON.parse(r.details_json) as { allowed: boolean; target: string; reason: string })
    .filter((d) => !d.allowed);

let f2: { origin: string; close(): Promise<void> };
let f3: { origin: string; close(): Promise<void> };
let ssrf: SsrfFixtureServer;
let forms: { origin: string; hits: Array<{ method: string; path: string }>; close(): Promise<void> };
/** The URL-only F2 project: its discovery run, artifact and published package. */
let modeB: {
  projectId: string;
  envId: string;
  jobId: string;
  artifact: string;
  pkg: { package_id: string; version: number; path: string };
};

/** A forms fixture: login, delete, invitation, unknown-effect and search forms; every request is recorded. */
async function startFormsSite() {
  const page = `<!doctype html><html lang="en"><title>Forms</title>
<form id="login" method="post" action="/login"><input name="email" type="email"><input name="password" type="password"><button>Sign in</button></form>
<form id="delete" method="post" action="/account/delete"><button>Delete account</button></form>
<form id="invite" method="post" action="/team/invite"><input name="email" type="email"><button>Invite</button></form>
<form id="export" method="get" action="/export"><input name="token" type="text"><button>Search</button></form>
<form id="search" method="get" action="/search"><input name="q" type="search"><button>Search</button></form></html>`;
  const hits: Array<{ method: string; path: string }> = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.push({ method: req.method ?? "GET", path });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(path === "/forms" ? page : "<!doctype html><title>Result</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "sys2qa-gate4-"));
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);
  await call("system.set_setting", { key: "local_owner_mode_enabled", value: true });
  const site = async (dir: string, fn: string) =>
    (
      (await import(pathToFileURL(join(dir, fn === "startF2Site" ? "site" : "runtime", "server.mjs")).href)) as Record<
        string,
        () => Promise<{ origin: string; close(): Promise<void> }>
      >
    )[fn]!();
  f2 = await site(F2, "startF2Site");
  f3 = await site(F3, "startF3Runtime");
  ssrf = await startSsrfFixtureServer();
  forms = await startFormsSite();

  // Mode B: a URL and nothing else.
  const { projectId, envId } = await environment(f2.origin);
  const run = await call<{ job_id: string; artifact: string }>("discovery.run", { source_id: envId });
  const pkg = await call<{ package_id: string; version: number; path: string }>("discovery.publish", {
    run_id: run.job_id,
  });
  modeB = { projectId, envId, jobId: run.job_id, artifact: run.artifact, pkg };
}, TIMEOUT);

afterAll(async () => {
  await Promise.all([f2?.close(), f3?.close(), ssrf?.close(), forms?.close()]);
  host?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("Gate 4 item 1: a URL-only project reaches reviewed, manually executable scenarios, with no internal-effect claims [@req QAA-FR-110] [@req QAA-FR-114] [@req CON-023] [@req SYS-001]", () => {
  it(
    "discovers F2 from its URL, plans and reviews scenarios on the observed package, approves two and starts a manual run",
    async () => {
      const sources = host.projects.listEvidenceSources(modeB.projectId).map((s) => s.kind);
      expect(sources).toEqual(["environment"]);
      const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
        project_id: modeB.projectId,
        package_id: modeB.pkg.package_id,
        version: modeB.pkg.version,
      });
      await call("scenarios.generate", { plan_id: plan.plan.plan_id });
      await call("scenarios.critique", { plan_id: plan.plan.plan_id });
      const pending = (
        await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
          project_id: modeB.projectId,
          status: "pending_review",
        })
      ).scenarios.map((s) => s.scenario_id);
      const chosen = pending.filter((id) => id.includes("register")).slice(0, 2);
      expect(chosen).toHaveLength(2);
      const binding = { mode: "manual", declared_environment: "F2 development site" } as const;
      const preview = await call<{ preview_token: string }>("approvals.preview", {
        project_id: modeB.projectId,
        scenario_ids: chosen,
        ...binding,
      });
      await call("approvals.approve", {
        project_id: modeB.projectId,
        scenario_ids: chosen,
        ...binding,
        preview_token: preview.preview_token,
      });
      const started = await call<{ run: { label: string } }>("runs.start_manual", {
        project_id: modeB.projectId,
        scenario_ids: chosen,
        declared_environment: binding.declared_environment,
        declared_environment_url: `${f2.origin}/`,
      });
      expect(started.run.label).toBe("tester-reported");
      const pack = await call<{ path: string }>("packs.export", { project_id: modeB.projectId, scenario_ids: chosen });
      expect(
        validateDocument("manual-test-pack", JSON.parse(readFileSync(join(pack.path, "pack.json"), "utf8"))).issues,
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "claims nothing about internal effects: no over-claiming, no forbidden scenario, no source or requirement basis",
    async () => {
      const truth = loadGroundTruth(join(F2, "ground-truth"), "F2-url-only");
      const metrics = computeMetrics(truth, {
        ...packageOutput(modeB.pkg.path),
        scenarios: await qaaDesign({ packageDir: modeB.pkg.path }),
      });
      expect(metrics.over_claiming).toEqual({ count: 0, items: [] });
      expect(metrics.scenarios.forbidden_present).toBe(0);
      expect(metrics.gates.filter((g) => !g.passed)).toEqual([]);
      const model = JSON.parse(readFileSync(join(modeB.pkg.path, "system-model.json"), "utf8")) as {
        relationships: Array<{ type: string }>;
      };
      expect([...new Set(model.relationships.map((r) => r.type))].sort()).toEqual(["CONTAINS", "NAVIGATES_TO"]);
    },
    TIMEOUT,
  );
});

describe("Gate 4 item 2: forms are inspected, never submitted by default; with read-only submissions only confirmed read-only forms are [@req SEC-024] [@req QAA-FR-025] [@req SEC-019]", () => {
  const formHits = () => forms.hits.filter((h) => h.path !== "/forms");
  it(
    "submits nothing by default and shows every stopped form with what remains unknown",
    async () => {
      const { envId } = await environment(forms.origin);
      const r = await call<{
        submissions: unknown[];
        stopped_for_approval: Array<{ proposal: string; unknown: string }>;
      }>("forms.inspect", { source_id: envId, url: `${forms.origin}/forms` });
      expect(r.submissions).toEqual([]);
      expect(r.stopped_for_approval).toHaveLength(5);
      expect(r.stopped_for_approval.every((s) => /was not observed/.test(s.unknown))).toBe(true);
      expect(formHits()).toEqual([]);
      // Discovery of F2 submitted none of its forms either, and lists each with the reason.
      const artifact = JSON.parse(readFileSync(modeB.artifact, "utf8")) as { forms: Array<{ submitted: boolean }> };
      expect(artifact.forms.length).toBeGreaterThan(0);
      expect(artifact.forms.every((f) => !f.submitted)).toBe(true);
      const completeness = JSON.parse(readFileSync(join(modeB.pkg.path, "completeness-report.json"), "utf8")) as {
        forms_not_submitted: unknown[];
      };
      expect(completeness.forms_not_submitted).toHaveLength(artifact.forms.length);
    },
    TIMEOUT,
  );

  it(
    "with L2r declared submits only the confirmed read-only search form; login, state-changing and unknown-effect forms never",
    async () => {
      const { envId } = await environment(forms.origin, { level: "L2r" });
      const first = await call<{ forms: Array<{ form_key: string; action: string }> }>("forms.inspect", {
        source_id: envId,
        url: `${forms.origin}/forms`,
      });
      const key = (path: string) => first.forms.find((f) => f.action === `${forms.origin}${path}`)!.form_key;
      for (const path of ["/login", "/account/delete", "/team/invite"])
        expect((await raw("forms.confirm", { source_id: envId, form_key: key(path), decision: "read_only" })).ok).toBe(
          false,
        );
      await call("forms.confirm", { source_id: envId, form_key: key("/search"), decision: "read_only" });
      forms.hits.length = 0;
      const second = await call<{ submissions: Array<{ form_key: string }> }>("forms.inspect", {
        source_id: envId,
        url: `${forms.origin}/forms`,
      });
      expect(second.submissions.map((s) => s.form_key)).toEqual([key("/search")]);
      expect(formHits()).toEqual([{ method: "GET", path: "/search" }]);
    },
    TIMEOUT,
  );
});

describe("Gate 4 item 3: the QAA package passes the same validator as SAA packages [@req QAA-FR-116]", () => {
  it("validates F2's observed package completely and imports it into another project as Mode D", async () => {
    const validation = validatePackage({ files: filesOf(modeB.pkg.path) });
    expect(validation.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(validation).toMatchObject({ ok: true, stage: "complete" });
    const manifest = JSON.parse(readFileSync(join(modeB.pkg.path, "manifest.json"), "utf8")) as {
      producer: { name: string };
    };
    expect(manifest.producer.name).toBe("QAA");
    const other = await call<{ id: string }>("project.create", { name: "Observed package (Mode D)" });
    const imported = await call<{ status: string; package: { producer: string } }>("package.import", {
      project_id: other.id,
      path: modeB.pkg.path,
    });
    expect(imported).toMatchObject({ status: "imported", package: { producer: "QAA" } });
  });
});

describe("Gate 4 item 4: combined mode detects the fixture discrepancies and shows revision correspondence [@req QAA-FR-115] [@req CON-026]", () => {
  it(
    "correlates F1's source package with the F3 runtime's observed package",
    async () => {
      const started = await call<{ project: { id: string }; source: { id: string } }>("saa.start", {
        name: "Acme portal",
        root: F1,
      });
      const projectId = started.project.id;
      await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
      const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
      const saa = await call<{ package_id: string; version: number; path: string }>("saa.export", {
        run_id: run.run_id,
      });
      const { envId } = await environment(f3.origin, { projectId });
      const model = JSON.parse(readFileSync(join(saa.path, "system-model.json"), "utf8")) as {
        entities: Array<{ kind: string; route_pattern?: string }>;
      };
      const seeds = model.entities
        .filter((e) => e.kind === "page" && e.route_pattern && !/[{[:]/.test(e.route_pattern))
        .map((e) => `${f3.origin}${e.route_pattern!}`);
      const discovered = await call<{ job_id: string }>("discovery.run", { source_id: envId, seeds });
      const qaa = await call<{ package_id: string; version: number }>("discovery.publish", {
        run_id: discovered.job_id,
      });
      const correlate = (revision_correspondence?: string) =>
        call<{
          revision_correspondence: string;
          discrepancies: Array<{
            type: string;
            observed_ids: string[];
            source_ids: string[];
            possibly_version_related: boolean;
          }>;
        }>("correlation.run", {
          project_id: projectId,
          saa_package_id: saa.package_id,
          saa_version: saa.version,
          qaa_package_id: qaa.package_id,
          qaa_version: qaa.version,
          ...(revision_correspondence ? { revision_correspondence } : {}),
        });
      const report = await correlate();
      const types = report.discrepancies.map((d) => d.type).sort();
      expect(types).toEqual(["constraint_mismatch", "route_unreachable", "unmatched_page"]);
      expect(report.discrepancies.find((d) => d.type === "constraint_mismatch")).toMatchObject({
        observed_ids: ["field:observed:/register#nib"],
        source_ids: ["business_rule:registration.nib_13_digits"],
      });
      expect(report.revision_correspondence).toBe("unconfirmed");
      expect(report.discrepancies.every((d) => d.possibly_version_related)).toBe(true);
      const confirmed = await correlate("user_confirmed");
      expect(confirmed.revision_correspondence).toBe("user_confirmed");
      expect(confirmed.discrepancies.every((d) => !d.possibly_version_related)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("Gate 4 item 5: out-of-scope navigation and SSRF fixtures are blocked [@req SEC-007] [@req SEC-008] [@req SEC-025] [@req QAA-FR-021]", () => {
  it(
    "refuses F2's off-scope partner redirect and audits the refusal",
    async () => {
      const artifact = JSON.parse(readFileSync(modeB.artifact, "utf8")) as {
        links_not_followed: Array<{ reason: string }>;
      };
      expect(artifact.links_not_followed.map((l) => l.reason)).toContain("redirect outside the scope, refused");
      expect(egressDenied(modeB.projectId).some((d) => d.target.includes("partner.evil.example"))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "never reaches internal, link-local, metadata or off-scope targets through the SSRF fixture's redirects",
    async () => {
      const { projectId, envId } = await environment(ssrf.origin, { paths: ["/chain", "/redirect"] });
      const seeds = ["metadata", "link_local", "private", "loopback_ipv6", "off_scope", "internal"].map(
        (t) => `${ssrf.origin}/redirect/${t}`,
      );
      await call("discovery.run", { source_id: envId, seeds, budget: { pages: 20 } });
      expect(ssrf.hits.filter((h) => h.path === "/internal/secret")).toEqual([]);
      const denied = egressDenied(projectId).map((d) => d.target);
      for (const target of ["169.254.169.254", "169.254.10.10", "10.0.0.1", "evil.example"])
        expect(
          denied.some((t) => t.includes(target)),
          target,
        ).toBe(true);
      // A seed outside the scope is refused before any browser starts.
      const outside = await raw("discovery.run", {
        source_id: envId,
        seeds: ["http://169.254.169.254/latest/meta-data/"],
      });
      expect(outside.ok ? "ok" : outside.error.code).toBe("SCOPE_DENIED");
    },
    TIMEOUT,
  );
});
