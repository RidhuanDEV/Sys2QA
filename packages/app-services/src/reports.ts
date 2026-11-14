import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validateDocument, validateScenario } from "@sys2qa/contract";
import { appendAudit, localIdPart, projectDirectory } from "@sys2qa/platform";
import { renderReportMarkdown, type QaReport, type ReportResult, type Scenario } from "@sys2qa/qaa-core";
import { storedConditions } from "./conditions.js";
import { planCoverage } from "./coverage.js";
import { defectIdsOf } from "./defects.js";
import { serviceError, ServiceError, SERVICE_ERRORS } from "./errors.js";
import type { Host } from "./host.js";
import { manualRunResult } from "./manual-runs.js";
import { defineOperation } from "./operations.js";
import { packageRow, revalidated } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const OUTCOMES = ["passed", "failed", "blocked", "inconclusive", "not_run"] as const;

interface CaseRow {
  run_id: string;
  scenario_id: string;
  version: number;
  doc_json: string;
  kind: "manual" | "automated";
  state: string;
  environment_json: string;
  baseline_json: string;
  baseline_changed: number;
  started_at: string | null;
  finished_at: string | null;
}

const insideAny = (path: string, roots: string[]) =>
  roots.some((root) => {
    const r = relative(resolve(root), resolve(path));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  });

/** Assembles the QA report of a project or one plan (QAA-FR-090–093, SYS-004, QAA-FR-111). */
export function buildReport(host: Host, input: { project_id: string; plan_id?: string; language?: string }): QaReport {
  const project = host.projects.getProject(input.project_id);
  const plans = (
    host.state.db
      .prepare("SELECT id FROM test_plans WHERE project_id = ? ORDER BY created_at, id")
      .all(project.id) as Array<{
      id: string;
    }>
  ).map((r) => r.id);
  if (input.plan_id && !plans.includes(input.plan_id))
    throw serviceError("NOT_FOUND", `no test plan ${input.plan_id} in this project`);
  const inPlans = input.plan_id ? [input.plan_id] : plans;

  // Scenarios in scope: those of the plan, or every scenario of the project.
  let scenarios = (
    host.state.db
      .prepare(
        `SELECT v.doc_json FROM scenarios s JOIN scenario_versions v ON v.scenario_id = s.scenario_id AND v.version = s.latest_version
         WHERE s.project_id = ? ORDER BY s.display_key`,
      )
      .all(project.id) as Array<{ doc_json: string }>
  ).map((r) => JSON.parse(r.doc_json) as Scenario);
  if (input.plan_id) {
    const conditions = new Set(storedConditions(host, input.plan_id).map((c) => c.condition_id));
    scenarios = scenarios.filter((s) => s.test_condition_ids.some((id) => conditions.has(id)));
  }
  const inScope = new Set(scenarios.map((s) => s.scenario_id));
  const byId = new Map(scenarios.map((s) => [s.scenario_id, s]));
  const approvedIds = new Set(
    (
      host.state.db
        .prepare(
          `SELECT DISTINCT a.scenario_id FROM approvals a JOIN scenarios s ON s.scenario_id = a.scenario_id
           WHERE s.project_id = ? AND a.state = 'active'`,
        )
        .all(project.id) as Array<{ scenario_id: string }>
    ).map((r) => r.scenario_id),
  );

  // Every recorded case result of a finished run, oldest first.
  const cases = (
    host.state.db
      .prepare(
        `SELECT c.run_id, c.scenario_id, c.version, c.doc_json, r.kind, r.state, r.environment_json, r.baseline_json,
                r.baseline_changed, r.started_at, r.finished_at
         FROM case_results c JOIN runs r ON r.id = c.run_id
         WHERE c.project_id = ? AND NOT EXISTS (SELECT 1 FROM case_results n WHERE n.supersedes = c.id)
         ORDER BY COALESCE(r.finished_at, r.started_at), c.run_id`,
      )
      .all(project.id) as CaseRow[]
  ).filter((c) => inScope.has(c.scenario_id));
  const attachments = new Map(
    (
      host.state.db
        .prepare("SELECT id, sha256, media_type FROM run_attachments WHERE project_id = ?")
        .all(project.id) as Array<{
        id: string;
        sha256: string;
        media_type: string;
      }>
    ).map((a) => [a.id, a]),
  );
  const defectsByRun = new Map<string, Map<string, string[]>>();
  const results: ReportResult[] = cases.map((c) => {
    const doc = JSON.parse(c.doc_json) as {
      outcome: string;
      reported_by: "tester" | "executor";
      steps: Array<{ evidence_refs?: string[] }>;
    };
    const baseline = JSON.parse(c.baseline_json) as {
      packages: Array<{ package_id: string; package_version: number }>;
      revision: unknown;
    };
    const scenario = byId.get(c.scenario_id)!;
    if (!defectsByRun.has(c.run_id)) defectsByRun.set(c.run_id, defectIdsOf(host, c.run_id));
    const refs = [...new Set(doc.steps.flatMap((s) => s.evidence_refs ?? []))];
    return {
      scenario_id: c.scenario_id,
      version: c.version,
      display_key: scenario.display_key,
      title: scenario.title.value,
      qa_objective: scenario.qa_objective,
      run_id: c.run_id,
      run_kind: c.kind,
      run_state: c.state,
      reported_by: doc.reported_by,
      label: doc.reported_by === "tester" ? "tester-reported" : "executor-reported",
      outcome: doc.outcome,
      environment: JSON.parse(c.environment_json) as unknown,
      packages: baseline.packages,
      revision: baseline.revision,
      evidence: refs.map((ref) => {
        const a = attachments.get(ref);
        return { ref, sha256: a?.sha256 ?? null, media_type: a?.media_type ?? null };
      }),
      started_at: c.started_at,
      finished_at: c.finished_at,
      defect_ids: defectsByRun.get(c.run_id)!.get(c.scenario_id) ?? [],
      baseline_changed: c.baseline_changed === 1,
    };
  });

  // Counts (QAA-FR-090): the latest result per executed scenario decides its outcome.
  const latest = new Map<string, string>();
  for (const r of results) latest.set(r.scenario_id, r.outcome);
  const summary = {
    proposed: scenarios.length,
    approved: scenarios.filter((s) => approvedIds.has(s.scenario_id)).length,
    executed: latest.size,
    ...(Object.fromEntries(OUTCOMES.map((o) => [o, [...latest.values()].filter((v) => v === o).length])) as Record<
      (typeof OUTCOMES)[number],
      number
    >),
  };

  // Evidence profiles and analysis limitations of every package the scenarios rest on (SYS-004).
  const packages = new Map<string, { package_id: string; package_version: number }>();
  for (const s of scenarios)
    for (const p of s.baseline.packages) packages.set(`${p.package_id}@${p.package_version}`, p);
  for (const planId of inPlans) {
    const plan = JSON.parse(
      (host.state.db.prepare("SELECT doc_json FROM test_plans WHERE id = ?").get(planId) as { doc_json: string })
        .doc_json,
    ) as { baseline: { packages: Array<{ package_id: string; package_version: number }> } };
    for (const p of plan.baseline.packages) packages.set(`${p.package_id}@${p.package_version}`, p);
  }
  const analysisLimits: string[] = [];
  const evidenceProfiles = [...packages.values()]
    .sort((a, b) => `${a.package_id}@${a.package_version}`.localeCompare(`${b.package_id}@${b.package_version}`))
    .map((p) => {
      const provenance = revalidated(packageRow(host, project.id, p.package_id, p.package_version)).provenance;
      const analysis = (provenance.analysis ?? {}) as { status?: string; limitations?: unknown[] };
      if (analysis.status && analysis.status !== "completed")
        analysisLimits.push(`${p.package_id} ${p.package_version}: analysis ${analysis.status}`);
      for (const limit of analysis.limitations ?? [])
        analysisLimits.push(
          `${p.package_id} ${p.package_version}: ${typeof limit === "string" ? limit : JSON.stringify(limit)}`,
        );
      for (const [category, value] of Object.entries((provenance.coverage_summary ?? {}) as Record<string, string>))
        if (value !== "complete")
          analysisLimits.push(`${p.package_id} ${p.package_version}: ${category} coverage ${value}`);
      return { ...p, profile: provenance.evidence_profile };
    });
  const cannotEstablish = [
    ...new Set(evidenceProfiles.flatMap((p) => (p.profile?.cannot_establish as string[] | undefined) ?? [])),
  ];

  const coverage = inPlans.map((planId) => {
    const c = planCoverage(host, planId);
    return { plan_id: c.plan_id, report: c.coverage as unknown as Record<string, unknown> };
  });
  const coverageGaps = coverage.flatMap(({ plan_id, report }) => {
    const r = report as {
      workflows: { uncovered: string[] };
      rules: { uncovered: string[] };
      role_permissions: { uncovered: Array<{ role: string; step: string }> };
      pages: { uncovered: string[] };
    };
    return [
      ...r.workflows.uncovered.map((w) => `${plan_id}: workflow ${w} has no approved scenario`),
      ...r.rules.uncovered.map((w) => `${plan_id}: rule ${w} lacks an approved scenario for a technique`),
      ...r.role_permissions.uncovered.map(
        (p) => `${plan_id}: ${p.role} on ${p.step} lacks an approved allowed or denied case`,
      ),
      ...r.pages.uncovered.map((p) => `${plan_id}: page ${p} has no approved scenario`),
    ];
  });
  const conflicts = (
    host.state.db
      .prepare("SELECT doc_json FROM qa_findings WHERE project_id = ? AND kind = 'conflict'")
      .all(project.id) as Array<{
      doc_json: string;
    }>
  )
    .map(
      (r) =>
        JSON.parse(r.doc_json) as { conflict_id: string; description: string; status: string; scenario_ids: string[] },
    )
    .filter((c) => c.status === "open" && c.scenario_ids.some((id) => inScope.has(id)));
  const assumptions = [
    ...scenarios
      .filter((s) => s.status === "needs_clarification")
      .map((s) => `${s.display_key} needs clarification: ${s.status_reason ?? "no reason recorded"}`),
    ...scenarios.flatMap((s) => s.assumptions.map((a) => `${s.display_key}: ${a.value}`)),
    ...conflicts.map((c) => `${c.conflict_id}: ${c.description}`),
  ];
  const manualOnly = scenarios.filter((s) => s.execution_classification === "manual_only").length;
  const unsupported = [
    ...(manualOnly > 0
      ? [`automated execution: ${manualOnly} scenario(s) are manual_only (no automation steps are defined for them)`]
      : []),
    ...evidenceProfiles.flatMap((p) =>
      ["runtime_observation", "source_analysis", "documentation_import"]
        .filter((k) => p.profile?.[k] === "unavailable")
        .map((k) => `${p.package_id} ${p.package_version}: ${k} unavailable`),
    ),
  ];

  const language = input.language ?? scenarios[0]?.content_language ?? project.default_languages[0] ?? "en";
  const glossary = host.glossary.get(language) ?? host.glossary.get("en")!;
  const runIds = [...new Set(results.map((r) => r.run_id))];
  const defects = (
    host.state.db
      .prepare("SELECT doc_json FROM defects WHERE project_id = ? ORDER BY created_at, id")
      .all(project.id) as Array<{
      doc_json: string;
    }>
  )
    .map((r) => JSON.parse(r.doc_json) as Record<string, unknown> & { links: { scenario_id: string } })
    .filter((d) => inScope.has(d.links.scenario_id));
  const objectives: Record<string, number> = {};
  for (const s of scenarios) objectives[s.qa_objective] = (objectives[s.qa_objective] ?? 0) + 1;

  return {
    report_id: host.newId("report"),
    kind: "qa_report",
    schema_version: "1.0.0",
    generated_at: host
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    language,
    glossary: `${language === glossary.locale ? language : "en"}@${glossary.version}`,
    project: { id: project.id, name: project.name },
    scope: { plan_id: input.plan_id ?? null, scenarios: scenarios.length },
    evidence_profiles: evidenceProfiles,
    qa_objectives: objectives,
    summary,
    results,
    defects,
    coverage,
    limitations: {
      analysis: analysisLimits,
      cannot_establish: cannotEstablish,
      unresolved_assumptions: assumptions,
      coverage_gaps: coverageGaps,
      unsupported_operations: unsupported,
    },
    documents: { scenarios, runs: runIds.map((id) => manualRunResult(host, id)) },
  };
}

/** Every contract document a report embeds validates against its schema (QAA-FR-093). */
function contractIssues(report: QaReport): string[] {
  const issues: string[] = [];
  for (const s of report.documents.scenarios as Scenario[]) {
    const r = ["pending_review", "approved"].includes(s.status) ? validateScenario(s) : validateDocument("scenario", s);
    issues.push(...r.issues.filter((i) => i.severity === "error").map((i) => `${s.scenario_id}: ${i.code}`));
  }
  for (const run of report.documents.runs as Array<{ run_id: string }>)
    issues.push(...validateDocument("run-result", run).issues.map((i) => `${run.run_id}: ${i.message}`));
  for (const d of report.defects as Array<{ defect_id: string }>)
    issues.push(...validateDocument("defect", d).issues.map((i) => `${d.defect_id}: ${i.message}`));
  return issues;
}

const reportsGenerate = defineOperation<
  { project_id: string; plan_id?: string; language?: string; output_dir?: string },
  unknown
>({
  name: "reports.generate",
  title: "Generate a QA report",
  description:
    "Writes the QA report of a project or one plan as `report.json` and `report.md` (QAA-FR-090–093), in English or Indonesian: the evidence profile of every package and what it cannot establish (SYS-004); the QA objectives (QAA-FR-111); counts of proposed, approved, executed, passed, failed, blocked, inconclusive and not-run scenarios that reconcile with the stored records; every result with its scenario version, run, environment, package version, revision, evidence, timestamps, defects and whether it is tester-reported; the defects; coverage relative to the model; and the limitations, unresolved assumptions, coverage gaps and unsupported operations, each section present even when empty. The scenarios, run results and defects are embedded as contract documents, which validate. Evidence a report names is kept from retention.",
  level: "none",
  effect: "write",
  paths: (input) => (input.output_dir ? [input.output_dir] : []),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id"],
    properties: {
      project_id: ID,
      plan_id: ID,
      language: { enum: ["en", "id"] },
      output_dir: { type: "string", minLength: 1, maxLength: 4096 },
    },
  },
  run: ({ host, caller }, input) => {
    if (input.output_dir !== undefined && !isAbsolute(input.output_dir))
      throw serviceError("INPUT_INVALID", "the output directory must be absolute", { field: "output_dir" });
    const project = host.projects.getProject(input.project_id);
    const roots = host.projects
      .listEvidenceSources(project.id)
      .filter((s) => s.kind === "source_root")
      .map((s) => s.ref);
    if (input.output_dir && insideAny(input.output_dir, roots))
      throw new ServiceError(
        "EXPORT_REFUSED",
        "conflict",
        "a report is never written into an analyzed repository",
        SERVICE_ERRORS.EXPORT_REFUSED!.remediation,
        { reason: "inside_analyzed_repository" },
      );
    const report = buildReport(host, input);
    const issues = contractIssues(report);
    if (issues.length > 0)
      throw new ServiceError(
        "INTERNAL_ERROR",
        "internal",
        "a document the report embeds does not match its contract",
        "Report it with the listed issues.",
        { issues: issues.slice(0, 20) },
      );
    const dir = join(
      input.output_dir ?? join(projectDirectory(host.home, project.id), "reports"),
      localIdPart(report.report_id),
    );
    if (existsSync(dir)) throw serviceError("CONFLICT", `${dir} already exists`);
    mkdirSync(dir, { recursive: true });
    const glossary = host.glossary.get(report.language) ?? host.glossary.get("en")!;
    const terms = (glossary as { terms?: Record<string, Record<string, string>> }).terms ?? {};
    writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(dir, "report.md"), renderReportMarkdown(report, terms));
    const hashes = [
      ...new Set(
        report.results.flatMap((r) => r.evidence.flatMap((e) => (e.sha256 ? [e.sha256.replace(/^sha256:/, "")] : []))),
      ),
    ];
    const at = host.now().toISOString();
    host.state.transaction(() => {
      const pin = host.state.db.prepare(
        "INSERT OR IGNORE INTO blob_pins (project_id, sha256, reason, created_at, updated_at) VALUES (?, ?, 'export', ?, ?)",
      );
      for (const h of hashes) pin.run(project.id, h, at, at);
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "report.generated",
          target: report.report_id,
          details: {
            plan_id: input.plan_id ?? null,
            language: report.language,
            summary: report.summary,
            pinned_blobs: hashes.length,
          },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return {
      report_id: report.report_id,
      path: dir,
      files: ["report.json", "report.md"],
      language: report.language,
      summary: report.summary,
    };
  },
});

export const REPORT_OPERATIONS = [reportsGenerate];
