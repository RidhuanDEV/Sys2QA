import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openHost, type Host } from "../../packages/app-services/src/index.js";
import { memorySink } from "../../packages/platform/src/index.js";
import {
  auditEgressDecisions,
  startScopeProxy,
  type ProxyDecision,
  type ScopeProxy,
  type ScopeProxyOptions,
} from "../../packages/runtime-observer/src/index.js";
import { rebindingLookup, SSRF_TARGETS, startSsrfFixtureServer, type SsrfFixtureServer } from "./harness/index.js";

vi.setConfig({ testTimeout: 30_000 });

let fixture: SsrfFixtureServer;
const proxies: ScopeProxy[] = [];
beforeAll(async () => {
  fixture = await startSsrfFixtureServer();
});
afterAll(async () => {
  for (const p of proxies) await p.close();
  await fixture.close();
});

async function proxy(
  overrides: Partial<Omit<ScopeProxyOptions, "scope">> & { scope?: Partial<ScopeProxyOptions["scope"]> } = {},
) {
  const decisions: ProxyDecision[] = [];
  const p = await startScopeProxy({
    localOwnerModeEnabled: false,
    rateLimit: { perSecond: 100, burst: 100 },
    connectTimeoutMs: 1000,
    onDecision: (d) => decisions.push(d),
    ...overrides,
    scope: {
      allowed_hosts: [`127.0.0.1:${fixture.port}`],
      path_prefixes: ["/"],
      local_owner_mode: false,
      ...overrides.scope,
    },
  });
  proxies.push(p);
  return { p, decisions };
}

const auth = (p: ScopeProxy) => `Basic ${Buffer.from(`${p.username}:${p.password}`).toString("base64")}`;

/** A plain-HTTP request through the proxy, in absolute form; redirects are not followed. */
function get(
  p: ScopeProxy,
  url: string,
  withAuth = true,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: p.port,
        path: url,
        method: "GET",
        headers: { host: new URL(url).host, ...(withAuth ? { "proxy-authorization": auth(p) } : {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Sends `CONNECT authority` (or an upgrade request) and returns the proxy's status line. */
function raw(p: ScopeProxy, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(p.port, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (c: Buffer) => {
      data += c.toString();
      if (data.includes("\r\n")) {
        resolve(data.split("\r\n")[0]!);
        socket.destroy();
      }
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
  });
}

const internalHits = () => fixture.hits.filter((h) => h.path === "/internal/secret").length;

describe("ST-05 SSRF through the scope proxy [@req SEC-007] [@req SEC-008] [@req SEC-025]", () => {
  it("refuses a loopback target by default, even when it is the named host, and the target sees nothing", async () => {
    const before = fixture.hits.length;
    const { p, decisions } = await proxy();
    const r = await get(p, `${fixture.origin}/redirect/internal`);
    expect(r.status).toBe(403);
    expect(fixture.hits.length).toBe(before);
    expect(decisions.at(-1)).toMatchObject({ allowed: false, address_class: "loopback", reason: "loopback address" });
  });

  it("reaches a named loopback target only in local owner mode with the administrator switch on", async () => {
    const off = await proxy({ scope: { local_owner_mode: true } });
    expect((await get(off.p, `${fixture.origin}/`)).status).toBe(403);
    const on = await proxy({ scope: { local_owner_mode: true }, localOwnerModeEnabled: true });
    const page = await get(on.p, `${fixture.origin}/`);
    expect(page.status).toBe(200);
    expect(on.decisions.at(-1)).toMatchObject({ allowed: true, kind: "http", address: "127.0.0.1" });
  });

  it("never follows a redirect itself: every redirect target is a new request with its own check", async () => {
    const { p, decisions } = await proxy({ scope: { local_owner_mode: true }, localOwnerModeEnabled: true });
    for (const [name, target] of Object.entries(SSRF_TARGETS)) {
      const hop = await get(p, `${fixture.origin}/redirect/${name}`);
      expect(hop.status, name).toBe(302);
      expect(hop.headers.location, name).toBe(target);
      // Following it is a new request to a host outside the scope: refused before any connection.
      expect((await get(p, target)).status, name).toBe(403);
    }
    // Internal and off-scope hosts fail the scope check; the https target is refused for its scheme (https only
    // through CONNECT, where the same scope check applies).
    expect(decisions.filter((d) => !d.allowed).map((d) => d.reason)).toEqual([
      ...Object.keys(SSRF_TARGETS)
        .filter((k) => k !== "off_scope")
        .map(() => "host or port outside the scope"),
      "only http in absolute form; https uses CONNECT",
    ]);
    expect(await raw(p, `CONNECT evil.example:443 HTTP/1.1\r\nproxy-authorization: ${auth(p)}\r\n\r\n`)).toMatch(
      / 403 /,
    );
    expect(internalHits()).toBe(0);
  });

  it("refuses a metadata endpoint even when it is named and local owner mode is on", async () => {
    const { p } = await proxy({
      scope: { allowed_hosts: ["169.254.169.254"], local_owner_mode: true },
      localOwnerModeEnabled: true,
    });
    expect((await get(p, SSRF_TARGETS.metadata)).status).toBe(403);
    expect(await raw(p, `CONNECT 169.254.169.254:443 HTTP/1.1\r\nproxy-authorization: ${auth(p)}\r\n\r\n`)).toMatch(
      / 403 /,
    );
  });

  it("refuses CONNECT tunnels outside the scope and WebSocket upgrades to unchecked targets", async () => {
    const { p, decisions } = await proxy();
    expect(await raw(p, `CONNECT evil.example:443 HTTP/1.1\r\nproxy-authorization: ${auth(p)}\r\n\r\n`)).toMatch(
      / 403 /,
    );
    const upgrades = fixture.hits.filter((h) => h.upgrade).length;
    const upgrade = `GET ${fixture.origin}/socket HTTP/1.1\r\nhost: 127.0.0.1:${fixture.port}\r\nconnection: Upgrade\r\nupgrade: websocket\r\nproxy-authorization: ${auth(p)}\r\n\r\n`;
    expect(await raw(p, upgrade)).toMatch(/ 403 /);
    expect(fixture.hits.filter((h) => h.upgrade).length).toBe(upgrades);
    expect(decisions.map((d) => d.kind)).toEqual(["connect", "upgrade"]);
    // In scope (local owner mode for this loopback fixture), the upgrade passes.
    const owner = await proxy({ scope: { local_owner_mode: true }, localOwnerModeEnabled: true });
    const allowed = upgrade.replace(auth(p), auth(owner.p));
    expect(await raw(owner.p, allowed)).toMatch(/ 101 /);
  });

  it("refuses paths outside the scope, other schemes and clients without the job credential", async () => {
    const { p } = await proxy({
      scope: { path_prefixes: ["/app"], local_owner_mode: true },
      localOwnerModeEnabled: true,
    });
    expect((await get(p, `${fixture.origin}/internal/secret`)).status).toBe(403);
    expect((await get(p, `${fixture.origin}/application`)).status).toBe(403);
    expect((await get(p, `${fixture.origin}/app`, false)).status).toBe(407);
    expect((await get(p, `ftp://127.0.0.1:${fixture.port}/`)).status).toBe(403);
    expect(internalHits()).toBe(0);
  });

  it("reports decisions without query strings", async () => {
    const { p, decisions } = await proxy();
    await get(p, `${fixture.origin}/search?token=abc123&q=x`);
    expect(JSON.stringify(decisions)).not.toContain("abc123");
    expect(decisions.at(-1)!.target).toBe(`${fixture.origin}/search`);
  });
});

describe("ST-06 DNS rebinding [@req SEC-007]", () => {
  it("resolves once per connection, connects to the address it checked, and refuses the rebound private answer", async () => {
    const lookup = rebindingLookup("192.0.2.10", "127.0.0.1");
    const before = fixture.hits.length;
    const { p, decisions } = await proxy({
      scope: { allowed_hosts: [`rebind.test:${fixture.port}`] },
      lookup,
    });
    // First answer: a public (documentation) address. It is checked and pinned; it is unreachable, so the request fails.
    const first = await get(p, `http://rebind.test:${fixture.port}/internal/secret`);
    expect(first.status).toBe(502);
    // Second answer: loopback. Refused before any connection.
    const second = await get(p, `http://rebind.test:${fixture.port}/internal/secret`);
    expect(second.status).toBe(403);
    expect(lookup.answers).toEqual(["192.0.2.10", "127.0.0.1"]);
    expect(decisions.map((d) => [d.allowed, d.address])).toEqual([
      [true, "192.0.2.10"],
      [false, "127.0.0.1"],
    ]);
    // The internal service behind the rebound name was never reached.
    expect(fixture.hits.length).toBe(before);
  });
});

describe("rate limits per environment [@req SEC-020]", () => {
  it("honors the configured rate: requests beyond the burst wait for their turn", async () => {
    const { p } = await proxy({
      scope: { local_owner_mode: true },
      localOwnerModeEnabled: true,
      rateLimit: { perSecond: 5, burst: 1 },
    });
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 6 }, () => get(p, `${fixture.origin}/`)));
    const elapsed = Date.now() - started;
    expect(results.every((r) => r.status === 200)).toBe(true);
    // 1 at once, then 5 more at 5 per second: at least about one second.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });
});

describe("egress decisions in the audit chain [@req SEC-025]", () => {
  let home: string;
  let host: Host;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "sys2qa-egress-"));
    host = openHost({ home, logSink: memorySink() });
  });
  afterAll(() => {
    host.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("appends every allow and deny decision to the project's audit chain", async () => {
    const project = host.projects.createProject({ name: "Egress", actor: "qa@example.com" });
    const sink = auditEgressDecisions(
      host.state.db,
      { redactor: host.redactor, now: host.now },
      project.id,
      "job:egress-test",
    );
    const { p } = await proxy({
      scope: { local_owner_mode: true },
      localOwnerModeEnabled: true,
      onDecision: sink,
    });
    await get(p, `${fixture.origin}/?session=secret-value`);
    await get(p, SSRF_TARGETS.off_scope.replace("https", "http"));
    const rows = host.state.db
      .prepare("SELECT details_json FROM audit_events WHERE action = 'egress.decision' AND project_id = ? ORDER BY seq")
      .all(project.id) as Array<{ details_json: string }>;
    const details = rows.map((r) => JSON.parse(r.details_json) as ProxyDecision);
    expect(details.map((d) => d.allowed)).toEqual([true, false]);
    expect(JSON.stringify(details)).not.toContain("secret-value");
  });
});
