import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { memorySink } from "../../packages/platform/src/index.js";
import { runL2Job, startScopeProxy, type ProxyDecision } from "../../packages/runtime-observer/src/index.js";

vi.setConfig({ testTimeout: 120_000 });

/** A target site on loopback: sets a session cookie, posts on load, and pulls a resource from another host. */
interface Site {
  port: number;
  origin: string;
  hits: Array<{ method: string; path: string; cookie: string | undefined }>;
  server: Server;
}
async function site(): Promise<Site> {
  const hits: Site["hits"] = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? "GET", path: req.url ?? "/", cookie: req.headers.cookie });
    res.setHeader("set-cookie", `session=${Math.random().toString(36).slice(2)}; Path=/; HttpOnly`);
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><title>Acme staging</title>
       <script>localStorage.setItem("seen", "yes"); fetch("/api/orders", { method: "POST", body: "{}" });</script>
       <img src="http://127.0.0.1:${other.port}/pixel.png"><img src="https://tracker.example/p.gif">`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { port, origin: `http://127.0.0.1:${port}`, hits, server };
}

let target: Site;
let other: Site;
beforeAll(async () => {
  other = await site();
  target = await site();
});
afterAll(() => {
  target.server.close();
  other.server.close();
});

const scopeOf = (s: Site) => ({ allowed_hosts: [`127.0.0.1:${s.port}`], path_prefixes: ["/"], local_owner_mode: true });

describe("L2 browser workers [@req SEC-012] [@req QAA-FR-006] [@req SEC-025]", () => {
  it("validates reachability with GET only, through the proxy, and reaches nothing outside the scope", async () => {
    const decisions: ProxyDecision[] = [];
    const proxy = await startScopeProxy({
      scope: scopeOf(target),
      localOwnerModeEnabled: true,
      rateLimit: { perSecond: 50, burst: 50 },
      onDecision: (d) => decisions.push(d),
    });
    try {
      const before = target.hits.length;
      const result = await runL2Job({ action: "validate", url: `${target.origin}/`, scope: scopeOf(target) }, proxy);
      expect(result).toMatchObject({ ok: true, status: 200, title: "Acme staging" });
      // The page's POST never left the browser; the target saw only the GET.
      expect(target.hits.slice(before).map((h) => h.method)).toEqual(["GET"]);
      expect(result.blocked.map((b) => [b.method, b.reason])).toEqual(
        expect.arrayContaining([
          ["POST", "POST is not allowed while validating"],
          ["GET", "outside the scope"],
        ]),
      );
      // The other loopback service and the tracker were reached by no route.
      expect(other.hits).toEqual([]);
      // The page load went through the proxy, although its address is loopback.
      expect(decisions.filter((d) => d.allowed).map((d) => d.target)).toContain(`${target.origin}/`);
    } finally {
      await proxy.close();
    }
  });

  it("starts every job from a fresh profile: no cookie or storage of an earlier job or project reaches the next (ST-11, L2 part)", async () => {
    const run = async () => {
      const proxy = await startScopeProxy({
        scope: scopeOf(target),
        localOwnerModeEnabled: true,
        rateLimit: { perSecond: 50, burst: 50 },
        onDecision: () => {},
      });
      try {
        return await runL2Job({ action: "validate", url: `${target.origin}/`, scope: scopeOf(target) }, proxy);
      } finally {
        await proxy.close();
      }
    };
    const before = target.hits.length;
    const first = await run();
    const second = await run();
    expect(first.cookies_after).toEqual(["session"]);
    expect(second.cookies_before).toEqual([]);
    const gets = target.hits.slice(before).filter((h) => h.method === "GET");
    expect(gets.map((h) => h.cookie)).toEqual([undefined, undefined]);
  });

  it("gives the worker process no secret of the host environment", async () => {
    process.env.SYS2QA_TEST_SECRET = "must-not-reach-the-worker";
    const proxy = await startScopeProxy({
      scope: scopeOf(target),
      localOwnerModeEnabled: true,
      rateLimit: { perSecond: 50, burst: 50 },
      onDecision: () => {},
    });
    try {
      const result = await runL2Job({ action: "validate", url: `${target.origin}/`, scope: scopeOf(target) }, proxy);
      expect(JSON.stringify(result)).not.toContain("must-not-reach-the-worker");
    } finally {
      delete process.env.SYS2QA_TEST_SECRET;
      await proxy.close();
    }
  });
});

describe("environment.validate [@req QAA-FR-006] [@req SEC-009] [@req SEC-005]", () => {
  let home: string;
  let host: Host;
  let services: AppServices;
  const caller = { interface: "cli" as const, actor: "owner@example.com" };
  const call = (operation: string, input: unknown): Promise<ServiceResult> =>
    services.execute(operation, input, caller);
  const data = <T>(r: ServiceResult) => {
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.data as T;
  };
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "sys2qa-l2-"));
    host = openHost({ home, logSink: memorySink() });
    services = new AppServices(host);
  });
  afterAll(() => {
    host.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("needs a declaration, refuses production, and otherwise reaches the environment through the audited proxy", async () => {
    const project = data<{ id: string }>(await call("project.create", { name: "Acme staging" }));
    const env = data<{ id: string }>(
      await call("project.add_source", { project_id: project.id, kind: "environment", ref: target.origin }),
    );
    const configure = (classification: string) =>
      call("project.configure_environment", {
        source_id: env.id,
        base_url: `${target.origin}/`,
        classification,
        allowed_hosts: [`127.0.0.1:${target.port}`],
        local_owner_mode: true,
      });
    expect((await configure("staging")).ok).toBe(false); // configuring needs a declaration first
    data(await call("project.declare", { source_id: env.id, declared_by: caller.actor, operation_level: "L2" }));
    data(await call("system.set_setting", { key: "local_owner_mode_enabled", value: true }));
    data(await configure("production"));
    const refused = await call("environment.validate", { source_id: env.id });
    expect(refused.ok ? "ok" : refused.error.code).toBe("PRODUCTION_REFUSED");
    data(await configure("staging"));
    const validated = data<{ reachable: boolean; status: number; title: string; job_id: string }>(
      await call("environment.validate", { source_id: env.id }),
    );
    expect(validated).toMatchObject({ reachable: true, status: 200, title: "Acme staging" });
    const audited = host.state.db
      .prepare(
        "SELECT action, details_json FROM audit_events WHERE project_id = ? AND action IN ('egress.decision', 'environment.validated') ORDER BY seq",
      )
      .all(project.id) as Array<{ action: string; details_json: string }>;
    expect(audited.at(-1)!.action).toBe("environment.validated");
    expect(audited.filter((a) => a.action === "egress.decision").length).toBeGreaterThan(0);
  });
});
