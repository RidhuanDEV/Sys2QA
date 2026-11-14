import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { buildZip, maliciousArchives, type ZipEntry } from "./harness/index.js";

const CONTRACT = fileURLToPath(new URL("../../fixtures/contract/", import.meta.url));
const VALID = join(CONTRACT, "packages", "valid", "mode-a-saa");
const INVALID = join(CONTRACT, "invalid");
const work = mkdtempSync(join(tmpdir(), "sys2qa-st13-"));
let host: Host;
let services: AppServices;
let projectId: string;
const caller = { interface: "cli" as const, actor: "tester" };

/** The files of a package directory as ZIP entries, optionally under one wrapping folder. */
function zipOf(dir: string, prefix = ""): Buffer {
  const entries: ZipEntry[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries.push({ name: prefix + relative(dir, path).split(sep).join("/"), data: readFileSync(path) });
    }
  };
  walk(dir);
  return buildZip(entries);
}

function write(name: string, bytes: Buffer): string {
  const path = join(work, "archives", name);
  mkdirSync(join(work, "archives"), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

const importPackage = (path: string) => services.execute("package.import", { project_id: projectId, path }, caller);
const code = (r: ServiceResult) => (r.ok ? "accepted" : r.error.code);
const projectDir = () => join(host.home, "projects", projectId.slice("project:".length));
const stored = () =>
  ["imports", "packages"].flatMap((d) => (existsSync(join(projectDir(), d)) ? readdirSync(join(projectDir(), d)) : []));

beforeAll(() => {
  host = openHost({ home: mkdtempSync(join(work, "home-")) });
  services = new AppServices(host);
  const created = services.execute("project.create", { name: "Imports" }, caller);
  return created.then((r) => {
    projectId = (r as { ok: true; data: { id: string } }).data.id;
  });
});
afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("ST-13 malicious package import [@req SEC-021] [@req QAA-FR-009] [@req CON-009]", () => {
  const hostile = maliciousArchives();
  it.each([
    ["zip_slip", "PKG_PATH_UNSAFE"],
    ["absolute_path", "PKG_PATH_UNSAFE"],
    ["windows_drive", "PKG_PATH_UNSAFE"],
    ["symlink", "PKG_PATH_UNSAFE"],
    ["oversized", "PKG_TOO_LARGE"],
    ["entry_flood", "PKG_TOO_LARGE"],
  ])("refuses the %s archive with %s and stores nothing", async (name, expected) => {
    const result = await importPackage(write(`${name}.zip`, hostile[name]!));
    expect(code(result)).toBe(expected);
    expect(stored()).toEqual([]);
  });

  it("writes nothing outside the import directory for a zip-slip archive", async () => {
    await importPackage(write("slip.zip", hostile.zip_slip!));
    for (const dir of [projectDir(), join(projectDir(), ".."), join(projectDir(), "..", ".."), host.home, work])
      expect(existsSync(join(dir, "outside.txt")), dir).toBe(false);
  });

  it("refuses a compression bomb whose entry inflates beyond its declared size", async () => {
    const bomb = buildZip([
      { name: "manifest.json", data: Buffer.from("{}") },
      { name: "system-model.json", data: Buffer.alloc(32 * 1024 * 1024), declaredSize: 1024 },
    ]);
    expect(code(await importPackage(write("bomb.zip", bomb)))).toBe("PKG_TOO_LARGE");
  });

  it("refuses an archive that is not a ZIP as unreadable", async () => {
    expect(code(await importPackage(write("garbage.zip", Buffer.from("not an archive at all"))))).toBe("PKG_NOT_FOUND");
  });

  it.each([
    ["checksum mismatch", "PKG_CHECKSUM_MISMATCH"],
    ["secret-bearing", "PKG_SECRET_SUSPECTED"],
    ["cross-producer", "PKG_EVIDENCE_PROFILE_INCONSISTENT"],
  ])("refuses a %s package with its contract code", async (_label, expected) => {
    const fixture = join(INVALID, expected, readdirSync(join(INVALID, expected))[0]!, "package");
    const result = await importPackage(write(`${expected}.zip`, zipOf(fixture)));
    expect(code(result)).toBe(expected);
    expect(stored()).toEqual([]);
    // A detected secret is never echoed back.
    expect(JSON.stringify(result)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("refuses a package directory containing a symbolic link", async (ctx) => {
    const dir = join(work, "linked");
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(VALID)) {
      const from = join(VALID, name);
      if (statSync(from).isFile()) writeFileSync(join(dir, name), readFileSync(from));
    }
    try {
      symlinkSync(fileURLToPath(new URL("../../package.json", import.meta.url)), join(dir, "linked.json"));
    } catch {
      ctx.skip(); // creating links needs privileges on some Windows runners
    }
    expect(code(await importPackage(dir))).toBe("PKG_PATH_UNSAFE");
  });

  it("audits every refusal without file contents", () => {
    const rows = host.state.db
      .prepare("SELECT details_json FROM audit_events WHERE action = 'package.import_refused'")
      .all() as Array<{ details_json: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect(Object.keys(JSON.parse(r.details_json) as object).sort()).toEqual(["code", "stage"]);
  });

  it("imports a valid archive wrapped in a folder and keeps the archive byte for byte [@req CON-010]", async () => {
    const zip = zipOf(VALID, "acme-package/");
    const result = await importPackage(write("valid.zip", zip));
    expect(code(result)).toBe("accepted");
    const data = (result as { ok: true; data: { original: { path: string; sha256: string; kind: string } } }).data;
    expect(data.original.kind).toBe("archive");
    const kept = readFileSync(join(data.original.path, "valid.zip"));
    expect(`sha256:${createHash("sha256").update(kept).digest("hex")}`).toBe(
      `sha256:${createHash("sha256").update(zip).digest("hex")}`,
    );
    expect(data.original.sha256).toBe(`sha256:${createHash("sha256").update(zip).digest("hex")}`);
  });

  it("never uses a stored package that was changed afterwards", async () => {
    const list = await services.execute("package.list", { project_id: projectId }, caller);
    const [pkg] = (
      list as { ok: true; data: { packages: Array<{ package_id: string; version: number; path: string }> } }
    ).data.packages;
    const show = () =>
      services.execute(
        "package.show",
        { project_id: projectId, package_id: pkg!.package_id, version: pkg!.version },
        caller,
      );
    expect(code(await show())).toBe("accepted");
    const model = join(pkg!.path, "system-model.json");
    writeFileSync(model, readFileSync(model, "utf8").replace(/}\s*$/, ', "tampered": true}'));
    expect(code(await show())).toBe("PKG_CHECKSUM_MISMATCH");
  });
});
