import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLogger,
  EncryptedFileSecretBackend,
  exportAudit,
  memorySink,
  MemorySecretBackend,
  openStateDatabase,
  Redactor,
  SecretService,
  selectSecretBackend,
  type StateDatabase,
} from "../src/index.js";

const PASS = "correct horse battery staple";
const VALUE = "Applicant!Fixture#2026";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sys2qa-secrets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("encrypted file backend [@req SEC-011]", () => {
  it("round-trips values and stores only ciphertext", async () => {
    const path = join(dir, "secrets.enc");
    const store = new EncryptedFileSecretBackend(path, PASS);
    await store.set("secretref:p1.login", VALUE);
    expect(await new EncryptedFileSecretBackend(path, PASS).get("secretref:p1.login")).toBe(VALUE);
    expect(readFileSync(path, "utf8")).not.toContain(VALUE);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await store.delete("secretref:p1.login")).toBe(true);
    expect(await store.get("secretref:p1.login")).toBeUndefined();
  });

  it("refuses a wrong passphrase, a tampered entry and an entry moved to another reference", async () => {
    const path = join(dir, "secrets.enc");
    await new EncryptedFileSecretBackend(path, PASS).set("secretref:p1.login", VALUE);
    await expect(
      new EncryptedFileSecretBackend(path, "not the passphrase").get("secretref:p1.login"),
    ).rejects.toMatchObject({ code: "SECRET_STORE_LOCKED" });
    const file = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { data: string }> };
    const moved = { ...file, entries: { "secretref:p2.login": file.entries["secretref:p1.login"]! } };
    writeFileSync(path, JSON.stringify(moved));
    await expect(new EncryptedFileSecretBackend(path, PASS).get("secretref:p2.login")).rejects.toMatchObject({
      code: "SECRET_STORE_LOCKED",
    });
    const data = Buffer.from(file.entries["secretref:p1.login"]!.data, "base64");
    data[0] = data[0]! ^ 1;
    file.entries["secretref:p1.login"]!.data = data.toString("base64");
    writeFileSync(path, JSON.stringify(file));
    await expect(new EncryptedFileSecretBackend(path, PASS).get("secretref:p1.login")).rejects.toMatchObject({
      code: "SECRET_STORE_LOCKED",
    });
    expect(() => new EncryptedFileSecretBackend(path, "short")).toThrow(/too short/);
  });

  it("selects the OS store when it works, the encrypted file with a passphrase otherwise, and never stores unencrypted", async () => {
    const filePath = join(dir, "secrets.enc");
    expect(
      (await selectSecretBackend({ mode: "auto", filePath, passphrase: PASS, osAvailable: async () => true })).kind,
    ).toBe("os");
    expect(
      (await selectSecretBackend({ mode: "auto", filePath, passphrase: PASS, osAvailable: async () => false })).kind,
    ).toBe("file");
    await expect(selectSecretBackend({ mode: "auto", filePath, osAvailable: async () => false })).rejects.toMatchObject(
      { code: "SECRET_STORE_UNAVAILABLE" },
    );
    await expect(
      selectSecretBackend({ mode: "os", filePath, passphrase: PASS, osAvailable: async () => false }),
    ).rejects.toMatchObject({ code: "SECRET_STORE_UNAVAILABLE" });
    expect(
      (await selectSecretBackend({ mode: "file", filePath, passphrase: PASS, osAvailable: async () => true })).kind,
    ).toBe("file");
  });
});

describe("secret references and job injection [@req SEC-011] [@req QAA-FR-005] [@req SEC-004] [@req SEC-014]", () => {
  let state: StateDatabase;
  let redactor: Redactor;
  const now = () => new Date("2026-10-22T10:00:00.000Z");
  beforeEach(() => {
    state = openStateDatabase({ path: join(dir, "state.db"), now });
    redactor = new Redactor();
    for (const id of ["project:a", "project:b"])
      state.db
        .prepare(
          "INSERT INTO projects (id, name, default_languages_json, created_at, updated_at) VALUES (?, 'P', '[\"en\"]', 'x', 'x')",
        )
        .run(id);
  });
  afterEach(() => state.close());

  it("keeps values out of state.db, logs and audit, and releases them only to a job of the owning project", async () => {
    const service = new SecretService(state.db, new EncryptedFileSecretBackend(join(dir, "secrets.enc"), PASS), {
      redactor,
      now,
    });
    const info = await service.put("project:a", "staging-login", VALUE, "owner");
    expect(info).toMatchObject({ ref: "secretref:a.staging-login", project_id: "project:a", backend: "file" });
    const values = await service.injectForJob("project:a", "job:1", [info.ref]);
    expect(values.get(info.ref)).toBe(VALUE);
    await expect(service.injectForJob("project:b", "job:2", [info.ref])).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });

    const sink = memorySink();
    createLogger({ sink, redactor, now }).error("job.failed", { message: `login rejected for ${VALUE}` });
    expect(sink.lines.join("\n")).not.toContain(VALUE);

    expect(exportAudit(state.db, { projectId: "project:a" }).map((e) => [e.action, e.target, e.details])).toEqual([
      ["credential.configured", info.ref, { backend: "file" }],
      ["credential.used", info.ref, { job_id: "job:1" }],
    ]);
    state.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const file of readdirSync(dir).filter((f) => f.startsWith("state.db")))
      expect(readFileSync(join(dir, file)).toString("latin1"), file).not.toContain(VALUE);
  });

  it("removes values with their references and lists every reference of a project for deletion", async () => {
    const backend = new MemorySecretBackend();
    const service = new SecretService(state.db, backend, { redactor, now });
    const a = await service.put("project:a", "one", "value-one-xyz", "owner");
    await service.put("project:a", "two", "value-two-xyz", "owner");
    await service.remove(a.ref, "owner");
    expect(backend.values.has(a.ref)).toBe(false);
    expect(await service.removeAllForProject("project:a")).toEqual(["secretref:a.two"]);
    expect(backend.values.size).toBe(0);
    await expect(service.put("project:a", "Bad Name", "x", "owner")).rejects.toMatchObject({ code: "INVALID" });
    await expect(service.put("project:zzz", "x", "v", "owner")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
