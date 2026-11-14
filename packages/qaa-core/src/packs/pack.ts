import type { Scenario } from "../scenarios/generator.js";

/** Placeholder the tester replaces with the environment they tested in; an import refuses it (QAA-FR-112). */
export const DECLARED_ENVIRONMENT_PLACEHOLDER = "REPLACE with the environment you tested in";

export interface ManualPackCase {
  scenario: Scenario;
  approval_id: string;
}

export interface ManualPack {
  contract: "sys2qa.manual-test-pack";
  schema_version: "1.0.0";
  pack_id: string;
  created_at: string;
  content_language: string;
  glossary_version: string;
  scenarios: Scenario[];
  approval_ids: string[];
  result_template: {
    schema: "https://sys2qa.dev/schemas/run-result/1.0.json";
    instructions: { language: string; value: string };
  };
}

const LABELS = {
  en: {
    title: "Manual test pack",
    intro:
      "Approved scenarios to run by hand in any environment you can use. Record each step in result-template.json: status pass, fail, blocked or not_applicable (only for a step without an expected result), the actual result (required for fail), notes (the reason, required for blocked) and evidence file names. Fill in the environment you tested in, then import the file back. Results are tester-reported.",
    instructions:
      "Replace the declared environment name (and URL and version, if known). For each step set status to pass, fail, blocked or not_applicable, add actual (required for fail) and notes (required for blocked), and set each case outcome: failed if a step failed, blocked if a step was blocked, otherwise passed. Leave steps you did not run as not_run and set state to abandoned with a reason on each case.",
    pack: "Pack",
    created: "Created",
    glossary: "Glossary",
    scenario: "Scenario",
    version: "version",
    approval: "approval",
    objective: "QA objective",
    priority: "Priority",
    risk: "Risk",
    stateChanging: "This scenario changes data in the environment; clean up as described.",
    preconditions: "Preconditions",
    testData: "Test data",
    secret: "secret: use your own test account",
    steps: "Steps",
    step: "Step",
    instruction: "Do",
    expected: "Expected",
    basis: "basis",
    oracle: "oracle",
    noExpected: "no expected result of its own",
    status: "Status (pass / fail / blocked / not_applicable)",
    actual: "Actual result",
    cleanup: "Cleanup",
    traceTo: "Rests on",
  },
  id: {
    title: "Paket uji manual",
    intro:
      "Skenario yang sudah disetujui untuk dijalankan secara manual di environment mana pun yang dapat Anda gunakan. Catat setiap langkah di result-template.json: status pass, fail, blocked atau not_applicable (hanya untuk langkah tanpa hasil yang diharapkan), hasil aktual (wajib untuk fail), catatan (alasan, wajib untuk blocked) dan nama file bukti. Isi environment tempat Anda menguji, lalu impor kembali file tersebut. Hasil dilaporkan oleh penguji (tester-reported).",
    instructions:
      "Ganti nama environment yang dideklarasikan (serta URL dan versi, jika diketahui). Untuk setiap langkah isi status pass, fail, blocked atau not_applicable, tambahkan actual (wajib untuk fail) dan notes (wajib untuk blocked), lalu isi outcome setiap kasus: failed jika ada langkah gagal, blocked jika ada langkah terblokir, selain itu passed. Biarkan langkah yang tidak dijalankan sebagai not_run dan ubah state menjadi abandoned dengan alasan pada setiap kasus.",
    pack: "Paket",
    created: "Dibuat",
    glossary: "Glosarium",
    scenario: "Skenario",
    version: "versi",
    approval: "approval",
    objective: "Tujuan QA",
    priority: "Prioritas",
    risk: "Risiko",
    stateChanging: "Skenario ini mengubah data di environment; lakukan pembersihan sesuai uraian.",
    preconditions: "Prasyarat",
    testData: "Data uji",
    secret: "rahasia: gunakan akun uji Anda sendiri",
    steps: "Langkah",
    step: "Langkah",
    instruction: "Lakukan",
    expected: "Diharapkan",
    basis: "dasar",
    oracle: "oracle",
    noExpected: "tidak memiliki hasil yang diharapkan sendiri",
    status: "Status (pass / fail / blocked / not_applicable)",
    actual: "Hasil aktual",
    cleanup: "Pembersihan",
    traceTo: "Berdasarkan",
  },
} as const;

type Labels = (typeof LABELS)[keyof typeof LABELS];
/** Labels in the pack's language; English when no labels exist for it (fallback, LOC-008). */
export const packLabels = (language: string): Labels =>
  (LABELS as Record<string, Labels>)[language.split("-")[0]!] ?? LABELS.en;

/** Instructions of the result template in the pack's language. */
export function resultInstructions(language: string): { language: string; value: string } {
  const own = (LABELS as Record<string, Labels>)[language.split("-")[0]!];
  return { language: own ? language : "en", value: (own ?? LABELS.en).instructions };
}

/**
 * The `run-result` skeleton a tester fills in (QAA-FR-112): the pack's run ID, every case with its approval and every
 * step `not_run`, and a declared environment to replace.
 */
export function resultTemplate(input: {
  runId: string;
  createdAt: string;
  language: string;
  cases: ManualPackCase[];
}): Record<string, unknown> {
  return {
    schema_version: "1.0.0",
    run_id: input.runId,
    kind: "manual",
    state: "completed",
    environment: { declared: { name: DECLARED_ENVIRONMENT_PLACEHOLDER } },
    baseline: input.cases[0]!.scenario.baseline,
    started_at: input.createdAt,
    locale: input.language,
    cases: input.cases.map(({ scenario, approval_id }) => ({
      scenario_id: scenario.scenario_id,
      version: scenario.version,
      approval_id,
      outcome: "not_run",
      reported_by: "tester",
      steps: scenario.steps.map((step) => ({
        step_id: step.step_id,
        status: "not_run",
        ...(step.expected_result ? { expected: step.expected_result.description.value } : {}),
      })),
    })),
  };
}

/** Glossary terms a pack shows (labels of controlled values, LOC-009); codes are shown when a term is missing. */
export type Terms = Partial<Record<string, Record<string, string>>>;

/** The pack as a Markdown document a tester can follow without Sys2QA (identifiers and numbers unchanged, LOC-006). */
export function renderManualPack(pack: ManualPack, approvals: Map<string, string>, terms: Terms = {}): string {
  const l = packLabels(pack.content_language);
  const term = (group: string, code: string) => terms[group]?.[code] ?? code.replaceAll("_", " ");
  const lines = [
    `# ${l.title}`,
    "",
    `${l.pack}: \`${pack.pack_id}\` · ${l.created}: ${pack.created_at} · ${l.glossary}: ${pack.content_language}@${pack.glossary_version}`,
    "",
    l.intro,
    "",
  ];
  for (const s of pack.scenarios) {
    lines.push(
      `## ${s.display_key}: ${s.title.value}`,
      "",
      `${l.scenario} \`${s.scenario_id}\`, ${l.version} ${s.version}, ${l.approval} \`${approvals.get(s.scenario_id) ?? "?"}\``,
      "",
      `- ${l.objective}: ${term("qa_objective", s.qa_objective)}`,
      `- ${l.priority}: ${term("priority", s.priority)}; ${l.risk}: ${s.risk.score} (${s.risk.impact} × ${s.risk.likelihood})`,
      "",
    );
    if (s.state_changing) lines.push(`> ${l.stateChanging}`, "");
    if (s.preconditions.length > 0)
      lines.push(`### ${l.preconditions}`, "", ...s.preconditions.map((p) => `- ${p.text.value}`), "");
    if (s.test_data.length > 0)
      lines.push(
        `### ${l.testData}`,
        "",
        ...s.test_data.map((d) =>
          d.sensitivity === "secret" ? `- ${d.name}: (${l.secret})` : `- ${d.name}: \`${d.value_ref}\``,
        ),
        "",
      );
    lines.push(`### ${l.steps}`, "");
    for (const step of s.steps) {
      lines.push(`#### ${l.step} ${step.step_id}`, "", `- ${l.instruction}: ${step.instruction.value}`);
      if (step.expected_result) {
        const e = step.expected_result;
        lines.push(
          `- ${l.expected}: ${e.description.value} (${l.basis}: ${term("expected_result_basis", e.basis)}; ${l.oracle}: ${term("oracle_class", e.oracle_class)})`,
        );
        if (e.trace.saa_ids.length > 0)
          lines.push(`- ${l.traceTo}: ${e.trace.saa_ids.map((id) => `\`${id}\``).join(", ")}`);
      } else lines.push(`- ${l.expected}: ${l.noExpected}`);
      lines.push(`- ${l.status}: ______`, `- ${l.actual}: ______`, "");
    }
    if (s.cleanup.length > 0) lines.push(`### ${l.cleanup}`, "", ...s.cleanup.map((c) => `- ${c.value}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
