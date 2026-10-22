/**
 * Translation invariants (LOC-006, PRD §19.3, §19.5): what must survive translation unchanged. Used on every machine
 * translation before it is stored; a violation rejects the translation rather than repairing it.
 */
export type InvariantViolation =
  | { kind: "protected_token_missing"; token: string }
  | { kind: "numbers_changed"; source: string[]; translated: string[] }
  | { kind: "negation_changed"; source: number; translated: number };

/** Negation markers per language. Heuristic by design: counts must match, which catches dropped or added negations. */
const NEGATIONS: Record<string, RegExp> = {
  en: /\b(?:not|no|never|none|cannot|without|neither|nor)\b|n't\b/gi,
  id: /\b(?:tidak|tak|bukan|jangan|belum|tanpa|tiada)\b/gi,
};

/** Tokens copied verbatim: code spans, quoted literals, IDs (`kind:id`), URLs, paths and enum-like codes. */
const PROTECTED: RegExp[] = [
  /`[^`]+`/g,
  /"[^"\n]+"/g,
  /\bhttps?:\/\/[^\s)>\]]+/g,
  /\b[a-z][a-z0-9_]*:[^\s,;)"'`]+/g,
  /(?<![\w.])\/[\w\-./{}:[\]]+/g,
  /\b[a-z]+(?:_[a-z0-9]+)+\b/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
];

const NUMBER = /(?<![\w.])-?\d+(?:[.,]\d+)*(?![\w])/g;

export function protectedTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const pattern of PROTECTED) for (const m of text.matchAll(pattern)) tokens.add(m[0].replace(/[.,;:]+$/, ""));
  return [...tokens].filter((t) => t.length > 1);
}

/** Numbers in order of appearance, excluding those inside protected tokens (already checked verbatim). */
function numbers(text: string): string[] {
  let stripped = text;
  for (const token of protectedTokens(text)) stripped = stripped.split(token).join(" ");
  return [...stripped.matchAll(NUMBER)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, "").replace(",", "."));
}

const negations = (text: string, language: string): number =>
  [...text.matchAll(NEGATIONS[language] ?? NEGATIONS.en!)].length;

export function checkTranslationInvariants(
  source: { text: string; language: string },
  translated: { text: string; language: string },
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const token of protectedTokens(source.text)) {
    if (!translated.text.includes(token)) violations.push({ kind: "protected_token_missing", token });
  }
  const a = numbers(source.text).sort();
  const b = numbers(translated.text).sort();
  if (a.join("|") !== b.join("|")) violations.push({ kind: "numbers_changed", source: a, translated: b });
  const na = negations(source.text, source.language);
  const nb = negations(translated.text, translated.language);
  if (na !== nb) violations.push({ kind: "negation_changed", source: na, translated: nb });
  return violations;
}
