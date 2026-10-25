import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppServices, openHost, removeHostEndpoint, startApiServer, writeHostEndpoint } from "@sys2qa/app-services";
import { defaultHome, EXIT_CODES, main, type CliIo } from "../src/index.js";

let home: string;
let out: string;
let err: string;
const io = (): CliIo => ({
  stdout: (t) => (out += t),
  stderr: (t) => (err += t),
  cwd: home,
  env: {},
  host: { logSink: () => {} },
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sys2qa-cli-"));
  out = "";
  err = "";
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("CLI [@req SYS-002] [@req NFR-010]", () => {
  it("prints usage, and rejects unknown commands and options with the usage exit code", async () => {
    expect(await main(["--help"], io())).toBe(EXIT_CODES.ok);
    expect(out).toContain("sys2qa project create <name>");
    expect(await main(["frobnicate"], io())).toBe(EXIT_CODES.usage);
    expect(await main(["info", "--bogus"], io())).toBe(EXIT_CODES.usage);
    expect(await main(["call", "system.info", "--input", "{not json"], io())).toBe(EXIT_CODES.usage);
  });

  it("asks only for what the user has: a name, then paths and URLs", async () => {
    expect(await main(["project", "create", "Acme", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
    const project = (JSON.parse(out) as { data: { id: string } }).data;
    out = "";
    expect(await main(["source", "add", project.id, "source_root", ".", "--home", home, "--json"], io())).toBe(
      EXIT_CODES.ok,
    );
    expect((JSON.parse(out) as { data: { ref: string } }).data.ref).toBe(home);
  });

  it("explains errors with the next action on stderr in human mode", async () => {
    expect(await main(["project", "show", "project:missing", "--home", home], io())).toBe(EXIT_CODES.not_found);
    expect(err).toMatch(/^error NOT_FOUND: .+\n {2}next: .+/);
  });

  it("talks to a running host through its local API instead of opening state.db [@req SYS-005]", async () => {
    const host = openHost({ home, logSink: () => {} });
    const server = await startApiServer(new AppServices(host));
    writeHostEndpoint(home, { pid: process.pid, url: server.url, token: server.token });
    try {
      expect(await main(["project", "create", "Through the API", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
      expect(host.projects.getProject((JSON.parse(out) as { data: { id: string } }).data.id).name).toBe(
        "Through the API",
      );
    } finally {
      removeHostEndpoint(home);
      await server.close();
      host.close();
    }
  });

  it("refuses to open a home that another host holds when that host publishes no API", async () => {
    const host = openHost({ home, logSink: () => {} });
    try {
      expect(await main(["project", "list", "--home", home], io())).toBe(EXIT_CODES.unavailable);
      expect(err).toContain("HOST_ALREADY_RUNNING");
    } finally {
      host.close();
    }
  });

  it("uses the platform's default home locations", () => {
    expect(defaultHome({ SYS2QA_HOME: "/x/home" })).toBe("/x/home");
    expect(defaultHome({}).toLowerCase()).toContain("sys2qa");
  });
});

describe("observability commands [@req QAA-FR-103] [@req OBS-001] [@req OBS-004]", () => {
  it("prints metrics in Prometheus format and the health report", async () => {
    expect(await main(["metrics", "--prometheus", "--home", home], io())).toBe(EXIT_CODES.ok);
    expect(out).toContain("# TYPE sys2qa_jobs_running gauge");
    out = "";
    expect(await main(["health", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
    expect((JSON.parse(out) as { data: { checks: Array<{ name: string }> } }).data.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["state_integrity", "migrations", "audit_chain", "jobs"]),
    );
  });

  it("turns telemetry on only by an explicit setting [@req OBS-005]", async () => {
    expect(await main(["info", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
    expect(
      (JSON.parse(out) as { data: { settings: { telemetry_enabled: boolean } } }).data.settings.telemetry_enabled,
    ).toBe(false);
    out = "";
    expect(await main(["settings", "set", "telemetry_enabled", "on", "--home", home, "--json"], io())).toBe(
      EXIT_CODES.ok,
    );
    expect((JSON.parse(out) as { data: { telemetry_enabled: boolean } }).data.telemetry_enabled).toBe(true);
    expect(await main(["settings", "set", "telemetry_enabled", "maybe", "--home", home], io())).toBe(
      EXIT_CODES.invalid_input,
    );
  });
});

describe("doctor and configuration [@req NFR-007] [@req SEC-018]", () => {
  it("reports every prerequisite with remediation and shows the model provider disclosure", async () => {
    expect(await main(["doctor", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
    const report = (
      JSON.parse(out) as {
        data: {
          status: string;
          checks: Array<{ id: string; status: string; remediation?: string }>;
          llm_disclosure: { mode: string };
        };
      }
    ).data;
    expect(report.checks.map((c) => c.id)).toEqual([
      "node",
      "sqlite",
      "home",
      "disk_space",
      "git",
      "config",
      "llm",
      "browser",
      "container_runtime",
    ]);
    for (const check of report.checks) if (check.status !== "ok") expect(check.remediation, check.id).toBeTruthy();
    expect(report.llm_disclosure.mode).toBe("deterministic_only");
    out = "";
    expect(await main(["config", "show", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
    expect(
      (JSON.parse(out) as { data: { llm_disclosure: { text: { en: string } } } }).data.llm_disclosure.text.en,
    ).toContain("Nothing is sent");
    // doctor runs real probes (git, docker, podman), each bounded at 5 s; slower on Windows runners (CI run #17).
  }, 30_000);

  it("fails doctor with the unavailable exit code when a prerequisite fails", async () => {
    const failing = { ...io(), env: { SYS2QA_LLM_BASE_URL: "https://llm.example.com/v1", SYS2QA_LLM_MODEL: "m" } };
    expect(await main(["doctor", "--home", home], failing)).toBe(EXIT_CODES.unavailable);
    expect(out).toContain("[FAIL] Model provider");
    expect(out).toContain("overall: fail");
  }, 30_000);
});

describe("credentials from the CLI [@req SEC-011]", () => {
  it("reads the value from standard input and never prints it", async () => {
    const env = { SYS2QA_SECRETS_PASSPHRASE: "correct horse battery staple" };
    const withSecrets = (): CliIo => ({
      ...io(),
      env,
      host: { logSink: () => {}, osSecretStoreAvailable: async () => false },
      readStdin: async () => "Applicant!Fixture#2026\n",
    });
    expect(await main(["project", "create", "Acme", "--home", home, "--json"], withSecrets())).toBe(EXIT_CODES.ok);
    const projectId = (JSON.parse(out) as { data: { id: string } }).data.id;
    out = "";
    expect(await main(["secret", "put", projectId, "staging-login", "--home", home, "--json"], withSecrets())).toBe(
      EXIT_CODES.ok,
    );
    expect(out).not.toContain("Applicant!Fixture#2026");
    expect((JSON.parse(out) as { data: { ref: string } }).data.ref).toMatch(/^secretref:/);
    const { readStdin: _stdin, ...noStdin } = withSecrets();
    expect(await main(["secret", "put", projectId, "x", "--home", home], noStdin)).toBe(EXIT_CODES.usage);
    expect(await main(["secret", "put", projectId, "y", "--home", home], { ...withSecrets(), env: {} }), err).toBe(
      EXIT_CODES.unavailable,
    );
    expect(err).toContain("SECRET_STORE_UNAVAILABLE");
  });
});

describe("project deletion from the CLI [@req QAA-FR-001] [@req SEC-015]", () => {
  it("requires the project name as confirmation", async () => {
    expect(await main(["project", "create", "Acme", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
    const id = (JSON.parse(out) as { data: { id: string } }).data.id;
    expect(await main(["project", "delete", id, "--confirm", "acme", "--home", home], io())).toBe(
      EXIT_CODES.invalid_input,
    );
    expect(await main(["project", "delete", id, "--confirm", "Acme", "--home", home], io())).toBe(EXIT_CODES.ok);
    expect(await main(["project", "show", id, "--home", home], io())).toBe(EXIT_CODES.not_found);
    expect(await main(["retention", "run", "--home", home, "--json"], io())).toBe(EXIT_CODES.ok);
  });
});
