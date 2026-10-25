import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import {
  AdapterProcess,
  analyzeBatch,
  formatSupportMatrix,
  LineDecoder,
  supportLookup,
  type AdapterSpec,
  type AnalyzeParams,
  type LaunchOptions,
} from "../src/index.js";

let base: string;
let entry: string;
let options: LaunchOptions;
const spec = (mode = "normal"): AdapterSpec => ({ id: "test-adapter", entry, args: [mode] });
const SHA = `sha256:${"0".repeat(64)}`;
const params = (
  files = ["src/a.ts", "src/b.ts"],
  budget = { max_ms: 10_000, max_output_bytes: 1_000_000 },
): AnalyzeParams => ({
  run_id: "run:01JTEST",
  root_id: "root:0",
  files: files.map((path) => ({ path, sha256: SHA })),
  budget,
});

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-adapter-host-"));
  entry = await bundleAdapter({
    entry: fileURLToPath(new URL("./fixtures/test-adapter.ts", import.meta.url)),
    outfile: join(base, "bundle", "test-adapter.mjs"),
  });
  mkdirSync(join(base, "root", "src"), { recursive: true });
  mkdirSync(join(base, "scratch"));
  writeFileSync(join(base, "root", "src", "a.ts"), "a\nb\n");
  writeFileSync(join(base, "root", "src", "b.ts"), "c\n");
  options = { root: join(base, "root"), scratch: join(base, "scratch"), limits: { cancel_grace_ms: 500 } };
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("adapter protocol and host [@req SAA-FR-047] [@req OSS-004]", () => {
  it("negotiates the protocol, analyzes a batch with progress, and validates the result", async () => {
    const adapter = await AdapterProcess.start(spec(), options);
    try {
      expect(adapter.info).toMatchObject({ adapter_id: "test-adapter", protocol_version: "1.1.0" });
      const progress: number[] = [];
      const result = await adapter.analyze(params(), { onProgress: (p) => progress.push(p.files_done) });
      expect(result.coverage).toEqual([
        { area: "src/a.ts", status: "analyzed", reason: "3 lines" },
        { area: "src/b.ts", status: "analyzed", reason: "2 lines" },
      ]);
      expect(progress).toEqual([1, 2]);
      // The process is reusable for the next batch.
      expect((await adapter.analyze(params(["src/b.ts"]))).coverage).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });

  it("refuses an adapter with another protocol major version or another identity", async () => {
    await expect(AdapterProcess.start(spec("v2"), options)).rejects.toMatchObject({ code: "ADAPTER_INCOMPATIBLE" });
    await expect(AdapterProcess.start(spec("wrong-id"), options)).rejects.toMatchObject({
      code: "ADAPTER_PROTOCOL_ERROR",
    });
    await expect(
      AdapterProcess.start({ id: "test-adapter", entry: join(base, "missing.mjs") }, options),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ADAPTER_(CRASHED|START_FAILED)/) });
  });

  it.each([
    ["crash", "ADAPTER_CRASHED"],
    ["garbage", "ADAPTER_PROTOCOL_ERROR"],
    ["invalid", "ADAPTER_OUTPUT_INVALID"],
    ["fail", "ADAPTER_FAILED"],
  ])("turns %s into %s and coverage records for every file of the batch", async (mode, code) => {
    const adapter = await AdapterProcess.start(spec(mode), options);
    try {
      const outcome = await analyzeBatch(adapter, params());
      expect(outcome).toMatchObject({
        status: "failed",
        error: { code },
        coverage: [
          { area: "src/a.ts", status: "failed", reason: `adapter test-adapter: ${code}` },
          { area: "src/b.ts", status: "failed", reason: `adapter test-adapter: ${code}` },
        ],
      });
      if (mode === "fail" && outcome.status === "failed") expect(outcome.error.message).not.toContain("hunter2hunter2");
    } finally {
      await adapter.kill();
    }
  });

  it("kills an adapter that exceeds its output budget or ignores cancellation past its time budget", async () => {
    const flood = await AdapterProcess.start(spec("flood"), options);
    await expect(
      flood.analyze(params(["src/a.ts"], { max_ms: 10_000, max_output_bytes: 100_000 })),
    ).rejects.toMatchObject({
      code: "ADAPTER_OUTPUT_TOO_LARGE",
    });
    await flood.kill();

    const hang = await AdapterProcess.start(spec("hang"), options);
    const started = Date.now();
    await expect(hang.analyze(params(["src/a.ts"], { max_ms: 300, max_output_bytes: 100_000 }))).rejects.toMatchObject({
      code: "ADAPTER_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    await hang.kill();
  });

  it("cancels cooperatively through the protocol", async () => {
    const adapter = await AdapterProcess.start(spec("cooperative"), options);
    try {
      const controller = new AbortController();
      const pending = adapter.analyze(params(["src/a.ts"]), { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
      // An adapter that honored the cancel is not killed after the grace period, and can be cancelled again.
      await new Promise((r) => setTimeout(r, 800));
      expect(adapter.failure).toBeUndefined();
      const again = new AbortController();
      const second = adapter.analyze(params(["src/b.ts"]), { signal: again.signal });
      again.abort();
      await expect(second).rejects.toMatchObject({ code: "ADAPTER_CANCELLED" });
      expect(adapter.failure).toBeUndefined();
    } finally {
      await adapter.kill();
    }
  });
});

describe("paths behind links", () => {
  // macOS keeps temp directories behind /var -> /private/var; Node.js resolves the entry through every directory.
  it.skipIf(process.platform === "win32")(
    "starts an adapter whose entry, root and scratch are reached through a link",
    async () => {
      const link = join(base, "link");
      symlinkSync(base, link, "dir");
      const adapter = await AdapterProcess.start(
        { id: "test-adapter", entry: join(link, "bundle", "test-adapter.mjs"), args: ["normal"] },
        { root: join(link, "root"), scratch: join(link, "scratch") },
      );
      try {
        expect((await adapter.analyze(params(["src/a.ts"]))).coverage).toHaveLength(1);
      } finally {
        await adapter.close();
      }
    },
  );
});

describe("support matrix [@req SAA-FR-047]", () => {
  it("derives support levels and prints in-depth and scanned languages separately", async () => {
    const adapter = await AdapterProcess.start(spec(), options);
    await adapter.close();
    const lookup = supportLookup([adapter.info]);
    expect([lookup.language("typescript"), lookup.language("python")]).toEqual(["analyzed", "scanned"]);
    expect([lookup.framework("express"), lookup.framework("django")]).toEqual(["analyzed", "unsupported"]);
    const text = formatSupportMatrix([adapter.info], [{ id: "sql", code: "ADAPTER_CRASHED", message: "exited" }]);
    expect(text).toContain("analyzed in depth: typescript >=4");
    expect(text).toContain("scanned only:      markdown");
    expect(text).toContain("framework express 4.x: workflow tracing partial");
    expect(text).toContain("fixtures:  fixtures/benchmarks/F1-repository-only");
    expect(text).toContain("sql: unavailable (ADAPTER_CRASHED: exited)");
    expect(formatSupportMatrix([])).toBe("No analyzer adapters are installed.\n");
  });
});

describe("message framing", () => {
  it("splits lines across chunks and refuses an oversized line", () => {
    const decoder = new LineDecoder(10);
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push("1}\n{}\n")).toEqual(['{"a":1}', "{}"]);
    expect(() => decoder.push("x".repeat(11))).toThrow(RangeError);
  });
});
