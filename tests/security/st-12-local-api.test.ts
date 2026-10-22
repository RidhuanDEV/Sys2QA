import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppServices,
  openHost,
  startApiServer,
  type ApiServer,
  type Host,
} from "../../packages/app-services/src/index.js";
import { memorySink } from "../../packages/platform/src/index.js";

/** Raw HTTP so that Host and Origin headers can be forged (fetch would refuse to). */
function call(
  server: ApiServer,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: options.path ?? "/api/v1/operations/system.info",
        method: options.method ?? "POST",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end((options.method ?? "POST") === "GET" ? undefined : (options.body ?? "{}"));
  });
}

describe("ST-12 local API hardening", () => {
  let home: string;
  let host: Host;
  let server: ApiServer;
  let ok: Record<string, string>;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "sys2qa-st12-"));
    host = openHost({ home, logSink: memorySink() });
    server = await startApiServer(new AppServices(host), { allowedOrigins: ["http://127.0.0.1:5173"] });
    ok = {
      host: `127.0.0.1:${server.port}`,
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    };
  });
  afterAll(async () => {
    await server.close();
    host.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("listens on loopback only and answers a correct request", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.token.length).toBeGreaterThanOrEqual(40);
    expect((await call(server, { headers: ok })).status).toBe(200);
  });

  it("rejects requests without the session token or with a wrong one", async () => {
    const { authorization: _a, ...noToken } = ok;
    expect((await call(server, { headers: noToken })).status).toBe(401);
    expect((await call(server, { headers: { ...ok, authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call(server, { path: "/api/v1/operations", method: "GET", headers: noToken })).status).toBe(401);
  });

  it("rejects a foreign Origin and allows the served one with a CORS header", async () => {
    expect((await call(server, { headers: { ...ok, origin: "https://evil.example" } })).status).toBe(403);
    const allowed = await call(server, { headers: { ...ok, origin: "http://127.0.0.1:5173" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
  });

  it("rejects a DNS-rebound host name even with a valid token", async () => {
    const rebound = await call(server, { headers: { ...ok, host: `rebind.evil.example:${server.port}` } });
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body)).toMatchObject({ error: { code: "HOST_REJECTED" } });
  });

  it("accepts only JSON bodies", async () => {
    expect(
      (await call(server, { headers: { ...ok, "content-type": "application/x-www-form-urlencoded" }, body: "a=b" }))
        .status,
    ).toBe(415);
  });
});

describe("metrics and health endpoints", () => {
  it("serve Prometheus text and the health report behind the same token rules", async () => {
    const home = mkdtempSync(join(tmpdir(), "sys2qa-metrics-"));
    const host = openHost({ home, logSink: memorySink() });
    const server = await startApiServer(new AppServices(host));
    try {
      const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${server.token}` };
      const metrics = await call(server, { path: "/api/v1/metrics", method: "GET", headers });
      expect(metrics.status).toBe(200);
      expect(metrics.headers["content-type"]).toContain("text/plain");
      expect(metrics.body).toContain("# TYPE sys2qa_jobs_running gauge");
      expect(
        (await call(server, { path: "/api/v1/metrics", method: "GET", headers: { host: headers.host } })).status,
      ).toBe(401);
      const health = await call(server, { path: "/api/v1/health", method: "GET", headers });
      expect([200, 503]).toContain(health.status);
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, data: { checks: expect.any(Array) } });
    } finally {
      await server.close();
      host.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
