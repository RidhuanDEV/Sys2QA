import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "@sys2qa/contract";
import { configKind, extractFiles } from "../src/adapters/config/extract.js";

const REPO = fileURLToPath(new URL("../../../fixtures/saa/config/repo/", import.meta.url));
const RESULT = { $ref: "https://sys2qa.dev/schemas/adapter-protocol/1.0.json#/$defs/analyze_result" };

function files(dir = REPO, prefix = ""): Array<{ path: string; sha256: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    return statSync(full).isDirectory()
      ? files(full, path)
      : [{ path, sha256: `sha256:${"c".repeat(64)}`, text: readFileSync(full, "utf8") }];
  });
}

describe("config adapter [@req SAA-FR-020] [@req SEC-002]", () => {
  it("recognizes configuration formats by path", () => {
    expect(configKind("package.json")).toBe("package_scripts");
    expect(configKind("deploy/.env.production.example")).toBe("env_template");
    expect(configKind("docker/api.Dockerfile")).toBe("dockerfile");
    expect(configKind("compose.prod.yaml")).toBe("compose");
    expect(configKind(".github/workflows/release.yml")).toBe("ci_workflow");
    expect(configKind(".gitlab-ci.yml")).toBe("ci_workflow");
    expect(configKind("tsconfig.json")).toBeUndefined();
  });

  it("extracts names, units and commands without any value, and flags install scripts", () => {
    const result = extractFiles(files(), { boundaryPath: "", capturedAt: "2026-10-25T00:00:00Z" });
    expect(validateJsonSchema(RESULT, result)).toEqual({ ok: true, errors: [] });
    const facts = (path: string) =>
      (result.entities.find((e) => e.id === `file:${path}`) as unknown as { config: Record<string, unknown> }).config;
    expect(facts(".env.example")).toMatchObject({
      variables: [
        { name: "DATABASE_URL", documented_value: true },
        { name: "SMTP_PASSWORD", documented_value: false },
        { name: "FEATURE_REPORTS", documented_value: true },
      ],
    });
    expect(facts("Dockerfile")).toMatchObject({
      base_images: ["node:22-alpine"],
      exposed_ports: ["8080"],
      variables: [
        { name: "NPM_TOKEN", kind: "ARG" },
        { name: "NODE_ENV", kind: "ENV" },
        { name: "PORT", kind: "ENV" },
      ],
    });
    expect(facts("docker-compose.yml")).toMatchObject({
      services: [
        {
          name: "api",
          builds: true,
          variables: ["DATABASE_URL", "DB_PASSWORD"],
          env_files: [".env"],
          depends_on: ["db"],
        },
        { name: "db", image: "postgres:17", variables: ["POSTGRES_PASSWORD"] },
      ],
    });
    expect(facts(".github/workflows/ci.yml")).toMatchObject({
      triggers: ["push", "pull_request"],
      variables: ["CI_LEVEL"],
      jobs: [{ name: "test", uses: ["actions/checkout@v4"], secrets: ["DEPLOY_TOKEN"] }],
    });
    expect(facts("package.json")).toMatchObject({
      scripts: [
        { name: "start", runs_on_install: false },
        { name: "postinstall", runs_on_install: true },
      ],
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("s3cr3t-db-pa55word-fixture");
    expect(output).not.toContain("postgres://localhost/acme");
    expect(result.coverage.find((c) => c.area === "src/server.js")).toMatchObject({ status: "analyzed" });
  });

  it("reports an unreadable YAML file as failed instead of guessing", () => {
    const result = extractFiles(
      [{ path: "docker-compose.yml", sha256: `sha256:${"c".repeat(64)}`, text: "services: [\n" }],
      {
        boundaryPath: "",
        capturedAt: "2026-10-25T00:00:00Z",
      },
    );
    expect(result.coverage).toEqual([
      { area: "docker-compose.yml", status: "failed", reason: expect.stringMatching(/^could not be read/) },
    ]);
  });
});
