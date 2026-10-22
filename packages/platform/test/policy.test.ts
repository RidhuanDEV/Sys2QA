import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyHost,
  createIdGenerator,
  createLogger,
  decide,
  exportAudit,
  memorySink,
  openStateDatabase,
  ProjectService,
  Redactor,
  verifyAuditChain,
  type Declaration,
  type Operation,
  type PlatformSettings,
  type PolicyContext,
  type ScopePolicy,
  type StateDatabase,
} from "../src/index.js";

const ROOT = resolve("/work/acme-portal");
const OFF: PlatformSettings = { l4_enabled: false, local_owner_mode_enabled: false, telemetry_enabled: false };

function declaration(
  level: Declaration["operation_level"],
  extra: Partial<Declaration["scope"]> = {},
  prohibitions: Declaration["prohibitions"] = {},
): Declaration {
  return {
    id: "declaration:1",
    project_id: "project:1",
    evidence_source_id: "source:1",
    declared_by: "owner@example.com",
    declared_at: "2026-10-22T10:00:00.000Z",
    operation_level: level,
    scope: { source_roots: [ROOT], allow_state_changing_tests: false, ...extra },
    prohibitions,
  };
}
function policy(extra: Partial<ScopePolicy> = {}): ScopePolicy {
  return {
    environment_id: "env:staging",
    version: 3,
    base_url: "https://staging.acme.example/",
    classification: "staging",
    allowed_hosts: ["staging.acme.example"],
    path_prefixes: ["/"],
    local_owner_mode: false,
    declaration_id: "declaration:1",
    max_level: "L3",
    allow_state_changing_tests: false,
    prohibitions: {},
    ...extra,
  };
}
const path = (p: string) => ({ kind: "path" as const, path: resolve(ROOT, p) });
const url = (u: string) => ({ kind: "url" as const, url: u });
const outcome = (operation: Operation, context: PolicyContext, target = SOURCE_TARGET(operation)) => {
  const d = decide({ operation, target }, context);
  return d.allowed ? "allowed" : `${d.code}:${d.reason}`;
};
const SOURCE_TARGET = (op: Operation) =>
  ["inventory", "static_read", "execute_repository_code"].includes(op)
    ? path("src/app.ts")
    : url("https://staging.acme.example/registrasi");

describe("policy decisions for every permission level [@req SEC-005] [@req SEC-006] [@req SEC-009]", () => {
  it.each([
    // operation, declared level, settings, expected
    ["inventory", "L0", OFF, "allowed"],
    ["static_read", "L0", OFF, "SCOPE_DENIED:level_not_declared"],
    ["static_read", "L1", OFF, "allowed"],
    ["execute_repository_code", "L1", OFF, "SCOPE_DENIED:level_not_declared"],
    ["execute_repository_code", "L4", OFF, "SCOPE_DENIED:level_disabled"],
    ["execute_repository_code", "L4", { ...OFF, l4_enabled: true }, "allowed"],
    ["observe", "L2", OFF, "allowed"],
    ["submit_read_only_form", "L2", OFF, "SCOPE_DENIED:level_not_declared"],
    ["submit_read_only_form", "L2r", OFF, "allowed"],
    ["execute_test", "L2r", OFF, "SCOPE_DENIED:level_not_declared"],
    ["execute_test", "L3", OFF, "allowed"],
    ["execute_state_changing_test", "L3", OFF, "SCOPE_DENIED:state_changing_not_declared"],
    ["touch_production", "L3", OFF, "PRODUCTION_REFUSED:out_of_scope_level"],
  ] as const)("%s with a %s declaration → %s", (operation, level, settings, expected) => {
    expect(outcome(operation, { declaration: declaration(level), scopePolicy: policy(), settings })).toBe(expected);
  });

  it("allows state-changing tests only when both the declaration and the scope policy allow them", () => {
    const d = declaration("L3", { allow_state_changing_tests: true });
    expect(
      outcome("execute_state_changing_test", {
        declaration: d,
        scopePolicy: policy({ allow_state_changing_tests: true }),
        settings: OFF,
      }),
    ).toBe("allowed");
    expect(outcome("execute_state_changing_test", { declaration: d, scopePolicy: policy(), settings: OFF })).toBe(
      "SCOPE_DENIED:state_changing_not_declared",
    );
  });

  it("refuses everything without a declaration and every environment operation on production", () => {
    expect(outcome("inventory", { settings: OFF })).toBe("SCOPE_DENIED:no_declaration");
    expect(
      outcome("observe", {
        declaration: declaration("L3"),
        scopePolicy: policy({ classification: "production" }),
        settings: OFF,
      }),
    ).toBe("PRODUCTION_REFUSED:production");
  });

  it("caps the level at the lower of the declaration and the scope policy", () => {
    expect(
      outcome("execute_test", {
        declaration: declaration("L3"),
        scopePolicy: policy({ max_level: "L2" }),
        settings: OFF,
      }),
    ).toBe("SCOPE_DENIED:level_not_declared");
  });
});

describe("source scope [@req SEC-005]", () => {
  const ctx = (p: Declaration["prohibitions"] = {}) => ({ declaration: declaration("L1", {}, p), settings: OFF });
  it.each([
    ["src/app.ts", "allowed"],
    [".", "allowed"],
    ["../other-repo/secret.ts", "SCOPE_DENIED:out_of_scope_path"],
    ["src/../../etc/passwd", "SCOPE_DENIED:out_of_scope_path"],
  ])("%s → %s", (p, expected) => {
    expect(outcome("static_read", ctx(), path(p))).toBe(expected);
  });

  it("refuses relative paths, prohibited paths and URL targets", () => {
    expect(outcome("static_read", ctx(), { kind: "path", path: "src/app.ts" })).toBe("SCOPE_DENIED:out_of_scope_path");
    expect(outcome("static_read", ctx({ paths: ["secrets"] }), path("secrets/prod.env"))).toBe(
      "SCOPE_DENIED:prohibited",
    );
    expect(outcome("static_read", ctx(), url("https://staging.acme.example/"))).toBe("SCOPE_DENIED:wrong_target_kind");
  });
});

describe("URL scope, SSRF and private networks [@req QAA-FR-002] [@req SEC-007] [@req SEC-008]", () => {
  const ctx = (p: Partial<ScopePolicy> = {}, settings = OFF, prohibitions: Declaration["prohibitions"] = {}) => ({
    declaration: declaration("L2", {}, prohibitions),
    scopePolicy: policy(p),
    settings,
  });
  it.each([
    ["https://staging.acme.example/registrasi?next=https://evil.example/", "allowed"],
    ["https://STAGING.acme.example:443/", "allowed"],
    ["https://staging.acme.example:8443/", "SCOPE_DENIED:host_not_allowed"],
    ["https://evil.example/", "SCOPE_DENIED:host_not_allowed"],
    ["https://staging.acme.example.evil.example/", "SCOPE_DENIED:host_not_allowed"],
    ["ftp://staging.acme.example/", "SCOPE_DENIED:scheme_not_allowed"],
    ["https://user:pass@staging.acme.example/", "SCOPE_DENIED:url_has_credentials"],
    ["http://169.254.169.254/latest/meta-data/", "SCOPE_DENIED:metadata_address"],
    ["not a url", "SCOPE_DENIED:invalid_url"],
  ])("%s → %s", (u, expected) => {
    expect(outcome("observe", ctx(), url(u))).toBe(expected);
  });

  it("matches path prefixes on segment boundaries, including after dot-segment normalization", () => {
    const scoped = ctx({ path_prefixes: ["/app"] });
    expect(outcome("observe", scoped, url("https://staging.acme.example/app/forms"))).toBe("allowed");
    expect(outcome("observe", scoped, url("https://staging.acme.example/application"))).toBe(
      "SCOPE_DENIED:path_not_allowed",
    );
    expect(outcome("observe", scoped, url("https://staging.acme.example/app/../admin"))).toBe(
      "SCOPE_DENIED:path_not_allowed",
    );
    expect(outcome("observe", scoped, url("https://staging.acme.example/app/%2e%2e/admin"))).toBe(
      "SCOPE_DENIED:path_not_allowed",
    );
  });

  it("allows a loopback target only in local owner mode enabled by an administrator, and never metadata addresses", () => {
    const local = { allowed_hosts: ["localhost:3000", "169.254.169.254"], base_url: "http://localhost:3000/" };
    expect(outcome("observe", ctx(local), url("http://localhost:3000/"))).toBe("SCOPE_DENIED:private_network");
    expect(outcome("observe", ctx({ ...local, local_owner_mode: true }), url("http://localhost:3000/"))).toBe(
      "SCOPE_DENIED:private_network",
    );
    const enabled = { ...OFF, local_owner_mode_enabled: true };
    expect(outcome("observe", ctx({ ...local, local_owner_mode: true }, enabled), url("http://localhost:3000/"))).toBe(
      "allowed",
    );
    expect(outcome("observe", ctx({ ...local, local_owner_mode: true }, enabled), url("http://localhost:4000/"))).toBe(
      "SCOPE_DENIED:host_not_allowed",
    );
    expect(outcome("observe", ctx({ ...local, local_owner_mode: true }, enabled), url("http://169.254.169.254/"))).toBe(
      "SCOPE_DENIED:metadata_address",
    );
  });

  it("refuses prohibited URL prefixes", () => {
    expect(
      outcome(
        "observe",
        ctx({}, OFF, { url_prefixes: ["https://staging.acme.example/admin"] }),
        url("https://staging.acme.example/admin/users"),
      ),
    ).toBe("SCOPE_DENIED:prohibited");
  });

  it.each([
    ["localhost", "loopback"],
    ["app.localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["[::1]", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.20.0.1", "private"],
    ["192.168.1.10", "private"],
    ["100.64.0.1", "private"],
    ["fd12:3456::1", "private"],
    ["169.254.10.10", "link_local"],
    ["fe80::1", "link_local"],
    ["169.254.169.254", "metadata"],
    ["0.0.0.0", "unspecified"],
    ["staging.acme.example", "public"],
    ["8.8.8.8", "public"],
    ["2001:db8::1", "public"],
  ])("classifies %s as %s", (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe("projects, declarations and environments [@req SYS-001] [@req QAA-FR-001] [@req QAA-FR-002] [@req SEC-005] [@req SEC-014]", () => {
  let dir: string;
  let state: StateDatabase;
  let service: ProjectService;
  let clock: number;
  const now = () => new Date(clock);
  const sink = memorySink();
  beforeEach(() => {
    clock = Date.parse("2026-10-22T10:00:00.000Z");
    dir = mkdtempSync(join(tmpdir(), "sys2qa-projects-"));
    state = openStateDatabase({ path: join(dir, "state.db"), now });
    const redactor = new Redactor();
    service = new ProjectService(state.db, {
      audit: { redactor, now },
      newId: createIdGenerator(now),
      logger: createLogger({ sink, redactor, now }),
    });
    sink.lines.length = 0;
  });
  afterEach(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const env = {
    baseUrl: "https://staging.acme.example/",
    classification: "staging" as const,
    allowedHosts: ["staging.acme.example"],
  };

  it("derives the starting mode from evidence and keeps the project when evidence is added", () => {
    const project = service.createProject({ name: "Acme portal", languages: ["en", "id"], actor: "owner" });
    expect(service.evidenceMode(project.id)).toBe("none");
    service.addEvidenceSource(project.id, "source_root", ROOT);
    expect(service.evidenceMode(project.id)).toBe("A");
    service.addEvidenceSource(project.id, "environment", env.baseUrl);
    expect(service.evidenceMode(project.id)).toBe("C");
    expect(service.getProject(project.id).default_languages).toEqual(["en", "id"]);
  });

  it("refuses analysis and environment configuration before a declaration, then enforces it", () => {
    const project = service.createProject({ name: "Acme", actor: "owner" });
    const source = service.addEvidenceSource(project.id, "source_root", ROOT);
    expect(service.authorize(source.id, "static_read", path("src/app.ts"))).toMatchObject({
      allowed: false,
      reason: "no_declaration",
    });
    service.declare(source.id, { declaredBy: "owner@example.com", operationLevel: "L1" });
    expect(service.authorize(source.id, "static_read", path("src/app.ts")).allowed).toBe(true);
    const environment = service.addEvidenceSource(project.id, "environment", env.baseUrl);
    expect(() => service.configureEnvironment(environment.id, env, "owner")).toThrow(/declaration/);
    expect(() => service.declare(environment.id, { declaredBy: "owner@example.com", operationLevel: "L1" })).toThrow(
      /does not apply/,
    );
    service.declare(environment.id, { declaredBy: "owner@example.com", operationLevel: "L2" });
    expect(service.configureEnvironment(environment.id, env, "owner").version).toBe(1);
    expect(service.authorize(environment.id, "observe", url("https://staging.acme.example/registrasi")).allowed).toBe(
      true,
    );
    expect(
      service.authorize(environment.id, "execute_test", url("https://staging.acme.example/registrasi")),
    ).toMatchObject({ allowed: false, reason: "level_not_declared" });
    const decisions = sink.lines
      .map((l) => JSON.parse(l) as { event: string; allowed: boolean })
      .filter((l) => l.event === "policy.decision");
    expect(decisions.map((d) => d.allowed)).toEqual([false, true, true, false]);
  });

  it("rejects an out-of-scope base URL at configuration time", () => {
    const project = service.createProject({ name: "Acme", actor: "owner" });
    const environment = service.addEvidenceSource(project.id, "environment", "http://localhost:3000/");
    service.declare(environment.id, { declaredBy: "owner", operationLevel: "L2" });
    expect(() =>
      service.configureEnvironment(environment.id, { ...env, baseUrl: "https://other.example/" }, "owner"),
    ).toThrow(/host other.example/);
    expect(() =>
      service.configureEnvironment(
        environment.id,
        {
          baseUrl: "http://localhost:3000/",
          classification: "development",
          allowedHosts: ["localhost:3000"],
          localOwnerMode: true,
        },
        "owner",
      ),
    ).toThrow(/local owner mode/);
    service.setSetting("local_owner_mode_enabled", true, "admin");
    expect(
      service.configureEnvironment(
        environment.id,
        {
          baseUrl: "http://localhost:3000/",
          classification: "development",
          allowedHosts: ["localhost:3000"],
          localOwnerMode: true,
        },
        "owner",
      ).local_owner_mode,
    ).toBe(true);
  });

  it("keeps declarations append-only and versions the scope policy only when it changes", () => {
    const project = service.createProject({ name: "Acme", actor: "owner" });
    const environment = service.addEvidenceSource(project.id, "environment", env.baseUrl);
    service.declare(environment.id, { declaredBy: "owner", operationLevel: "L3" });
    expect(service.configureEnvironment(environment.id, env, "owner").version).toBe(1);
    expect(service.configureEnvironment(environment.id, env, "owner").version).toBe(1);
    clock += 1000;
    service.declare(environment.id, { declaredBy: "owner", operationLevel: "L2" });
    expect(service.currentScopePolicy(environment.id)).toMatchObject({ version: 2, max_level: "L2" });
    expect(() => state.db.prepare("UPDATE authorization_declarations SET operation_level = 'L4'").run()).toThrow(
      /append-only/,
    );
    expect(() => state.db.prepare("DELETE FROM scope_policies").run()).toThrow(/append-only/);
    expect(exportAudit(state.db, { projectId: project.id }).map((e) => e.action)).toEqual([
      "project.created",
      "authorization.declared",
      "environment.configured",
      "scope_policy.changed",
      "environment.configured",
      "authorization.declared",
      "scope_policy.changed",
    ]);
  });

  it("refuses a production environment at decision time", () => {
    const project = service.createProject({ name: "Acme", actor: "owner" });
    const environment = service.addEvidenceSource(project.id, "environment", "https://www.acme.example/");
    service.declare(environment.id, { declaredBy: "owner", operationLevel: "L2" });
    service.configureEnvironment(
      environment.id,
      { baseUrl: "https://www.acme.example/", classification: "production", allowedHosts: ["www.acme.example"] },
      "owner",
    );
    expect(service.authorize(environment.id, "observe", url("https://www.acme.example/"))).toMatchObject({
      allowed: false,
      code: "PRODUCTION_REFUSED",
    });
  });

  it("enables L4 only through an audited administrator setting", () => {
    const project = service.createProject({ name: "Acme", actor: "owner" });
    const source = service.addEvidenceSource(project.id, "source_root", ROOT);
    service.declare(source.id, { declaredBy: "owner", operationLevel: "L4" });
    expect(service.authorize(source.id, "execute_repository_code", path("."))).toMatchObject({
      allowed: false,
      reason: "level_disabled",
    });
    service.setSetting("l4_enabled", true, "admin");
    expect(service.authorize(source.id, "execute_repository_code", path(".")).allowed).toBe(true);
    expect(exportAudit(state.db, { projectId: null }).map((e) => [e.action, e.target])).toEqual([
      ["settings.changed", "l4_enabled"],
    ]);
  });

  it("deletes a project's state and leaves the remaining audit trail verifiable [@req SEC-015]", () => {
    const keep = service.createProject({ name: "Keep", actor: "owner" });
    const project = service.createProject({ name: "Acme", actor: "owner" });
    const environment = service.addEvidenceSource(project.id, "environment", env.baseUrl);
    service.declare(environment.id, { declaredBy: "owner", operationLevel: "L2" });
    service.configureEnvironment(environment.id, env, "owner");
    service.deleteProject(project.id, "owner");
    expect(() => service.getProject(project.id)).toThrow(/not found/);
    for (const table of ["evidence_sources", "authorization_declarations", "environments", "scope_policies"]) {
      expect(state.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(service.getProject(keep.id).name).toBe("Keep");
    expect(verifyAuditChain(state.db).ok).toBe(true);
    expect(exportAudit(state.db, { projectId: null }).at(-1)).toMatchObject({
      action: "project.deleted",
      target: project.id,
    });
  });
});
