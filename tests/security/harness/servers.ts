import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface Hit {
  method: string;
  path: string;
  upgrade?: boolean;
}

export interface SsrfFixtureServer {
  readonly origin: string;
  readonly port: number;
  /** Every request received, in order, including the internal routes a redirect may lead to. */
  readonly hits: Hit[];
  close(): Promise<void>;
}

/** Redirect targets that a scope-enforcing client must never follow (ST-05). */
export const SSRF_TARGETS = {
  metadata: "http://169.254.169.254/latest/meta-data/",
  link_local: "http://169.254.10.10/",
  private: "http://10.0.0.1/",
  loopback_ipv6: "http://[::1]/",
  off_scope: "https://evil.example/",
} as const;

/**
 * SSRF fixture server (ST-05). It listens on loopback, so `/redirect/internal` leads to a private target it can observe:
 * a client that follows it leaves a hit on `/internal/secret`. Other routes redirect to unreachable private,
 * link-local, metadata and off-scope addresses, chain redirects, and accept WebSocket upgrades.
 */
export async function startSsrfFixtureServer(): Promise<SsrfFixtureServer> {
  const hits: Hit[] = [];
  let origin = "";
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", origin);
    hits.push({ method: req.method ?? "GET", path: url.pathname });
    const redirect = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    const target = SSRF_TARGETS[url.pathname.replace("/redirect/", "") as keyof typeof SSRF_TARGETS];
    if (url.pathname === "/redirect/internal") return redirect(`${origin}/internal/secret`);
    if (target) return redirect(target);
    const chain = /^\/chain\/(\d+)$/.exec(url.pathname);
    if (chain)
      return redirect(Number(chain[1]) > 0 ? `${origin}/chain/${Number(chain[1]) - 1}` : `${origin}/redirect/internal`);
    if (url.pathname === "/internal/secret") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("internal data that must never be fetched");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<a href="/redirect/internal">next</a>');
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    hits.push({ method: req.method ?? "GET", path: req.url ?? "/", upgrade: true });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export type LookupCallback = (error: NodeJS.ErrnoException | null, address: string, family: number) => void;

/**
 * DNS-rebinding resolver (ST-06): a `lookup`-compatible function whose answers alternate between a public and a private
 * address. The egress proxy must pin the first validated address and refuse the rebound one.
 */
export function rebindingLookup(
  publicAddress = "93.184.216.34",
  privateAddress = "127.0.0.1",
): ((hostname: string, options: unknown, callback: LookupCallback) => void) & { answers: string[] } {
  const answers: string[] = [];
  const lookup = ((_hostname: string, _options: unknown, callback: LookupCallback) => {
    const address = answers.length % 2 === 0 ? publicAddress : privateAddress;
    answers.push(address);
    callback(null, address, 4);
  }) as ((hostname: string, options: unknown, callback: LookupCallback) => void) & { answers: string[] };
  lookup.answers = answers;
  return lookup;
}
