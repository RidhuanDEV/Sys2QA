import type { Database } from "better-sqlite3";
import { appendAudit, type AuditContext } from "../audit/audit.js";
import type { SecretBackend } from "./backends.js";

export class SecretAccessError extends Error {
  override readonly name = "SecretAccessError";
  constructor(
    readonly code: "NOT_FOUND" | "SCOPE_DENIED" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface SecretInfo {
  ref: string;
  project_id: string;
  name: string;
  backend: string;
  created_at: string;
}

/**
 * Secret references for projects (SEC-011, QAA-FR-005). The state database holds only references and owners; values
 * stay in the backend and are released only to a job of the owning project.
 */
export class SecretService {
  constructor(
    private readonly db: Database,
    private readonly backend: SecretBackend,
    private readonly audit: AuditContext,
  ) {}

  static refFor(projectId: string, name: string): string {
    return `secretref:${projectId.replace(/^project:/, "")}.${name}`;
  }

  /** Stores or replaces a value and returns its reference. Audited as `credential.configured` (no value). */
  async put(projectId: string, name: string, value: string, actor: string): Promise<SecretInfo> {
    if (!NAME.test(name))
      throw new SecretAccessError(
        "INVALID",
        "secret names use lowercase letters, digits, dot, dash and underscore (max 64)",
      );
    if (value.length === 0) throw new SecretAccessError("INVALID", "the secret value is empty");
    if (!this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId))
      throw new SecretAccessError("NOT_FOUND", `project ${projectId} not found`);
    const ref = SecretService.refFor(projectId, name);
    await this.backend.set(ref, value);
    const at = this.audit.now().toISOString();
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO secret_refs (ref, project_id, name, backend, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (ref) DO UPDATE SET backend = excluded.backend, updated_at = excluded.updated_at`,
          )
          .run(ref, projectId, name, this.backend.kind, at, at);
        appendAudit(
          this.db,
          { projectId, actor, action: "credential.configured", target: ref, details: { backend: this.backend.kind } },
          this.audit,
        );
      })
      .immediate();
    return this.info(ref)!;
  }

  info(ref: string): SecretInfo | undefined {
    return this.db
      .prepare("SELECT ref, project_id, name, backend, created_at FROM secret_refs WHERE ref = ?")
      .get(ref) as SecretInfo | undefined;
  }

  list(projectId: string): SecretInfo[] {
    return this.db
      .prepare("SELECT ref, project_id, name, backend, created_at FROM secret_refs WHERE project_id = ? ORDER BY name")
      .all(projectId) as SecretInfo[];
  }

  async remove(ref: string, actor: string): Promise<void> {
    const info = this.info(ref);
    if (!info) throw new SecretAccessError("NOT_FOUND", `no secret ${ref}`);
    await this.backend.delete(ref);
    this.db
      .transaction(() => {
        this.db.prepare("DELETE FROM secret_refs WHERE ref = ?").run(ref);
        appendAudit(
          this.db,
          { projectId: info.project_id, actor, action: "credential.removed", target: ref },
          this.audit,
        );
      })
      .immediate();
  }

  /** Deletes every value of a project before its state rows go (SEC-015, IMP-019). Returns the references removed. */
  async removeAllForProject(projectId: string): Promise<string[]> {
    const refs = this.list(projectId).map((s) => s.ref);
    for (const ref of refs) await this.backend.delete(ref);
    return refs;
  }

  /**
   * Releases values to one job (SEC-011): only references of the job's own project; each value is registered for
   * exact-match redaction and each use is audited as `credential.used`. The caller passes values to the worker
   * through the job channel, never through the environment or the job payload.
   */
  async injectForJob(projectId: string, jobId: string, refs: string[], actor = "system"): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    for (const ref of refs) {
      const info = this.info(ref);
      if (!info) throw new SecretAccessError("NOT_FOUND", `no secret ${ref}`);
      if (info.project_id !== projectId)
        throw new SecretAccessError("SCOPE_DENIED", `${ref} belongs to another project`);
      const value = await this.backend.get(ref);
      if (value === undefined)
        throw new SecretAccessError("NOT_FOUND", `the value of ${ref} is missing from the ${this.backend.kind} store`);
      this.audit.redactor.addKnownSecret(value);
      values.set(ref, value);
    }
    if (refs.length > 0) {
      this.db
        .transaction(() => {
          for (const ref of refs)
            appendAudit(
              this.db,
              { projectId, actor, action: "credential.used", target: ref, details: { job_id: jobId } },
              this.audit,
            );
        })
        .immediate();
    }
    return values;
  }
}
