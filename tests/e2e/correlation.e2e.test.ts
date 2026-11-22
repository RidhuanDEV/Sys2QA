import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { memorySink } from "../../packages/platform/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const F1 = join(ROOT, "fixtures", "benchmarks", "F1-repository-only", "repo");
const F3 = join(ROOT, "fixtures", "benchmarks", "F3-combined");
const EXPECTED = JSON.parse(readFileSync(join(F3, "ground-truth", "correlation.json"), "utf8")) as {
  links: Array<{ observed: string; source: string }>;
  discrepancies: Array<{ key: string; type: string; observed: string[]; source: string[] }>;
  unmatched: { observed: string[]; source: string[] };
  revision_correspondence: string;
};

interface Report {
  revision_correspondence: string;
  links: Array<{ observed_id: string; source_id: string; rationale: string; confidence: string }>;
  unmatched: { observed: string[]; source: string[] };
  discrepancies: Array<{
    type: string;
    observed_ids: string[];
    source_ids: string[];
    description: string;
    possibly_version_related: boolean;
  }>;
  path: string;
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-correlation-"));
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "owner@example.com" };
const call = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
const data = <T>(r: ServiceResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as T;
};
let runtime: { origin: string; close(): Promise<void> };
let report: Report;

beforeAll(async () => {
  const adapters = await bundleSaaAdapters(join(work, "adapters"));
  host = openHost({ home: mkdtempSync(join(work, "home-")), logSink: memorySink(), adapters });
  services = new AppServices(host);
  data(await call("system.set_setting", { key: "local_owner_mode_enabled", value: true }));
  const { startF3Runtime } = (await import(pathToFileURL(join(F3, "runtime", "server.mjs")).href)) as {
    startF3Runtime(): Promise<{ origin: string; close(): Promise<void> }>;
  };
  runtime = await startF3Runtime();

  // Mode C: one project with the repository and the environment; SAA and QAA each publish their own package.
  const started = data<{ project: { id: string }; source: { id: string } }>(
    await call("saa.start", { name: "Acme portal", root: F1 }),
  );
  const projectId = started.project.id;
  data(
    await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" }),
  );
  const run = data<{ run_id: string }>(await call("saa.analyze", { source_id: started.source.id }));
  const saa = data<{ package_id: string; version: number; path: string }>(
    await call("saa.export", { run_id: run.run_id }),
  );

  const env = data<{ id: string }>(
    await call("project.add_source", { project_id: projectId, kind: "environment", ref: runtime.origin }),
  );
  data(await call("project.declare", { source_id: env.id, declared_by: caller.actor, operation_level: "L2" }));
  data(
    await call("project.configure_environment", {
      source_id: env.id,
      base_url: `${runtime.origin}/`,
      classification: "development",
      allowed_hosts: [new URL(runtime.origin).host],
      local_owner_mode: true,
    }),
  );
  // The source's static page routes seed the walk, so a route no link leads to is still tried.
  const sourceModel = JSON.parse(readFileSync(join(saa.path, "system-model.json"), "utf8")) as {
    entities: Array<{ kind: string; route_pattern?: string }>;
  };
  const seeds = sourceModel.entities
    .filter((e) => e.kind === "page" && e.route_pattern && !/[{[:]/.test(e.route_pattern))
    .map((e) => `${runtime.origin}${e.route_pattern!}`);
  const discovered = data<{ job_id: string }>(await call("discovery.run", { source_id: env.id, seeds }));
  const qaa = data<{ package_id: string; version: number }>(
    await call("discovery.publish", { run_id: discovered.job_id }),
  );
  report = data<Report>(
    await call("correlation.run", {
      project_id: projectId,
      saa_package_id: saa.package_id,
      saa_version: saa.version,
      qaa_package_id: qaa.package_id,
      qaa_version: qaa.version,
    }),
  );
  const reports = join(ROOT, "reports", "e2e");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "correlation-f3.json"), `${JSON.stringify(report, null, 2)}\n`);
});

afterAll(async () => {
  await runtime?.close();
  host?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("Mode C correlation on F3 [@req QAA-FR-115] [@req CON-026] [@req CON-023]", () => {
  it("links every expected observed page and form to its source counterpart, with a rationale", () => {
    for (const expected of EXPECTED.links)
      expect(
        report.links.find((l) => l.observed_id === expected.observed && l.source_id === expected.source),
        expected.observed,
      ).toMatchObject({ rationale: expect.any(String) });
  });

  it("detects every deliberate discrepancy", () => {
    for (const expected of EXPECTED.discrepancies) {
      const found = report.discrepancies.find(
        (d) =>
          d.type === expected.type &&
          expected.observed.every((id) => d.observed_ids.includes(id)) &&
          expected.source.every((id) => d.source_ids.includes(id)),
      );
      expect(found, expected.key).toBeDefined();
    }
    // The page with no source route is reported, never given an invented source link.
    expect(
      report.discrepancies.some((d) => d.type === "unmatched_page" && d.observed_ids.includes("page:observed:/promo")),
    ).toBe(true);
    expect(report.links.some((l) => l.observed_id === "page:observed:/promo")).toBe(false);
  });

  it("lists what stays unmatched on each side and never counts the disabled route as observed", () => {
    for (const id of EXPECTED.unmatched.observed) expect(report.unmatched.observed).toContain(id);
    for (const id of EXPECTED.unmatched.source) expect(report.unmatched.source).toContain(id);
    expect(report.links.some((l) => l.source_id === "page:web:/admin/users")).toBe(false);
  });

  it("keeps revision correspondence unconfirmed, so every discrepancy may be version-related", () => {
    expect(report.revision_correspondence).toBe(EXPECTED.revision_correspondence);
    expect(report.discrepancies.every((d) => d.possibly_version_related)).toBe(true);
  });
});
