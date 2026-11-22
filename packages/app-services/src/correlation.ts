import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDocument } from "@sys2qa/contract";
import { appendAudit, localIdPart, projectDirectory } from "@sys2qa/platform";
import { correlatePackages, type CorrelationModel } from "@sys2qa/qaa-core";
import { ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";
import { packageRow, revalidated } from "./readiness.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const PACKAGE_ID = { type: "string", pattern: "^pkg:[a-z0-9][a-z0-9._-]{0,127}$" } as const;
const VERSION = { type: "integer", minimum: 1 } as const;

/** A stored package, revalidated, with its producer and system model. */
function load(host: Host, projectId: string, packageId: string, version: number) {
  const prepared = revalidated(packageRow(host, projectId, packageId, version));
  const text = prepared.files.get("system-model.json");
  if (!text)
    throw new ServiceError(
      "PKG_ARTIFACT_MISSING",
      "invalid_input",
      `${packageId} has no system model`,
      "Re-export the package.",
    );
  return {
    producer: String(prepared.provenance.producer.name),
    model: JSON.parse(Buffer.from(text).toString("utf8")) as CorrelationModel,
  };
}

const correlationRun = defineOperation<
  {
    project_id: string;
    saa_package_id: string;
    saa_version: number;
    qaa_package_id: string;
    qaa_version: number;
    revision_correspondence?: "user_confirmed" | "unconfirmed";
  },
  unknown
>({
  name: "correlation.run",
  title: "Correlate source and runtime packages",
  description:
    "Mode C (QAA-FR-115, CON-026): links the pages, forms and fields a QAA package observed to the routes, forms and fields of an SAA package, with a rationale and confidence, and records what stays unmatched on each side and every discrepancy: a field constraint that differs, a source route the environment did not serve, an observed page without a source route. Both packages stay unchanged. Unless a person confirms that the environment runs the analyzed revision, correspondence is `unconfirmed` and every discrepancy may be version-related. The report is validated and written next to the project's packages.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["project_id", "saa_package_id", "saa_version", "qaa_package_id", "qaa_version"],
    properties: {
      project_id: ID,
      saa_package_id: PACKAGE_ID,
      saa_version: VERSION,
      qaa_package_id: PACKAGE_ID,
      qaa_version: VERSION,
      revision_correspondence: { enum: ["user_confirmed", "unconfirmed"] },
    },
  },
  run: ({ host, caller }, input) => {
    const project = host.projects.getProject(input.project_id);
    const saa = load(host, project.id, input.saa_package_id, input.saa_version);
    const qaa = load(host, project.id, input.qaa_package_id, input.qaa_version);
    if (saa.producer !== "SAA" || qaa.producer !== "QAA")
      throw new ServiceError(
        "CONFLICT",
        "conflict",
        `correlation needs an SAA and a QAA package; got ${saa.producer} and ${qaa.producer}`,
        "Name the source package as SAA and the observed package as QAA.",
      );
    const reportId = host.newId("correlation");
    const report = correlatePackages({
      report_id: reportId,
      generated_at: host
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
      saa: { package_id: input.saa_package_id, package_version: input.saa_version, model: saa.model },
      qaa: { package_id: input.qaa_package_id, package_version: input.qaa_version, model: qaa.model },
      revision_correspondence: input.revision_correspondence ?? "unconfirmed",
    });
    const check = validateDocument("correlation-report", report);
    if (!check.ok)
      throw new ServiceError(
        "PACKAGE_INVALID",
        "internal",
        "the correlation report failed contract validation",
        "Report this as a defect.",
        { issues: check.issues.slice(0, 20).map((i) => ({ code: i.code, message: i.message })) },
      );
    const dir = join(projectDirectory(host.home, project.id), "correlation");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${localIdPart(reportId)}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    host.state.transaction(() =>
      appendAudit(
        host.state.db,
        {
          projectId: project.id,
          actor: caller.actor,
          action: "correlation.created",
          target: reportId,
          details: {
            saa: `${input.saa_package_id}@${input.saa_version}`,
            qaa: `${input.qaa_package_id}@${input.qaa_version}`,
            revision_correspondence: report.revision_correspondence,
            links: report.links.length,
            discrepancies: report.discrepancies.length,
          },
        },
        { redactor: host.redactor, now: host.now },
      ),
    );
    return { ...report, path };
  },
});

export const CORRELATION_OPERATIONS = [correlationRun];
