import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTranslationInvariants } from "@sys2qa/platform";
import { bundleAdapter } from "../../../scripts/adapter-bundle.mjs";
import {
  analyzeStructure,
  budgetFor,
  completenessReport,
  detectStack,
  DOC_ROLES,
  loadSkbView,
  persistSkbRun,
  renderDocumentation,
  RootSandbox,
  scanInventory,
  type InventoryEntry,
  type RenderedDocument,
} from "../src/index.js";

const fixture = (p: string) => fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url));
const F1 = fixture("benchmarks/F1-repository-only/repo/");
const F4 = fixture("benchmarks/F4-incomplete-evidence/repo/");
let base: string;
let adapters: Array<{ id: string; entry: string }>;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "sys2qa-docs-"));
  adapters = [];
  for (const id of ["js-ts", "sql", "config", "docs"])
    adapters.push({
      id,
      entry: await bundleAdapter({
        entry: fileURLToPath(new URL(`../../saa-adapters/src/adapters/${id}/main.ts`, import.meta.url)),
        outfile: join(base, "bundle", `${id}.mjs`),
      }),
    });
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function skbOf(root: string, name: string): Promise<string> {
  const sandbox = await RootSandbox.open([root]);
  const inventory: InventoryEntry[] = [];
  await scanInventory(sandbox, { budget: budgetFor("standard") }, (e) => {
    inventory.push(e);
  });
  const included = inventory.filter((e) => e.status === "included");
  const stack = await detectStack(sandbox, included);
  const runId = `run:01JDOCS${name}`;
  const structure = await analyzeStructure({
    sandbox,
    included,
    boundaries: stack.boundaries,
    adapters,
    scratch: join(base, `scratch-${name}`),
    runId,
    revision: "1".repeat(40),
  });
  const completeness = completenessReport({
    runId,
    roots: ["repo"],
    inventory,
    boundaries: stack.boundaries,
    structure,
  });
  const dir = join(base, "skb", name);
  persistSkbRun(
    dir,
    {
      runId,
      revision: { kind: "git_commit", value: "1".repeat(40), worktree_dirty: false },
      structure,
      completeness,
      stack,
    },
    () => new Date("2026-10-25T12:00:00Z"),
  );
  return dir;
}

const idsIn = (markdown: string) => new Set([...markdown.matchAll(/`([a-z][a-z0-9_]*:[^`]+)`/g)].map((m) => m[1]));

describe("documentation renderer [@req SAA-FR-013] [@req SAA-FR-035] [@req LOC-011]", () => {
  it("renders every §12.2 role in en and id from the SKB, with the same IDs in both", async () => {
    const view = loadSkbView(await skbOf(F1, "F1"));
    const docs = renderDocumentation(view);
    for (const language of ["en", "id"] as const)
      for (const role of DOC_ROLES)
        expect(
          docs.some((d) => d.role === role && d.language === language),
          `${role} ${language}`,
        ).toBe(true);
    // One document per workflow and language.
    expect(docs.filter((d) => d.role === "workflows" && d.language === "en")).toHaveLength(view.workflows.length);
    const pairs = new Map<string, RenderedDocument[]>();
    for (const d of docs)
      pairs.set(d.path.replace(/^docs\/(en|id)\//, ""), [
        ...(pairs.get(d.path.replace(/^docs\/(en|id)\//, "")) ?? []),
        d,
      ]);
    for (const [file, [en, id]] of pairs) {
      expect(id, file).toBeDefined();
      expect(idsIn(id!.markdown), file).toEqual(idsIn(en!.markdown));
      // IDs, codes, paths and numbers survive between the languages (LOC-006 invariants, except negation words in
      // machine text, which stays in the model's language).
      const violations = checkTranslationInvariants(
        { text: en!.markdown, language: "en" },
        { text: id!.markdown, language: "id" },
      ).filter((v) => v.kind !== "negation_changed" && !(v.kind === "protected_token_missing" && v.token === "`en`"));
      expect(violations, file).toEqual([]);
      // Every document states revision, date, profile and language.
      expect(en!.markdown).toMatch(
        /Revision `111111111111` · analyzed `2026-10-25` · profile `standard` · language `en`/,
      );
      expect(id!.markdown).toMatch(/Revisi `111111111111` · dianalisis `2026-10-25` · profil `standard` · bahasa `id`/);
    }
    const byRole = (role: string, language = "en") =>
      docs.find((d) => d.role === role && d.language === language)!.markdown;
    expect(byRole("business_rules")).toContain("`business_rule:registration.password_min_12_characters`");
    expect(byRole("business_rules")).toContain("`gap:contradiction:registration.password_min_12_characters`");
    expect(byRole("roles_and_permissions")).toContain(
      "| `api:POST:/api/orders/{id}/decision` | `AUTHORIZES_WITH` | `actor_role:admin` |",
    );
    expect(byRole("workflow_catalog")).toContain("`workflow:job:cleanup.nightly`");
    expect(byRole("observed_behavior")).toContain("CON-025");
    expect(byRole("configuration_deployment")).toContain("`config_key:AWS_ACCESS_KEY_ID`");
    // Deterministic.
    expect(renderDocumentation(view)).toEqual(docs);
  }, 120_000);

  it("documents gaps instead of leaving sections out (F4)", async () => {
    const docs = renderDocumentation(loadSkbView(await skbOf(F4, "F4")), { languages: ["en"] });
    const byRole = (role: string) => docs.find((d) => d.role === role)!.markdown;
    expect(byRole("data_model")).toContain("None found within the examined scope.");
    expect(byRole("integrations_events")).toContain("`gap:consumer:orders.placed`");
    expect(byRole("unknowns")).toContain("`gap:external:api.shop.internal.example`");
    expect(byRole("routes_and_pages")).toContain("`config.loyaltyProgram`");
  }, 120_000);
});
