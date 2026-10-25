import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkMetrics, Measured } from "./metrics.js";

const show = (v: Measured) =>
  typeof v === "number"
    ? Number.isInteger(v)
      ? String(v)
      : `${(v * 100).toFixed(1)}%`
    : `not measured (${v.not_measured})`;

/** Markdown report for one fixture and producer. */
export function renderBenchmarkReport(m: BenchmarkMetrics, producer: string, at: string): string {
  const lines = [
    `# Benchmark ${m.fixture} — ${producer}`,
    "",
    `Generated ${at}. Metrics per Test Strategy §5; targets are set after the first baseline, except the gate rules.`,
    "",
    "## Gate rules",
    "",
    "| Metric | Rule | Value | Result |",
    "|---|---|---|---|",
    ...m.gates.map((g) => `| ${g.metric} | ${g.rule} | ${show(g.value)} | ${g.passed ? "pass" : "**FAIL**"} |`),
    "",
    "## Discovery and reconstruction",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Expected / discovered / matched workflows | ${m.discovery.expected} / ${m.discovery.discovered} / ${m.discovery.matched} |`,
    `| Discovery recall | ${show(m.discovery.recall)} |`,
    `| Discovery precision | ${show(m.discovery.precision)} |`,
    `| Step-sequence F1 | ${show(m.reconstruction.step_f1)} |`,
    `| Branch recall | ${show(m.reconstruction.branch_recall)} |`,
    `| Stop-point accuracy | ${show(m.reconstruction.stop_point_accuracy)} |`,
    `| External-boundary labeling accuracy | ${show(m.reconstruction.external_boundary_accuracy)} |`,
    `| Reported gaps that are true gaps | ${show(m.uncertainty.true_gap_ratio)} |`,
    `| Missed workflows inside reported unexplored areas | ${show(m.uncertainty.misses_in_unexplored_areas)} |`,
    `| Over-claiming | ${m.over_claiming.count}${m.over_claiming.items.length ? ` (${m.over_claiming.items.join(", ")})` : ""} |`,
    `| Evidence traceability | ${show(m.evidence_traceability)} |`,
    "",
    "## Scenarios and runtime",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Expected scenarios covered | ${show(m.scenarios.expected_covered)} |`,
    `| Forbidden expectations present | ${show(m.scenarios.forbidden_present)} |`,
    `| Page recall | ${show(m.runtime.page_recall)} |`,
    `| Form recall | ${show(m.runtime.form_recall)} |`,
    `| Withheld-form errors | ${show(m.runtime.withheld_form_errors)} |`,
    "",
  ];
  return lines.join("\n");
}

/** Writes `<dir>/<fixture>/<producer>.{json,md}` and appends one line to `<dir>/trend.jsonl` (trend storage). */
export function storeBenchmarkResult(
  dir: string,
  m: BenchmarkMetrics,
  producer: string,
  at: string,
  commit?: string,
): void {
  mkdirSync(join(dir, m.fixture), { recursive: true });
  writeFileSync(
    join(dir, m.fixture, `${producer}.json`),
    `${JSON.stringify({ at, producer, commit, metrics: m }, null, 2)}\n`,
  );
  writeFileSync(join(dir, m.fixture, `${producer}.md`), renderBenchmarkReport(m, producer, at));
  appendFileSync(
    join(dir, "trend.jsonl"),
    `${JSON.stringify({ at, commit, fixture: m.fixture, producer, recall: m.discovery.recall, precision: m.discovery.precision, step_f1: m.reconstruction.step_f1, over_claiming: m.over_claiming.count, evidence_traceability: m.evidence_traceability, gates_passed: m.gates.every((g) => g.passed) })}\n`,
  );
}
