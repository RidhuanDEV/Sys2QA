import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  chainHead,
  createLogger,
  exportAudit,
  fileSink,
  memorySink,
  openStateDatabase,
  Redactor,
  verifyAuditChain,
  type AuditContext,
  type StateDatabase,
} from "../src/index.js";

const AT = "2026-10-22T10:00:00.000Z";
const now = () => new Date(AT);

/** Planted secrets (ST-04): none of these strings may appear in any log line or audit record. */
const SECRETS = {
  aws: "AKIAIOSFODNN7EXAMPLE",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  github: `ghp_${"a1B2".repeat(9)}`,
  bearer: "Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  privateKeyBody: "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  envValue: "s3cr3t-db-pa55word",
  plainPassword: "correct horse battery staple",
};
const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\n${SECRETS.privateKeyBody}\n-----END RSA PRIVATE KEY-----`;

function leaked(text: string): string[] {
  return Object.entries(SECRETS)
    .filter(([, secret]) => text.includes(secret.replace(/^Bearer /, "")))
    .map(([name]) => name);
}

let dir: string;
let state: StateDatabase;
let context: AuditContext;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sys2qa-audit-"));
  state = openStateDatabase({ path: join(dir, "state.db"), now });
  context = { redactor: new Redactor(), now };
  for (const id of ["project:a", "project:b"]) {
    state.db
      .prepare(
        "INSERT INTO projects (id, name, default_languages_json, created_at, updated_at) VALUES (?, 'P', '[\"en\"]', ?, ?)",
      )
      .run(id, AT, AT);
  }
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("structured logging [@req OBS-002] [@req QAA-FR-101] [@req SEC-004]", () => {
  it("never writes a planted secret, whether in values, sensitive fields, nested data or errors (ST-04, logging part)", () => {
    const sink = memorySink();
    const redactor = new Redactor();
    redactor.addKnownSecret(SECRETS.plainPassword); // as the secret store does when it injects a credential
    const log = createLogger({ sink, redactor, level: "debug", now }).child({
      job_id: "job:01JBQD00000000000000000000",
    });
    log.info("credential.used", { role: "applicant", secret_ref: "secretref:applicant", password: SECRETS.envValue });
    log.debug("http.request", {
      headers: { Authorization: SECRETS.bearer, cookie: "session=abc123def456" },
      url: "https://staging.example/login",
    });
    log.warn("adapter.output", {
      excerpt: `const key = "${SECRETS.aws}"; const t = "${SECRETS.jwt}";`,
      file: PRIVATE_KEY,
    });
    log.error("job.failed", {
      error: new Error(`login failed for token ${SECRETS.github} with ${SECRETS.plainPassword}`),
    });
    const output = sink.lines.join("\n");
    expect(leaked(output)).toEqual([]);
    const first = JSON.parse(sink.lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      ts: AT,
      level: "info",
      event: "credential.used",
      job_id: "job:01JBQD00000000000000000000",
      secret_ref: "secretref:applicant",
      password: "[REDACTED]",
    });
    expect(first.redacted_paths).toEqual(["/password"]);
    expect(output).toContain("https://staging.example/login");
  });

  it("filters by level and rejects malformed event names", () => {
    const sink = memorySink();
    const log = createLogger({ sink, redactor: new Redactor(), level: "warn", now });
    log.info("job.transition", { from: "queued", to: "running" });
    log.warn("policy.decision", { decision: "deny", reason: "production_refused" });
    expect(sink.lines).toHaveLength(1);
    expect(() => log.warn("Policy Decision")).toThrow(/event name/);
  });

  it("writes JSON lines to a daily file", () => {
    const logs = join(dir, "logs");
    const log = createLogger({ sink: fileSink(logs, now), redactor: new Redactor(), now });
    log.info("job.transition", { job_id: "job:1", from: "queued", to: "running" });
    log.info("job.transition", { job_id: "job:1", from: "running", to: "completed" });
    expect(readdirSync(logs)).toEqual(["sys2qa-2026-10-22.log"]);
    const lines = readFileSync(join(logs, "sys2qa-2026-10-22.log"), "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { to: string }).to)).toEqual(["running", "completed"]);
  });
});

describe("audit trail [@req SEC-014] [@req OBS-006]", () => {
  it("is written in the same transaction as the action and rolls back with it", () => {
    expect(() =>
      appendAudit(state.db, { projectId: "project:a", actor: "user", action: "approval.granted" }, context),
    ).toThrow(/transaction/);
    state.transaction(() =>
      appendAudit(
        state.db,
        { projectId: "project:a", actor: "user", action: "approval.granted", target: "approval:1" },
        context,
      ),
    );
    expect(() =>
      state.transaction(() => {
        appendAudit(
          state.db,
          { projectId: "project:a", actor: "user", action: "run.started", target: "run:1" },
          context,
        );
        throw new Error("run could not start");
      }),
    ).toThrow(/could not start/);
    expect(exportAudit(state.db).map((e) => e.action)).toEqual(["approval.granted"]);
  });

  it("redacts secrets in details and records which fields were redacted [@req SEC-004]", () => {
    const record = state.transaction(() =>
      appendAudit(
        state.db,
        {
          projectId: "project:a",
          actor: "user",
          action: "credential.configured",
          target: "env:staging",
          details: { role: "applicant", password: SECRETS.envValue, note: `token ${SECRETS.github}` },
        },
        context,
      ),
    );
    expect(record.details).toMatchObject({
      role: "applicant",
      password: "[REDACTED]",
      redacted_paths: ["/password", "/note"],
    });
    expect(leaked(JSON.stringify(exportAudit(state.db)))).toEqual([]);
  });

  it("rejects actions outside the audit catalog", () => {
    expect(() =>
      state.transaction(() => appendAudit(state.db, { actor: "user", action: "job.transition" as never }, context)),
    ).toThrow(/unknown audit action/);
  });

  it("exports per project and installation-wide events in order", () => {
    state.transaction(() => {
      appendAudit(state.db, { projectId: "project:a", actor: "user", action: "authorization.declared" }, context);
      appendAudit(state.db, { projectId: null, actor: "system", action: "export.created" }, context);
      appendAudit(state.db, { projectId: "project:a", actor: "user", action: "scope_policy.changed" }, context);
    });
    expect(exportAudit(state.db, { projectId: "project:a" }).map((e) => e.action)).toEqual([
      "authorization.declared",
      "scope_policy.changed",
    ]);
    expect(exportAudit(state.db, { projectId: null }).map((e) => e.action)).toEqual(["export.created"]);
  });
});

describe("audit integrity (ST-16) [@req SEC-014]", () => {
  function seed(): void {
    state.transaction(() => {
      appendAudit(state.db, { projectId: "project:a", actor: "user", action: "authorization.declared" }, context);
      appendAudit(state.db, { projectId: "project:b", actor: "user", action: "authorization.declared" }, context);
      appendAudit(
        state.db,
        { projectId: "project:a", actor: "user", action: "approval.granted", target: "approval:1" },
        context,
      );
      appendAudit(state.db, { projectId: null, actor: "system", action: "export.created" }, context);
    });
  }

  it("verifies an untouched trail and links each project's events into its own chain", () => {
    seed();
    expect(verifyAuditChain(state.db)).toEqual({ ok: true, events: 4 });
    const a = exportAudit(state.db, { projectId: "project:a" });
    expect(a[0]!.prev_hash).toBeNull();
    expect(a[1]!.prev_hash).toBe(a[0]!.hash);
  });

  it("detects a modified row even when the append-only trigger is bypassed", () => {
    seed();
    state.db.exec("DROP TRIGGER audit_events_no_update"); // an attacker with write access to state.db
    state.db.prepare("UPDATE audit_events SET actor = 'mallory' WHERE seq = 3").run();
    expect(verifyAuditChain(state.db)).toEqual({ ok: false, seq: 3, reason: "event content does not match its hash" });
  });

  it("detects a removed event in the middle of a chain", () => {
    seed();
    state.db.exec("DROP TRIGGER audit_events_no_delete");
    state.db.prepare("DELETE FROM audit_events WHERE seq = 1").run();
    expect(verifyAuditChain(state.db)).toMatchObject({ ok: false, seq: 3 });
  });

  it("stays valid after a project is deleted, because other chains do not depend on it [@req SEC-015]", () => {
    seed();
    const head = chainHead(state.db, "project:a");
    state.transaction(() => {
      state.db
        .prepare(
          "INSERT INTO project_deletions (project_id, requested_by, requested_at, created_at, updated_at) VALUES ('project:a', 'user', ?, ?, ?)",
        )
        .run(AT, AT, AT);
      appendAudit(
        state.db,
        {
          projectId: null,
          actor: "user",
          action: "project.deleted",
          target: "project:a",
          details: { last_audit_hash: head },
        },
        context,
      );
      state.db.prepare("DELETE FROM projects WHERE id = 'project:a'").run();
    });
    expect(verifyAuditChain(state.db)).toEqual({ ok: true, events: 3 });
    expect(exportAudit(state.db, { projectId: null }).at(-1)?.details).toEqual({ last_audit_hash: head });
  });
});
