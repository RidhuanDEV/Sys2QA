import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkGit,
  checkHome,
  checkNode,
  checkSqlite,
  ConfigError,
  DEFAULT_CONFIG,
  doctorStatus,
  loadConfig,
} from "../src/index.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sys2qa-config-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("configuration layers [@req QAA-FR-100]", () => {
  it("uses the defaults without a file: deterministic-only, nothing sent", () => {
    expect(loadConfig({ home })).toMatchObject({
      config: DEFAULT_CONFIG,
      sources: { llm: "default", log_level: "default" },
    });
  });

  it("layers defaults, the user file, environment variables and overrides, and records each source", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        log_level: "warn",
        jobs: { max_concurrent: 4 },
        llm: {
          provider: "openai_compatible",
          base_url: "http://localhost:11434/v1",
          model: "llama",
          api_key_ref: "secretref:llm",
        },
      }),
    );
    const loaded = loadConfig({
      home,
      env: { SYS2QA_LOG_LEVEL: "debug" },
      overrides: { jobs: { cancel_grace_ms: 2000 } },
    });
    expect(loaded.config).toMatchObject({
      log_level: "debug",
      jobs: { max_concurrent: 4, cancel_grace_ms: 2000, lease_ms: 30_000 },
      llm: { model: "llama", api_key_ref: "secretref:llm" },
    });
    expect(loaded.sources).toEqual({
      llm: "user_file",
      log_level: "env",
      jobs: "override",
      llm_exclusions: "default",
      secrets: "default",
    });
  });

  it("refuses a configuration file that contains a secret instead of a reference [@req SEC-004]", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        llm: {
          provider: "openai_compatible",
          base_url: "https://llm.example.com/v1",
          model: "m",
          api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
        },
      }),
    );
    expect(() => loadConfig({ home })).toThrow(expect.objectContaining({ code: "CONFIG_SECRET_SUSPECTED" }));
  });

  it("reports invalid settings with the place they came from", () => {
    writeFileSync(join(home, "config.json"), "{ not json");
    expect(() => loadConfig({ home })).toThrow(ConfigError);
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { max_concurrent: 0 } }));
    expect(() => loadConfig({ home })).toThrow(/config\.json/);
    rmSync(join(home, "config.json"));
    expect(() => loadConfig({ home, env: { SYS2QA_LLM_BASE_URL: "ftp://x" } })).toThrow(/environment variables/);
  });
});

describe("doctor checks [@req NFR-007] [@req OSS-001]", () => {
  it("checks Node.js, the SQLite driver, the home directory and Git, each with what it is needed for", () => {
    expect(checkNode()).toMatchObject({ id: "node", status: "ok", required_for: ["core"] });
    expect(checkNode("20.11.0")).toMatchObject({ status: "fail", remediation: expect.stringContaining("22.12.0") });
    expect(checkNode("22.12.0").status).toBe("ok");
    expect(checkSqlite()).toMatchObject({ id: "sqlite", status: "ok" });
    expect(checkHome(home).map((c) => c.id)).toEqual(["home", "disk_space"]);
    expect(checkHome(home, Number.MAX_SAFE_INTEGER)[1]).toMatchObject({
      status: "warn",
      remediation: expect.any(String),
    });
    expect(["ok", "warn"]).toContain(checkGit().status);
    expect(doctorStatus([checkNode(), checkNode("18.0.0")])).toBe("fail");
  });
});
