import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  budgetFor,
  detectStack,
  matchesWorkspace,
  RootSandbox,
  scanInventory,
  yamlList,
  type InventoryEntry,
  type SupportLookup,
} from "../src/index.js";

const fixture = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const MONOREPO = fixture("saa/monorepo/");
const F1 = fixture("benchmarks/F1-repository-only/repo/");

async function stackOf(root: string, support?: SupportLookup) {
  const sandbox = await RootSandbox.open([root]);
  const included: InventoryEntry[] = [];
  await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
    if (e.status === "included") included.push(e);
  });
  return detectStack(sandbox, included, support);
}

/** What a js-ts + sql adapter set would declare (IMP-105 supplies the real matrix). */
const FIRST_RELEASE: SupportLookup = {
  language: (l) => (["typescript", "javascript", "sql", "prisma"].includes(l) ? "analyzed" : "scanned"),
  framework: (f) => (["express", "react-router", "nextjs", "prisma"].includes(f) ? "analyzed" : "unsupported"),
};

describe("project boundaries [@req SAA-FR-002]", () => {
  it("keeps every monorepo project as its own boundary, with declared members verified and the rest inferred", async () => {
    const expected = JSON.parse(readFileSync(join(MONOREPO, "expected.json"), "utf8")) as {
      boundaries: Array<Record<string, unknown>>;
      unknown: Record<string, number>;
    };
    const report = await stackOf(join(MONOREPO, "repo"));
    expect(
      report.boundaries.map((b) => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        status: b.status,
        ecosystems: b.ecosystems,
        frameworks: b.frameworks.map((f) => f.name),
      })),
    ).toEqual(expected.boundaries);
    expect(report.unknown).toEqual(expected.unknown);
    for (const b of report.boundaries) if (b.status === "inferred") expect(b.confidence_rationale, b.id).toMatch(/\S/);
    const byId = new Map(report.boundaries.map((b) => [b.id, b]));
    // Files belong to the innermost boundary; the root keeps only the loose files.
    expect(byId.get("project:apps/api")).toMatchObject({ files: 3, languages: { json: 1, typescript: 1, prisma: 1 } });
    expect(byId.get("project:services/worker")).toMatchObject({ files: 2, languages: { python: 1, toml: 1 } });
    expect(byId.get("project:.")).toMatchObject({ languages: { markdown: 1, json: 1, yaml: 1 } });
    expect(byId.get("project:apps/web")?.frameworks).toEqual([
      { name: "react", version: "^18.3.1", manifest: "apps/web/package.json", support: "unsupported" },
      { name: "react-router", version: "^6.28.0", manifest: "apps/web/package.json", support: "unsupported" },
    ]);
  });

  it("finds the single F1 application and its frameworks", async () => {
    const report = await stackOf(F1, FIRST_RELEASE);
    expect(report.boundaries).toHaveLength(1);
    expect(report.boundaries[0]).toMatchObject({
      id: "project:.",
      name: "acme-portal",
      kind: "member",
      status: "source_verified",
      ecosystems: ["npm"],
    });
    expect(report.boundaries[0]!.frameworks.map((f) => [f.name, f.support])).toEqual([
      ["express", "analyzed"],
      ["node-cron", "unsupported"],
      ["prisma", "analyzed"],
      ["react", "unsupported"],
      ["react-router", "analyzed"],
    ]);
  });

  it("groups files of a root without any manifest into an inferred implicit boundary named after the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sys2qa-stack-"));
    try {
      mkdirSync(join(dir, "lib"));
      writeFileSync(join(dir, "lib", "a.go"), "package lib\n");
      writeFileSync(join(dir, "notes.xyz"), "?");
      const report = await stackOf(dir);
      expect(report.boundaries).toEqual([
        expect.objectContaining({
          id: "project:.",
          kind: "implicit",
          status: "inferred",
          files: 2,
          languages: { go: 1 },
        }),
      ]);
      expect(report.boundaries[0]!.name).toMatch(/^sys2qa-stack-/);
      expect(report.unknown).toEqual({ ".xyz": 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unparsable manifest as a failed capability with its consequence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sys2qa-stack-"));
    try {
      writeFileSync(join(dir, "package.json"), "{ not json");
      const report = await stackOf(dir);
      expect(report.limitations).toContainEqual(
        expect.objectContaining({ area: "manifest:package.json", status: "failed", consequence: expect.any(String) }),
      );
      expect(report.boundaries).toEqual([expect.objectContaining({ id: "project:.", ecosystems: ["npm"] })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("language and framework inventory [@req SAA-FR-003] [@req SAA-FR-020]", () => {
  it("lists languages with their support level and records what is only scanned or unsupported", async () => {
    const report = await stackOf(join(MONOREPO, "repo"), FIRST_RELEASE);
    expect(report.languages.find((l) => l.language === "typescript")).toMatchObject({ support: "analyzed" });
    expect(report.languages.find((l) => l.language === "python")).toMatchObject({ files: 1, support: "scanned" });
    expect(report.limitations).toContainEqual({
      area: "language:python",
      boundary: "project:services/worker",
      status: "partial",
      reason: "no adapter analyzes python in depth",
      consequence:
        "1 python file(s) in project:services/worker are inventoried only; their entry points, calls and data access are not traced",
    });
    expect(report.limitations).toContainEqual(
      expect.objectContaining({
        area: "framework:fastapi",
        boundary: "project:services/worker",
        status: "unsupported",
      }),
    );
    expect(report.limitations.some((l) => l.area === "framework:express")).toBe(false);
  });
});

describe("workspace manifests", () => {
  it("parses pnpm-workspace.yaml lists and matches workspace globs with negation", () => {
    expect(
      yamlList("packages:\n  - \"apps/*\"\n  - 'libs/**' # all\n  - tools\ncatalog:\n  - x\n", "packages"),
    ).toEqual(["apps/*", "libs/**", "tools"]);
    const patterns = ["apps/*", "packages/**", "!packages/legacy-*"];
    expect(matchesWorkspace("apps/web", patterns)).toBe(true);
    expect(matchesWorkspace("apps/web/nested", patterns)).toBe(false);
    expect(matchesWorkspace("packages/a/b", patterns)).toBe(true);
    expect(matchesWorkspace("packages/legacy-x", patterns)).toBe(false);
    expect(matchesWorkspace("services/x", patterns)).toBe(false);
    expect(matchesWorkspace("tools", ["./tools/"])).toBe(true);
  });
});
