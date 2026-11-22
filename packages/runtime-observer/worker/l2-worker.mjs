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
        dom_id: form.id || null,
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
            constraints: Object.fromEntries(
              ["maxlength", "minlength", "pattern", "min", "max", "inputmode", "step"]
                .map((a) => [a, el.getAttribute(a)])
                .filter(([, v]) => v !== null),
            ),
          })),
        hints: [...form.querySelectorAll(".hint, small, [role=note]")]
          .map((h) => (h.textContent || "").trim().slice(0, 200))
          .filter(Boolean),
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

const stripQuery = (url) => {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
};

/** Signals that a login needs more than a username and password (QAA-FR-026): never bypassed. */
const ADDITIONAL_AUTH =
  /captcha|recaptcha|hcaptcha|one[- ]?time|otp|verification code|two[- ]factor|2fa|authenticator/i;

/**
 * Logs in through a credential profile (QAA-FR-023): fills the username and password fields of the login page and
 * lets exactly one POST to that form's target through. The secret values exist only in this process and are never
 * written out. A page asking for anything more (MFA, CAPTCHA) stops discovery with guidance (QAA-FR-026).
 */
async function login(page, job, loginState) {
  const { url, username, password } = job.login;
  await page.goto(url, { waitUntil: "load", timeout: job.timeoutMs ?? 15000 });
  const content = await page.content();
  if (ADDITIONAL_AUTH.test(content))
    return {
      status: "unsupported",
      reason: "the login page asks for more than a username and password (MFA or CAPTCHA)",
    };
  const passwordField = page.locator("input[type=password]").first();
  if ((await passwordField.count()) === 0) return { status: "failed", reason: "no password field on the login page" };
  const form = passwordField.locator("xpath=ancestor::form[1]");
  const userField = form.locator("input[type=email], input[type=text], input:not([type])").first();
  await userField.fill(username);
  await passwordField.fill(password);
  const action = await form.evaluate((f) => new URL(f.getAttribute("action") || location.href, location.href).href);
  loginState.allowPostTo = stripQuery(action);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: job.timeoutMs ?? 15000 }).catch(() => null),
    form.evaluate((f) => f.requestSubmit()),
  ]);
  loginState.allowPostTo = null;
  const after = await page.content();
  if (ADDITIONAL_AUTH.test(after))
    return { status: "unsupported", reason: "after the password the site asks for another factor (MFA or CAPTCHA)" };
  if ((await page.locator("input[type=password]").count()) > 0)
    return { status: "failed", reason: "the site still shows a password field after the login" };
  return { status: "logged_in", reason: "credential profile accepted" };
}

/**
 * Discovery (QAA-FR-021, QAA-FR-022, QAA-FR-024): a breadth-first walk of in-scope links within the page, depth and time
 * budget. A path is one page of the catalog; its query-string variants are capped (crawler traps). Links and
 * redirects outside the scope are recorded and not followed. Each page's forms go to the parent, which alone decides
 * which may be submitted (SEC-024). Page text is data only; nothing on a page changes what the worker does (SEC-003).
 */
async function discover(page, job, loginState) {
  const budget = {
    pages: job.budget?.pages ?? 50,
    depth: job.budget?.depth ?? 6,
    ms: job.budget?.ms ?? 120000,
    variants: job.budget?.variants ?? 3,
  };
  const deadline = Date.now() + budget.ms;
  const pages = new Map();
  const notFollowed = new Map();
  const traps = new Map();
  const formsSeen = [];
  const submissions = [];
  let exhausted = null;
  let loginOutcome = null;
  if (job.login) {
    loginOutcome = await login(page, job, loginState);
    if (loginOutcome.status !== "logged_in")
      return {
        ok: false,
        stopped: "login",
        login: loginOutcome,
        pages: [],
        links_not_followed: [],
        forms_seen: [],
        submissions,
        traps: [],
        budget: { ...budget, exhausted: null },
      };
  }
  const queue = [
    { url: job.url, depth: 0, from: null },
    ...(job.seeds ?? []).filter((u) => inScope(u, job.scope)).map((url) => ({ url, depth: 0, from: "seed" })),
  ];
  const visited = new Set();
  const variants = new Map();
  while (queue.length > 0) {
    if (Date.now() > deadline) {
      exhausted = "time";
      break;
    }
    if (pages.size >= budget.pages) {
      exhausted = "pages";
      break;
    }
    const { url, depth, from } = queue.shift();
    const clean = url.split("#")[0];
    if (visited.has(clean)) continue;
    const path = new URL(clean).pathname;
    const seen = variants.get(path) ?? 0;
    if (seen >= budget.variants) {
      if (!traps.has(path))
        traps.set(path, { path, reason: `more than ${budget.variants} query variants of one path` });
      continue;
    }
    visited.add(clean);
    variants.set(path, seen + 1);
    let response = null;
    let error = null;
    try {
      response = await page.goto(clean, { waitUntil: "load", timeout: job.timeoutMs ?? 15000 });
      await page.waitForTimeout(job.settleMs ?? 150);
    } catch (e) {
      error = String(e?.message ?? e);
    }
    const observedAt = new Date().toISOString();
    if (error) {
      // The browser layer refuses out-of-scope requests it sees; redirects it does not route are refused by the proxy.
      const refused = /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED/.test(error);
      notFollowed.set(stripQuery(clean), {
        target: stripQuery(clean),
        from,
        reason: refused ? "redirect outside the scope, refused" : `not loaded: ${error.split("\n")[0].slice(0, 160)}`,
      });
      continue;
    }
    const final = page.url();
    if (!inScope(final, job.scope)) {
      notFollowed.set(stripQuery(clean), {
        target: stripQuery(final),
        from,
        reason: "redirect outside the scope, refused",
      });
      continue;
    }
    const finalPath = new URL(final).pathname;
    const requiresAuth = finalPath !== path && (await page.locator("input[type=password]").count()) > 0;
    if (!pages.has(path))
      pages.set(path, {
        path,
        url: stripQuery(clean),
        status: response?.status() ?? null,
        title: (await page.title()).slice(0, 300),
        observed_at: observedAt,
        depth,
        source: "runtime_observation",
        confidence: "observed",
        ...(finalPath !== path ? { redirected_to: stripQuery(final) } : {}),
        ...(requiresAuth ? { observability: "auth_required" } : {}),
      });
    if (requiresAuth) continue;
    // Links rendered after scripts ran, so client-side routes show as well.
    const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.href));
    for (const link of links) {
      let target;
      try {
        target = new URL(link);
      } catch {
        continue;
      }
      if (!["http:", "https:"].includes(target.protocol)) continue;
      if (!inScope(target.href, job.scope)) {
        notFollowed.set(stripQuery(target.href), {
          target: stripQuery(target.href),
          from: stripQuery(clean),
          reason: "outside the scope",
        });
        continue;
      }
      if (depth + 1 <= budget.depth) queue.push({ url: target.href, depth: depth + 1, from: stripQuery(clean) });
    }
    if (new URL(final).pathname === path) {
      const forms = await extractForms(page);
      if (forms.length > 0) {
        formsSeen.push(...forms.map((f) => ({ ...f, observed_at: observedAt })));
        write({ type: "forms", forms });
        const reply = await nextMessage();
        for (const index of reply.submit ?? []) {
          const f = forms[index];
          if (!f || f.method !== "GET") continue;
          await page.goto(clean, { waitUntil: "load", timeout: job.timeoutMs ?? 15000 });
          const handle = page.locator("form").nth(index);
          for (const field of f.fields)
            if (["text", "search", "input"].includes(field.type))
              await handle
                .locator(`[name="${field.name.replace(/"/g, '\\"')}"]`)
                .first()
                .fill("sys2qa");
          const [navigation] = await Promise.all([
            page.waitForNavigation({ waitUntil: "load", timeout: job.timeoutMs ?? 15000 }).catch(() => null),
            handle.evaluate((el) => el.requestSubmit()),
          ]);
          submissions.push({
            page: f.page_url,
            index,
            action: f.action,
            status: navigation?.status() ?? null,
            final_url: stripQuery(page.url()),
          });
        }
      }
    }
  }
  return {
    ok: pages.size > 0,
    login: loginOutcome,
    pages: [...pages.values()],
    links_not_followed: [...notFollowed.values()],
    forms_seen: formsSeen,
    submissions,
    traps: [...traps.values()],
    budget: { ...budget, exhausted },
  };
}

async function main() {
  const job = await nextMessage();
  const profile = mkdtempSync(join(tmpdir(), "sys2qa-l2-"));
  const blocked = [];
  // The one POST a credential-profile login may send, armed just before it submits (QAA-FR-023).
  const loginState = { allowPostTo: null };
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
      const u0 = new URL(request.url());
      const target0 = `${u0.protocol}//${u0.host}${u0.pathname}`;
      const loginPost = method === "POST" && loginState.allowPostTo === target0;
      const reason = !inScope(request.url(), job.scope)
        ? "outside the scope"
        : method !== "GET" && method !== "HEAD" && !loginPost
          ? `${method} is not allowed during ${job.action === "validate" ? "validation" : "discovery"}`
          : null;
      if (loginPost) loginState.allowPostTo = null;
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
    if (job.action === "discover") {
      const outcome = await discover(page, job, loginState);
      write({ type: "result", ...outcome, cookies_before: before, blocked, downloads });
      return;
    }
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
