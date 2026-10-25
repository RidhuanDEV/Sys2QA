import type { Database } from "better-sqlite3";
import { appendAudit, chainHead, type AuditContext } from "../audit/audit.js";
import { canonicalJson } from "../canonical-json.js";
import type { Logger } from "../logging/logger.js";
import {
  decide,
  checkUrl,
  DEFAULT_PLATFORM_SETTINGS,
  type Declaration,
  type EnvironmentClassification,
  type PlatformSettings,
  type PolicyDecision,
  type PolicyTarget,
  type Prohibitions,
  type ScopePolicy,
} from "../policy/engine.js";
import { SOURCE_OPERATIONS, type DeclarableLevel, type Operation } from "../policy/levels.js";

export type EvidenceSourceKind = "source_root" | "environment" | "package";
/** Starting mode derived from a project's evidence (SYS-001, PRD §6). */
export type EvidenceMode = "A" | "B" | "C" | "D" | "none";

export interface Project {
  id: string;
  name: string;
  default_languages: string[];
  archived_at: string | null;
  created_at: string;
}

export interface EvidenceSource {
  id: string;
  project_id: string;
  kind: EvidenceSourceKind;
  ref: string;
  added_at: string;
}

export interface DeclarationInput {
  declaredBy: string;
  operationLevel: DeclarableLevel;
  sourceRoots?: string[];
  allowStateChangingTests?: boolean;
  prohibitions?: Prohibitions;
}

export interface EnvironmentInput {
  baseUrl: string;
  classification: EnvironmentClassification;
  allowedHosts: string[];
  pathPrefixes?: string[];
  localOwnerMode?: boolean;
}

export class ProjectError extends Error {
  override readonly name = "ProjectError";
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "DECLARATION_REQUIRED" | "SCOPE_DENIED",
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectServiceOptions {
  audit: AuditContext;
  newId: (kind: string) => string;
  logger?: Logger;
}

const SOURCE_LEVELS: ReadonlySet<DeclarableLevel> = new Set(["L0", "L1", "L4"]);
const ENVIRONMENT_LEVELS: ReadonlySet<DeclarableLevel> = new Set(["L2", "L2r", "L3"]);

/**
 * Projects, evidence sources, scoped authorization declarations, environments and their versioned scope policies
 * (SYS-001, SEC-005, QAA-FR-001, QAA-FR-002). Every change runs in one transaction with its audit event.
 */
export class ProjectService {
  constructor(
    private readonly db: Database,
    private readonly options: ProjectServiceOptions,
  ) {}

  private at(): string {
    return this.options.audit.now().toISOString();
  }

  private tx<T>(fn: () => T): T {
    return this.db.inTransaction ? fn() : this.db.transaction(fn).immediate();
  }

  private audit(event: Parameters<typeof appendAudit>[1]): void {
    appendAudit(this.db, event, this.options.audit);
  }

  createProject(input: { name: string; languages?: string[]; actor: string }): Project {
    if (input.name.trim() === "") throw new ProjectError("INVALID", "project name is required");
    return this.tx(() => {
      const id = this.options.newId("project");
      const at = this.at();
      this.db
        .prepare(
          "INSERT INTO projects (id, name, default_languages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, input.name.trim(), JSON.stringify(input.languages ?? ["en"]), at, at);
      this.audit({
        projectId: id,
        actor: input.actor,
        action: "project.created",
        target: id,
        details: { name: input.name.trim() },
      });
      return this.getProject(id);
    });
  }

  getProject(id: string): Project {
    const row = this.db
      .prepare("SELECT id, name, default_languages_json, archived_at, created_at FROM projects WHERE id = ?")
      .get(id) as
      | { id: string; name: string; default_languages_json: string; archived_at: string | null; created_at: string }
      | undefined;
    if (!row) throw new ProjectError("NOT_FOUND", `project ${id} not found`);
    return {
      id: row.id,
      name: row.name,
      default_languages: JSON.parse(row.default_languages_json) as string[],
      archived_at: row.archived_at,
      created_at: row.created_at,
    };
  }

  renameProject(id: string, name: string): Project {
    if (name.trim() === "") throw new ProjectError("INVALID", "project name is required");
    this.getProject(id);
    this.db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name.trim(), this.at(), id);
    return this.getProject(id);
  }

  archiveProject(id: string): Project {
    this.getProject(id);
    const at = this.at();
    this.db
      .prepare("UPDATE projects SET archived_at = coalesce(archived_at, ?), updated_at = ? WHERE id = ?")
      .run(at, at, id);
    return this.getProject(id);
  }

  /**
   * Deletes the project's operational state in one transaction (SEC-015): a tombstone authorizes the cascade through
   * append-only tables, and an installation-wide audit event records the head of the deleted project's audit chain.
   * Files, secrets and index rows are removed by the deletion job (IMP-019).
   */
  /**
   * Records the deletion tombstone (SEC-015). From here on the project's append-only rows may be deleted, and an
   * interrupted deletion can be resumed (IMP-019).
   */
  requestDeletion(id: string, actor: string): void {
    this.getProject(id);
    const at = this.at();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO project_deletions (project_id, requested_by, requested_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, actor, at, at, at);
  }

  deleteProject(id: string, actor: string): void {
    this.getProject(id);
    this.tx(() => {
      const at = this.at();
      this.db
        .prepare(
          "INSERT OR IGNORE INTO project_deletions (project_id, requested_by, requested_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, actor, at, at, at);
      this.audit({
        projectId: null,
        actor,
        action: "project.deleted",
        target: id,
        details: { last_audit_hash: chainHead(this.db, id) },
      });
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
  }

  addEvidenceSource(projectId: string, kind: EvidenceSourceKind, ref: string): EvidenceSource {
    this.getProject(projectId);
    if (ref.trim() === "") throw new ProjectError("INVALID", "evidence source reference is required");
    const id = kind === "environment" ? this.options.newId("env") : this.options.newId("source");
    const at = this.at();
    this.db
      .prepare(
        "INSERT INTO evidence_sources (id, project_id, kind, ref, added_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, projectId, kind, ref, at, at, at);
    return this.getEvidenceSource(id);
  }

  getEvidenceSource(id: string): EvidenceSource {
    const row = this.db
      .prepare("SELECT id, project_id, kind, ref, added_at FROM evidence_sources WHERE id = ?")
      .get(id) as EvidenceSource | undefined;
    if (!row) throw new ProjectError("NOT_FOUND", `evidence source ${id} not found`);
    return row;
  }

  listEvidenceSources(projectId: string): EvidenceSource[] {
    return this.db
      .prepare(
        "SELECT id, project_id, kind, ref, added_at FROM evidence_sources WHERE project_id = ? ORDER BY added_at, id",
      )
      .all(projectId) as EvidenceSource[];
  }

  /** Mode A source only, B environment only, C both, D package only (SYS-001). Adding evidence never restarts a project. */
  evidenceMode(projectId: string): EvidenceMode {
    const kinds = new Set(this.listEvidenceSources(projectId).map((s) => s.kind));
    if (kinds.has("source_root") && kinds.has("environment")) return "C";
    if (kinds.has("source_root")) return "A";
    if (kinds.has("environment")) return "B";
    if (kinds.has("package")) return "D";
    return "none";
  }

  /** Records a scoped authorization declaration (SEC-005). Declarations are append-only; the latest one applies. */
  declare(sourceId: string, input: DeclarationInput): Declaration {
    const source = this.getEvidenceSource(sourceId);
    if (input.declaredBy.trim() === "") throw new ProjectError("INVALID", "the declaration must name who declares");
    const allowed = source.kind === "environment" ? ENVIRONMENT_LEVELS : SOURCE_LEVELS;
    if (!allowed.has(input.operationLevel)) {
      throw new ProjectError(
        "INVALID",
        `level ${input.operationLevel} does not apply to a ${source.kind} source (allowed: ${[...allowed].join(", ")})`,
      );
    }
    const roots = input.sourceRoots ?? (source.kind === "source_root" ? [source.ref] : []);
    if (source.kind === "source_root" && roots.length === 0)
      throw new ProjectError("INVALID", "a source declaration needs at least one source root");
    return this.tx(() => {
      const id = this.options.newId("declaration");
      const at = this.at();
      const scope: Declaration["scope"] = {
        source_roots: roots,
        allow_state_changing_tests: input.allowStateChangingTests ?? false,
      };
      const prohibitions = input.prohibitions ?? {};
      this.db
        .prepare(
          `INSERT INTO authorization_declarations (id, project_id, evidence_source_id, declared_by, declared_at, scope_json, operation_level, prohibitions_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          source.project_id,
          source.id,
          input.declaredBy,
          at,
          JSON.stringify(scope),
          input.operationLevel,
          JSON.stringify(prohibitions),
          at,
          at,
        );
      this.audit({
        projectId: source.project_id,
        actor: input.declaredBy,
        action: "authorization.declared",
        target: source.id,
        details: { operation_level: input.operationLevel, scope, prohibitions },
      });
      const declaration = this.latestDeclaration(source.id)!;
      // A new declaration for an environment re-derives its scope policy (it may narrow or widen the level).
      if (source.kind === "environment" && this.environmentExists(source.id))
        this.writeScopePolicy(source.id, input.declaredBy);
      return declaration;
    });
  }

  latestDeclaration(sourceId: string): Declaration | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM authorization_declarations WHERE evidence_source_id = ? ORDER BY declared_at DESC, rowid DESC LIMIT 1",
      )
      .get(sourceId) as
      | {
          id: string;
          project_id: string;
          evidence_source_id: string;
          declared_by: string;
          declared_at: string;
          operation_level: DeclarableLevel;
          scope_json: string;
          prohibitions_json: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      project_id: row.project_id,
      evidence_source_id: row.evidence_source_id,
      declared_by: row.declared_by,
      declared_at: row.declared_at,
      operation_level: row.operation_level,
      scope: JSON.parse(row.scope_json) as Declaration["scope"],
      prohibitions: JSON.parse(row.prohibitions_json) as Prohibitions,
    };
  }

  private environmentExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM environments WHERE id = ?").get(id) !== undefined;
  }

  /**
   * Configures the environment behind an `environment` evidence source (QAA-FR-002). Impossible without a declaration
   * (SEC-005); the base URL must itself be inside the new scope. Writes a new scope policy version when anything changes.
   */
  configureEnvironment(sourceId: string, input: EnvironmentInput, actor: string): ScopePolicy {
    const source = this.getEvidenceSource(sourceId);
    if (source.kind !== "environment")
      throw new ProjectError("INVALID", "only environment sources have an environment");
    const declaration = this.latestDeclaration(sourceId);
    if (!declaration)
      throw new ProjectError(
        "DECLARATION_REQUIRED",
        "record a scoped authorization declaration before configuring the environment (SEC-005)",
      );
    if (input.allowedHosts.length === 0) throw new ProjectError("INVALID", "at least one allowed host is required");
    const draft = this.policyFrom(source.id, input, declaration, 0);
    const problem = checkUrl(input.baseUrl, draft, this.settings());
    if (problem) throw new ProjectError("SCOPE_DENIED", `base URL rejected: ${problem.detail}`);
    return this.tx(() => {
      const at = this.at();
      this.db
        .prepare(
          `INSERT INTO environments (id, project_id, base_url, classification, state, local_owner_mode, scope_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'configured', ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET base_url = excluded.base_url, classification = excluded.classification,
             local_owner_mode = excluded.local_owner_mode, scope_json = excluded.scope_json, updated_at = excluded.updated_at`,
        )
        .run(
          source.id,
          source.project_id,
          input.baseUrl,
          input.classification,
          input.localOwnerMode ? 1 : 0,
          JSON.stringify(input),
          at,
          at,
        );
      this.audit({
        projectId: source.project_id,
        actor,
        action: "environment.configured",
        target: source.id,
        details: { base_url: input.baseUrl, classification: input.classification },
      });
      return this.writeScopePolicy(source.id, actor);
    });
  }

  private policyFrom(
    environmentId: string,
    input: EnvironmentInput,
    declaration: Declaration,
    version: number,
  ): ScopePolicy {
    return {
      environment_id: environmentId,
      version,
      base_url: input.baseUrl,
      classification: input.classification,
      allowed_hosts: input.allowedHosts,
      path_prefixes: input.pathPrefixes ?? ["/"],
      local_owner_mode: input.localOwnerMode ?? false,
      declaration_id: declaration.id,
      max_level: declaration.operation_level,
      allow_state_changing_tests: declaration.scope.allow_state_changing_tests,
      prohibitions: declaration.prohibitions,
    };
  }

  /** Appends a scope policy version if the derived policy differs from the current one (approvals bind to versions). */
  private writeScopePolicy(environmentId: string, actor: string): ScopePolicy {
    const source = this.getEvidenceSource(environmentId);
    const declaration = this.latestDeclaration(environmentId)!;
    const stored = this.db.prepare("SELECT scope_json FROM environments WHERE id = ?").get(environmentId) as {
      scope_json: string;
    };
    const input = JSON.parse(stored.scope_json) as EnvironmentInput;
    const current = this.currentScopePolicy(environmentId);
    const next = this.policyFrom(environmentId, input, declaration, (current?.version ?? 0) + 1);
    const { version: _nextVersion, ...nextBody } = next;
    if (current) {
      const { version: _currentVersion, ...currentBody } = current;
      if (canonicalJson(currentBody) === canonicalJson(nextBody)) return current;
    }
    const at = this.at();
    this.db
      .prepare(
        "INSERT INTO scope_policies (environment_id, version, project_id, policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(environmentId, next.version, source.project_id, JSON.stringify(nextBody), at, at);
    this.audit({
      projectId: source.project_id,
      actor,
      action: "scope_policy.changed",
      target: environmentId,
      details: { version: next.version, previous_version: current?.version ?? null },
    });
    return next;
  }

  currentScopePolicy(environmentId: string): ScopePolicy | undefined {
    const row = this.db
      .prepare("SELECT version, policy_json FROM scope_policies WHERE environment_id = ? ORDER BY version DESC LIMIT 1")
      .get(environmentId) as { version: number; policy_json: string } | undefined;
    return row && { ...(JSON.parse(row.policy_json) as Omit<ScopePolicy, "version">), version: row.version };
  }

  settings(): PlatformSettings {
    const rows = this.db
      .prepare(
        "SELECT key, value_json FROM settings WHERE key IN ('l4_enabled', 'local_owner_mode_enabled', 'telemetry_enabled')",
      )
      .all() as Array<{ key: keyof PlatformSettings; value_json: string }>;
    const out = { ...DEFAULT_PLATFORM_SETTINGS };
    for (const r of rows) out[r.key] = JSON.parse(r.value_json) === true;
    return out;
  }

  /** Administrator switches (SEC-006, SEC-008); audited. */
  setSetting(key: keyof PlatformSettings, value: boolean, actor: string): PlatformSettings {
    this.tx(() => {
      const at = this.at();
      this.db
        .prepare(
          `INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(value), at, at);
      this.audit({ projectId: null, actor, action: "settings.changed", target: key, details: { value } });
    });
    return this.settings();
  }

  /**
   * Decides an operation on one evidence source with its current declaration and scope policy, and logs the decision
   * (OBS-002). Refusals carry SCOPE_DENIED or PRODUCTION_REFUSED.
   */
  authorize(sourceId: string, operation: Operation, target?: PolicyTarget): PolicyDecision {
    const source = this.getEvidenceSource(sourceId);
    const declaration = this.latestDeclaration(sourceId);
    const scopePolicy = SOURCE_OPERATIONS.has(operation) ? undefined : this.currentScopePolicy(sourceId);
    const decision = decide(
      { operation, ...(target ? { target } : {}) },
      { ...(declaration ? { declaration } : {}), ...(scopePolicy ? { scopePolicy } : {}), settings: this.settings() },
    );
    this.options.logger?.info("policy.decision", {
      project_id: source.project_id,
      source_id: source.id,
      operation,
      allowed: decision.allowed,
      ...(decision.allowed ? {} : { code: decision.code, reason: decision.reason }),
      scope_policy_version: scopePolicy?.version ?? null,
    });
    return decision;
  }
}
