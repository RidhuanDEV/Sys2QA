import childProcess from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { bundleSaaAdapters } from "../benchmark/harness/index.js";

const F1 = fileURLToPath(new URL("../../fixtures/benchmarks/F1-repository-only/repo", import.meta.url));
const RULE = "business_rule:registration.nib_13_digits";
const SPAWNING = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

/** Replaces every child_process entry point with a recorder that refuses to start anything (as ST-02 does). */
function monitorSpawns(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const target = childProcess as unknown as Record<string, unknown>;
  const original = Object.fromEntries(SPAWNING.map((name) => [name, target[name]]));
  for (const name of SPAWNING)
    target[name] = (...args: unknown[]) => {
      calls.push(`${name} ${String(args[0])}`);
      throw new Error(`no process may start: ${name}`);
    };
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      Object.assign(target, original);
      syncBuiltinESMExports();
    },
  };
}

function tree(dir: string): string {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const n of readdirSync(p).sort()) {
      const f = join(p, n);
      if (statSync(f).isDirectory()) walk(f);
      else out.push(`${f.slice(dir.length)}:${readFileSync(f).toString("base64")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

const work = mkdtempSync(join(tmpdir(), "sys2qa-source-check-"));
const repo = join(work, "acme-portal");
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
  return r.data as T;
}
interface Check {
  result: string;
  source_type: string;
  evidence: Array<{ status: string; path: string }>;
}

let ref: { project_id: string; package_id: string; version: number; packagePath: string };

beforeAll(async () => {
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
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number; path: string }>("saa.export", {
    run_id: run.run_id,
  });
  ref = {
    project_id: started.project.id,
    package_id: exported.package_id,
    version: exported.version,
    packagePath: exported.path,
  };
}, 240_000);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const verify = (record_id = RULE) =>
  raw("source.verify", { project_id: ref.project_id, package_id: ref.package_id, version: ref.version, record_id });

describe("targeted source verification [@req QAA-FR-017] [@req SEC-002]", () => {
  it("confirms a record whose cited files are unchanged, reading only, starting no process and changing nothing", async () => {
    const repoBefore = tree(repo);
    const packageBefore = tree(ref.packagePath);
    const monitor = monitorSpawns();
    let result: ServiceResult;
    try {
      result = await verify();
    } finally {
      monitor.restore();
    }
    expect(monitor.calls).toEqual([]);
    const check = (result as { ok: true; data: Check }).data;
    expect(check).toMatchObject({ result: "confirmed", source_type: "targeted_source_check" });
    expect(check.evidence.length).toBeGreaterThan(0);
    for (const e of check.evidence) expect(e.status).toBe("matches");
    expect(tree(repo)).toBe(repoBefore);
    expect(tree(ref.packagePath)).toBe(packageBefore);
    const stored = host.state.db.prepare("SELECT result FROM source_checks WHERE record_id = ?").all(RULE) as Array<{
      result: string;
    }>;
    expect(stored).toEqual([{ result: "confirmed" }]);
  });

  it("is unconfirmed, comparing nothing, when the checkout is at another revision", async () => {
    appendFileSync(join(repo, "README.md"), "\nEdited after the analysis.\n");
    const check = ((await verify()) as { ok: true; data: Check }).data;
    expect(check.result).toBe("unconfirmed");
    for (const e of check.evidence) expect(e.status).toBe("not_checked");
  });

  it("needs a declaration that covers reading the checkout, and a record with source evidence", async () => {
    expect((await verify("entity:no_such_thing")).ok ? "ok" : "NOT_FOUND").toBe("NOT_FOUND");
    const other = await call<{ id: string }>("project.create", { name: "No checkout" });
    const imported = await call<{ package: { package_id: string; version: number } }>("package.import", {
      project_id: other.id,
      path: ref.packagePath,
    });
    const r = await raw("source.verify", {
      project_id: other.id,
      package_id: imported.package.package_id,
      version: imported.package.version,
      record_id: RULE,
    });
    expect(r.ok ? "ok" : r.error.code).toBe("NOT_FOUND");
    const third = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
      name: "Undeclared",
      root: repo,
    });
    const imported3 = await call<{ package: { package_id: string; version: number } }>("package.import", {
      project_id: third.project.id,
      path: ref.packagePath,
    });
    const denied = await raw("source.verify", {
      project_id: third.project.id,
      package_id: imported3.package.package_id,
      version: imported3.package.version,
      record_id: RULE,
    });
    expect(denied.ok ? "ok" : denied.error.code).toBe("DECLARATION_REQUIRED");
  });
});
