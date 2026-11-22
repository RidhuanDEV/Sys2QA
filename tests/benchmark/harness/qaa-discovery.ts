import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppServices, openHost, type ServiceResult } from "../../../packages/app-services/src/index.js";
import type { ProducerOutput } from "./producer-output.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const F2_SITE = join(ROOT, "fixtures", "benchmarks", "F2-url-only", "site", "server.mjs");

/**
 * Runtime discovery of F2 as a producer (Gate 4): the F2 site on loopback, a URL-only project whose environment is
 * named by local owner mode, `discovery.run` from the base URL only (no names supplied, QAA-FR-114), and
 * `discovery.publish`. The published package is copied to `packageDir`; the runtime facts come from the run's
 * observations. Needs Chromium (Playwright), like the E2E suite.
 */
export async function discoverF2(
  packageDir: string,
): Promise<{ packageDir: string; runtime: NonNullable<ProducerOutput["runtime"]> }> {
  const { startF2Site } = (await import(pathToFileURL(F2_SITE).href)) as {
    startF2Site(): Promise<{ origin: string; close(): Promise<void> }>;
  };
  const site = await startF2Site();
  const work = mkdtempSync(join(tmpdir(), "sys2qa-f2-discovery-"));
  const host = openHost({ home: work });
  const services = new AppServices(host);
  const caller = { interface: "cli" as const, actor: "benchmark" };
  const call = async <T>(operation: string, input: unknown): Promise<T> => {
    const r: ServiceResult = await services.execute(operation, input, caller);
    if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  };
  try {
    await call("system.set_setting", { key: "local_owner_mode_enabled", value: true });
    const project = await call<{ id: string }>("project.create", { name: "F2 site" });
    const env = await call<{ id: string }>("project.add_source", {
      project_id: project.id,
      kind: "environment",
      ref: site.origin,
    });
    await call("project.declare", { source_id: env.id, declared_by: "benchmark", operation_level: "L2" });
    await call("project.configure_environment", {
      source_id: env.id,
      base_url: `${site.origin}/`,
      classification: "development",
      allowed_hosts: [new URL(site.origin).host],
      local_owner_mode: true,
    });
    const run = await call<{ job_id: string; artifact: string }>("discovery.run", { source_id: env.id });
    const published = await call<{ path: string }>("discovery.publish", { run_id: run.job_id, output_dir: packageDir });
    const observations = JSON.parse(readFileSync(run.artifact, "utf8")) as {
      pages: Array<{ path: string; status: number | null; observability?: string }>;
      forms: Array<{ submitted: boolean; form: { page_url: string; dom_id?: string | null } }>;
    };
    const formId = (f: (typeof observations.forms)[number]) =>
      `form:observed:${new URL(f.form.page_url).pathname}#${f.form.dom_id}`;
    return {
      packageDir: published.path,
      runtime: {
        visited_pages: observations.pages
          .filter((p) => !p.observability && (p.status === null || p.status < 400))
          .map((p) => p.path),
        discovered_forms: observations.forms.map(formId),
        submitted_forms: observations.forms.filter((f) => f.submitted).map(formId),
      },
    };
  } finally {
    host.close();
    await site.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
