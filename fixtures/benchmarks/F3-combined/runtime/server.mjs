// F3 runtime: F1 (../../F1-repository-only/repo) as deployed, with deliberate discrepancies (Test Strategy §4):
//   1. /register accepts a 16-digit NIB in the browser, while the source requires exactly 13 digits;
//   2. /admin/users exists in the source but is disabled in this deployment (404);
//   3. /promo is served here but has no route in the source.
// F1 itself needs PostgreSQL and third-party packages, so its pages are rendered by this simulator instead.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const layout = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><nav><a href="/">Home</a> <a href="/register">Register</a> <a href="/login">Log in</a> <a href="/orders/new">New order</a> <a href="/promo">Promo</a></nav>
<main>${body}</main></body></html>`;

const PAGES = {
  "/": layout("Acme portal", "<h1>Acme portal</h1>"),
  "/register": layout("Register", `<form id="register" method="post" action="/api/auth/register">
<input name="email" type="email" required>
<input name="password" type="password" minlength="12" required>
<input name="nib" inputmode="numeric" pattern="[0-9]{16}" maxlength="16" required>
<button>Create account</button></form>`),
  "/login": layout("Log in", `<form id="login" method="post" action="/api/auth/login">
<input name="email" type="email" required><input name="password" type="password" required>
<a href="/reset-password">Forgot password?</a><button>Log in</button></form>`),
  "/reset-password": layout("Reset password", `<form id="reset-request" method="post" action="/api/auth/password-reset/request">
<input name="email" type="email" required><button>Send reset link</button></form>`),
  "/orders/new": layout("New order", `<form id="new-order" method="post" action="/api/orders">
<input name="amount" type="number" min="1" max="10000" required><button>Submit order</button></form>`),
  "/promo": layout("Promo", "<h1>Autumn promo</h1><p>Spend 100 EUR, get 10% off.</p>"),
};

export async function startF3Runtime(port = 0) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const html = PAGES[path];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(html ?? layout("Not found", "<h1>Not found</h1>"));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address();
  return { origin: `http://127.0.0.1:${actual}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = await startF3Runtime(Number(process.env.PORT ?? 4003));
  console.log(`F3 runtime at ${site.origin}`);
}
