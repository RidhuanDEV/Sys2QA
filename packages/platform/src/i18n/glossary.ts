import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Versioned glossary of controlled terms for one locale (LOC-009, PRD §19.5). */
export interface Glossary {
  locale: string;
  version: string;
  terms: Record<string, Record<string, string>>;
}

export const DEFAULT_LOCALE = "en";
const FILE = /^glossary\.([a-z]{2,3}(?:-[A-Z]{2})?)\.json$/;

export function defaultGlossaryDirectory(): string {
  return fileURLToPath(new URL("../../i18n/", import.meta.url));
}

/**
 * Glossaries keyed by locale. Adding a locale means adding `glossary.<locale>.json`; no code or schema changes (LOC-003).
 */
export class GlossaryRegistry {
  readonly #glossaries = new Map<string, Glossary>();

  constructor(directory = defaultGlossaryDirectory()) {
    for (const file of readdirSync(directory)) {
      const match = FILE.exec(file);
      if (!match) continue;
      const glossary = JSON.parse(readFileSync(join(directory, file), "utf8")) as Glossary;
      if (glossary.locale !== match[1]) throw new Error(`${file} declares locale ${glossary.locale}`);
      if (!/^\d+\.\d+\.\d+$/.test(glossary.version))
        throw new Error(`${file} has an invalid version ${glossary.version}`);
      this.#glossaries.set(glossary.locale, glossary);
    }
    if (!this.#glossaries.has(DEFAULT_LOCALE)) throw new Error(`the ${DEFAULT_LOCALE} glossary is required`);
  }

  locales(): string[] {
    return [...this.#glossaries.keys()].sort();
  }

  supports(locale: string): boolean {
    return this.#glossaries.has(locale);
  }

  get(locale: string): Glossary | undefined {
    return this.#glossaries.get(locale);
  }

  /** `<locale>@<version>`, recorded on exports (LOC-009). */
  reference(locale: string): string {
    const g = this.#glossaries.get(locale);
    if (!g) throw new Error(`no glossary for locale ${locale}`);
    return `${g.locale}@${g.version}`;
  }

  /**
   * The label of an enum code. Falls back to the default locale with an explicit marker (PRD §19.4); an unknown code is
   * shown as the code itself, never invented.
   */
  term(
    locale: string,
    domain: string,
    code: string,
  ): { text: string; language: string; fallback_language?: string; missing?: true } {
    const own = this.#glossaries.get(locale)?.terms[domain]?.[code];
    if (own !== undefined) return { text: own, language: locale };
    const fallback = this.#glossaries.get(DEFAULT_LOCALE)?.terms[domain]?.[code];
    if (fallback !== undefined) return { text: fallback, language: DEFAULT_LOCALE, fallback_language: DEFAULT_LOCALE };
    return { text: code, language: locale, missing: true };
  }
}
