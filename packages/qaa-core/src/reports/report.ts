import type { Terms } from "../packs/pack.js";

/** Counts of a QA report (QAA-FR-090); each reconciles with the stored records. */
export interface ReportSummary {
  proposed: number;
  approved: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  inconclusive: number;
  not_run: number;
}

/** One case result with every link it needs (QAA-FR-091). */
export interface ReportResult {
  scenario_id: string;
  version: number;
  display_key: string;
  title: string;
  qa_objective: string;
  run_id: string;
  run_kind: "manual" | "automated";
  run_state: string;
  reported_by: "tester" | "executor";
  label: string;
  outcome: string;
  environment: unknown;
  packages: Array<{ package_id: string; package_version: number }>;
  revision: unknown;
  evidence: Array<{ ref: string; sha256: string | null; media_type: string | null }>;
  started_at: string | null;
  finished_at: string | null;
  defect_ids: string[];
  baseline_changed: boolean;
}

export interface QaReport {
  report_id: string;
  kind: "qa_report";
  schema_version: "1.0.0";
  generated_at: string;
  language: string;
  glossary: string;
  project: { id: string; name: string };
  scope: { plan_id: string | null; scenarios: number };
  evidence_profiles: Array<{
    package_id: string;
    package_version: number;
    profile: Record<string, unknown> | null;
  }>;
  qa_objectives: Record<string, number>;
  summary: ReportSummary;
  results: ReportResult[];
  defects: Array<Record<string, unknown>>;
  coverage: Array<{ plan_id: string; report: Record<string, unknown> }>;
  limitations: {
    analysis: string[];
    cannot_establish: string[];
    unresolved_assumptions: string[];
    coverage_gaps: string[];
    unsupported_operations: string[];
  };
  documents: { scenarios: unknown[]; runs: unknown[] };
}

const LABELS = {
  en: {
    title: "QA report",
    generated: "Generated",
    glossary: "Glossary",
    scope: "Scope",
    wholeProject: "the whole project",
    plan: "plan",
    scenarios: "scenario(s)",
    evidence: "Evidence profile",
    cannot: "What this evidence cannot establish",
    objectives: "QA objectives",
    summary: "Summary",
    count: {
      proposed: "Proposed",
      approved: "Approved",
      executed: "Executed",
      passed: "Passed",
      failed: "Failed",
      blocked: "Blocked",
      inconclusive: "Inconclusive",
      not_run: "Not run",
    },
    results: "Results",
    result: {
      scenario: "Scenario",
      objective: "QA objective",
      outcome: "Outcome",
      reported: "Reported",
      run: "Run",
      environment: "Environment",
      baseline: "Package and revision",
      evidence: "Evidence",
      time: "Started / finished",
      defects: "Defects",
    },
    baselineChanged: "the baseline changed during this run",
    defects: "Defects",
    coverage: "Coverage relative to the model",
    limitations: "Limitations",
    analysis: "Analysis limitations",
    assumptions: "Unresolved assumptions",
    gaps: "Coverage gaps",
    unsupported: "Unsupported operations",
    none: "None recorded.",
    declared: "declared",
  },
  id: {
    title: "Laporan QA",
    generated: "Dibuat",
    glossary: "Glosarium",
    scope: "Cakupan",
    wholeProject: "seluruh proyek",
    plan: "rencana",
    scenarios: "skenario",
    evidence: "Profil bukti",
    cannot: "Hal yang tidak dapat dibuktikan oleh bukti ini",
    objectives: "Tujuan QA",
    summary: "Ringkasan",
    count: {
      proposed: "Diusulkan",
      approved: "Disetujui",
      executed: "Dijalankan",
      passed: "Lulus",
      failed: "Gagal",
      blocked: "Terblokir",
      inconclusive: "Tidak meyakinkan",
      not_run: "Tidak dijalankan",
    },
    results: "Hasil",
    result: {
      scenario: "Skenario",
      objective: "Tujuan QA",
      outcome: "Hasil akhir",
      reported: "Dilaporkan",
      run: "Run",
      environment: "Environment",
      baseline: "Paket dan revisi",
      evidence: "Bukti",
      time: "Mulai / selesai",
      defects: "Defect",
    },
    baselineChanged: "baseline berubah selama run ini",
    defects: "Defect",
    coverage: "Cakupan relatif terhadap model",
    limitations: "Keterbatasan",
    analysis: "Keterbatasan analisis",
    assumptions: "Asumsi yang belum terselesaikan",
    gaps: "Celah cakupan",
    unsupported: "Operasi yang tidak didukung",
    none: "Tidak ada yang tercatat.",
    declared: "dideklarasikan",
  },
} as const;

type Labels = (typeof LABELS)[keyof typeof LABELS];
const labelsFor = (language: string): Labels =>
  (LABELS as Record<string, Labels>)[language.split("-")[0]!] ?? LABELS.en;

function environmentText(env: unknown, declared: string): string {
  const e = env as { environment_id?: string; declared?: { name: string; url?: string; version?: string } };
  if (e?.environment_id) return `\`${e.environment_id}\``;
  if (e?.declared)
    return `${e.declared.name} (${declared}${e.declared.url ? `, ${e.declared.url}` : ""}${e.declared.version ? `, ${e.declared.version}` : ""})`;
  return "?";
}

/** The report as Markdown in its language; identifiers, numbers and status codes stay as recorded (LOC-006). */
export function renderReportMarkdown(report: QaReport, terms: Terms = {}): string {
  const l = labelsFor(report.language);
  const term = (group: string, code: string) => terms[group]?.[code] ?? code.replaceAll("_", " ");
  const list = (items: string[]) => (items.length === 0 ? [l.none] : items.map((i) => `- ${i}`));
  const ratio = (r: { covered: number; of: number }) => `${r.covered}/${r.of}`;
  const lines: string[] = [
    `# ${l.title}: ${report.project.name}`,
    "",
    `\`${report.report_id}\` · ${l.generated}: ${report.generated_at} · ${l.glossary}: ${report.glossary}`,
    "",
    `${l.scope}: ${report.scope.plan_id ? `${l.plan} \`${report.scope.plan_id}\`` : l.wholeProject}, ${report.scope.scenarios} ${l.scenarios}.`,
    "",
    `## ${l.evidence}`,
    "",
  ];
  for (const p of report.evidence_profiles) {
    const profile = p.profile ?? {};
    lines.push(
      `### \`${p.package_id}\` ${p.package_version}`,
      "",
      ...["source_analysis", "runtime_observation", "documentation_import", "revision_correspondence"].map(
        (k) =>
          `- ${k.replaceAll("_", " ")}: ${term(k === "revision_correspondence" ? k : "evidence_availability", String(profile[k] ?? "?"))}`,
      ),
      "",
      `${l.cannot}:`,
      "",
      ...list((profile.cannot_establish as string[] | undefined) ?? []),
      "",
    );
  }
  if (report.evidence_profiles.length === 0) lines.push(l.none, "");
  lines.push(`## ${l.objectives}`, "");
  lines.push(
    ...list(Object.entries(report.qa_objectives).map(([k, n]) => `${term("qa_objective", k)} (\`${k}\`): ${n}`)),
    "",
  );
  lines.push(`## ${l.summary}`, "", "| | |", "|---|--:|");
  for (const k of Object.keys(l.count) as Array<keyof Labels["count"]>)
    lines.push(`| ${l.count[k]} | ${report.summary[k]} |`);
  lines.push("", `## ${l.results}`, "");
  if (report.results.length === 0) lines.push(l.none, "");
  for (const r of report.results) {
    lines.push(
      `### ${r.display_key}: ${r.title}`,
      "",
      `- ${l.result.scenario}: \`${r.scenario_id}\` v${r.version}`,
      `- ${l.result.objective}: ${term("qa_objective", r.qa_objective)}`,
      `- ${l.result.outcome}: ${term("case_outcome", r.outcome)} (\`${r.outcome}\`)`,
      `- ${l.result.reported}: ${r.label}`,
      `- ${l.result.run}: \`${r.run_id}\` (${r.run_kind}, ${term("run_state", r.run_state)})${r.baseline_changed ? `, ${l.baselineChanged}` : ""}`,
      `- ${l.result.environment}: ${environmentText(r.environment, l.declared)}`,
      `- ${l.result.baseline}: ${r.packages.map((p) => `\`${p.package_id}\` ${p.package_version}`).join(", ")}; ${JSON.stringify(r.revision)}`,
      `- ${l.result.evidence}: ${r.evidence.length === 0 ? l.none : r.evidence.map((e) => `\`${e.ref}\`${e.sha256 ? ` (${e.sha256})` : ""}`).join(", ")}`,
      `- ${l.result.time}: ${r.started_at ?? "?"} / ${r.finished_at ?? "?"}`,
      `- ${l.result.defects}: ${r.defect_ids.length === 0 ? l.none : r.defect_ids.map((d) => `\`${d}\``).join(", ")}`,
      "",
    );
  }
  lines.push(`## ${l.defects}`, "");
  lines.push(
    ...list(
      report.defects.map((d) => {
        const doc = d as {
          defect_id: string;
          title: { value: string };
          state: string;
          severity: string;
          priority: string;
          links: { scenario_id: string; run_id: string; step_id: string };
        };
        return `\`${doc.defect_id}\` ${doc.title.value}: ${term("defect_state", doc.state)}, ${term("severity", doc.severity)}, ${term("priority", doc.priority)}; \`${doc.links.scenario_id}\` ${doc.links.step_id}, \`${doc.links.run_id}\``;
      }),
    ),
    "",
  );
  lines.push(`## ${l.coverage}`, "");
  if (report.coverage.length === 0) lines.push(l.none, "");
  for (const c of report.coverage) {
    const r = c.report as {
      scope_statement: string;
      workflows: { designed: { covered: number; of: number }; approved: { covered: number; of: number } };
      rules: { approved: { covered: number; of: number } };
      role_permissions: { approved: { covered: number; of: number } };
      pages: { approved: { covered: number; of: number } };
      execution: { executed: number; of: number };
    };
    lines.push(
      `### \`${c.plan_id}\``,
      "",
      r.scope_statement,
      "",
      `- workflows: ${ratio(r.workflows.approved)} (designed ${ratio(r.workflows.designed)})`,
      `- rules: ${ratio(r.rules.approved)}`,
      `- role_permissions: ${ratio(r.role_permissions.approved)}`,
      `- pages: ${ratio(r.pages.approved)}`,
      `- execution: ${r.execution.executed}/${r.execution.of}`,
      "",
    );
  }
  lines.push(`## ${l.limitations}`, "");
  lines.push(`### ${l.analysis}`, "", ...list(report.limitations.analysis), "");
  lines.push(`### ${l.cannot}`, "", ...list(report.limitations.cannot_establish), "");
  lines.push(`### ${l.assumptions}`, "", ...list(report.limitations.unresolved_assumptions), "");
  lines.push(`### ${l.gaps}`, "", ...list(report.limitations.coverage_gaps), "");
  lines.push(`### ${l.unsupported}`, "", ...list(report.limitations.unsupported_operations), "");
  return `${lines.join("\n").trimEnd()}\n`;
}
