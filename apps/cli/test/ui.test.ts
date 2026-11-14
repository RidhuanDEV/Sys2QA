import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES, main, type CliIo } from "../src/index.js";

let home: string;
let web: string;
let out: string;
let err: string;
const io = (extra: Partial<CliIo> = {}): CliIo => ({
  stdout: (t) => (out += t),
  stderr: (t) => (err += t),
  cwd: home,
  env: {},
  host: { logSink: () => {} },
  ...extra,
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sys2qa-ui-home-"));
  web = mkdtempSync(join(tmpdir(), "sys2qa-ui-web-"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Sys2QA</title>");
  out = "";
  err = "";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(web, { recursive: true, force: true });
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
};

describe("sys2qa ui launcher [@req SYS-005]", () => {
  it("serves the UI and the API on loopback, prints the session link, and other CLI calls use that host", async () => {
    const stop = new AbortController();
    const running = main(["ui", "--home", home], io({ signal: stop.signal, webRoot: web }));
    await until(() => out.includes("#token="));
    const link = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([A-Za-z0-9_-]+)/.exec(out)!;
    expect(link).not.toBeNull();
    const [, url, token] = link;
    expect(existsSync(join(home, "host.json"))).toBe(true);
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Sys2QA</title>");
    const api = await fetch(`${url}/api/v1/operations/system.info`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(api.status).toBe(200);
    // A second CLI process talks to the running host (it holds state.db).
    const before = out;
    expect(await main(["project", "create", "Acme", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
    expect(out.slice(before.length)).toContain('"ok": true');
    // A second launcher on the same home is refused.
    expect(await main(["ui", "--home", home], io({ webRoot: web }))).toBe(EXIT_CODES.conflict);
    stop.abort();
    expect(await running).toBe(EXIT_CODES.ok);
    expect(existsSync(join(home, "host.json"))).toBe(false);
  });

  it("explains how to build the UI when it is missing", async () => {
    expect(await main(["ui", "--home", home], io({ webRoot: join(web, "missing") }))).toBe(EXIT_CODES.unavailable);
    expect(err).toMatch(/WEB_UI_NOT_BUILT[\s\S]*pnpm build:web/);
  });
});
