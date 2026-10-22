/** Language dimensions (PRD §19.1). Source-language content (identifiers, code, routes, data) is never translated. */
export const LANGUAGE_DIMENSIONS = [
  "ui_locale",
  "saa_doc_language",
  "scenario_language",
  "manual_instruction_language",
  "report_language",
] as const;
export type LanguageDimension = (typeof LANGUAGE_DIMENSIONS)[number];

/** Per-scope settings: each dimension is set independently (LOC-001). `saa_doc_language` may hold several languages. */
export type LanguageSettings = Partial<Record<LanguageDimension, string | string[]>>;

export interface LanguageSources {
  override?: LanguageSettings;
  project?: LanguageSettings;
  user?: LanguageSettings;
  instanceDefault?: string;
}

export interface ResolvedLanguage {
  languages: string[];
  source: "override" | "project" | "user" | "default";
  /** Settings skipped because the locale is not supported, so the choice is never silent. */
  skipped: Array<{ source: string; value: string }>;
}

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Resolution order (PRD §19.2): per-operation override → project → user preference → instance default (`en`).
 * `manual_instruction_language` falls back to `scenario_language` at the same level before moving on.
 */
export function resolveLanguage(
  dimension: LanguageDimension,
  sources: LanguageSources,
  supports: (locale: string) => boolean,
): ResolvedLanguage {
  const skipped: ResolvedLanguage["skipped"] = [];
  for (const source of ["override", "project", "user"] as const) {
    const settings = sources[source];
    if (!settings) continue;
    let values = asList(settings[dimension]);
    if (values.length === 0 && dimension === "manual_instruction_language") values = asList(settings.scenario_language);
    if (values.length === 0) continue;
    const supported = values.filter((v) => supports(v));
    for (const v of values) if (!supports(v)) skipped.push({ source, value: v });
    if (supported.length > 0)
      return { languages: dimension === "saa_doc_language" ? supported : [supported[0]!], source, skipped };
  }
  return { languages: [sources.instanceDefault ?? "en"], source: "default", skipped };
}

/** A natural-language field in one language (Contract Spec §1). */
export interface LocalizedText {
  language: string;
  value: string;
  machine_translated?: boolean;
}

export interface SelectedText extends LocalizedText {
  /** Set when the requested language was unavailable (PRD §19.4); never mixed silently. */
  fallback_language?: string;
}

/**
 * Picks the variant for `requested`, else the human-authored original, else the first available, marking the fallback.
 * Machine translations keep their label (LOC-008).
 */
export function selectText(variants: readonly LocalizedText[], requested: string): SelectedText | undefined {
  const exact = variants.find((v) => v.language === requested);
  if (exact) return { ...exact };
  const original = variants.find((v) => !v.machine_translated) ?? variants[0];
  return original && { ...original, fallback_language: original.language };
}
