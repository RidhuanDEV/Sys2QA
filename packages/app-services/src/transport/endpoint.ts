import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HostEndpoint {
  pid: number;
  url: string;
  token: string;
}

const FILE = "host.json";

/** Published by a host that serves the local API, so a CLI started later talks to it instead of opening state.db. */
export function writeHostEndpoint(home: string, endpoint: HostEndpoint): void {
  writeFileSync(join(home, FILE), JSON.stringify(endpoint), { mode: 0o600 });
}

export function removeHostEndpoint(home: string): void {
  rmSync(join(home, FILE), { force: true });
}

/** The endpoint of a host that is still running, or undefined. */
export function readHostEndpoint(home: string): HostEndpoint | undefined {
  try {
    const endpoint = JSON.parse(readFileSync(join(home, FILE), "utf8")) as HostEndpoint;
    process.kill(endpoint.pid, 0);
    return endpoint;
  } catch {
    return undefined;
  }
}
