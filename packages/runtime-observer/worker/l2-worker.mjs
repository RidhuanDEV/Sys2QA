// L2 browser worker (ADR-005, SEC-012): one OS process per job, started only by the runtime observation service.
// It reads one job as a JSON line on stdin and writes one result as a JSON line on stdout. The browser runs with a
// fresh temporary profile that is deleted at the end, no storage state from elsewhere, service workers blocked, and
// every request, loopback included, sent through the job's scope-enforcing proxy (ADR-007). The browser layer checks
// scope again (hosts and path prefixes for HTTPS, which the proxy cannot see) and lets only GET and HEAD through while
// validating reachability (QAA-FR-006).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

// Messages from the parent arrive as JSON lines: the job first, then (for `inspect`) the forms it lets the worker submit.
const lines = [];
const waiting = [];
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const next = waiting.shift();
    if (next) next(message);
    else lines.push(message);
  }
});
const nextMessage = () =>
  new Promise((resolve) => {
    const queued = lines.shift();
    if (queued) resolve(queued);
    else waiting.push(resolve);
  });

/** The page's forms as discovery may see them: method, target, fields and labels, button texts; never values. */
/* global document, location, CSS -- the extraction function runs in the page, not in Node. */
const extractForms = (page) =>
  page.evaluate(() =>
    [...document.forms].map((form, index) => {
      const action = new URL(form.getAttribute("action") || location.href, location.href);
      const labelOf = (el) => {
        const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
        const text =
          (byFor ?? el.closest("label"))?.textContent ??
          el.getAttribute("aria-label") ??
          el.getAttribute("placeholder");
        return text ? text.trim().slice(0, 120) : null;
      };
      return {
        index,
        page_url: `${location.protocol}//${location.host}${location.pathname}`,
        method: (form.getAttribute("method") || "GET").toUpperCase(),
        action: `${action.protocol}//${action.host}${action.pathname}`,
        fields: [...form.elements]
          .filter((el) => el.name && el.tagName !== "BUTTON")
          .map((el) => ({
            name: el.name.slice(0, 100),
            type: (el.getAttribute("type") || el.tagName).toLowerCase(),
            label: labelOf(el),
            required: el.required === true,
          })),
        buttons: [...form.querySelectorAll("button, input[type=submit]")]
          .map((b) => (b.textContent || b.value || "").trim().slice(0, 80))
          .filter(Boolean),
      };
    }),
  );

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** Same rules as the proxy: host or host:port named in the scope, and a path under a prefix. */
function inScope(url, scope) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "about:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const defaultPort = u.protocol === "https:" ? "443" : "80";
  const port = u.port || defaultPort;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const named = scope.allowed_hosts.some((h) => {
    const entry = h.toLowerCase();
    return entry === `${host}:${port}` || (port === defaultPort && entry === host);
  });
  const path = u.pathname;
  const pathOk = scope.path_prefixes.some(
    (p) => p === "/" || path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`),
  );
  return named && pathOk;
}

async function main() {
  const job = await nextMessage();
  const profile = mkdtempSync(join(tmpdir(), "sys2qa-l2-"));
  const blocked = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      // A Chromium other than Playwright's own download, when the operator names one (SYS2QA_BROWSER_EXECUTABLE).
      ...(process.env.SYS2QA_BROWSER_EXECUTABLE ? { executablePath: process.env.SYS2QA_BROWSER_EXECUTABLE } : {}),
      proxy: { server: job.proxy.server, username: job.proxy.username, password: job.proxy.password, bypass: "" },
      args: [
        // Chromium sends loopback directly by default; everything goes through the proxy here.
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
      ],
      serviceWorkers: "block",
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    const before = (await context.cookies()).map((c) => c.name);
    await context.route("**/*", (route) => {
      const request = route.request();
      const method = request.method();
      const reason = !inScope(request.url(), job.scope)
        ? "outside the scope"
        : job.action === "validate" && method !== "GET" && method !== "HEAD"
          ? `${method} is not allowed while validating`
          : null;
      if (reason) {
        const u = new URL(request.url());
        blocked.push({ method, target: `${u.protocol}//${u.host}${u.pathname}`, reason });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const downloads = [];
    context.on("page", (p) => p.on("download", (d) => downloads.push(d.url())));
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("download", (d) => {
      const u = new URL(d.url());
      downloads.push(`${u.protocol}//${u.host}${u.pathname}`);
      d.cancel().catch(() => {});
    });
    const response = await page.goto(job.url, { waitUntil: "load", timeout: job.timeoutMs ?? 15000 });
    await page.waitForTimeout(job.settleMs ?? 300);
    let forms = [];
    const submissions = [];
    if (job.action === "inspect") {
      forms = await extractForms(page);
      write({ type: "forms", forms });
      const reply = await nextMessage();
      for (const index of reply.submit ?? []) {
        const form = forms[index];
        // Only GET forms are ever submitted here; the route above refuses any other method in any case.
        if (!form || form.method !== "GET") continue;
        await page.goto(job.url, { waitUntil: "load", timeout: job.timeoutMs ?? 15000 });
        const handle = page.locator("form").nth(index);
        for (const field of form.fields)
          if (["text", "search", "input"].includes(field.type))
            await handle
              .locator(`[name="${field.name.replace(/"/g, '\\"')}"]`)
              .first()
              .fill("sys2qa");
        const [navigation] = await Promise.all([
          page.waitForNavigation({ waitUntil: "load", timeout: job.timeoutMs ?? 15000 }).catch(() => null),
          handle.evaluate((f) => f.requestSubmit()),
        ]);
        const u = new URL(page.url());
        submissions.push({
          index,
          status: navigation?.status() ?? null,
          final_url: `${u.protocol}//${u.host}${u.pathname}`,
        });
      }
    }
    const after = await context.cookies();
    const final = new URL(page.url());
    write({
      type: "result",
      ok: response !== null && response.status() < 400,
      status: response?.status() ?? null,
      final_url: `${final.protocol}//${final.host}${final.pathname}`,
      title: (await page.title()).slice(0, 300),
      cookies_before: before,
      cookies_after: after.map((c) => c.name),
      blocked,
      forms,
      submissions,
      downloads,
    });
  } catch (error) {
    write({ type: "result", ok: false, error: String(error?.message ?? error).slice(0, 500), blocked });
  } finally {
    await context?.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    write({ type: "result", ok: false, error: String(error?.message ?? error).slice(0, 500), blocked: [] });
    process.exit(1);
  },
);
