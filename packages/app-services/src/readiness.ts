import { validateDocument } from "@sys2qa/contract";
import { appendAudit, type AuditAction } from "@sys2qa/platform";
import {
  assessReadiness,
  packageFreshness,
  PackageImportError,
  packageModel,
  prepareImport,
  type EnvironmentState,
  type MaterialityOverride,
  type PreparedImport,
  type RevisionValue,
} from "@sys2qa/qaa-core";
import { budgetFor, identifyRevision, RootSandbox, scanInventory, type InventoryEntry } from "@sys2qa/saa-core";
import { serviceError, ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const PACKAGE_ID = { type: "string", pattern: "^pkg:[a-z0-9][a-z0-9._-]{0,127}$" } as const;
const TEXT = { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" } as const;

interface PackageRow {
  package_id: string;
  version: number;
  path: string;
  manifest_sha256: string;
}

function packageRow(host: Host, projectId: string, packageId: string, version: number): PackageRow {
  const row = host.state.db
    .prepare("SELECT * FROM packages WHERE project_id = ? AND package_id = ? AND version = ?")
    .get(projectId, packageId, version) as PackageRow | undefined;
  if (!row) throw serviceError("NOT_FOUND", `no ${packageId} version ${version} in this project`);
  return row;
}

/** Revalidates a stored package; a package changed after it was stored is never assessed. */
function revalidated(row: PackageRow): PreparedImport {
  let prepared: PreparedImport;
  try {
    prepared = prepareImport(row.path);
  } catch (error) {
    if (error instanceof PackageImportError)
      throw new ServiceError(error.code, "invalid_input", error.message, "Re-import the package from its producer.");
    throw error;
  }
  if (prepared.manifestSha256 !== row.manifest_sha256)
    throw new ServiceError(
      "PKG_CHECKSUM_MISMATCH",
      "invalid_input",
      "the stored package's manifest changed after it was stored",
      "Re-import the package from its producer.",
    );
  return prepared;
}

/**
 * The project baseline from a registered local checkout (QAA-FR-003): read-only and local, only where a declaration
 * covers static reading, never a clone or fetch. The same revision identity SAA records, so the two compare.
 */
async function checkoutRevision(host: Host, projectId: string): Promise<{ revision?: RevisionValue; note: string }> {
  const roots = host.projects.listEvidenceSources(projectId).filter((s) => s.kind === "source_root");
  if (roots.length === 0) return { note: "no local checkout is registered" };
  const source = roots[0]!;
  const decision = host.projects.authorize(source.id, "static_read", { kind: "path", path: source.ref });
  if (!decision.allowed) return { note: `the local checkout is not authorized for reading (${decision.reason})` };
  try {
    const sandbox = await RootSandbox.open([source.ref], { logger: host.logger });
    const inventory: InventoryEntry[] = [];
    await scanInventory(sandbox, { budget: budgetFor("overview") }, (e) => {
      inventory.push(e);
    });
    const identity = await identifyRevision(
      sandbox,
      0,
      inventory.filter((e) => e.status === "included"),
    );
    return {
      revision: { kind: identity.revision.kind, value: identity.revision.value },
      note: `baseline read from ${source.ref}`,
    };
  } catch {
    return { note: "the local checkout could not be read" };
  }
}

function overridesOf(host: Host, projectId: string): MaterialityOverride[] {
  const rows = host.state.db
    .prepare(
      "SELECT gap_id, material, reason, overridden_by, created_at FROM materiality_overrides WHERE project_id = ? ORDER BY created_at, rowid",
    )
    .all(projectId) as Array<{
    gap_id: string;
    material: number;
    reason: string;
    overridden_by: string;
    created_at: string;
  }>;
  // The latest decision per gap applies.
  const latest = new Map<string, MaterialityOverride>();
  for (const r of rows)
    latest.set(r.gap_id, {
      gap_id: r.gap_id,
      material: r.material === 1,
      reason: r.reason,
      by: r.overridden_by,
      at: r.created_at.replace(/\.\d{3}Z$/, "Z"),
    });
  return [...latest.values()].sort((a, b) => a.gap_id.localeCompare(b.gap_id));
}

const readinessAssess = defineOperation<
  { project_id: string; package_id: string; version: number; workflow_ids?: string[] },
  unknown
>({
  name: "readiness.assess",
  title: "Assess readiness per QA activity",
  description:
    "Readiness of an imported package for scenario design, manual preparation and automated execution (PRD §13.9, CON-022), with freshness against the project baseline, every coverage category, material gaps per selected workflow, and QAA's own findings (`qgap:` IDs). Nothing in the package is changed.",
  level: "L0",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version"],
    properties: {
      project_id: ID,
      package_id: PACKAGE_ID,
      version: { type: "integer", minimum: 1 },
      workflow_ids: { type: "array", maxItems: 500, items: ID },
    },
  },
  run: async ({ host }, input) => {
    const project = host.projects.getProject(input.project_id);
    const row = packageRow(host, project.id, input.package_id, input.version);
    const prepared = revalidated(row);
    const model = packageModel(prepared);
    if (model && input.workflow_ids) {
      const unknown = input.workflow_ids.filter((id) => !model.workflow(id));
      if (unknown.length > 0)
        throw serviceError("NOT_FOUND", `no workflow ${unknown[0]} in this package`, { workflow_ids: unknown });
    }
    const newer = (
      host.state.db
        .prepare("SELECT version FROM packages WHERE project_id = ? AND package_id = ? AND version > ?")
        .all(project.id, row.package_id, row.version) as Array<{ version: number }>
    ).map((r) => r.version);
    const manifest = JSON.parse(new TextDecoder().decode(prepared.files.get("manifest.json")!)) as Record<
      string,
      unknown
    >;
    const repository = manifest.repository as { revision?: { kind: string; value: string } } | null;
    const checkout = repository ? await checkoutRevision(host, project.id) : { note: "runtime package" };
    const freshness = packageFreshness({
      packageRevision: repository?.revision
        ? { kind: repository.revision.kind, value: repository.revision.value }
        : null,
      deployedRevisions: (
        (manifest.observed_environments as Array<{ deployed_revision?: { value: string | null } }>) ?? []
      ).map((e) => e.deployed_revision?.value ?? null),
      ...(checkout.revision ? { checkoutRevision: checkout.revision } : {}),
      newerVersions: newer,
    });
    const environment = host.state.db
      .prepare(
        "SELECT classification, state FROM environments WHERE project_id = ? AND state != 'disabled' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(project.id) as EnvironmentState | undefined;
    const confirmed =
      host.state.db
        .prepare(
          "SELECT 1 FROM baseline_confirmations WHERE project_id = ? AND package_id = ? AND package_version = ? LIMIT 1",
        )
        .get(project.id, row.package_id, row.version) !== undefined;
    const assessmentId = host.newId("ready");
    const result = assessReadiness({
      assessmentId,
      assessedAt: host
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      packageRef: { package_id: row.package_id, package_version: row.version },
      manifest,
      ...(model ? { model } : {}),
      issues: prepared.issues,
      freshness,
      ...(input.workflow_ids ? { scope: input.workflow_ids } : {}),
      ...(environment ? { environment } : {}),
      baselineConfirmed: confirmed,
      overrides: overridesOf(host, project.id),
    });
    const check = validateDocument("readiness-assessment", result.assessment);
    if (!check.ok)
      throw new ServiceError(
        "INTERNAL_ERROR",
        "internal",
        "the readiness assessment does not match its contract schema",
        "Report it with the listed issues.",
        { issues: check.issues.slice(0, 10).map((i) => i.message) },
      );
    host.state.transaction(() => {
      const at = host.now().toISOString();
      const insert = host.state.db.prepare(
        "INSERT INTO readiness_assessments (id, project_id, package_ref_json, activity, readiness, reasons_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [activity, value] of Object.entries(result.assessment.activities))
        insert.run(
          `${assessmentId}#${activity}`,
          project.id,
          JSON.stringify({ ...result.assessment.package_refs[0], assessment_id: assessmentId }),
          activity,
          value.readiness,
          JSON.stringify(value.reasons),
          at,
          at,
        );
    });
    return {
      ...result,
      freshness: {
        value: freshness.freshness,
        reason: freshness.reason,
        baseline: freshness.baseline,
        ...(freshness.code ? { code: freshness.code } : {}),
        checkout: checkout.note,
      },
      repository: manifest.repository ?? null,
    };
  },
});

const confirmBaseline = defineOperation<
  { project_id: string; package_id: string; version: number; statement: string },
  unknown
>({
  name: "readiness.confirm_baseline",
  title: "Confirm a package's baseline",
  description:
    "Records a person's statement that the target runs exactly the working tree a dirty or non-Git package was analyzed from (OD-04), or that the deployed revision matches the package. Audited and append-only.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version", "statement"],
    properties: { project_id: ID, package_id: PACKAGE_ID, version: { type: "integer", minimum: 1 }, statement: TEXT },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    packageRow(host, project.id, input.package_id, input.version);
    const id = host.newId("baseline");
    host.state.transaction(() => {
      const at = host.now().toISOString();
      host.state.db
        .prepare(
          "INSERT INTO baseline_confirmations (id, project_id, package_id, package_version, confirmed_by, statement, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, project.id, input.package_id, input.version, caller.actor, input.statement, at, at);
      audit(host, project.id, caller.actor, "baseline.confirmed", {
        confirmation_id: id,
        package_id: input.package_id,
        version: input.version,
      });
    });
    return { confirmation_id: id, package_id: input.package_id, version: input.version, confirmed_by: caller.actor };
  },
});

const overrideMateriality = defineOperation<
  { project_id: string; gap_id: string; material: boolean; reason: string },
  unknown
>({
  name: "readiness.override_materiality",
  title: "Override a gap's materiality",
  description:
    "Marks a gap material or not material for the project's QA scope, with a reason (PRD §13.9). Audited and append-only; the latest decision per gap applies to later assessments.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "gap_id", "material", "reason"],
    properties: { project_id: ID, gap_id: ID, material: { type: "boolean" }, reason: TEXT },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    const id = host.newId("override");
    host.state.transaction(() => {
      const at = host.now().toISOString();
      host.state.db
        .prepare(
          "INSERT INTO materiality_overrides (id, project_id, gap_id, material, reason, overridden_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, project.id, input.gap_id, input.material ? 1 : 0, input.reason, caller.actor, at, at);
      audit(host, project.id, caller.actor, "materiality.overridden", {
        override_id: id,
        gap_id: input.gap_id,
        material: input.material,
      });
    });
    return { override_id: id, gap_id: input.gap_id, material: input.material, by: caller.actor };
  },
});

function audit(host: Host, projectId: string, actor: string, action: AuditAction, details: Record<string, unknown>) {
  appendAudit(
    host.state.db,
    { projectId, actor, action, target: projectId, details },
    { redactor: host.redactor, now: host.now },
  );
}

export const READINESS_OPERATIONS = [readinessAssess, confirmBaseline, overrideMateriality];
