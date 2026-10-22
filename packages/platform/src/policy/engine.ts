import { isAbsolute, relative, resolve } from "node:path";
import {
  levelAtMost,
  OPERATION_LEVELS,
  SOURCE_OPERATIONS,
  type DeclarableLevel,
  type Operation,
  type PermissionLevel,
} from "./levels.js";
import { classifyHost } from "./network.js";

export type EnvironmentClassification = "development" | "staging" | "production";

export interface Prohibitions {
  /** Paths (absolute, or relative to a source root) that must never be read. */
  paths?: string[];
  /** URL prefixes (`https://host/path`) that must never be visited. */
  url_prefixes?: string[];
  operations?: Operation[];
  /** Free-text data prohibitions shown to people (e.g. "no real customer data"); not machine-enforced. */
  notes?: string[];
}

/** A scoped authorization declaration (SEC-005). Self-declared and not verified (MD-3). */
export interface Declaration {
  id: string;
  project_id: string;
  evidence_source_id: string;
  declared_by: string;
  declared_at: string;
  operation_level: DeclarableLevel;
  scope: {
    source_roots: string[];
    /** "Tests may modify data" (PRD W1): allows approved state-changing tests at L3. */
    allow_state_changing_tests: boolean;
  };
  prohibitions: Prohibitions;
}

/** The enforced, versioned scope policy of one environment (QAA-FR-002, Data Model §4 `scope_policies`). */
export interface ScopePolicy {
  environment_id: string;
  version: number;
  base_url: string;
  classification: EnvironmentClassification;
  /** `host` or `host:port`, compared case-insensitively; no wildcards. */
  allowed_hosts: string[];
  /** Path prefixes matched on segment boundaries; `/` allows every path. */
  path_prefixes: string[];
  local_owner_mode: boolean;
  declaration_id: string;
  max_level: DeclarableLevel;
  allow_state_changing_tests: boolean;
  prohibitions: Prohibitions;
}

export interface PlatformSettings {
  /** Repository code execution (L4); off by default (SEC-006, SEC-013). */
  l4_enabled: boolean;
  /** Administrator switch for local owner mode (SEC-008); off by default. */
  local_owner_mode_enabled: boolean;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = { l4_enabled: false, local_owner_mode_enabled: false };

export type PolicyTarget = { kind: "path"; path: string } | { kind: "url"; url: string };

export interface PolicyRequest {
  operation: Operation;
  target?: PolicyTarget;
}

export interface PolicyContext {
  declaration?: Declaration;
  /** Required for environment operations. */
  scopePolicy?: ScopePolicy;
  settings: PlatformSettings;
}

export type DenyReason =
  | "no_declaration"
  | "out_of_scope_level"
  | "production"
  | "level_not_declared"
  | "level_disabled"
  | "state_changing_not_declared"
  | "target_required"
  | "wrong_target_kind"
  | "no_scope_policy"
  | "out_of_scope_path"
  | "prohibited"
  | "invalid_url"
  | "scheme_not_allowed"
  | "url_has_credentials"
  | "host_not_allowed"
  | "path_not_allowed"
  | "metadata_address"
  | "private_network";

export type PolicyDecision =
  | {
      allowed: true;
      operation: Operation;
      level: PermissionLevel;
      declaration_id: string;
      scope_policy_version?: number;
    }
  | {
      allowed: false;
      operation: Operation;
      level: PermissionLevel;
      code: "SCOPE_DENIED" | "PRODUCTION_REFUSED";
      reason: DenyReason;
      detail: string;
    };

/**
 * The policy engine (SEC-005, SEC-006, SEC-008, SEC-009, QAA-FR-002). Pure: callers load the declaration, scope policy
 * and settings, so every decision is reproducible in tests. A decision covers authorization and scope only;
 * approvals are checked separately (CR-055, CR-056).
 */
export function decide(request: PolicyRequest, context: PolicyContext): PolicyDecision {
  const { operation } = request;
  const level = OPERATION_LEVELS[operation];
  const deny = (
    reason: DenyReason,
    detail: string,
    code: "SCOPE_DENIED" | "PRODUCTION_REFUSED" = "SCOPE_DENIED",
  ): PolicyDecision => ({
    allowed: false,
    operation,
    level,
    code,
    reason,
    detail,
  });
  if (level === "L5")
    return deny(
      "out_of_scope_level",
      "production and live external systems are out of scope (X-09)",
      "PRODUCTION_REFUSED",
    );
  const declaration = context.declaration;
  if (!declaration) return deny("no_declaration", "record a scoped authorization declaration first (SEC-005)");
  const isSource = SOURCE_OPERATIONS.has(operation);
  const policy = context.scopePolicy;
  if (!isSource) {
    if (!policy) return deny("no_scope_policy", "configure the environment first");
    if (policy.classification === "production")
      return deny("production", "production environments are refused (SEC-009)", "PRODUCTION_REFUSED");
  }
  const ceiling = isSource ? declaration.operation_level : minLevel(declaration.operation_level, policy!.max_level);
  if (!levelAtMost(level, ceiling))
    return deny("level_not_declared", `${operation} needs ${level}; the declaration allows up to ${ceiling}`);
  if (level === "L4" && !context.settings.l4_enabled)
    return deny("level_disabled", "repository code execution (L4) is disabled in this installation");
  if (
    operation === "execute_state_changing_test" &&
    !(declaration.scope.allow_state_changing_tests && (policy?.allow_state_changing_tests ?? false))
  ) {
    return deny("state_changing_not_declared", "the declaration does not allow tests that modify data");
  }
  const prohibitions = mergeProhibitions(declaration.prohibitions, policy?.prohibitions);
  if (prohibitions.operations?.includes(operation))
    return deny("prohibited", `${operation} is prohibited by the declaration`);
  const target = request.target;
  if (!target) return deny("target_required", `${operation} needs a ${isSource ? "path" : "URL"} target`);
  if (isSource) {
    if (target.kind !== "path") return deny("wrong_target_kind", `${operation} works on paths`);
    const check = checkPath(target.path, declaration.scope.source_roots, prohibitions.paths ?? []);
    if (check) return deny(check.reason, check.detail);
    return { allowed: true, operation, level, declaration_id: declaration.id };
  }
  if (target.kind !== "url") return deny("wrong_target_kind", `${operation} works on URLs`);
  const check = checkUrl(target.url, policy!, context.settings, prohibitions.url_prefixes ?? []);
  if (check) return deny(check.reason, check.detail);
  return { allowed: true, operation, level, declaration_id: declaration.id, scope_policy_version: policy!.version };
}

function minLevel(a: DeclarableLevel, b: DeclarableLevel): DeclarableLevel {
  return levelAtMost(a, b) ? a : b;
}

function mergeProhibitions(a: Prohibitions, b?: Prohibitions): Prohibitions {
  return {
    paths: [...(a.paths ?? []), ...(b?.paths ?? [])],
    url_prefixes: [...(a.url_prefixes ?? []), ...(b?.url_prefixes ?? [])],
    operations: [...(a.operations ?? []), ...(b?.operations ?? [])],
  };
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Lexical containment in a declared root. Symlinks are resolved by the root sandbox at file access (SEC-001);
 * this check decides whether a requested path is in scope at all.
 */
function checkPath(
  path: string,
  roots: string[],
  prohibited: string[],
): { reason: DenyReason; detail: string } | undefined {
  if (!isAbsolute(path)) return { reason: "out_of_scope_path", detail: "paths must be absolute" };
  const target = resolve(path);
  const root = roots.map((r) => resolve(r)).find((r) => inside(r, target));
  if (!root) return { reason: "out_of_scope_path", detail: "the path is outside every declared source root" };
  if (prohibited.some((p) => inside(isAbsolute(p) ? resolve(p) : resolve(root, p), target))) {
    return { reason: "prohibited", detail: "the path is prohibited by the declaration" };
  }
  return undefined;
}

const matchesPrefix = (path: string, prefix: string): boolean => {
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return prefix === "/" || path === prefix || path.startsWith(p);
};

/** Checks a URL against the scope policy. Query strings, fragments, page content and model output never widen it. */
export function checkUrl(
  raw: string,
  policy: ScopePolicy,
  settings: PlatformSettings,
  prohibitedPrefixes: string[] = [],
): { reason: DenyReason; detail: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "invalid_url", detail: "the URL cannot be parsed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { reason: "scheme_not_allowed", detail: `scheme ${url.protocol} is not allowed` };
  if (url.username !== "" || url.password !== "")
    return { reason: "url_has_credentials", detail: "credentials in URLs are not allowed; use a credential profile" };
  const hostClass = classifyHost(url.hostname);
  if (hostClass === "metadata")
    return { reason: "metadata_address", detail: "cloud metadata addresses are always refused" };
  const host = url.hostname.toLowerCase();
  const hostPort = url.port === "" ? host : `${host}:${url.port}`;
  // An entry without a port allows the scheme's default port only; `host:port` allows that port.
  const effectivePort = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  const allowed = policy.allowed_hosts.map((h) => h.toLowerCase());
  if (!allowed.includes(`${host}:${effectivePort}`) && !(url.port === "" && allowed.includes(host))) {
    return { reason: "host_not_allowed", detail: `host ${hostPort} is not in the scope policy` };
  }
  if (hostClass !== "public" && !(policy.local_owner_mode && settings.local_owner_mode_enabled)) {
    return {
      reason: "private_network",
      detail: `${hostClass} addresses need local owner mode for this environment (SEC-008)`,
    };
  }
  if (!policy.path_prefixes.some((prefix) => matchesPrefix(url.pathname, prefix))) {
    return { reason: "path_not_allowed", detail: `path ${url.pathname} is outside the scope policy's path prefixes` };
  }
  for (const prefix of prohibitedPrefixes) {
    let p: URL;
    try {
      p = new URL(prefix);
    } catch {
      continue;
    }
    const pHost = p.port === "" ? p.hostname : `${p.hostname}:${p.port}`;
    if (pHost.toLowerCase() === hostPort && matchesPrefix(url.pathname, p.pathname))
      return { reason: "prohibited", detail: "the URL is prohibited by the declaration" };
  }
  return undefined;
}
