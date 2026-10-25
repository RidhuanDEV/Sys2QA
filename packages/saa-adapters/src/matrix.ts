import type { InitializeResult } from "./protocol.js";

/** How deeply a language or framework is analyzed, from the adapters' own declarations (SAA-FR-047). */
export interface AdapterSupportLookup {
  /** `analyzed` if an adapter declares the language; every inventoried language is at least `scanned`. */
  language(language: string): "analyzed" | "scanned";
  /** `analyzed` if an adapter declares the framework, with any workflow-tracing level. */
  framework(framework: string): "analyzed" | "unsupported";
}

export function supportLookup(adapters: readonly InitializeResult[]): AdapterSupportLookup {
  const languages = new Set(adapters.flatMap((a) => a.support_matrix.languages.map((l) => l.name)));
  const frameworks = new Set(adapters.flatMap((a) => a.support_matrix.frameworks.map((f) => f.name)));
  return {
    language: (language) => (languages.has(language) ? "analyzed" : "scanned"),
    framework: (framework) => (frameworks.has(framework) ? "analyzed" : "unsupported"),
  };
}

/** Plain-text support matrix for `sys2qa adapters` (SAA-FR-047): in-depth languages listed apart from scanned ones. */
export function formatSupportMatrix(
  adapters: readonly InitializeResult[],
  failures: ReadonlyArray<{ id: string; code: string; message: string }> = [],
): string {
  if (adapters.length === 0 && failures.length === 0) return "No analyzer adapters are installed.\n";
  const lines: string[] = [];
  for (const a of adapters) {
    const m = a.support_matrix;
    lines.push(`${a.adapter_id} ${a.adapter_version} (protocol ${a.protocol_version})`);
    lines.push(
      `  analyzed in depth: ${list(m.languages.map((l) => (l.versions ? `${l.name} ${l.versions}` : l.name)))}`,
    );
    lines.push(`  scanned only:      ${list(m.scanned_only_languages)}`);
    if (m.frameworks.length === 0) lines.push("  frameworks:        none");
    for (const f of m.frameworks) {
      lines.push(`  framework ${f.name}${f.versions ? ` ${f.versions}` : ""}: workflow tracing ${f.workflow_tracing}`);
      lines.push(`    entities:  ${list(f.entities)}`);
      lines.push(`    relations: ${list(f.relations)}`);
      lines.push(`    fixtures:  ${list(f.fixtures)}`);
    }
    lines.push(`  prerequisites:     ${list(m.prerequisites)}`);
    for (const limitation of m.limitations) lines.push(`  limitation: ${limitation}`);
  }
  for (const f of failures) lines.push(`${f.id}: unavailable (${f.code}: ${f.message})`);
  return `${lines.join("\n")}\n`;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}
