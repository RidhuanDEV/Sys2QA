import { createHash } from "node:crypto";
import type { Entity, Evidence } from "@sys2qa/contract";
import type { AnalyzeResult } from "../../protocol.js";

export const ADAPTER_ID = "docs";
export const ADAPTER_VERSION = "0.1.0";

export interface FileInput {
  path: string;
  sha256: string;
  text: string;
}

/** A sentence of documentation that states a numeric constraint, with each quantity and where it sits in the text. */
export interface DocStatement {
  text: string;
  quantities: Array<{
    kind: "min" | "max" | "exact" | "range";
    value?: number;
    min?: number;
    max?: number;
    unit?: "characters" | "digits";
    /** Character offset of the quantity in `text`, so the reader can tell which word it belongs to. */
    at: number;
  }>;
  line: number;
  evidence: string;
}

const NUMBER = String.raw`(-?\d[\d,]*)`;
const UNIT = String.raw`(?:\s*(characters?|chars?|digits?|letters?))?`;
// Order matters: a span taken by an earlier pattern is not read again ("at least 8 characters" is a minimum).
const PATTERNS: Array<{ kind: DocStatement["quantities"][number]["kind"]; re: RegExp }> = [
  { kind: "range", re: new RegExp(String.raw`\b(?:between|from)\s+${NUMBER}\s+(?:and|to)\s+${NUMBER}${UNIT}`, "gi") },
  {
    kind: "min",
    re: new RegExp(String.raw`\b(?:at\s+least|minimum(?:\s+of)?|no\s+fewer\s+than|min\.?)\s+${NUMBER}${UNIT}`, "gi"),
  },
  {
    kind: "max",
    re: new RegExp(
      String.raw`\b(?:at\s+most|maximum(?:\s+of)?|up\s+to|no\s+more\s+than|max\.?)\s+${NUMBER}${UNIT}`,
      "gi",
    ),
  },
  { kind: "exact", re: /\bexactly\s+(\d+)\s*(digits?|characters?|chars?)\b/gi },
  { kind: "exact", re: /\b(\d+)[-\s](digits?)\b/gi },
];

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

const toNumber = (s: string) => Number(s.replace(/,/g, ""));
const unitOf = (s: string | undefined): "characters" | "digits" | undefined =>
  s === undefined ? undefined : /^digit/i.test(s) ? "digits" : "characters";

/**
 * Sentences that state numeric constraints ("at least 8 characters", "13-digit", "between 1 and 10000"). Lines of a
 * paragraph are joined, so a sentence wrapped over lines is read whole; code blocks are skipped. `line` is where the
 * sentence starts.
 */
export function statementsOf(text: string): Array<Omit<DocStatement, "evidence">> {
  const out: Array<Omit<DocStatement, "evidence">> = [];
  const paragraphs: Array<{ text: string; starts: number[]; line: number }> = [];
  let current: { text: string; starts: number[]; line: number } | undefined;
  let inCode = false;
  text.split("\n").forEach((raw, i) => {
    const fence = /^\s*(```|~~~)/.test(raw);
    if (fence) inCode = !inCode;
    const blank = raw.trim() === "" || fence || inCode || /^\s*(#|\||[-*+]\s|\d+\.\s)/.test(raw);
    if (blank) {
      if (current) paragraphs.push(current);
      current = undefined;
      // Headings, list items and table rows stand alone.
      if (!fence && !inCode && raw.trim() !== "") paragraphs.push({ text: raw.trim(), starts: [0], line: i + 1 });
      return;
    }
    if (!current) current = { text: raw.trim(), starts: [0], line: i + 1 };
    else {
      current.starts.push(current.text.length + 1);
      current.text += ` ${raw.trim()}`;
    }
  });
  if (current) paragraphs.push(current);
  for (const p of paragraphs) {
    let offset = 0;
    for (const sentence of p.text.split(/(?<=[.!?;])\s+/)) {
      const at = p.text.indexOf(sentence, offset);
      offset = at + sentence.length;
      const quantities: DocStatement["quantities"] = [];
      const taken: Array<[number, number]> = [];
      for (const { kind, re } of PATTERNS)
        for (const m of sentence.matchAll(re)) {
          const start = m.index;
          const end = start + m[0].length;
          if (taken.some(([a, b]) => start < b && end > a)) continue;
          taken.push([start, end]);
          if (kind === "range")
            quantities.push({
              kind,
              min: toNumber(m[1]!),
              max: toNumber(m[2]!),
              ...(unitOf(m[3]) ? { unit: unitOf(m[3])! } : {}),
              at: start,
            });
          else
            quantities.push({
              kind,
              value: toNumber(m[1]!),
              ...(unitOf(m[2]) ? { unit: unitOf(m[2])! } : {}),
              at: start,
            });
        }
      if (quantities.length > 0)
        out.push({
          text: sentence.trim().slice(0, 240),
          quantities,
          line: p.line + p.starts.filter((s) => s <= at).length - 1,
        });
    }
  }
  return out;
}

/**
 * Documentation statements (IMP-113, SAA-FR-011): one `file` entity per document with the sentences that state numeric
 * constraints. The host compares them with the rules found in code; documentation alone never verifies anything
 * (CR-001). Text is data: nothing in it is followed.
 */
export function extractFiles(
  files: readonly FileInput[],
  context: { boundaryPath: string; capturedAt: string },
): AnalyzeResult {
  const out: AnalyzeResult = { entities: [], relationships: [], evidence: [], coverage: [] };
  const boundary = context.boundaryPath === "" ? "project:." : `project:${context.boundaryPath}`;
  for (const file of files) {
    if (!/\.(md|mdx|markdown|txt)$/i.test(file.path)) {
      out.coverage.push({ area: file.path, status: "unsupported", reason: "not a documentation file" });
      continue;
    }
    const lines = file.text.split("\n");
    const evidence = (start: number, end: number): string => {
      const id = `evidence:${hash16("documentation", file.path, `${start}-${end}`, file.sha256, ADAPTER_ID, ADAPTER_VERSION)}`;
      if (!out.evidence.some((e) => e.id === id))
        out.evidence.push({
          id,
          source_type: "documentation",
          captured_at: context.capturedAt,
          extractor: { adapter: ADAPTER_ID, version: ADAPTER_VERSION, method: "constraint-statements" },
          path: file.path,
          range: { start_line: start, end_line: Math.max(start, end) },
          file_fingerprint: file.sha256,
          excerpt_policy: "digest_only",
          excerpt_digest: `sha256:${createHash("sha256")
            .update(lines.slice(start - 1, Math.max(start, end)).join("\n"))
            .digest("hex")}`,
        } as Evidence);
      return id;
    };
    const statements = statementsOf(file.text).map((s) => ({ ...s, evidence: evidence(s.line, s.line) }));
    out.entities.push({
      id: `file:${file.path}`,
      kind: "file",
      name: file.path,
      project_boundary: boundary,
      status: "inferred",
      confidence_rationale: "documentation describes intent; it does not prove behavior",
      origin: "source",
      evidence_ids: [evidence(1, lines.length)],
      path: file.path,
      ...(statements.length > 0 ? { doc_statements: statements } : {}),
    } as unknown as Entity);
    out.coverage.push({ area: file.path, status: "analyzed" });
  }
  return out;
}
