import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PackageQuery } from "@sys2qa/system-model";
import { PackageImportError, prepareImport, storeImport, unsafePathReason } from "../src/index.js";

const CONTRACT = fileURLToPath(new URL("../../../fixtures/contract/", import.meta.url));
const VALID = join(CONTRACT, "packages", "valid");
const INVALID = join(CONTRACT, "invalid");
const work = mkdtempSync(join(tmpdir(), "sys2qa-import-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PackageImportError) return error.code;
    throw error;
  }
  return "accepted";
};

describe("package import validation [@req QAA-FR-009] [@req SEC-021]", () => {
  const cases = readdirSync(INVALID).flatMap((code) =>
    readdirSync(join(INVALID, code))
      .map((name) => ({
        id: `${code}/${name}`,
        dir: join(INVALID, code, name),
        expected: JSON.parse(readFileSync(join(INVALID, code, name, "expected.json"), "utf8")) as {
          kind: string;
          code: string;
          ok: boolean;
        },
      }))
      .filter((c) => c.expected.kind === "package"),
  );

  it.each(cases)("$id yields its code", ({ dir, expected }) => {
    const path = join(dir, "package");
    if (expected.ok) {
      const prepared = prepareImport(path);
      expect(prepared.issues.map((i) => i.code)).toContain(expected.code);
    } else expect(refusal(() => prepareImport(path))).toBe(expected.code);
  });

  it("reports a missing path as PKG_NOT_FOUND", () => {
    expect(refusal(() => prepareImport(join(work, "no-such-package")))).toBe("PKG_NOT_FOUND");
  });

  it("accepts both valid packages and keeps their provenance [@req QAA-FR-012]", () => {
    const saa = prepareImport(join(VALID, "mode-a-saa"));
    expect(saa.provenance).toMatchObject({
      package_id: expect.stringMatching(/^pkg:/),
      package_version: expect.any(Number),
      package_schema_version: "1.0.0",
      producer: { name: "SAA" },
      repository: expect.objectContaining({ revision: expect.anything() }),
      analysis: expect.objectContaining({ run_id: expect.any(String), status: expect.any(String) }),
      evidence_profile: expect.objectContaining({ source_analysis: "available" }),
    });
    expect(saa.provenance.generated_at).toMatch(/^\d{4}-/);
    const qaa = prepareImport(join(VALID, "mode-b-qaa"));
    expect(qaa.provenance).toMatchObject({ producer: { name: "QAA" }, repository: null });
    expect(qaa.provenance.observed_environments).toHaveLength(1);
    for (const p of [saa, qaa]) {
      expect(p.stage).toBe("complete");
      expect(p.artifacts.map((a) => a.role)).toEqual(expect.arrayContaining(["system_model", "evidence_index"]));
    }
  });

  it("reports a missing documentation language and falls back", () => {
    const prepared = prepareImport(join(VALID, "mode-a-saa"), { language: "fr" });
    expect(prepared.issues.map((i) => i.code)).toContain("PKG_LANGUAGE_UNAVAILABLE");
  });
});

describe("artifact discovery by role [@req CON-011] [@req QAA-FR-011]", () => {
  it("gives the same result when documentation files are renamed but keep their roles", () => {
    const renamed = join(work, "renamed");
    cpSync(join(VALID, "mode-a-saa"), renamed, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(renamed, "manifest.json"), "utf8")) as {
      artifacts: Array<{ path: string; media_type: string }>;
    };
    for (const a of manifest.artifacts.filter((x) => x.media_type === "text/markdown")) {
      const to = a.path.replace(/([^/]+)\.md$/, "renamed-$1.md");
      cpSync(join(renamed, a.path), join(renamed, to));
      rmSync(join(renamed, a.path));
      a.path = to;
    }
    writeFileSync(join(renamed, "manifest.json"), JSON.stringify(manifest, null, 2));
    const original = prepareImport(join(VALID, "mode-a-saa"));
    const changed = prepareImport(renamed);
    const strip = (p: typeof original) => ({
      provenance: p.provenance,
      artifacts: p.artifacts.map(({ path: _path, ...rest }) => rest),
      stage: p.stage,
      issues: p.issues.map((i) => i.code),
    });
    expect(strip(changed)).toEqual(strip(original));
  });

  it("maps from the structured artifacts only: blanking every Markdown document changes nothing else", () => {
    // The contract requires at least one Markdown artifact, so "removed" means emptied: QAA must not read it.
    const blank = join(work, "blank-markdown");
    cpSync(join(VALID, "mode-a-saa"), blank, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(blank, "manifest.json"), "utf8")) as {
      artifacts: Array<{ path: string; media_type: string; sha256: string }>;
    };
    for (const a of manifest.artifacts.filter((x) => x.media_type === "text/markdown")) {
      writeFileSync(join(blank, a.path), "");
      a.sha256 = `sha256:${createHash("sha256").update("").digest("hex")}`;
    }
    writeFileSync(join(blank, "manifest.json"), JSON.stringify(manifest, null, 2));
    const original = prepareImport(join(VALID, "mode-a-saa"));
    const blanked = prepareImport(blank);
    expect(blanked.provenance).toEqual(original.provenance);
    for (const name of ["system-model.json", "evidence-index.json"])
      expect(Buffer.from(blanked.files.get(name)!).equals(Buffer.from(original.files.get(name)!))).toBe(true);
    expect(PackageQuery.open(blank).workflows()).toEqual(PackageQuery.open(join(VALID, "mode-a-saa")).workflows());
  });
});

describe("storing an import [@req CON-010]", () => {
  it("keeps the original byte for byte and stores only the listed files as the package", () => {
    const source = join(work, "with-extra");
    cpSync(join(VALID, "mode-a-saa"), source, { recursive: true });
    writeFileSync(join(source, "notes.txt"), "not listed");
    const prepared = prepareImport(source);
    expect(prepared.issues.map((i) => i.code)).toContain("PKG_UNLISTED_FILE");
    const target = { packagesDir: join(work, "store", "packages"), importDir: join(work, "store", "imports", "i1") };
    const stored = storeImport(prepared, target);
    expect(stored.status).toBe("imported");
    // Original: every file, byte-equal (including the unlisted one).
    for (const [path, bytes] of prepared.originalFiles)
      expect(readFileSync(join(stored.originalPath!, path)).equals(Buffer.from(bytes)), path).toBe(true);
    // Package: the manifest's files only.
    expect(readdirSync(stored.packagePath)).not.toContain("notes.txt");
    expect(prepareImport(stored.packagePath).manifestSha256).toBe(prepared.manifestSha256);
    // The same version again is unchanged; a different manifest under the same version is refused.
    expect(storeImport(prepared, { ...target, importDir: join(work, "store", "imports", "i2") }).status).toBe(
      "unchanged",
    );
    const other = { ...prepared, manifestSha256: `sha256:${"0".repeat(64)}` };
    expect(refusal(() => storeImport(other, { ...target, importDir: join(work, "store", "imports", "i3") }))).toBe(
      "PACKAGE_VERSION_CONFLICT",
    );
  });
});

describe("package paths", () => {
  it("accepts only relative forward-slash paths inside the package", () => {
    expect(unsafePathReason("docs/en/00-summary.md")).toBeUndefined();
    for (const bad of ["", "../x", "a/../../x", "/etc/passwd", "C:/x", "c:x", "a\\b", "a//b", "./a", "a/\u0000"])
      expect(unsafePathReason(bad), bad).toBeDefined();
  });
});
