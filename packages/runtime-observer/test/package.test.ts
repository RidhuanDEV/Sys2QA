import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportObservedPackage, type ObservedPackageOptions } from "../src/index.js";
import { O, OBS } from "./observations.fixture.js";

const out = mkdtempSync(join(tmpdir(), "sys2qa-qaa-pkg-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const options = (over: Partial<ObservedPackageOptions> = {}): ObservedPackageOptions => ({
  observations: { ...OBS, pages: OBS.pages.map((p) => ({ ...p, lang: "en" })) },
  outputDir: out,
  packageId: "pkg:test-site-observed",
  packageVersion: 1,
  project: { system_id: "system:test-site", name: "Test site" },
  environment: { base_url: `${O}/`, classification: "development", read_only_submissions: false },
  now: () => new Date("2026-11-22T10:02:00.000Z"),
  ...over,
});

describe("QAA package publication [@req QAA-FR-116]", () => {
  it("publishes a package with producer QAA that the contract validator accepts", () => {
    const r = exportObservedPackage(options());
    if (r.status !== "exported") throw new Error(JSON.stringify(r));
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(r.path, "manifest.json"), "utf8")) as {
      producer: unknown;
      evidence_profile: unknown;
      repository: unknown;
      observed_environments: unknown[];
      coverage_summary: Record<string, string>;
    };
    expect(manifest.producer).toMatchObject({ name: "QAA" });
    expect(manifest.evidence_profile).toMatchObject({
      source_analysis: "unavailable",
      runtime_observation: "available",
    });
    expect(manifest.repository).toBeNull();
    expect(manifest.observed_environments[0]).toMatchObject({
      environment_id: OBS.environment_id,
      observed_from: OBS.started_at,
      observed_to: OBS.finished_at,
      target_app_locale: "en",
      permission_level_max: "L2",
      read_only_submissions: false,
    });
    expect(manifest.coverage_summary.data_model).toBe("unobservable");
    const doc = readFileSync(join(r.path, "docs", "en", "05c-observed-behavior.md"), "utf8");
    expect(doc).toContain("10 pages and 6 candidate workflows observed within the declared scope.");
    // Page text never reaches the document.
    expect(doc).not.toMatch(/account was deleted/);
  });

  it("keeps versions immutable and links a new version to the previous one", () => {
    const again = exportObservedPackage(options());
    expect(again).toMatchObject({ status: "refused", reason: "package_version_exists" });
    const skipped = exportObservedPackage(options({ packageId: "pkg:other-observed", packageVersion: 2 }));
    expect(skipped).toMatchObject({ status: "refused", reason: "previous_package_unknown" });
    const v2 = exportObservedPackage(options({ packageVersion: 2 }));
    if (v2.status !== "exported") throw new Error(JSON.stringify(v2));
    expect(v2.manifest.previous_package).toEqual({
      package_version: 1,
      revision: `${OBS.environment_id}@${OBS.started_at}/${OBS.finished_at}`,
    });
  });

  it("publishes nothing when the documents fail validation", () => {
    // An observation outside the walk's window breaks the evidence revision rule (CR-011).
    const broken = options({
      packageId: "pkg:broken-observed",
      observations: { ...OBS, pages: OBS.pages.map((p) => ({ ...p, observed_at: "2026-11-23T00:00:00.000Z" })) },
    });
    const r = exportObservedPackage(broken);
    expect(r.status).toBe("invalid");
    expect(readdirSync(out).filter((n) => n.startsWith("broken") || n.startsWith(".staging"))).toEqual([]);
  });
});
