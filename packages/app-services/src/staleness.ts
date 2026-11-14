import { createHash } from "node:crypto";
import { validateDocument } from "@sys2qa/contract";
import { appendAudit } from "@sys2qa/platform";
import {
  baselineRevision,
  diffPackages,
  packageModel,
  staleness,
  type PackageDiff,
  type Scenario,
  type StalenessDecision,
} from "@sys2qa/qaa-core";
import { serviceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";
import { packageRow, revalidated } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const PACKAGE_ID = { type: "string", pattern: "^pkg:[a-z0-9][a-z0-9._-]{0,127}$" } as const;
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

interface Latest {
  scenario_id: string;
  version: number;
  status: string;
  doc_json: string;
}

const linksOf = (s: Scenario) => [s.feature_ref, ...s.steps.flatMap((st) => st.expected_result?.trace.saa_ids ?? [])];

/** The diff from one stored version of a package to another, or null when either cannot be read (§13.11 "no diff"). */
function diffBetween(host: Host, projectId: string, packageId: string, from: number, to: number): PackageDiff | null {
  try {
    const base = revalidated(packageRow(host, projectId, packageId, from));
    const target = revalidated(packageRow(host, projectId, packageId, to));
    const baseModel = packageModel(base);
    const targetModel = packageModel(target);
    if (!baseModel || !targetModel) return null;
    const report = target.artifacts.find((a) => a.role === "diff_report");
    const parsed = report
      ? (JSON.parse(new TextDecoder().decode(target.files.get(report.path)!)) as Parameters<typeof diffPackages>[2])
      : undefined;
    return diffPackages(baseModel, targetModel, parsed, from);
  } catch {
    return null;
  }
}

/**
 * Propagates a new package version to the project's scenarios and approvals (PRD §13.11, QAA-FR-046/047): each
 * scenario still on an older version of the package gets the freshness its linked records decide, and its active
 * approvals are suspended or invalidated. Prior results and documents are never changed; an approved document keeps
 * its content and only its stored freshness changes.
 */
export function propagateNewPackage(host: Host, projectId: string, packageId: string, version: number, actor: string) {
  const rows = host.state.db
    .prepare(
      `SELECT v.scenario_id, v.version, v.status, v.doc_json FROM scenarios s
       JOIN scenario_versions v ON v.scenario_id = s.scenario_id AND v.version = s.latest_version
       WHERE s.project_id = ? AND v.status NOT IN ('rejected', 'superseded')`,
    )
    .all(projectId) as Latest[];
  const affected = rows
    .map((r) => ({ row: r, doc: JSON.parse(r.doc_json) as Scenario }))
    .filter(
      ({ doc }) =>
        doc.baseline.packages[0]?.package_id === packageId && doc.baseline.packages[0].package_version < version,
    );
  const diffs = new Map<number, PackageDiff | null>();
  const decisions: Array<{ scenario_id: string; version: number; decision: StalenessDecision }> = [];
  host.state.transaction(() => {
    const at = host.now().toISOString();
    for (const { row, doc } of affected) {
      const from = doc.baseline.packages[0]!.package_version;
      if (!diffs.has(from)) diffs.set(from, diffBetween(host, projectId, packageId, from, version));
      const decision = staleness(linksOf(doc), diffs.get(from)!);
      decisions.push({ scenario_id: row.scenario_id, version: row.version, decision });
      if (row.status === "approved")
        host.state.db
          .prepare("UPDATE scenario_versions SET freshness = ?, updated_at = ? WHERE scenario_id = ? AND version = ?")
          .run(decision.freshness, at, row.scenario_id, row.version);
      else {
        const json = JSON.stringify({ ...doc, freshness: decision.freshness });
        host.state.db
          .prepare(
            "UPDATE scenario_versions SET freshness = ?, doc_json = ?, content_sha256 = ?, updated_at = ? WHERE scenario_id = ? AND version = ?",
          )
          .run(decision.freshness, json, sha256(json), at, row.scenario_id, row.version);
      }
      const approvals = host.state.db
        .prepare("SELECT id FROM approvals WHERE scenario_id = ? AND state = 'active'")
        .all(row.scenario_id) as Array<{ id: string }>;
      for (const a of approvals) {
        host.state.db
          .prepare("UPDATE approvals SET state = ?, updated_at = ? WHERE id = ?")
          .run(decision.approval, at, a.id);
        appendAudit(
          host.state.db,
          {
            projectId,
            actor,
            action: decision.approval === "suspended" ? "approval.suspended" : "approval.invalidated",
            target: a.id,
            details: { scenario_id: row.scenario_id, package_id: packageId, version, reason: decision.reason },
          },
          { redactor: host.redactor, now: host.now },
        );
      }
    }
    appendAudit(
      host.state.db,
      {
        projectId,
        actor,
        action: "staleness.evaluated",
        target: `${packageId}@${version}`,
        details: {
          scenarios: decisions.length,
          current: decisions.filter((d) => d.decision.freshness === "current").length,
          potentially_stale: decisions.filter((d) => d.decision.freshness === "potentially_stale").length,
          stale: decisions.filter((d) => d.decision.freshness === "stale").length,
          diff: [...diffs.values()].every((d) => d !== null) ? "available" : "unavailable",
        },
      },
      { redactor: host.redactor, now: host.now },
    );
  });
  return {
    package_id: packageId,
    version,
    diff: diffs.size === 0 ? "not_needed" : [...diffs.values()].every((d) => d !== null) ? "available" : "unavailable",
    scenarios: decisions.map((d) => ({ scenario_id: d.scenario_id, version: d.version, ...d.decision })),
  };
}

/** After a new scope policy version, approvals bound to an older one are suspended (§13.11). */
export function suspendForScopeChange(
  host: Host,
  projectId: string,
  environmentId: string,
  scopePolicyVersion: number,
  actor: string,
): number {
  const rows = host.state.db
    .prepare(
      "SELECT id, binding_json FROM approvals WHERE state = 'active' AND json_extract(binding_json, '$.environment_id') = ?",
    )
    .all(environmentId) as Array<{ id: string; binding_json: string }>;
  let suspended = 0;
  for (const r of rows) {
    const bound = (JSON.parse(r.binding_json) as { scope_policy_version: number }).scope_policy_version;
    if (bound >= scopePolicyVersion) continue;
    host.state.db
      .prepare("UPDATE approvals SET state = 'suspended', updated_at = ? WHERE id = ?")
      .run(host.now().toISOString(), r.id);
    appendAudit(
      host.state.db,
      {
        projectId,
        actor,
        action: "approval.suspended",
        target: r.id,
        details: {
          environment_id: environmentId,
          bound_scope_policy_version: bound,
          scope_policy_version: scopePolicyVersion,
        },
      },
      { redactor: host.redactor, now: host.now },
    );
    suspended++;
  }
  return suspended;
}

const stalenessEvaluate = defineOperation<{ project_id: string; package_id: string; version: number }, unknown>({
  name: "staleness.evaluate",
  title: "Evaluate staleness",
  description:
    "Propagates a stored package version to the project's scenarios and approvals (PRD §13.11): unchanged links stay current with the approval suspended until revalidation, changed links make the scenario potentially stale and suspend its approval, removed or contradicted links make it stale and invalidate its approval, and without a diff every scenario becomes potentially stale. Runs by itself when a newer package version is imported or exported.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version"],
    properties: { project_id: ID, package_id: PACKAGE_ID, version: { type: "integer", minimum: 1 } },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    packageRow(host, project.id, input.package_id, input.version);
    return propagateNewPackage(host, project.id, input.package_id, input.version, caller.actor);
  },
});

const approvalsRevalidate = defineOperation<{ project_id: string; package_id: string; version: number }, unknown>({
  name: "approvals.revalidate",
  title: "Revalidate approvals for a new baseline",
  description:
    "The single human action of PRD §13.11: every approval suspended by a new package version whose scenario's linked records are unchanged is rebound to the new baseline — a new scenario version with the new baseline, approved, and a new approval record with the same environment, scope policy version, test-data profile and mode; the old ones are superseded. Audited. Scenarios with changed, removed or contradicted links are left for a person to re-approve or edit.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version"],
    properties: { project_id: ID, package_id: PACKAGE_ID, version: { type: "integer", minimum: 1 } },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    const target = revalidated(packageRow(host, project.id, input.package_id, input.version));
    const manifest = JSON.parse(new TextDecoder().decode(target.files.get("manifest.json")!)) as Record<
      string,
      unknown
    >;
    const newBaseline = {
      packages: [{ package_id: input.package_id, package_version: input.version }],
      revision: baselineRevision(manifest),
    };
    const suspended = host.state.db
      .prepare(
        `SELECT a.id, a.scenario_id, a.version, a.binding_json FROM approvals a JOIN scenarios s ON s.scenario_id = a.scenario_id
         WHERE s.project_id = ? AND a.state = 'suspended' AND a.version = s.latest_version`,
      )
      .all(project.id) as Array<{ id: string; scenario_id: string; version: number; binding_json: string }>;
    const rebound: Array<{ scenario_id: string; version: number; approval_id: string }> = [];
    const left: Array<{ scenario_id: string; reason: string }> = [];
    const diffs = new Map<number, PackageDiff | null>();
    host.state.transaction(() => {
      const at = host.now().toISOString();
      for (const a of suspended) {
        const binding = JSON.parse(a.binding_json) as Record<string, unknown> & { baseline: Scenario["baseline"] };
        const from = binding.baseline.packages[0]?.package_version;
        if (
          binding.baseline.packages[0]?.package_id !== input.package_id ||
          from === undefined ||
          from >= input.version
        )
          continue;
        if (!diffs.has(from)) diffs.set(from, diffBetween(host, project.id, input.package_id, from, input.version));
        const row = host.state.db
          .prepare("SELECT doc_json FROM scenario_versions WHERE scenario_id = ? AND version = ?")
          .get(a.scenario_id, a.version) as {
          doc_json: string;
        };
        const doc = JSON.parse(row.doc_json) as Scenario;
        const decision = staleness(linksOf(doc), diffs.get(from)!);
        if (!decision.revalidatable) {
          left.push({ scenario_id: a.scenario_id, reason: decision.reason });
          continue;
        }
        const next: Scenario = {
          ...doc,
          version: a.version + 1,
          baseline: newBaseline as Scenario["baseline"],
          status: "approved",
          freshness: "current",
        };
        const json = JSON.stringify(next);
        host.state.db
          .prepare(
            "INSERT INTO scenario_versions (scenario_id, version, doc_json, status, freshness, content_sha256, created_at, updated_at) VALUES (?, ?, ?, 'approved', 'current', ?, ?, ?)",
          )
          .run(a.scenario_id, next.version, json, sha256(json), at, at);
        host.state.db
          .prepare("UPDATE scenarios SET latest_version = ?, updated_at = ? WHERE scenario_id = ?")
          .run(next.version, at, a.scenario_id);
        host.state.db
          .prepare(
            "UPDATE scenario_versions SET status = 'superseded', updated_at = ? WHERE scenario_id = ? AND version = ?",
          )
          .run(at, a.scenario_id, a.version);
        host.state.db.prepare("UPDATE approvals SET state = 'superseded', updated_at = ? WHERE id = ?").run(at, a.id);
        const approval = {
          ...binding,
          approval_id: host.newId("approval"),
          scenario_version: next.version,
          baseline: newBaseline,
          approver: caller.actor,
          approved_at: at.replace(/\.\d{3}Z$/, "Z"),
          state: "active",
        };
        const check = validateDocument("approval", approval);
        if (!check.ok)
          throw serviceError("INTERNAL_ERROR", "a revalidated approval is not valid", {
            issues: check.issues.slice(0, 5),
          });
        host.state.db
          .prepare(
            "INSERT INTO approvals (id, scenario_id, version, binding_json, mode, state, approver, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
          )
          .run(
            approval.approval_id,
            a.scenario_id,
            next.version,
            JSON.stringify(approval),
            String(binding.mode),
            caller.actor,
            approval.approved_at,
            at,
            at,
          );
        appendAudit(
          host.state.db,
          {
            projectId: project.id,
            actor: caller.actor,
            action: "approval.revalidated",
            target: approval.approval_id,
            details: {
              scenario_id: a.scenario_id,
              from_version: a.version,
              to_version: next.version,
              supersedes: a.id,
              package_version: input.version,
            },
          },
          { redactor: host.redactor, now: host.now },
        );
        rebound.push({ scenario_id: a.scenario_id, version: next.version, approval_id: approval.approval_id });
      }
    });
    return { rebound, left_for_review: left };
  },
});

export const STALENESS_OPERATIONS = [stalenessEvaluate, approvalsRevalidate];
