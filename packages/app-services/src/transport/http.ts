import { randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
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
 * and port (DNS-rebinding defense); a browser Origin must be allowed; JSON bodies only, at most 1 MB.
 */
export async function startApiServer(services: AppServices, options: ApiServerOptions = {}): Promise<ApiServer> {
  const token = options.token ?? randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  let port = 0;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reply.code(403).send(denied("HOST_REJECTED", "the Host header does not name this loopback service"));
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reply.code(403).send(denied("ORIGIN_REJECTED", "requests from this origin are not allowed"));
    }
    const auth = Buffer.from(request.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return reply.code(401).send(denied("TOKEN_REQUIRED", "a valid session token is required"));
    }
    if (origin !== undefined) reply.header("access-control-allow-origin", origin).header("vary", "Origin");
    return undefined;
  });

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
  app.post<{ Params: { name: string } }>("/api/v1/operations/:name", async (request, reply) => {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      return reply.code(415).send(denied("CONTENT_TYPE_REJECTED", "send the input as application/json"));
    }
    const result = await services.execute(request.params.name, request.body, { interface: "api", actor: "local-user" });
    return reply.code(result.ok ? 200 : HTTP_STATUS[result.error.kind]).send(result);
  });

  await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
  const address = app.server.address();
  port = typeof address === "object" && address ? address.port : 0;
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
