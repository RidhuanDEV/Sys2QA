import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkTranslationInvariants,
  defaultGlossaryDirectory,
  GlossaryRegistry,
  JOB_STATES,
  resolveLanguage,
  selectText,
} from "../src/index.js";

const schema = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../schemas/${name}.schema.json`, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
const registry = new GlossaryRegistry();

/** Enumerations rendered as labels; codes shown verbatim (producer names, permission levels) are excluded. */
function controlledVocabulary(): Record<string, string[]> {
  const defs = schema("common").$defs as Record<string, { enum?: string[] }>;
  const vocab: Record<string, string[]> = {};
  for (const [name, def] of Object.entries(defs))
    if (def.enum && !["producer_name", "permission_level"].includes(name)) vocab[name] = def.enum;
  const scenario = schema("scenario") as {
    properties: Record<string, { enum?: string[]; items?: { properties: { id: { enum: string[] } } } }>;
  };
  vocab.test_technique = scenario.properties.test_techniques!.items!.properties.id.enum;
  vocab.execution_classification = scenario.properties.execution_classification!.enum!;
  vocab.readiness_activity = ["scenario_design", "manual_preparation", "automated_execution"];
  vocab.job_state = [...JOB_STATES];
  return vocab;
}

describe("versioned glossary [@req LOC-002] [@req LOC-003] [@req LOC-009]", () => {
  it("covers every controlled term of the contract in en and id", () => {
    expect(registry.locales()).toEqual(["en", "id"]);
    for (const locale of registry.locales()) {
      const missing = Object.entries(controlledVocabulary()).flatMap(([domain, codes]) =>
        codes.filter((c) => registry.get(locale)!.terms[domain]?.[c] === undefined).map((c) => `${domain}.${c}`),
      );
      expect(missing, locale).toEqual([]);
    }
  });

  it("references the glossary version for exports and renders codes with an explicit fallback", () => {
    expect(registry.reference("id")).toBe("id@1.0.0");
    expect(registry.term("id", "case_outcome", "passed")).toEqual({ text: "Lulus", language: "id" });
    expect(registry.term("en", "claim_status", "source_verified").text).toBe("Verified in source");
    expect(registry.term("xx", "severity", "critical")).toEqual({
      text: "Critical",
      language: "en",
      fallback_language: "en",
    });
    expect(registry.term("id", "severity", "catastrophic")).toEqual({
      text: "catastrophic",
      language: "id",
      missing: true,
    });
  });

  it("adds a locale through a glossary file alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "sys2qa-glossary-"));
    try {
      copyFileSync(join(defaultGlossaryDirectory(), "glossary.en.json"), join(dir, "glossary.en.json"));
      writeFileSync(
        join(dir, "glossary.ms.json"),
        JSON.stringify({ locale: "ms", version: "0.1.0", terms: { case_outcome: { passed: "Lulus" } } }),
      );
      const extended = new GlossaryRegistry(dir);
      expect(extended.supports("ms")).toBe(true);
      expect(extended.term("ms", "case_outcome", "passed").text).toBe("Lulus");
      expect(extended.term("ms", "case_outcome", "failed")).toMatchObject({ text: "Failed", fallback_language: "en" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("language resolution [@req LOC-001]", () => {
  const supports = (l: string) => registry.supports(l);
  it("resolves each dimension independently: override, project, user, default", () => {
    const sources = {
      project: { scenario_language: "id", report_language: "en" },
      user: { ui_locale: "id", report_language: "id" },
    };
    expect(resolveLanguage("scenario_language", sources, supports)).toMatchObject({
      languages: ["id"],
      source: "project",
    });
    expect(resolveLanguage("report_language", sources, supports)).toMatchObject({
      languages: ["en"],
      source: "project",
    });
    expect(resolveLanguage("ui_locale", sources, supports)).toMatchObject({ languages: ["id"], source: "user" });
    expect(
      resolveLanguage("report_language", { ...sources, override: { report_language: "id" } }, supports),
    ).toMatchObject({ languages: ["id"], source: "override" });
    expect(resolveLanguage("saa_doc_language", sources, supports)).toMatchObject({
      languages: ["en"],
      source: "default",
    });
  });

  it("lets manual instructions follow the scenario language, allows several documentation languages and reports unsupported values", () => {
    expect(
      resolveLanguage("manual_instruction_language", { project: { scenario_language: "id" } }, supports),
    ).toMatchObject({ languages: ["id"], source: "project" });
    expect(
      resolveLanguage("saa_doc_language", { project: { saa_doc_language: ["en", "id"] } }, supports).languages,
    ).toEqual(["en", "id"]);
    expect(resolveLanguage("ui_locale", { project: { ui_locale: "fr" }, user: { ui_locale: "id" } }, supports)).toEqual(
      { languages: ["id"], source: "user", skipped: [{ source: "project", value: "fr" }] },
    );
  });
});

describe("text selection and fallback [@req LOC-008]", () => {
  const variants = [
    { language: "en", value: "Register with a 13-digit NIB" },
    { language: "id", value: "Daftar dengan NIB 13 digit", machine_translated: true },
  ];
  it("returns the requested language with its machine-translation label", () => {
    expect(selectText(variants, "id")).toEqual({
      language: "id",
      value: "Daftar dengan NIB 13 digit",
      machine_translated: true,
    });
  });
  it("falls back to the human original with an explicit marker", () => {
    expect(selectText(variants, "ms")).toEqual({
      language: "en",
      value: "Register with a 13-digit NIB",
      fallback_language: "en",
    });
    expect(selectText([], "en")).toBeUndefined();
  });
});

describe("translation invariants [@req LOC-006]", () => {
  const en = (text: string) => ({ text, language: "en" });
  const id = (text: string) => ({ text, language: "id" });
  it.each([
    [
      "NIB must be exactly 13 digits; the form does not accept letters.",
      "NIB harus tepat 13 digit; formulir tidak menerima huruf.",
    ],
    ['Open `page:web:/registrasi` and click "Daftar".', 'Buka `page:web:/registrasi` lalu klik "Daftar".'],
    [
      "Requests go to /api/registrations at https://staging.acme.example/.",
      "Permintaan dikirim ke /api/registrations di https://staging.acme.example/.",
    ],
    ["Never submit the login form.", "Jangan mengirim formulir login."],
    ["The status becomes pending_review after 2 approvals.", "Status menjadi pending_review setelah 2 persetujuan."],
  ])("accepts a faithful translation: %s", (source, translated) => {
    expect(checkTranslationInvariants(en(source), id(translated))).toEqual([]);
  });

  it.each([
    [
      "NIB must be exactly 13 digits; the form does not accept letters.",
      "NIB harus tepat 13 digit; formulir menerima huruf.",
      "negation_changed",
    ],
    ["NIB must be exactly 13 digits.", "NIB harus tepat 12 digit.", "numbers_changed"],
    ['Click "Daftar".', 'Klik "Register".', "protected_token_missing"],
    ["Open `page:web:/registrasi`.", "Buka halaman registrasi.", "protected_token_missing"],
    ["The status becomes pending_review.", "Status menjadi menunggu tinjauan.", "protected_token_missing"],
    ["Requests go to /api/registrations.", "Permintaan dikirim ke /api/pendaftaran.", "protected_token_missing"],
  ])("rejects %s → %s (%s)", (source, translated, kind) => {
    expect(checkTranslationInvariants(en(source), id(translated)).map((v) => v.kind)).toContain(kind);
  });
});
