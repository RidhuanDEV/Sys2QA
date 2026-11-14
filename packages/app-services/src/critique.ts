import { createHash } from "node:crypto";
import { validateScenario } from "@sys2qa/contract";
import { appendAudit } from "@sys2qa/platform";
import { critiqueScenarios, type Scenario } from "@sys2qa/qaa-core";
import { planContext, storedConditions } from "./conditions.js";
import { serviceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

interface LatestRow {
  scenario_id: string;
  version: number;
  status: string;
  doc_json: string;
}

function latest(host: Host, projectId: string): LatestRow[] {
  return host.state.db
    .prepare(
      `SELECT v.scenario_id, v.version, v.status, v.doc_json FROM scenarios s
       JOIN scenario_versions v ON v.scenario_id = s.scenario_id AND v.version = s.latest_version
       WHERE s.project_id = ? ORDER BY s.display_key`,
    )
    .all(projectId) as LatestRow[];
}

/** Approved versions of the project's scenarios (any version, since a later draft may follow an approved one). */
function approved(host: Host, projectId: string): Scenario[] {
  return (
    host.state.db
      .prepare(
        `SELECT v.doc_json FROM scenario_versions v JOIN scenarios s ON s.scenario_id = v.scenario_id
         WHERE s.project_id = ? AND v.status = 'approved'`,
      )
      .all(projectId) as Array<{ doc_json: string }>
  ).map((r) => JSON.parse(r.doc_json) as Scenario);
}

const scenariosCritique = defineOperation<{ plan_id: string }, unknown>({
  name: "scenarios.critique",
  title: "Critique scenarios",
  description:
    "Checks a plan's unapproved scenarios against the test-case quality checklist (PRD §15.13), finds duplicates with the reason (QAA-FR-035, also against approved scenarios), records every conflict between sources with all its sides (QAA-FR-016), and sets each scenario to `pending_review` or to `needs_clarification` with the reason (QAA-FR-034).",
  level: "none",
  effect: "write",
  input: { type: "object", additionalProperties: false, required: ["plan_id"], properties: { plan_id: ID } },
  run: ({ host, caller }, input) => {
    const { projectId, plan, model } = planContext(host, input.plan_id);
    const conditionIds = new Set(storedConditions(host, plan.plan_id).map((c) => c.condition_id));
    const rows = latest(host, projectId).filter((r) => {
      const doc = JSON.parse(r.doc_json) as Scenario;
      return (
        ["draft", "needs_clarification", "pending_review"].includes(r.status) &&
        doc.test_condition_ids.some((id) => conditionIds.has(id)) &&
        doc.baseline.packages[0]?.package_id === plan.baseline.packages[0]?.package_id
      );
    });
    if (rows.length === 0)
      throw serviceError("NOT_FOUND", `plan ${plan.plan_id} has no scenarios to critique; generate them first`);
    const scenarios = rows.map((r) => JSON.parse(r.doc_json) as Scenario);
    const { critiques, duplicates, conflicts } = critiqueScenarios({
      scenarios,
      approved: approved(host, projectId),
      model,
    });
    const byId = new Map(scenarios.map((s) => [s.scenario_id, s]));
    host.state.transaction(() => {
      const at = host.now().toISOString();
      const remove = host.state.db.prepare(
        "DELETE FROM qa_findings WHERE project_id = ? AND kind = ? AND subject_id = ?",
      );
      const insert = host.state.db.prepare(
        "INSERT INTO qa_findings (id, project_id, kind, subject_id, version, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const c of critiques) {
        const doc = byId.get(c.scenario_id)!;
        const updated: Scenario = {
          ...doc,
          status: c.status as Scenario["status"],
          ...(c.status_reason ? { status_reason: c.status_reason } : {}),
        };
        if (!c.status_reason) delete (updated as { status_reason?: string }).status_reason;
        const check = validateScenario(updated);
        // A scenario the contract refuses for review stays a clarification, never a broken review item (CR-050–054).
        const final = check.ok
          ? updated
          : {
              ...updated,
              status: "needs_clarification" as const,
              status_reason: check.issues.map((i) => i.code).join(", "),
            };
        const json = JSON.stringify(final);
        host.state.db
          .prepare(
            "UPDATE scenario_versions SET doc_json = ?, status = ?, content_sha256 = ?, updated_at = ? WHERE scenario_id = ? AND version = ?",
          )
          .run(json, final.status, sha256(json), at, c.scenario_id, c.version);
        for (const kind of ["checklist", "duplicate"]) remove.run(projectId, kind, c.scenario_id);
        insert.run(
          host.newId("finding"),
          projectId,
          "checklist",
          c.scenario_id,
          c.version,
          JSON.stringify(c.checks),
          at,
          at,
        );
      }
      for (const d of duplicates)
        insert.run(
          host.newId("finding"),
          projectId,
          "duplicate",
          d.scenario_id,
          byId.get(d.scenario_id)?.version ?? null,
          JSON.stringify(d),
          at,
          at,
        );
      for (const c of conflicts) {
        remove.run(projectId, "conflict", c.conflict_id);
        insert.run(host.newId("finding"), projectId, "conflict", c.conflict_id, null, JSON.stringify(c), at, at);
      }
      appendAudit(
        host.state.db,
        {
          projectId,
          actor: caller.actor,
          action: "scenarios.critiqued",
          target: plan.plan_id,
          details: { checked: critiques.length, duplicates: duplicates.length, conflicts: conflicts.length },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    const statuses: Record<string, number> = {};
    for (const r of rows) {
      const s = host.state.db
        .prepare("SELECT status FROM scenario_versions WHERE scenario_id = ? AND version = ?")
        .get(r.scenario_id, r.version) as {
        status: string;
      };
      statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    }
    const failedChecks: Record<string, number> = {};
    for (const c of critiques)
      for (const k of c.checks.filter((x) => !x.passed)) failedChecks[k.check] = (failedChecks[k.check] ?? 0) + 1;
    return {
      plan_id: plan.plan_id,
      checked: critiques.length,
      by_status: statuses,
      failed_checks: failedChecks,
      duplicates,
      conflicts,
      critiques,
    };
  },
});

const findingsList = defineOperation<{ project_id: string; kind?: "checklist" | "duplicate" | "conflict" }, unknown>({
  name: "findings.list",
  title: "List critic findings",
  description: "The critic's findings for a project: checklist results, duplicates and conflict records.",
  level: "none",
  effect: "read",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id"],
    properties: { project_id: ID, kind: { enum: ["checklist", "duplicate", "conflict"] } },
  },
  run: ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const rows = host.state.db
      .prepare(
        `SELECT kind, subject_id, version, doc_json FROM qa_findings WHERE project_id = ?${input.kind ? " AND kind = ?" : ""} ORDER BY kind, subject_id`,
      )
      .all(...(input.kind ? [project.id, input.kind] : [project.id])) as Array<{
      kind: string;
      subject_id: string;
      version: number | null;
      doc_json: string;
    }>;
    return {
      project_id: project.id,
      findings: rows.map((r) => ({
        kind: r.kind,
        subject_id: r.subject_id,
        version: r.version,
        detail: JSON.parse(r.doc_json) as unknown,
      })),
    };
  },
});

export const CRITIQUE_OPERATIONS = [scenariosCritique, findingsList];
