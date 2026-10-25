// sql analyzer adapter process (ADR-009, OD-06). Bundled by `pnpm build:adapters`; started by the adapter host.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "../../protocol.js";
import { serveAdapter } from "../../sdk.js";
import { boundaryPathOf } from "../shared.js";
import { ADAPTER_ID, ADAPTER_VERSION, extractFiles, type FileInput } from "./extract.js";

void serveAdapter({
  initialize: () => ({
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    support_matrix: {
      languages: [
        { name: "sql", versions: "DDL shared by PostgreSQL, MySQL and SQLite" },
        { name: "prisma", versions: "Prisma schema language 4.x-6.x" },
      ],
      scanned_only_languages: [],
      frameworks: [
        {
          name: "prisma",
          versions: "4.x-6.x",
          entities: ["orm_model", "entity", "table", "column"],
          relations: ["USES_SCHEMA", "REFERENCES"],
          workflow_tracing: "unsupported",
          fixtures: ["fixtures/benchmarks/F1-repository-only"],
        },
      ],
      prerequisites: ["none: no database connection; files are read, never executed"],
      limitations: [
        "CREATE TABLE … AS SELECT, views, triggers, stored procedures and dialect-specific table options are skipped",
        "migrations are applied in path order; down migrations and migration tools' own ordering files are not interpreted",
        "CHECK and DEFAULT expressions are kept as text",
      ],
    },
  }),
  analyze: async (params, context) => {
    const files: FileInput[] = [];
    const failed: Array<{ path: string; reason: string }> = [];
    for (const [i, ref] of params.files.entries()) {
      if (context.signal.aborted) break;
      try {
        const bytes = readFileSync(ref.path);
        const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (sha256 !== ref.sha256) failed.push({ path: ref.path, reason: "file changed since intake" });
        else files.push({ path: ref.path, sha256, text: bytes.toString("utf8") });
      } catch (error) {
        failed.push({ path: ref.path, reason: `unreadable: ${(error as NodeJS.ErrnoException).code ?? "error"}` });
      }
      context.progress(i + 1, params.files.length);
    }
    const result = extractFiles(files, {
      boundaryPath: boundaryPathOf(params.root_id),
      capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    for (const f of failed) result.coverage.push({ area: f.path, status: "failed", reason: f.reason });
    return result;
  },
});
