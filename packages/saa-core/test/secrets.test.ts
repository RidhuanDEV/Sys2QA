import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readForAnalysis, redactOutput, RootSandbox, sensitiveFileKind } from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sys2qa-secrets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

// Token-shaped values are assembled at run time, so this file holds none.
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GITHUB_TOKEN = ["ghp", "_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");

describe("sensitive files [@req SAA-FR-018] [@req SEC-004]", () => {
  it("classifies environment files, keys, keystores, credential files and registry auth by name", () => {
    expect(sensitiveFileKind(".env")).toBe("env_file");
    expect(sensitiveFileKind("config/.env.production")).toBe("env_file");
    expect(sensitiveFileKind("deploy/prod.env")).toBe("env_file");
    expect(sensitiveFileKind(".env.example")).toBeUndefined();
    expect(sensitiveFileKind("app.env.sample")).toBeUndefined();
    expect(sensitiveFileKind("certs/server.pem")).toBe("private_key");
    expect(sensitiveFileKind(".ssh/id_ed25519")).toBe("private_key");
    expect(sensitiveFileKind(".ssh/id_ed25519.pub")).toBeUndefined();
    expect(sensitiveFileKind("android/release.jks")).toBe("keystore");
    expect(sensitiveFileKind("gcp/service-account.json")).toBe("credentials_file");
    expect(sensitiveFileKind("secrets.yaml")).toBe("credentials_file");
    expect(sensitiveFileKind(".npmrc")).toBe("registry_auth");
    expect(sensitiveFileKind(".git-credentials")).toBe("netrc");
    expect(sensitiveFileKind("src/secrets.ts")).toBeUndefined();
  });

  it("withholds sensitive files, returning only environment variable names", async () => {
    write(".env", `# comment\nDB_PASSWORD=hunter2-but-longer\nexport API_TOKEN=${GITHUB_TOKEN}\n\nEMPTY=\n`);
    write("server.pem", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
    const sandbox = await RootSandbox.open([dir]);
    const env = await readForAnalysis(sandbox, { root: 0, path: ".env" }, 1024);
    expect(env).toEqual({
      kind: "withheld",
      sensitive: "env_file",
      env_names: ["DB_PASSWORD", "API_TOKEN", "EMPTY"],
      secrets: [{ root: 0, path: ".env", detector: "sensitive_file:env_file" }],
    });
    expect(await readForAnalysis(sandbox, { root: 0, path: "server.pem" }, 1024)).toMatchObject({
      kind: "withheld",
      sensitive: "private_key",
      env_names: [],
    });
  });
});

describe("redaction at intake and before output [@req SAA-FR-018] [@req CON-017]", () => {
  it("redacts detected secrets in text and reports each by line and detector, never by value", async () => {
    write(
      "src/config.ts",
      [
        "export const config = {",
        `  awsKey: "${AWS_KEY}",`,
        "  password: process.env.DB_PASSWORD,",
        `  token: "${GITHUB_TOKEN}",`,
        "};",
        "",
      ].join("\n"),
    );
    const read = await readForAnalysis(await RootSandbox.open([dir]), { root: 0, path: "src/config.ts" }, 4096);
    expect(read.kind).toBe("text");
    if (read.kind !== "text") return;
    expect(read.text).toContain("[REDACTED:aws_access_key_id]");
    expect(read.text).toContain("[REDACTED:github_token]");
    expect(read.text).toContain("process.env.DB_PASSWORD");
    expect(read.text).not.toContain(AWS_KEY);
    expect(read.text).not.toContain(GITHUB_TOKEN);
    expect(read.secrets).toEqual([
      { root: 0, path: "src/config.ts", line: 2, detector: "aws_access_key_id" },
      { root: 0, path: "src/config.ts", line: 4, detector: "github_token" },
    ]);
    expect(JSON.stringify(read.secrets)).not.toContain(AWS_KEY);
  });

  it("redacts every string of an output value and counts the strings it changed", () => {
    const { value, redacted } = redactOutput({
      id: "entity:config",
      excerpts: [`key = ${AWS_KEY}`, "nothing here"],
      nested: { note: `Authorization: Bearer ${GITHUB_TOKEN}`, count: 3, flag: true, none: null },
    });
    expect(redacted).toBe(2);
    expect(JSON.stringify(value)).not.toContain(AWS_KEY);
    expect(JSON.stringify(value)).not.toContain(GITHUB_TOKEN);
    expect(value).toMatchObject({ id: "entity:config", nested: { count: 3, flag: true, none: null } });
  });
});
