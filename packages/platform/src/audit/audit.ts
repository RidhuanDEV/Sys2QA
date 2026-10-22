import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { canonicalJson } from "../canonical-json.js";
import type { Redactor } from "../redaction.js";

/** Audited actions (SEC-014, OBS-006). Job transitions and policy decisions go to the structured log (OBS-002). */
export const AUDIT_ACTIONS = [
  "project.created",
  "project.deleted",
  "authorization.declared",
  "environment.configured",
  "scope_policy.changed",
  "credential.configured",
  "credential.removed",
  "credential.used",
  "approval.granted",
  "approval.suspended",
  "approval.invalidated",
  "approval.superseded",
  "approval.revoked",
  "run.started",
  "run.cancelled",
  "l4.action",
  "export.created",
  "data.deleted",
  "settings.changed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEventInput {
  /** null or omitted for installation-wide events, which form their own chain and survive project deletion. */
  projectId?: string | null;
  actor: string;
  action: AuditAction;
  target?: string;
  details?: Record<string, unknown>;
}

export interface AuditRecord {
  seq: number;
  project_id: string | null;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  prev_hash: string | null;
  hash: string;
}

export interface AuditContext {
  redactor: Redactor;
  now: () => Date;
}

const ACTIONS = new Set<string>(AUDIT_ACTIONS);

/**
 * Appends an audit event inside the caller's transaction, so the event and the action it records commit or roll back
 * together (Data Model §6.3). Each project has its own hash chain; installation-wide events form another one.
 */
export function appendAudit(db: Database, event: AuditEventInput, context: AuditContext): AuditRecord {
  if (!db.inTransaction) {
    throw new Error("audit events must be written in the transaction of the action they record (Data Model §6.3)");
  }
  if (!ACTIONS.has(event.action)) throw new Error(`unknown audit action ${event.action}`);
  const projectId = event.projectId ?? null;
  const redacted = context.redactor.redact(event.details ?? {});
  const details =
    redacted.redactedPaths.length > 0 ? { ...redacted.value, redacted_paths: redacted.redactedPaths } : redacted.value;
  const previous = db
    .prepare("SELECT hash FROM audit_events WHERE project_id IS ? ORDER BY seq DESC LIMIT 1")
    .get(projectId) as { hash: string | null } | undefined;
  const seq = (db.prepare("SELECT coalesce(max(seq), 0) + 1 AS seq FROM audit_events").get() as { seq: number }).seq;
  const at = context.now().toISOString();
  const record: Omit<AuditRecord, "hash"> = {
    seq,
    project_id: projectId,
    at,
    actor: context.redactor.redactText(event.actor).text,
    action: event.action,
    target: event.target === undefined ? null : context.redactor.redactText(event.target).text,
    details,
    prev_hash: previous?.hash ?? null,
  };
  const hash = auditHash(record);
  db.prepare(
    `INSERT INTO audit_events (seq, project_id, at, actor, action, target, details_json, prev_hash, hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    projectId,
    at,
    record.actor,
    record.action,
    record.target,
    JSON.stringify(details),
    record.prev_hash,
    hash,
    at,
    at,
  );
  return { ...record, hash };
}

export function auditHash(record: Omit<AuditRecord, "hash">): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ v: 1, ...record }))
    .digest("hex")}`;
}

interface AuditRow {
  seq: number;
  project_id: string | null;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  details_json: string;
  prev_hash: string | null;
  hash: string | null;
}

const toRecord = (row: AuditRow): AuditRecord => ({
  seq: row.seq,
  project_id: row.project_id,
  at: row.at,
  actor: row.actor,
  action: row.action,
  target: row.target,
  details: JSON.parse(row.details_json) as Record<string, unknown>,
  prev_hash: row.prev_hash,
  hash: row.hash ?? "",
});

/** Audit events in order, for export (OBS-006). `projectId: null` selects installation-wide events. */
export function exportAudit(db: Database, filter: { projectId?: string | null } = {}): AuditRecord[] {
  const rows =
    filter.projectId === undefined
      ? (db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as AuditRow[])
      : (db
          .prepare("SELECT * FROM audit_events WHERE project_id IS ? ORDER BY seq")
          .all(filter.projectId) as AuditRow[]);
  return rows.map(toRecord);
}

export type AuditVerification = { ok: true; events: number } | { ok: false; seq: number; reason: string };

/** Recomputes every chain (ST-16). Detects edited, reordered, inserted or removed events within a chain. */
export function verifyAuditChain(db: Database): AuditVerification {
  const lastHash = new Map<string | null, string | null>();
  let events = 0;
  for (const row of db.prepare("SELECT * FROM audit_events ORDER BY seq").iterate() as IterableIterator<AuditRow>) {
    events++;
    let record: AuditRecord;
    try {
      record = toRecord(row);
    } catch {
      return { ok: false, seq: row.seq, reason: "details are not valid JSON" };
    }
    const expectedPrev = lastHash.get(record.project_id) ?? null;
    if (record.prev_hash !== expectedPrev)
      return { ok: false, seq: record.seq, reason: "chain link does not match the previous event" };
    const { hash, ...rest } = record;
    if (hash !== auditHash(rest))
      return { ok: false, seq: record.seq, reason: "event content does not match its hash" };
    lastHash.set(record.project_id, hash);
  }
  return { ok: true, events };
}

/** The latest hash of a project's chain; recorded in the installation-wide `project.deleted` event (IMP-019). */
export function chainHead(db: Database, projectId: string | null): string | null {
  const row = db
    .prepare("SELECT hash FROM audit_events WHERE project_id IS ? ORDER BY seq DESC LIMIT 1")
    .get(projectId) as { hash: string | null } | undefined;
  return row?.hash ?? null;
}
