// Hostile analyzer adapter (ST-14). It speaks the adapter protocol (ADR-009) and, when asked to analyze, tries the
// forbidden action named by its first argument. It reports whatever it obtained, so a test can prove nothing leaked.
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const [mode, arg] = process.argv.slice(2);

const attempts = {
  connect: () => net.connect(Number(arg), "127.0.0.1"),
  bypass: () => {
    const port = Number(arg);
    const results = [];
    for (const [name, attempt] of Object.entries({
      socket: () => new net.Socket().connect(port, "127.0.0.1"),
      clientRequest: () => new http.ClientRequest({ host: "127.0.0.1", port }).end(),
      agent: () => new http.Agent().createConnection({ host: "127.0.0.1", port }),
      fetch: () => fetch(`http://127.0.0.1:${port}/`),
      resolver: () => new dns.Resolver().resolve4("example.com", () => undefined),
      udp: () => new dgram.Socket("udp4").send("x", port, "127.0.0.1"),
      listen: () => net.createServer().listen(0),
      binding: () => process.binding("tcp_wrap"),
    })) {
      try {
        attempt();
        results.push(`${name}: not refused`);
      } catch (error) {
        results.push(`${name}: ${error.code ?? error.message}`);
      }
    }
    if (results.some((r) => r.endsWith("not refused"))) return results.join("; ");
    throw Object.assign(new Error(results.join("; ")), { code: "ALL_REFUSED" });
  },
  "write-outside": () => writeFileSync(join(arg, "SYS2QA_SENTINEL_adapter"), "written outside scratch"),
  "write-scratch": () => writeFileSync(join(process.env.TMPDIR, "allowed.txt"), "scratch is writable"),
  "read-outside": () => readFileSync(arg, "utf8"),
  "read-root": () => readFileSync("src/a.ts", "utf8"),
  spawn: () => spawnSync(process.execPath, ["-e", "1"]),
  worker: () => new Worker("1", { eval: true }),
  env: () => JSON.stringify(Object.keys(process.env).sort()),
  memory: () => {
    const hoard = [];
    for (;;) hoard.push(new Array(1_000_000).fill(Math.random()));
  },
  hang: () => new Promise(() => undefined),
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (request.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          adapter_id: "hostile-adapter",
          adapter_version: "0.0.1",
          protocol_version: "1.0.0",
          support_matrix: {
            languages: [],
            scanned_only_languages: [],
            frameworks: [],
            prerequisites: [],
            limitations: [],
          },
        },
      });
    } else if (request.method === "analyze") {
      try {
        const obtained = await attempts[mode]();
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            entities: [],
            relationships: [],
            evidence: [],
            coverage: [{ area: "obtained", status: "analyzed", reason: String(obtained ?? "done").slice(0, 2000) }],
          },
        });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: `${error.code ?? "Error"}: ${error.message}` },
        });
      }
    }
  }
});
