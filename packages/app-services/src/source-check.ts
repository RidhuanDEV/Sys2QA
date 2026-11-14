import { appendAudit } from "@sys2qa/platform";
import { packageModel } from "@sys2qa/qaa-core";
import { budgetFor, identifyRevision, RootSandbox, scanInventory, type InventoryEntry } from "@sys2qa/saa-core";
import { serviceError, ServiceError, SERVICE_ERRORS } from "./errors.js";
import { defineOperation } from "./operations.js";
import { packageRow, revalidated } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;

type EvidenceStatus = "matches" | "changed" | "missing";

const sourceVerify = defineOperation<
  { project_id: string; package_id: string; version: number; record_id: string },
  unknown
>({
  name: "source.verify",
  title: "Verify a package record against the local checkout",
  description:
    "A targeted source check (QAA-FR-017): the source evidence of one package record (entity, relationship, claim, workflow or gap) is compared, read-only, with the project's registered local checkout. If the checkout is at another revision than the package, the check is `unconfirmed` without comparing files; otherwise every cited file must still have the fingerprint the package recorded (`confirmed`) or the check is `not_confirmed`. Nothing in the repository is executed and nothing is fetched. The result is QAA evidence (`targeted_source_check`), kept out of the package.",
  level: "L1",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "package_id", "version", "record_id"],
    properties: {
      project_id: ID,
      package_id: { type: "string", pattern: "^pkg:[a-z0-9][a-z0-9._-]{0,127}$" },
      version: { type: "integer", minimum: 1 },
      record_id: ID,
    },
  },
  run: async ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    const prepared = revalidated(packageRow(host, project.id, input.package_id, input.version));
    const model = packageModel(prepared);
    if (!model) throw serviceError("NOT_FOUND", "the package has no structured model to verify");
    const evidence = model.evidenceFor(input.record_id);
    if (evidence.length === 0)
      throw serviceError("NOT_FOUND", `no record ${input.record_id} with evidence in this package`);
    const cited = evidence.filter((e) => typeof e.path === "string" && typeof e.file_fingerprint === "string");
    if (cited.length === 0) throw serviceError("NOT_FOUND", `${input.record_id} has no source evidence to check`);

    const root = host.projects.listEvidenceSources(project.id).find((s) => s.kind === "source_root");
    if (!root) throw serviceError("NOT_FOUND", "the project has no registered local checkout", { field: "project_id" });
    const decision = host.projects.authorize(root.id, "static_read", { kind: "path", path: root.ref });
    if (!decision.allowed)
      throw new ServiceError(
        "DECLARATION_REQUIRED",
        "denied",
        `reading ${root.ref} is not authorized (${decision.reason})`,
        SERVICE_ERRORS.DECLARATION_REQUIRED!.remediation,
      );

    const manifest = JSON.parse(new TextDecoder().decode(prepared.files.get("manifest.json")!)) as {
      repository?: { revision?: { kind: string; value: string } } | null;
    };
    const packageRevision = manifest.repository?.revision ?? null;
    const sandbox = await RootSandbox.open([root.ref], { logger: host.logger });
    const inventory: InventoryEntry[] = [];
    await scanInventory(sandbox, { budget: budgetFor("overview") }, (e) => {
      inventory.push(e);
    });
    const identity = await identifyRevision(
      sandbox,
      0,
      inventory.filter((e) => e.status === "included"),
    );
    const checkoutRevision = { kind: identity.revision.kind, value: identity.revision.value };
    const sameRevision =
      packageRevision !== null &&
      packageRevision.kind === checkoutRevision.kind &&
      packageRevision.value === checkoutRevision.value;

    const results: Array<{
      evidence_id: string;
      path: string;
      range?: unknown;
      status: EvidenceStatus | "not_checked";
    }> = [];
    if (!sameRevision)
      for (const e of cited)
        results.push({
          evidence_id: e.id,
          path: e.path!,
          ...(e.range ? { range: e.range } : {}),
          status: "not_checked",
        });
    else
      for (const e of cited) {
        let status: EvidenceStatus;
        try {
          const { digest } = await sandbox.sha256(await sandbox.resolve(0, e.path!));
          status = `sha256:${digest}` === e.file_fingerprint ? "matches" : "changed";
        } catch {
          status = "missing";
        }
        results.push({ evidence_id: e.id, path: e.path!, ...(e.range ? { range: e.range } : {}), status });
      }
    const result = !sameRevision
      ? "unconfirmed"
      : results.every((r) => r.status === "matches")
        ? "confirmed"
        : "not_confirmed";
    const doc = {
      source_type: "targeted_source_check",
      record_id: input.record_id,
      package: { package_id: input.package_id, package_version: input.version },
      package_revision: packageRevision,
      checkout_revision: checkoutRevision,
      result,
      reason:
        result === "unconfirmed"
          ? "the local checkout is at another revision than the package; nothing was compared"
          : result === "confirmed"
            ? "every cited file is unchanged since the analysis"
            : "a cited file changed or is missing in the checkout",
      evidence: results,
      checked_at: host
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    };
    const id = host.newId("srccheck");
    host.state.transaction(() => {
      const at = host.now().toISOString();
      host.state.db
        .prepare(
          "INSERT INTO source_checks (id, project_id, package_id, package_version, record_id, result, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, project.id, input.package_id, input.version, input.record_id, result, JSON.stringify(doc), at, at);
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "source.verified",
          target: input.record_id,
          details: { check_id: id, result },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return { check_id: id, ...doc };
  },
});

export const SOURCE_CHECK_OPERATIONS = [sourceVerify];
