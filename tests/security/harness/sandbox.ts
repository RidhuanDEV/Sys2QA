import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { SECURITY_FIXTURES } from "./paths.js";

export const SENTINEL_PREFIX = "SYS2QA_SENTINEL_";
export const MALICIOUS_ADAPTER = join(SECURITY_FIXTURES, "adapters", "malicious-adapter.mjs");

/** Sentinel files left by code that must never run or write there (ST-02, ST-14). */
export function findSentinels(roots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.startsWith(SENTINEL_PREFIX)) found.push(path);
      else if (statSync(path).isDirectory() && name !== "node_modules") walk(path);
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/** A loopback listener that records every connection: a sandboxed process must never reach it (ST-14). */
export async function connectionTrap(): Promise<{
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const server = createServer((socket) => {
    count++;
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => count,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Runs the malicious adapter in one mode with the given Node.js flags (the sandbox under test supplies the limits). */
export function runMaliciousAdapter(
  args: string[],
  execArgv: string[] = [],
  timeoutMs = 20_000,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...execArgv, MALICIOUS_ADAPTER, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 2000) stderr += c.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}
