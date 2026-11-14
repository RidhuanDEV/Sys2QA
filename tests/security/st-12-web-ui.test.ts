import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  options: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(options.method === "POST" ? (options.body ?? "{}") : undefined);
  });
}

/** Sends only the headers of a POST with the given Content-Length and returns the status of the early answer. */
function headersOnly(
  server: ApiServer,
  path: string,
  headers: Record<string, string>,
  length: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: server.port,
      path,
      method: "POST",
      headers: { ...headers, "content-length": String(length) },
    });
    req.on("response", (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    req.on("error", (error) => reject(error));
    req.flushHeaders();
  });
}

describe("ST-12 local API hardening with the web UI served", () => {
  let home: string;
  let ui: string;
  let host: Host;
  let server: ApiServer;
  let hostHeader: Record<string, string>;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "sys2qa-st12-ui-"));
    ui = mkdtempSync(join(tmpdir(), "sys2qa-ui-"));
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>Sys2QA</title>");
    writeFileSync(join(ui, "app.js"), "console.log(1)");
    writeFileSync(join(ui, "notes.txt"), "not a UI file type");
    host = openHost({ home, logSink: memorySink() });
    server = await startApiServer(new AppServices(host), { webUi: { root: ui } });
    hostHeader = { host: `127.0.0.1:${server.port}` };
  });
  afterAll(async () => {
    await server.close();
    host.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(ui, { recursive: true, force: true });
  });

  it("serves the UI's own files without the token, with a strict content security policy", async () => {
    for (const path of ["/", "/index.html", "/app.js"]) {
      const r = await call(server, { path, headers: hostHeader });
      expect(r.status, path).toBe(200);
      expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
      expect(String(r.headers["content-security-policy"])).toContain("script-src 'self'");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("serves nothing else without the token: other files, traversal, query strings and the API all need it", async () => {
    for (const path of [
      "/notes.txt",
      "/../state.db",
      "/%2e%2e/state.db",
      "/app.js?x=1",
      "/api/v1/operations",
      "/state.db",
    ]) {
      const r = await call(server, { path, headers: hostHeader });
      expect(r.status, path).toBe(401);
    }
  });

  it("still rejects a forged Host header for the UI's files (DNS rebinding)", async () => {
    const r = await call(server, { path: "/", headers: { host: `evil.example:${server.port}` } });
    expect(r.status).toBe(403);
  });

  it("accepts API calls from the UI's own origin and rejects every other origin", async () => {
    const api = {
      ...hostHeader,
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    };
    const path = "/api/v1/operations/system.info";
    const own = await call(server, {
      path,
      method: "POST",
      headers: { ...api, origin: `http://127.0.0.1:${server.port}` },
    });
    expect(own.status).toBe(200);
    expect(own.headers["access-control-allow-origin"]).toBe(`http://127.0.0.1:${server.port}`);
    const other = await call(server, { path, method: "POST", headers: { ...api, origin: "http://127.0.0.1:5173" } });
    expect(other.status).toBe(403);
  });

  it("limits bodies to 1 MB, except a manual-evidence upload, which may carry its 5 MB file", async () => {
    const api = { ...hostHeader, authorization: `Bearer ${server.token}`, "content-type": "application/json" };
    const twoMb = 2 * 1024 * 1024;
    // A refusal comes before the body is read: only the headers are sent, so the closed connection races nothing.
    expect(await headersOnly(server, "/api/v1/operations/system.info", api, twoMb)).toBe(413);
    expect(
      await headersOnly(
        server,
        "/api/v1/operations/runs.attach",
        { ...hostHeader, "content-type": "application/json" },
        twoMb,
      ),
    ).toBe(401);
    // The upload route reads the whole body; the service then rejects the incomplete input.
    const big = JSON.stringify({ content_base64: "A".repeat(twoMb) });
    const upload = await call(server, {
      path: "/api/v1/operations/runs.attach",
      method: "POST",
      headers: api,
      body: big,
    });
    expect(upload.status).toBe(400);
    expect(JSON.parse(upload.body)).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
  });

  it("serves no UI file at all when no UI is configured", async () => {
    const plain = await startApiServer(new AppServices(host));
    try {
      const r = await call(plain, { path: "/", headers: { host: `127.0.0.1:${plain.port}` } });
      expect(r.status).toBe(401);
    } finally {
      await plain.close();
    }
  });
});
