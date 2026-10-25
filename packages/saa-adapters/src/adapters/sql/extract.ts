import { createHash } from "node:crypto";
import type { CoverageItem, Entity, Evidence } from "@sys2qa/contract";
import type { AnalyzeResult } from "../../protocol.js";
import { parseDdl, type DdlOperation } from "./ddl.js";
import { parsePrisma, type PrismaSchema } from "./prisma.js";

export const ADAPTER_ID = "sql";
export const ADAPTER_VERSION = "0.1.0";

export interface FileInput {
  path: string;
  sha256: string;
  text: string;
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/**
 * One `file` entity per schema file (IMP-108). SQL files carry their DDL operations in order, Prisma files their
 * parsed schema; each operation, model and enum cites its own evidence (a digest, never the text, CR-060). The host
 * applies migrations in path order and builds tables, columns, ORM models, domain entities and mappings, because a
 * migration may change a table that another batch created.
 */
export function extractFiles(
  files: readonly FileInput[],
  context: { boundaryPath: string; capturedAt: string },
): AnalyzeResult {
  const out: AnalyzeResult = { entities: [], relationships: [], evidence: [], coverage: [] };
  const boundary = context.boundaryPath === "" ? "project:." : `project:${context.boundaryPath}`;
  for (const file of files) {
    const lower = file.path.toLowerCase();
    const isPrisma = lower.endsWith(".prisma");
    if (!isPrisma && !lower.endsWith(".sql")) {
      out.coverage.push({ area: file.path, status: "unsupported", reason: "not a SQL or Prisma file" });
      continue;
    }
    const sourceType = isPrisma ? "schema" : /(^|\/)migrations?\//i.test(file.path) ? "migration" : "schema";
    const method = isPrisma ? "prisma-schema" : "ddl-statements";
    const lines = file.text.split("\n");
    const evidence = (start: number, end: number): string => {
      const id = `evidence:${hash16(sourceType, file.path, `${start}-${end}`, file.sha256, ADAPTER_ID, ADAPTER_VERSION, method)}`;
      if (!out.evidence.some((e) => e.id === id))
        out.evidence.push({
          id,
          source_type: sourceType,
          captured_at: context.capturedAt,
          extractor: { adapter: ADAPTER_ID, version: ADAPTER_VERSION, method },
          path: file.path,
          range: { start_line: start, end_line: Math.max(start, end) },
          file_fingerprint: file.sha256,
          excerpt_policy: "digest_only",
          excerpt_digest: `sha256:${createHash("sha256")
            .update(lines.slice(start - 1, Math.max(start, end)).join("\n"))
            .digest("hex")}`,
        } as Evidence);
      return id;
    };
    const fileEvidence = evidence(1, lines.length);
    const entity: Record<string, unknown> = {
      id: `file:${file.path}`,
      kind: "file",
      name: file.path,
      project_boundary: boundary,
      status: "source_verified",
      origin: "source",
      evidence_ids: [fileEvidence],
      path: file.path,
    };
    const notes: string[] = [];
    if (isPrisma) {
      const schema: PrismaSchema = parsePrisma(file.text);
      entity.prisma = {
        ...schema,
        models: schema.models.map((m) => ({ ...m, evidence: evidence(m.line, m.end_line) })),
        enums: schema.enums.map((e) => ({ ...e, evidence: evidence(e.line, e.end_line) })),
      };
      notes.push(...schema.unreadable.slice(0, 3).map((u) => `line ${u.line}: ${u.reason}`));
    } else {
      const ddl = parseDdl(file.text);
      entity.ddl = ddl.operations.map((op: DdlOperation) => {
        const { text, ...rest } = op;
        return { ...rest, evidence: evidence(op.line, op.line + (text.match(/\n/g) ?? []).length) };
      });
      notes.push(...ddl.unreadable.slice(0, 3).map((u) => `statement at line ${u.line} not read: ${u.reason}`));
      if (ddl.skipped > 0) notes.push(`${ddl.skipped} statement(s) not about the schema were skipped`);
    }
    out.entities.push(entity as unknown as Entity);
    const unread = notes.some((n) => /not read|not understood|outside a block/.test(n));
    const item: CoverageItem = { area: file.path, status: unread ? "partial" : "analyzed" };
    if (notes.length > 0) item.reason = notes.join("; ");
    out.coverage.push(item);
  }
  return out;
}
