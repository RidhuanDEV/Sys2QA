import { CONTRACT_VERSION, type CompletenessReport, type Gap } from "@sys2qa/contract";
import type { InventoryEntry } from "../intake/inventory.js";
import type { ProjectBoundary } from "../stack/stack.js";
import type { StructureResult } from "./run.js";

type Suggestion = CompletenessReport["improvement_suggestions"][number];

/** Languages that are inventory only: no analyzer adapter is expected for them, so their absence is not a gap. */
const NOT_ANALYZED = new Set([
  "json",
  "yaml",
  "toml",
  "xml",
  "ini",
  "markdown",
  "text",
  "css",
  "html",
  "restructuredtext",
  "asciidoc",
]);

export interface CompletenessInput {
  runId: string;
  /** Root labels as the user knows them (never resolved to absolute paths here). */
  roots: readonly string[];
  /** The whole inventory: included, excluded, skipped and unreadable entries. */
  inventory: readonly InventoryEntry[];
  boundaries: readonly ProjectBoundary[];
  structure: Pick<
    StructureResult,
    "coverage" | "gaps" | "component_traces" | "catalog" | "adapters" | "failed_batches"
  >;
}

/** The directory an entry is summarized under: its first two path segments. */
function areaOf(path: string): string {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `${parts.slice(0, 2).join("/")}/`;
}

/**
 * The completeness report of an SAA run (IMP-114, SAA-FR-045, CR-043). Every count is within the examined scope. It
 * states what was examined (roots, boundaries), how many constructs were analyzed, partly analyzed or unsupported,
 * entry points and workflows by discovery status, workflows with unresolved links, languages no adapter analyzed and
 * failed adapters, excluded areas (summarized by directory and reason), unexplored areas (unsupported or failed
 * files, gaps, workflows not deepened) and, for each gap, the evidence that would improve the result.
 */
export function completenessReport(input: CompletenessInput): CompletenessReport {
  const { structure } = input;
  const workflows = structure.catalog.workflows;

  const constructs = { analyzed: 0, partial: 0, unsupported: 0 };
  for (const c of structure.coverage) {
    if (c.status === "analyzed") constructs.analyzed++;
    else if (c.status === "partial" || c.status === "failed") constructs.partial++;
    else if (c.status === "unsupported") constructs.unsupported++;
  }

  const byStatus: Record<string, number> = {};
  for (const w of workflows) byStatus[w.discovery_status] = (byStatus[w.discovery_status] ?? 0) + 1;

  // Languages present in the inventory that no adapter declares, and adapters whose batches failed.
  const declared = new Set(structure.adapters.flatMap((a) => a.support_matrix.languages.map((l) => l.name)));
  const missing = new Map<string, number>();
  for (const e of input.inventory)
    if (e.status === "included" && e.language && !declared.has(e.language) && !NOT_ANALYZED.has(e.language))
      missing.set(e.language, (missing.get(e.language) ?? 0) + 1);
  const unavailable: CompletenessReport["unavailable_adapters"] = [
    ...[...missing].sort().map(([language, files]) => ({
      adapter: language,
      reason: `no analyzer adapter for ${language}; ${files} file(s) were inventoried but not analyzed`,
    })),
    ...[...new Map(structure.failed_batches.map((f) => [`${f.adapter}\0${f.code}`, f])).values()].map((f) => ({
      adapter: f.adapter,
      reason: `batches failed with ${f.code}; their files are marked failed`,
    })),
  ];

  // Excluded areas, summarized by directory and reason.
  const excluded = new Map<string, { area: string; reason: string }>();
  for (const e of input.inventory)
    if (e.status !== "included" && e.reason) {
      const area = e.type === "directory" ? `${e.path}/` : areaOf(e.path);
      const reason = `${e.status}: ${e.reason}${e.rule ? ` (${e.rule})` : ""}`;
      excluded.set(`${area}\0${reason}`, { area, reason });
    }

  // Unexplored: files analyzed partly or not at all, what the gaps leave open, and workflows not deepened.
  const unexplored = new Map<string, { area: string; reason: string }>();
  const addUnexplored = (area: string, reason: string) => {
    if (!unexplored.has(area)) unexplored.set(area, { area, reason: reason.slice(0, 300) });
  };
  for (const c of structure.coverage)
    if (c.status === "unsupported" || c.status === "failed" || c.status === "partial")
      addUnexplored(c.area, `${c.status}${c.reason ? `: ${c.reason}` : ""}`);
  for (const g of structure.gaps.filter((x) => x.type !== "contradiction"))
    for (const related of (g.related_entity_ids ?? []).slice(0, 1)) addUnexplored(related, g.description);
  for (const id of structure.catalog.not_deepened)
    addUnexplored(id, "not deepened within this run's budget; deepen on demand");

  const affected = (gap: Gap) =>
    workflows
      .filter(
        (w) =>
          w.unresolved_hops.some((h) => h.gap_id === gap.id) ||
          w.steps.some((s) => (gap.related_entity_ids ?? []).includes(s.entity_id)),
      )
      .map((w) => w.id);
  const suggestions: Suggestion[] = [];
  const suggest = (s: Suggestion) => {
    if (!suggestions.some((x) => x.description === s.description)) suggestions.push(s);
  };
  for (const gap of structure.gaps) {
    const related = gap.related_entity_ids ?? [];
    const would = [...new Set([...affected(gap), ...related])].slice(0, 20);
    const withTargets = (s: Omit<Suggestion, "would_improve">): Suggestion =>
      would.length > 0 ? { ...s, would_improve: would } : s;
    const backend = workflows.some((w) =>
      w.unresolved_hops.some((h) => h.gap_id === gap.id && h.reason_code === "missing_repository"),
    );
    if (gap.id.startsWith("gap:consumer:"))
      suggest(
        withTargets({
          evidence_kind: "source",
          description: `Add the repository that consumes ${gap.id.slice("gap:consumer:".length)} to trace what happens after the message.`,
        }),
      );
    else if (gap.type === "external_boundary" && backend)
      suggest(
        withTargets({
          evidence_kind: "source",
          description: `Add the repository of the backend behind ${related[0] ?? gap.id} to trace the requests past the browser.`,
        }),
      );
    else if (gap.type === "external_boundary")
      suggest(
        withTargets({
          evidence_kind: "runtime",
          description: `Observe ${related[0] ?? gap.id} in a test environment, or provide its API contract, to confirm what happens after the request.`,
        }),
      );
    else if (gap.id.startsWith("gap:route-condition:"))
      suggest(
        withTargets({
          evidence_kind: "environment",
          description: `Provide the deployed configuration for ${related[0] ?? gap.id} to know whether the page exists in each environment.`,
        }),
      );
    else if (gap.type === "contradiction")
      suggest(
        withTargets({
          evidence_kind: "requirement",
          description: `Confirm the intended behavior where documentation and code disagree (${related[0] ?? gap.id}).`,
        }),
      );
    else if (gap.id === "gap:authorization")
      suggest(
        withTargets({
          evidence_kind: "requirement",
          description: "Describe the roles and who may call which endpoint; no access check was recognized in code.",
        }),
      );
    else if (gap.type === "unsupported")
      suggest(
        withTargets({
          evidence_kind: "runtime",
          description: `Observe the running system to see what ${related[0] ?? gap.id} registers at run time.`,
        }),
      );
    else if (gap.type === "missing_evidence")
      suggest(
        withTargets({
          evidence_kind: "source",
          description: `Provide the missing source or configuration for ${related[0] ?? gap.id}.`,
        }),
      );
  }
  for (const u of unavailable.filter((x) => missing.has(x.adapter)))
    suggest({
      evidence_kind: "adapter",
      description: `An analyzer adapter for ${u.adapter} would cover the files listed as unsupported.`,
    });

  return {
    schema_version: CONTRACT_VERSION,
    producer: "SAA",
    run_id: input.runId,
    count_scope: "within_examined_scope",
    examined: { roots: [...input.roots], boundaries: input.boundaries.map((b) => b.id) },
    constructs,
    entry_points_found: structure.component_traces.length,
    workflows_by_status: byStatus,
    unresolved_workflow_ids: workflows.filter((w) => w.unresolved_hops.length > 0).map((w) => w.id),
    unavailable_adapters: unavailable,
    excluded: [...excluded.values()].slice(0, 500),
    unexplored: [...unexplored.values()].slice(0, 500),
    improvement_suggestions: suggestions,
  };
}
