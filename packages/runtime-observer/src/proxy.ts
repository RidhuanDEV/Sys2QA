import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";
import { appendAudit, classifyHost, type AuditContext, type HostClass } from "@sys2qa/platform";

/**
 * The scope-enforcing local proxy (ADR-007, SEC-007, SEC-008, SEC-020, SEC-025): the only way a browser worker reaches
 * a target. It accepts plain HTTP requests in absolute form and HTTPS `CONNECT` tunnels on loopback, behind a per-job
 * credential. For every connection it checks scheme, host and port against the scope, resolves the host once, checks
 * the resolved address (loopback, private, link-local, metadata and unspecified ranges are refused unless local owner
 * mode names the target), and connects to that same address: a second resolution never happens, so DNS rebinding
 * cannot move an allowed name to an internal address. Redirects are new requests and pass the same checks. TLS is not
 * intercepted. Every decision is reported, with the query string removed.
 */

export interface ProxyScope {
  /** `host` or `host:port`; no wildcards (Scope policy, Data Model §4). */
  allowed_hosts: string[];
  /** Path prefixes matched on segment boundaries; checked for plain HTTP here, for HTTPS by the browser layer. */
  path_prefixes: string[];
  /** The scope allows the named private or loopback targets in `allowed_hosts` (SEC-008). */
  local_owner_mode: boolean;
}

export interface ProxyDecision {
  at: string;
  allowed: boolean;
  kind: "http" | "connect" | "upgrade";
  /** Scheme, host, port and path; never the query string or fragment. */
  target: string;
  address?: string | undefined;
  address_class?: HostClass | undefined;
  reason: string;
}

export type LookupFunction = (
  hostname: string,
  options: { family?: number; all?: false },
  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

export interface ScopeProxyOptions {
  scope: ProxyScope;
  /** The administrator switch for local owner mode (SEC-008); without it the scope's flag has no effect. */
  localOwnerModeEnabled: boolean;
  /** Requests per second for this environment and the burst it may use at once (SEC-020). */
  rateLimit: { perSecond: number; burst: number };
  onDecision: (decision: ProxyDecision) => void;
  /** Resolver; tests inject one (ST-06). */
  lookup?: LookupFunction;
  /** Upstream connection timeout. */
  connectTimeoutMs?: number;
  now?: () => Date;
}

export interface ScopeProxy {
  /** `http://127.0.0.1:<port>`, to configure as the browser's proxy. */
  readonly url: string;
  readonly port: number;
  /** The per-job credential the browser sends as proxy basic authentication. */
  readonly username: string;
  readonly password: string;
  close(): Promise<void>;
}

const BLOCKED: ReadonlySet<HostClass> = new Set(["loopback", "private", "link_local", "metadata", "unspecified"]);

/** Splits `host[:port]` (with bracketed IPv6) into a lowercase host and a port. */
function hostPort(authority: string, defaultPort: number): { host: string; port: number } | undefined {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!m) return undefined;
  const port = m[2] === undefined ? defaultPort : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return {
    host: m[1]!
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, ""),
    port,
  };
}

const pathAllowed = (path: string, prefixes: string[]) =>
  prefixes.some((p) => p === "/" || path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));

/** A token bucket: callers wait until a token is free, so the configured rate is honored, never exceeded. */
class Bucket {
  #tokens: number;
  #last = Date.now();
  #queue: Array<() => void> = [];
  #timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {
    this.#tokens = burst;
  }
  take(): Promise<void> {
    return new Promise((resolve) => {
      this.#queue.push(resolve);
      this.#drain();
    });
  }
  #drain() {
    const now = Date.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((now - this.#last) / 1000) * this.perSecond);
    this.#last = now;
    while (this.#queue.length > 0 && this.#tokens >= 1) {
      this.#tokens -= 1;
      this.#queue.shift()!();
    }
    if (this.#queue.length > 0 && !this.#timer)
      this.#timer = setTimeout(
        () => {
          this.#timer = undefined;
          this.#drain();
        },
        Math.ceil(((1 - this.#tokens) / this.perSecond) * 1000),
      );
  }
  stop() {
    if (this.#timer) clearTimeout(this.#timer);
  }
}

export async function startScopeProxy(options: ScopeProxyOptions): Promise<ScopeProxy> {
  if (!(options.rateLimit.perSecond > 0) || !(options.rateLimit.burst >= 1))
    throw new Error("the proxy needs a positive rate limit");
  const now = options.now ?? (() => new Date());
  const lookup: LookupFunction = options.lookup ?? (dnsLookup as unknown as LookupFunction);
  const username = "job";
  const password = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const bucket = new Bucket(options.rateLimit.perSecond, options.rateLimit.burst);
  const allowed = new Set(options.scope.allowed_hosts.map((h) => h.toLowerCase()));
  const localOwner = options.scope.local_owner_mode && options.localOwnerModeEnabled;
  const sockets = new Set<Socket>();

  const decide = (d: Omit<ProxyDecision, "at">): ProxyDecision => {
    const decision = { at: now().toISOString(), ...d };
    options.onDecision(decision);
    return decision;
  };

  /** Scope and address checks for one target; resolves to the address to connect to, or a refusal. */
  const check = (
    scheme: "http" | "https",
    host: string,
    port: number,
  ): Promise<
    | { ok: true; address: string; addressClass: HostClass }
    | { ok: false; reason: string; address?: string; addressClass?: HostClass }
  > => {
    const defaultPort = scheme === "https" ? 443 : 80;
    const named = allowed.has(port === defaultPort ? host : `${host}:${port}`) || allowed.has(`${host}:${port}`);
    if (!named) return Promise.resolve({ ok: false, reason: "host or port outside the scope" });
    const literalClass = classifyHost(host);
    if (literalClass === "metadata") return Promise.resolve({ ok: false, reason: "metadata endpoint" });
    return new Promise((resolve) => {
      const decideAddress = (address: string) => {
        const addressClass = classifyHost(address);
        // Metadata endpoints are never reachable, not even in local owner mode.
        if (addressClass === "metadata")
          return resolve({ ok: false, reason: "metadata address", address, addressClass });
        if (BLOCKED.has(addressClass) && !localOwner)
          return resolve({ ok: false, reason: `${addressClass} address`, address, addressClass });
        resolve({ ok: true, address, addressClass });
      };
      if (isIP(host)) return decideAddress(host);
      lookup(host, {}, (error, address) => {
        if (error || !address) return resolve({ ok: false, reason: "name does not resolve" });
        decideAddress(address);
      });
    });
  };

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const refuse = (res: ServerResponse, status: number, reason: string) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "content-type": "text/plain", connection: "close" });
    res.end(`Sys2QA scope proxy: ${reason}\n`);
  };

  const server: Server = createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="sys2qa"', connection: "close" });
      return res.end();
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return refuse(res, 400, "requests must use the absolute form");
    }
    const target = `${url.protocol}//${url.host}${url.pathname}`;
    if (url.protocol !== "http:") {
      decide({ allowed: false, kind: "http", target, reason: "only http in absolute form; https uses CONNECT" });
      return refuse(res, 403, "scheme outside the scope");
    }
    const hp = hostPort(url.host, 80);
    if (!hp) return refuse(res, 400, "invalid host");
    if (!pathAllowed(url.pathname, options.scope.path_prefixes)) {
      decide({ allowed: false, kind: "http", target, reason: "path outside the scope" });
      return refuse(res, 403, "path outside the scope");
    }
    void bucket.take().then(async () => {
      const verdict = await check("http", hp.host, hp.port);
      if (!verdict.ok) {
        decide({
          allowed: false,
          kind: "http",
          target,
          address: verdict.address,
          address_class: verdict.addressClass,
          reason: verdict.reason,
        });
        return refuse(res, 403, verdict.reason);
      }
      decide({
        allowed: true,
        kind: "http",
        target,
        address: verdict.address,
        address_class: verdict.addressClass,
        reason: "in scope",
      });
      const headers = { ...req.headers };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      headers.host = url.host;
      const upstream = httpRequest({
        host: verdict.address,
        port: hp.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        timeout: options.connectTimeoutMs ?? 15_000,
      });
      upstream.on("response", (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
      upstream.on("error", () => refuse(res, 502, "upstream unreachable"));
      req.pipe(upstream);
    });
  });

  // HTTPS: a tunnel to the checked address; the browser's TLS goes end to end.
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const deny = (status: number, text: string) => {
      client.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    };
    if (!authorized(req))
      return client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="sys2qa"\r\n\r\n',
      );
    const hp = hostPort(req.url ?? "", 443);
    const target = `https://${req.url ?? ""}/`;
    if (!hp) return deny(400, "Bad Request");
    void bucket.take().then(async () => {
      const verdict = await check("https", hp.host, hp.port);
      if (!verdict.ok) {
        decide({
          allowed: false,
          kind: "connect",
          target,
          address: verdict.address,
          address_class: verdict.addressClass,
          reason: verdict.reason,
        });
        return deny(403, "Forbidden");
      }
      decide({
        allowed: true,
        kind: "connect",
        target,
        address: verdict.address,
        address_class: verdict.addressClass,
        reason: "in scope",
      });
      const upstream = connect(
        { host: verdict.address, port: hp.port, timeout: options.connectTimeoutMs ?? 15_000 },
        () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        },
      );
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => deny(502, "Bad Gateway"));
    });
  });

  // Plain-HTTP WebSocket upgrades pass the same checks as any other connection.
  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const deny = (reason: string, target: string, extra: Partial<ProxyDecision> = {}) => {
      decide({ allowed: false, kind: "upgrade", target, reason, ...extra });
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    if (!authorized(req)) return client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
    const target = `${url.protocol}//${url.host}${url.pathname}`;
    const hp = hostPort(url.host, 80);
    if (url.protocol !== "http:" || !hp) return deny("scheme outside the scope", target);
    if (!pathAllowed(url.pathname, options.scope.path_prefixes)) return deny("path outside the scope", target);
    void bucket.take().then(async () => {
      const verdict = await check("http", hp.host, hp.port);
      if (!verdict.ok)
        return deny(verdict.reason, target, { address: verdict.address, address_class: verdict.addressClass });
      decide({
        allowed: true,
        kind: "upgrade",
        target,
        address: verdict.address,
        address_class: verdict.addressClass,
        reason: "in scope",
      });
      const upstream = connect({ host: verdict.address, port: hp.port }, () => {
        const headers = Object.entries(req.headers)
          .filter(([k]) => k !== "proxy-authorization" && k !== "proxy-connection")
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
        upstream.write(`${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    username,
    password,
    close: () =>
      new Promise((resolve) => {
        bucket.stop();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Records each proxy decision in the project's audit chain (ADR-007: every allow or deny decision is audited), one
 * transaction per decision. The target carries no query string or fragment.
 */
export function auditEgressDecisions(
  db: Parameters<typeof appendAudit>[0],
  context: AuditContext,
  projectId: string,
  jobId: string,
): (decision: ProxyDecision) => void {
  return (decision) =>
    db.transaction(() =>
      appendAudit(
        db,
        { projectId, actor: "scope-proxy", action: "egress.decision", target: jobId, details: { ...decision } },
        context,
      ),
    )();
}
