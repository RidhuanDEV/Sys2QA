import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { memorySink } from "../../packages/platform/src/index.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * ST-07 fixture site: one page with a login form, a delete form, an invitation form, an unknown-effect GET form and a
 * GET search form, plus a download link and a script that tries to post. It records every request it receives.
 */
const PAGE = `<!doctype html><title>Forms</title>
<form id="login" method="post" action="/login"><label for="e">Email</label><input id="e" name="email" type="email">
  <label for="p">Password</label><input id="p" name="password" type="password"><button>Sign in</button></form>
<form id="delete" method="post" action="/account/delete"><button>Delete account</button></form>
<form id="invite" method="post" action="/team/invite"><input name="email" type="email" aria-label="Colleague"><button>Invite</button></form>
<form id="export" method="get" action="/export"><input name="token" type="text"><button>Search</button></form>
<form id="search" method="get" action="/search"><input name="q" type="search" aria-label="Search"><button>Search</button></form>
<a id="dl" href="/report.csv" download>Download</a>
<script>document.getElementById("dl").click();</script>`;

let server: Server;
let origin: string;
let port: number;
const hits: Array<{ method: string; path: string }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push({ method: req.method ?? "GET", path: url.pathname });
    if (url.pathname === "/report.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=report.csv" });
      return res.end("a,b\n1,2\n");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(url.pathname === "/forms" ? PAGE : "<!doctype html><title>Result</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});
afterAll(() => server.close());

interface Inspected {
  read_only_submissions_declared: boolean;
  forms: Array<{ form_key: string; action: string; proposal: string; submitted: boolean }>;
  submissions: Array<{ form_key: string; final_url: string }>;
  stopped_for_approval: Array<{ form_key: string; unknown: string }>;
  downloads_refused: string[];
}

describe("ST-07 form-interaction policy [@req SEC-024] [@req QAA-FR-025] [@req SEC-019]", () => {
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
  let envId: string;
  const formHits = () =>
    hits.filter((h) => ["/login", "/account/delete", "/team/invite", "/export", "/search"].includes(h.path));
  const inspect = async () =>
    data<Inspected>(await call("forms.inspect", { source_id: envId, url: `${origin}/forms` }));
  const byAction = (r: Inspected, path: string) => r.forms.find((f) => f.action === `${origin}${path}`)!;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "sys2qa-st07-"));
    host = openHost({ home, logSink: memorySink() });
    services = new AppServices(host);
    const project = data<{ id: string }>(await call("project.create", { name: "Forms" }));
    envId = data<{ id: string }>(
      await call("project.add_source", { project_id: project.id, kind: "environment", ref: origin }),
    ).id;
    data(await call("project.declare", { source_id: envId, declared_by: caller.actor, operation_level: "L2" }));
    data(await call("system.set_setting", { key: "local_owner_mode_enabled", value: true }));
    data(
      await call("project.configure_environment", {
        source_id: envId,
        base_url: `${origin}/`,
        classification: "staging",
        allowed_hosts: [`127.0.0.1:${port}`],
        local_owner_mode: true,
      }),
    );
  });
  afterAll(() => {
    host.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("submits no form by default, refuses the download, and lists every form with what remains unknown", async () => {
    const r = await inspect();
    expect(r.read_only_submissions_declared).toBe(false);
    expect(Object.fromEntries(r.forms.map((f) => [new URL(f.action).pathname, f.proposal]))).toEqual({
      "/login": "login",
      "/account/delete": "state_changing",
      "/team/invite": "state_changing",
      "/export": "unknown",
      "/search": "read_only",
    });
    expect(r.submissions).toEqual([]);
    expect(r.stopped_for_approval).toHaveLength(5);
    expect(r.stopped_for_approval.map((s) => s.unknown).join("\n")).toMatch(
      /was not observed: login forms are never submitted/,
    );
    expect(formHits()).toEqual([]);
    expect(r.downloads_refused).toEqual([`${origin}/report.csv`]);
  });

  it("refuses to confirm a login or state-changing form as read-only", async () => {
    const r = await inspect();
    for (const path of ["/login", "/account/delete", "/team/invite"]) {
      const refused = await call("forms.confirm", {
        source_id: envId,
        form_key: byAction(r, path).form_key,
        decision: "read_only",
      });
      expect(refused.ok ? "ok" : refused.error.code, path).toBe("CONFLICT");
    }
  });

  it("with read-only submissions declared, submits only the confirmed GET search form", async () => {
    const before = await inspect();
    // A confirmation alone is not enough without the declaration.
    data(
      await call("forms.confirm", {
        source_id: envId,
        form_key: byAction(before, "/search").form_key,
        decision: "read_only",
      }),
    );
    expect((await inspect()).submissions).toEqual([]);
    expect(formHits()).toEqual([]);
    data(await call("project.declare", { source_id: envId, declared_by: caller.actor, operation_level: "L2r" }));
    const r = await inspect();
    expect(r.read_only_submissions_declared).toBe(true);
    expect(r.submissions.map((s) => s.form_key)).toEqual([byAction(r, "/search").form_key]);
    expect(r.submissions[0]!.final_url).toBe(`${origin}/search`);
    // Login, delete, invitation and the unknown-effect form were never submitted.
    expect(formHits()).toEqual([{ method: "GET", path: "/search" }]);
    const audited = host.state.db
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('forms.inspected', 'form.confirmed')")
      .get() as { n: number };
    expect(audited.n).toBeGreaterThanOrEqual(5);
  });
});
