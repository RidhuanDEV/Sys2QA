import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkUrl,
  createIdGenerator,
  createLogger,
  LlmService,
  memorySink,
  NoneBackend,
  openStateDatabase,
  ProjectService,
  Redactor,
  type StateDatabase,
} from "../../packages/platform/src/index.js";
import {
  connectionTrap,
  diffPolicyState,
  findSentinels,
  INJECTION_PAGE,
  INJECTION_REPO,
  injectionCorpus,
  listZip,
  maliciousArchives,
  plantedSecrets,
  rebindingLookup,
  runMaliciousAdapter,
  scanFiles,
  scanText,
  snapshotPolicyState,
  SSRF_TARGETS,
  startSsrfFixtureServer,
  unsafeEntries,
  buildZip,
} from "./harness/index.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "sys2qa-security-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("secret-leak scanner (ST-04)", () => {
  it("detects planted secrets raw and encoded in a leaky stub's output", () => {
    const secret = (id: string) => plantedSecrets().find((s) => s.id === id)!.value;
    const leakyLog = [
      `key=${secret("aws_access_key_id")}`,
      `token=${Buffer.from(secret("github_token")).toString("base64")}`,
      `q=${encodeURIComponent(secret("staging_login_password"))}`,
    ].join("\n");
    writeFileSync(join(scratch, "leaky.log"), leakyLog);
    expect(scanFiles([scratch]).map((l) => [l.secret, l.encoding])).toEqual([
      ["aws_access_key_id", "raw"],
      ["github_token", "base64"],
      ["staging_login_password", "url"],
    ]);
  });

  it("finds nothing in the redacting logger's output when the same secrets appear in realistic contexts [@req SEC-004] [@req OBS-002]", () => {
    const secret = (id: string) => plantedSecrets().find((s) => s.id === id)!.value;
    const sink = memorySink();
    const redactor = new Redactor();
    // A credential the secret store manages is registered when it is injected into a job (IMP-010).
    redactor.addKnownSecret(secret("staging_login_password"));
    const log = createLogger({ sink, redactor });
    log.warn("adapter.output", {
      config: `aws_access_key_id = ${secret("aws_access_key_id")}\nAWS_SECRET_ACCESS_KEY=${secret("aws_secret_access_key")}\nDB_PASSWORD=${secret("env_db_password")}`,
      headers: `Authorization: Bearer ${secret("jwt")}`,
      github: `remote https://x-access-token:${secret("github_token")}@github.example/acme.git`,
      key: `-----BEGIN RSA PRIVATE KEY-----\n${secret("private_key_body")}\n-----END RSA PRIVATE KEY-----`,
      error: new Error(`login failed with ${secret("staging_login_password")}`),
    });
    expect(scanText(sink.lines.join("\n"), "log")).toEqual([]);
  });

  it("finds nothing in the canonical contract packages [@req SEC-004]", () => {
    expect(scanFiles([fileURLToPath(new URL("../../fixtures/contract/packages/valid/", import.meta.url))])).toEqual([]);
  });
});

describe("prompt-injection corpus (ST-03)", () => {
  it("is planted in a fixture repository and a fixture page", () => {
    const corpus = injectionCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(9);
    const planted = [
      readFileSync(join(INJECTION_REPO, "README.md"), "utf8"),
      readFileSync(join(INJECTION_REPO, "src", "registration.ts"), "utf8"),
      readFileSync(INJECTION_PAGE, "utf8"),
    ].join("\n");
    expect(corpus.filter((e) => planted.includes(e.text.split("\n")[0]!.slice(0, 40))).length).toBeGreaterThanOrEqual(
      6,
    );
  });

  describe("policy snapshots", () => {
    let dir: string;
    let state: StateDatabase;
    let service: ProjectService;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "sys2qa-injection-"));
      state = openStateDatabase({ path: join(dir, "state.db") });
      service = new ProjectService(state.db, {
        audit: { redactor: new Redactor(), now: () => new Date() },
        newId: createIdGenerator(),
      });
    });
    afterEach(() => {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("detect a gullible stub that obeys injected text", () => {
      const before = snapshotPolicyState(state.db);
      if (readFileSync(join(INJECTION_REPO, "README.md"), "utf8").includes("enabled repository code execution"))
        service.setSetting("l4_enabled", true, "gullible-stub");
      expect(diffPolicyState(before, snapshotPolicyState(state.db))).toEqual(["settings"]);
    });

    it("show no policy change when the corpus goes through the LLM port, and the data block cannot be closed [@req SEC-003] [@req SAA-FR-019]", async () => {
      const project = service.createProject({ name: "Injection", actor: "owner" });
      const source = service.addEvidenceSource(project.id, "source_root", INJECTION_REPO);
      service.declare(source.id, { declaredBy: "owner", operationLevel: "L1" });
      const before = snapshotPolicyState(state.db);
      const llm = new LlmService(new NoneBackend(), { redactor: new Redactor() });
      const data = injectionCorpus().map((e) => ({ label: e.id, content: e.text }));
      const { messages } = llm.buildMessages({
        purpose: "saa.describe",
        promptTemplate: { id: "t", version: "1" },
        instructions: "Describe the module.",
        data,
        outputSchema: { type: "object" },
      });
      expect(messages[1]!.content.match(/<\/untrusted_data>/g)).toHaveLength(data.length);
      await llm.generate({
        purpose: "saa.describe",
        promptTemplate: { id: "t", version: "1" },
        instructions: "Describe the module.",
        data,
        outputSchema: { type: "object" },
      });
      expect(
        service.authorize(source.id, "execute_repository_code", { kind: "path", path: INJECTION_REPO }),
      ).toMatchObject({ allowed: false });
      expect(diffPolicyState(before, snapshotPolicyState(state.db))).toEqual([]);
    });
  });
});

describe("SSRF and DNS fixtures (ST-05, ST-06)", () => {
  it("records a gullible client following a redirect to an internal address, but not a careful one", async () => {
    const server = await startSsrfFixtureServer();
    try {
      await fetch(`${server.origin}/redirect/internal`);
      expect(server.hits.map((h) => h.path)).toEqual(["/redirect/internal", "/internal/secret"]);
      server.hits.length = 0;
      const careful = await fetch(`${server.origin}/chain/3`, { redirect: "manual" });
      expect(careful.status).toBe(302);
      expect(server.hits.map((h) => h.path)).toEqual(["/chain/3"]);
      const upgraded = await new Promise<number | undefined>((resolve) => {
        const req = request(`${server.origin}/ws`, { headers: { connection: "Upgrade", upgrade: "websocket" } });
        req.on("upgrade", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode);
        });
        req.end();
      });
      expect(upgraded).toBe(101);
      expect(server.hits.at(-1)).toMatchObject({ path: "/ws", upgrade: true });
    } finally {
      await server.close();
    }
  });

  it("every redirect target is refused by the URL policy [@req SEC-007] [@req SEC-008]", () => {
    const policy = {
      environment_id: "env:s",
      version: 1,
      base_url: "https://staging.acme.example/",
      classification: "staging" as const,
      allowed_hosts: ["staging.acme.example"],
      path_prefixes: ["/"],
      local_owner_mode: false,
      declaration_id: "d",
      max_level: "L2" as const,
      allow_state_changing_tests: false,
      prohibitions: {},
    };
    for (const target of Object.values(SSRF_TARGETS))
      expect(
        checkUrl(target, policy, { l4_enabled: false, local_owner_mode_enabled: false, telemetry_enabled: false }),
        target,
      ).toBeDefined();
  });

  it("alternates public and private answers to simulate DNS rebinding", () => {
    const lookup = rebindingLookup();
    const answers: string[] = [];
    for (let i = 0; i < 3; i++) lookup("rebind.example", {}, (_e, address) => answers.push(address));
    expect(answers).toEqual(["93.184.216.34", "127.0.0.1", "93.184.216.34"]);
  });
});

describe("malicious adapter stub (ST-14)", () => {
  it("is detected opening a socket", async () => {
    const trap = await connectionTrap();
    try {
      await runMaliciousAdapter(["--connect", String(trap.port)]);
      await new Promise((r) => setTimeout(r, 50));
      expect(trap.connections()).toBe(1);
    } finally {
      await trap.close();
    }
  });

  it("is detected writing outside its scratch directory and spawning processes", async () => {
    await runMaliciousAdapter(["--write-outside", scratch]);
    await runMaliciousAdapter(["--spawn", scratch]);
    expect(
      findSentinels([scratch])
        .map((p) => p.slice(scratch.length + 1))
        .sort(),
    ).toEqual(["SYS2QA_SENTINEL_adapter", "SYS2QA_SENTINEL_spawn"]);
  });

  it("is stopped by a memory limit", async () => {
    const outcome = await runMaliciousAdapter(["--memory"], ["--max-old-space-size=32"]);
    expect(outcome.code === 0 && outcome.signal === null).toBe(false);
  }, 30_000);

  it("the injection repository's install scripts have never run (ST-02 baseline)", () => {
    expect(findSentinels([INJECTION_REPO])).toEqual([]);
  });
});

describe("malicious package archives (ST-13)", () => {
  it("contain the hostile entries an importer must refuse", () => {
    const archives = maliciousArchives();
    const unsafe = Object.fromEntries(
      Object.entries(archives).map(([name, buf]) => [name, unsafeEntries(listZip(buf))]),
    );
    expect(unsafe).toEqual({
      zip_slip: ["../../outside.txt"],
      absolute_path: ["/etc/cron.d/evil"],
      windows_drive: ["C:\\Windows\\evil.dll"],
      symlink: ["docs/link"],
      oversized: [],
      entry_flood: [],
    });
    expect(listZip(archives.oversized!).find((e) => e.name === "system-model.json")?.size).toBe(4_000_000_000);
    expect(listZip(archives.entry_flood!)).toHaveLength(20_001);
    expect(
      unsafeEntries(
        listZip(buildZip([{ name: "manifest.json", data: Buffer.from("{}") }, { name: "docs/en/index.md" }])),
      ),
    ).toEqual([]);
  });
});
