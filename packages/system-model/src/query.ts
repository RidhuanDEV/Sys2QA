import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  validatePackage,
  type CompletenessReport,
  type ContractIssue,
  type Entity,
  type Evidence,
  type Gap,
  type Relationship,
  type Workflow,
} from "@sys2qa/contract";

/** A claim as the system model stores it. */
export interface ModelClaim {
  id: string;
  text: { language?: string; value: string } | Array<{ language?: string; value: string }>;
  status: string;
  subject_entity_id: string;
  evidence_ids: string[];
  gap_ids?: string[];
  caveats: string[];
  last_validated_revision: string;
}

export class PackageInvalidError extends Error {
  constructor(readonly issues: ContractIssue[]) {
    super(`package is not valid: ${issues.find((i) => i.severity === "error")?.message ?? "unknown issue"}`);
    this.name = "PackageInvalidError";
  }
}

/** Reads a package directory into the path → bytes map the contract library validates. */
export function readPackageDirectory(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(dir, path).split(sep).join("/"), new Uint8Array(readFileSync(path)));
    }
  };
  walk(dir);
  return files;
}

/**
 * The local query library over a Documentation Package (IMP-117, SAA-FR-015): QAA, the CLI and MCP tools read
 * workflows, contracts, roles, rules, dependencies, evidence, freshness and unknowns through it instead of parsing
 * files. A package is validated with the contract library first; an invalid one is refused.
 */
export class PackageQuery {
  readonly manifest: Record<string, unknown>;
  readonly revision: unknown;
  readonly issues: ContractIssue[];
  private readonly entities: Map<string, Entity>;
  private readonly relationships: Relationship[];
  private readonly evidence: Map<string, Evidence>;
  private readonly claims: ModelClaim[];
  private readonly gaps: Gap[];
  private readonly workflowList: Workflow[];
  readonly completeness: CompletenessReport | undefined;
  private readonly files: ReadonlyMap<string, Uint8Array>;

  constructor(files: ReadonlyMap<string, Uint8Array>) {
    const result = validatePackage({ files });
    if (!result.ok || !result.documents) throw new PackageInvalidError(result.issues);
    this.issues = result.issues;
    this.files = files;
    const docs = result.documents as unknown as {
      manifest: Record<string, unknown>;
      model: {
        revision: unknown;
        entities: Entity[];
        relationships: Relationship[];
        claims: ModelClaim[];
        gaps: Gap[];
        workflows: Workflow[];
      };
      evidenceIndex: { evidence: Evidence[] };
      completeness?: CompletenessReport;
    };
    this.manifest = docs.manifest;
    this.revision = docs.model.revision;
    this.entities = new Map(docs.model.entities.map((e) => [e.id, e]));
    this.relationships = docs.model.relationships;
    this.evidence = new Map(docs.evidenceIndex.evidence.map((e) => [e.id, e]));
    this.claims = docs.model.claims ?? [];
    this.gaps = docs.model.gaps ?? [];
    this.workflowList = [...(docs.model.workflows ?? [])].sort(
      (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
    );
    this.completeness = docs.completeness;
  }

  static open(dir: string): PackageQuery {
    return new PackageQuery(readPackageDirectory(dir));
  }

  entity(id: string): Entity | undefined {
    return this.entities.get(id);
  }
  byKind(kind: string): Entity[] {
    return [...this.entities.values()].filter((e) => e.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
  }
  /** Relationships from (`out`) or to (`in`) an entity, optionally of one type. */
  related(id: string, direction: "out" | "in" = "out", type?: string): Relationship[] {
    return this.relationships.filter(
      (r) => (direction === "out" ? r.from === id : r.to === id) && (type === undefined || r.type === type),
    );
  }
  /** The workflow catalog in rank order, optionally one category. */
  workflows(category?: string): Workflow[] {
    return this.workflowList.filter((w) => category === undefined || w.category === category);
  }
  workflow(id: string): Workflow | undefined {
    return this.workflowList.find((w) => w.id === id);
  }
  /** Endpoints with the roles that guard them and the rules that validate them. */
  contracts(): Array<{ api: Entity; authorizes: string[]; authenticates: string[]; validations: string[] }> {
    return this.byKind("api").map((api) => ({
      api,
      authorizes: this.related(api.id, "out", "AUTHORIZES_WITH").map((r) => r.to),
      authenticates: this.related(api.id, "out", "AUTHENTICATES_WITH").map((r) => r.to),
      validations: this.related(api.id, "in", "VALIDATES").map((r) => r.from),
    }));
  }
  roles(): Entity[] {
    return [...this.byKind("actor_role"), ...this.byKind("permission")];
  }
  rules(): Entity[] {
    return this.byKind("business_rule");
  }
  stateMachines(): Entity[] {
    return this.byKind("state_machine");
  }
  /** Modules an entity's module imports (dependencies) or that import it (dependents). */
  dependencies(moduleId: string, direction: "out" | "in" = "out"): string[] {
    return this.related(moduleId, direction, "IMPORTS")
      .map((r) => (direction === "out" ? r.to : r.from))
      .sort();
  }
  /** The evidence records cited by an entity, relationship, claim or workflow. */
  evidenceFor(id: string): Evidence[] {
    const subject =
      this.entities.get(id) ??
      this.relationships.find((r) => r.id === id) ??
      this.claims.find((c) => c.id === id) ??
      this.workflowList.find((w) => w.id === id);
    const ids = (subject as { evidence_ids?: string[] } | undefined)?.evidence_ids ?? [];
    return ids.map((e) => this.evidence.get(e)).filter((e): e is Evidence => e !== undefined);
  }
  claimsAbout(entityId: string): ModelClaim[] {
    return this.claims.filter((c) => c.subject_entity_id === entityId);
  }
  /** What the package does not know: unresolved gaps, and the open questions among them. */
  unknowns(): { gaps: Gap[]; questions: Gap[] } {
    const gaps = this.gaps.filter((g) => g.status === "unresolved").sort((a, b) => a.id.localeCompare(b.id));
    return { gaps, questions: gaps.filter((g) => g.requires_human_clarification) };
  }
  /**
   * Freshness input (QAA-FR-014): the analyzed revision, so a consumer can compare it with the revision it tests.
   * `current` only when both revisions are given and equal; the full decision is QAA's (IMP-202).
   */
  freshness(deployed?: { kind: string; value: string }): "current" | "mismatched" | "unverifiable" {
    const own = this.revision as { kind?: string; value?: string } | undefined;
    if (!deployed || !own?.value) return "unverifiable";
    return own.kind === deployed.kind && own.value === deployed.value ? "current" : "mismatched";
  }
  /** A rendered document by role and language (CON-011): artifacts are found by role, never by file name. */
  document(role: string, language = "en"): string | undefined {
    const artifacts = (this.manifest.artifacts as Array<{ role: string; language?: string; path: string }>) ?? [];
    const entry = artifacts.find((a) => a.role === role && (a.language ?? "en") === language);
    const bytes = entry ? this.files.get(entry.path) : undefined;
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }
}
