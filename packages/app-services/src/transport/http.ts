import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ErrorKind } from "../errors.js";
import type { AppServices } from "../services.js";

export const HTTP_STATUS: Record<ErrorKind, number> = {
  invalid_input: 400,
  not_found: 404,
  denied: 403,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

export interface ApiServerOptions {
  /** Origins allowed to call the API from a browser (the served web UI). Requests without Origin are allowed. */
  allowedOrigins?: string[];
  /** Fixed token (tests); a random 256-bit token otherwise. */
  token?: string;
  port?: number;
  /**
   * Serves the built web UI from this directory (its files are read once, at start; nothing else on disk is reachable).
   * The UI's own origin is then allowed; it receives the session token in the URL fragment, which no request carries.
   */
  webUi?: { root: string };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
/** The UI loads only its own files and talks only to this API (no inline script, no third-party origin). */
const UI_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** The UI's files by URL path, read once; `/` is index.html. */
function uiAssets(root: string): Map<string, { type: string; body: Buffer }> {
  const assets = new Map<string, { type: string; body: Buffer }>();
  for (const name of readdirSync(root)) {
    const file = join(root, name);
    const type = CONTENT_TYPES[extname(name)];
    if (type && statSync(file).isFile()) assets.set(`/${name}`, { type, body: readFileSync(file) });
  }
  const index = assets.get("/index.html");
  if (!index) throw new Error(`no index.html in the web UI directory ${root}`);
  assets.set("/", index);
  return assets;
}

export interface ApiServer {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Local HTTP API (Architecture §8; ST-12). Hardened for a loopback service that a browser on the same machine can
 * reach: binds 127.0.0.1 only; every request needs the session token; the Host header must name the loopback address
 * and port (DNS-rebinding defense); a browser Origin must be allowed; JSON bodies only, at most 1 MB (8 MB for a manual-evidence upload).
 */
export async function startApiServer(services: AppServices, options: ApiServerOptions = {}): Promise<ApiServer> {
  const token = options.token ?? randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  let port = 0;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const assets = options.webUi ? uiAssets(options.webUi.root) : new Map<string, { type: string; body: Buffer }>();

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reply.code(403).send(denied("HOST_REJECTED", "the Host header does not name this loopback service"));
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reply.code(403).send(denied("ORIGIN_REJECTED", "requests from this origin are not allowed"));
    }
    // The UI's static files hold no data; everything they read goes through the token-checked API.
    if (request.method === "GET" && assets.has(request.url)) return undefined;
    const auth = Buffer.from(request.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return reply.code(401).send(denied("TOKEN_REQUIRED", "a valid session token is required"));
    }
    if (origin !== undefined) reply.header("access-control-allow-origin", origin).header("vary", "Origin");
    return undefined;
  });

  for (const [path, asset] of assets)
    app.get(path, async (_request, reply) => reply.headers(UI_HEADERS).type(asset.type).send(asset.body));

  app.get("/api/v1/operations", async () => ({ ok: true, data: services.catalog() }));
  // Scrape-friendly views of system.metrics and system.health (same token rules as every other route).
  app.get("/api/v1/metrics", async (_request, reply) => {
    const result = await services.execute(
      "system.metrics",
      { format: "prometheus" },
      { interface: "api", actor: "local-user" },
    );
    if (!result.ok) return reply.code(HTTP_STATUS[result.error.kind]).send(result);
    return reply.type("text/plain; version=0.0.4").send((result.data as { text: string }).text);
  });
  app.get("/api/v1/health", async (_request, reply) => {
    const result = await services.execute("system.health", {}, { interface: "api", actor: "local-user" });
    if (!result.ok) return reply.code(HTTP_STATUS[result.error.kind]).send(result);
    return reply.code((result.data as { status: string }).status === "failing" ? 503 : 200).send(result);
  });
  const execute = async (name: string, request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      return reply.code(415).send(denied("CONTENT_TYPE_REJECTED", "send the input as application/json"));
    }
    const result = await services.execute(name, request.body, { interface: "api", actor: "local-user" });
    return reply.code(result.ok ? 200 : HTTP_STATUS[result.error.kind]).send(result);
  };
  // A manual-evidence upload carries its file (at most 5 MB, base64); every other operation stays within 1 MB.
  app.post("/api/v1/operations/runs.attach", { bodyLimit: 8 * 1024 * 1024 }, (request, reply) =>
    execute("runs.attach", request, reply),
  );
  app.post<{ Params: { name: string } }>("/api/v1/operations/:name", (request, reply) =>
    execute(request.params.name, request, reply),
  );

  await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
  const address = app.server.address();
  port = typeof address === "object" && address ? address.port : 0;
  if (options.webUi) for (const name of ["127.0.0.1", "localhost"]) allowedOrigins.add(`http://${name}:${port}`);
  return { url: `http://127.0.0.1:${port}`, token, port, close: () => app.close() };
}

function denied(code: string, message: string) {
  return {
    ok: false,
    error: {
      code,
      kind: "denied",
      message,
      remediation: "Use the Sys2QA web UI or CLI on this machine; they send the session token.",
      retryable: false,
    },
  };
}
