import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetFor, identifyRevision, RootSandbox, scanInventory } from "../../packages/saa-core/src/index.js";
import { connectionTrap } from "./harness/index.js";

/** Records and refuses every socket connection, `fetch` and DNS lookup made in-process. */
function monitorNetwork(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const connect = net.Socket.prototype.connect;
  const fetch = globalThis.fetch;
  const lookup = dns.lookup;
  const promisesLookup = dns.promises.lookup;
  const refuse = (what: string) => {
    calls.push(what);
    throw new Error(`SEC-017: ${what} during analysis`);
  };
  net.Socket.prototype.connect = function (...args: unknown[]) {
    return refuse(`connect ${JSON.stringify(args[0])}`);
  } as typeof connect;
  globalThis.fetch = ((input: unknown) => refuse(`fetch ${String(input)}`)) as typeof fetch;
  (dns as { lookup: unknown }).lookup = (host: string) => refuse(`lookup ${host}`);
  (dns.promises as { lookup: unknown }).lookup = (host: string) => refuse(`lookup ${host}`);
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      net.Socket.prototype.connect = connect;
      globalThis.fetch = fetch;
      (dns as { lookup: unknown }).lookup = lookup;
      (dns.promises as { lookup: unknown }).lookup = promisesLookup;
      syncBuiltinESMExports();
    },
  };
}

let base: string;
let repo: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-sec017-"));
  repo = join(base, "repo");
  mkdirSync(repo);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("no repository acquisition [@req SEC-017]", () => {
  it("identifies a repository whose remotes point at a listening server without any network activity", async () => {
    const trap = await connectionTrap();
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=F", "-c", "user.email=f@example.com", ...args], { cwd: repo });
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.ts"), "export {};\n");
      git("add", "-A");
      git("commit", "-q", "--no-gpg-sign", "-m", "initial");
      git("remote", "add", "origin", `http://127.0.0.1:${trap.port}/acme/portal.git`);
      git("remote", "add", "mirror", `git://127.0.0.1:${trap.port}/acme/portal.git`);
      // A branch tracking a remote that is ahead: following it would need a fetch.
      git("config", "branch.main.remote", "origin");
      git("config", "branch.main.merge", "refs/heads/main");

      const monitor = monitorNetwork();
      let identity;
      try {
        const sandbox = await RootSandbox.open([repo]);
        const included: Array<{ root: number; path: string }> = [];
        await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
          if (e.status === "included") included.push(e);
        });
        identity = await identifyRevision(sandbox, 0, included);
      } finally {
        monitor.restore();
      }
      expect(identity).toMatchObject({ provider: "git", identity: `http://127.0.0.1:${trap.port}/acme/portal.git` });
      expect(monitor.calls).toEqual([]);
      expect(trap.connections()).toBe(0);
    } finally {
      await trap.close();
    }
  });

  it("the network monitor sees fetch, socket connections and DNS lookups (detector check)", async () => {
    const monitor = monitorNetwork();
    try {
      await expect(Promise.resolve().then(() => fetch("http://127.0.0.1:9/"))).rejects.toThrow(/SEC-017/);
      expect(() => net.connect(9, "127.0.0.1")).toThrow(/SEC-017/);
      const { lookup } = await import("node:dns/promises");
      expect(() => lookup("example.com")).toThrow(/SEC-017/);
    } finally {
      monitor.restore();
    }
    expect(monitor.calls).toHaveLength(3);
  });
});
