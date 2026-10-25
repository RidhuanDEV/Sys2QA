import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterProcess,
  analyzeBatch,
  type AdapterSpec,
  type AnalyzeParams,
  type LaunchOptions,
} from "../../packages/saa-adapters/src/index.js";
import { connectionTrap, findSentinels, SECURITY_FIXTURES } from "./harness/index.js";

const HOSTILE = join(SECURITY_FIXTURES, "adapters", "hostile-adapter.mjs");
const SECRET_CONTENT = "SYS2QA_OUTSIDE_SECRET_CONTENT";

let base: string;
let options: LaunchOptions;
const params = (budget = { max_ms: 10_000, max_output_bytes: 1_000_000 }): AnalyzeParams => ({
  run_id: "run:01JST14",
  root_id: "root:0",
  files: [{ path: "src/a.ts", sha256: `sha256:${"0".repeat(64)}` }],
  budget,
});
const hostile = (...args: string[]): AdapterSpec => ({ id: "hostile-adapter", entry: HOSTILE, args });

async function attempt(spec: AdapterSpec, budget?: AnalyzeParams["budget"]) {
  const adapter = await AdapterProcess.start(spec, options);
  try {
    return { outcome: await analyzeBatch(adapter, params(budget)), adapter };
  } finally {
    await adapter.kill();
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-st14-"));
  mkdirSync(join(base, "root", "src"), { recursive: true });
  mkdirSync(join(base, "scratch"));
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "root", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(base, "outside", "secret.txt"), SECRET_CONTENT);
  options = {
    root: join(base, "root"),
    scratch: join(base, "scratch"),
    limits: { memory_mb: 64, cancel_grace_ms: 500 },
  };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("ST-14 malicious adapter [@req OSS-005] [@req SEC-001] [@req SEC-002]", () => {
  it("cannot open a connection by any route, and the batch is recorded as failed", async () => {
    const trap = await connectionTrap();
    try {
      const direct = await attempt(hostile("connect", String(trap.port)));
      expect(direct.outcome).toMatchObject({ status: "failed", error: { code: "ADAPTER_FAILED" } });
      expect(direct.outcome.status === "failed" && direct.outcome.error.message).toContain("ERR_ACCESS_DENIED");
      const bypass = await attempt(hostile("bypass", String(trap.port)));
      expect(bypass.outcome.status === "failed" && bypass.outcome.error.message).toMatch(/^ALL_REFUSED/);
      await new Promise((r) => setTimeout(r, 100));
      expect(trap.connections()).toBe(0);
    } finally {
      await trap.close();
    }
  });

  it("cannot write outside its scratch directory, read outside its root, start processes or workers", async () => {
    for (const spec of [
      hostile("write-outside", join(base, "outside")),
      hostile("read-outside", join(base, "outside", "secret.txt")),
      hostile("spawn"),
      hostile("worker"),
    ]) {
      const { outcome } = await attempt(spec);
      expect(outcome, spec.args?.[0]).toMatchObject({
        status: "failed",
        error: { code: "ADAPTER_FAILED", message: expect.stringContaining("ERR_ACCESS_DENIED") },
        coverage: [{ area: "src/a.ts", status: "failed", reason: "adapter hostile-adapter: ADAPTER_FAILED" }],
      });
      expect(JSON.stringify(outcome)).not.toContain(SECRET_CONTENT);
    }
    expect(findSentinels([join(base, "outside"), base])).toEqual([]);
  });

  it("can still do its job: read its root and write its scratch directory (detector check)", async () => {
    expect((await attempt(hostile("read-root"))).outcome).toMatchObject({
      status: "completed",
      result: { coverage: [{ reason: "export const a = 1;\n" }] },
    });
    expect((await attempt(hostile("write-scratch"))).outcome).toMatchObject({ status: "completed" });
  });

  it("receives none of the host's environment", async () => {
    process.env.SYS2QA_ST14_HOST_SECRET = "must-not-reach-adapters";
    try {
      const { outcome } = await attempt(hostile("env"));
      expect(outcome.status).toBe("completed");
      const keys = outcome.status === "completed" ? (JSON.parse(outcome.result.coverage[0]!.reason!) as string[]) : [];
      expect(keys).not.toContain("SYS2QA_ST14_HOST_SECRET");
      const allowed = new Set(["LANG", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"]);
      // libuv copies these system variables into every Windows child process.
      if (process.platform === "win32")
        for (const k of [
          "HOMEDRIVE",
          "HOMEPATH",
          "LOGONSERVER",
          "PATH",
          "SYSTEMDRIVE",
          "USERDOMAIN",
          "USERNAME",
          "USERPROFILE",
          "WINDIR",
        ])
          allowed.add(k);
      // macOS CoreFoundation sets the user's text encoding (a code page number) in every process.
      if (process.platform === "darwin") allowed.add("__CF_USER_TEXT_ENCODING");
      expect(keys.filter((k) => !allowed.has(k.toUpperCase()))).toEqual([]);
    } finally {
      delete process.env.SYS2QA_ST14_HOST_SECRET;
    }
  });

  it("is killed when it exceeds its memory limit or ignores its time budget, leaving coverage records", async () => {
    const memory = await attempt(hostile("memory"));
    expect(memory.outcome).toMatchObject({
      status: "failed",
      error: { code: "ADAPTER_CRASHED" },
      coverage: [{ area: "src/a.ts", status: "failed" }],
    });
    const hang = await attempt(hostile("hang"), { max_ms: 300, max_output_bytes: 1_000 });
    expect(hang.outcome).toMatchObject({ status: "failed", error: { code: "ADAPTER_TIMEOUT" } });
    expect(hang.adapter.failure?.code).toBe("ADAPTER_TIMEOUT");
  }, 60_000);
});
