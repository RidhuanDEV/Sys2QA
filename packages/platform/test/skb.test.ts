import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  indexSkbRun,
  listSkbRuns,
  openStateDatabase,
  queryEdges,
  queryEntities,
  queryWorkflows,
  readSkbDocument,
  readSkbManifest,
  readSkbRecords,
  rebuildIndex,
  runDirectory,
  shardRecords,
  SkbIntegrityError,
  sweepSkbRuns,
  writeFileAtomic,
  writeSkbRun,
  type SkbRun,
} from "../src/index.js";

const EV = "evidence:0123456789abcdef";
const entity = (id: string, kind: string, name = id) => ({
  id,
  kind,
  name,
  status: "source_verified",
  origin: "source",
  evidence_ids: [EV],
});
function run(runId: string, extra = 0): SkbRun {
  return {
    run_id: runId,
    producer: "SAA",
    revision: { kind: "git_commit", value: "a".repeat(40), worktree_dirty: false },
    records: {
      entities: [
        entity("api:POST:/api/orders", "api", "POST /api/orders"),
        entity("entity:order", "entity", "order"),
        {
          ...entity("business_rule:order.amount_1_to_10000", "business_rule", "amount"),
          statement: "amount must be from 1 to 10000.",
        },
        ...Array.from({ length: extra }, (_, i) => entity(`module:m${i}`, "module")),
      ],
      relationships: [
        {
          id: "relationship:1",
          type: "WRITES_TO",
          from: "api:POST:/api/orders",
          to: "entity:order",
          status: "source_verified",
          evidence_ids: [EV],
        },
      ],
      claims: [],
      evidence: [
        {
          id: EV,
          source_type: "source_code",
          captured_at: "2026-10-25T00:00:00Z",
          extractor: { adapter: "js-ts", version: "0.1.0", method: "test" },
          path: "src/orders.ts",
          range: { start_line: 1, end_line: 2 },
          file_fingerprint: `sha256:${"b".repeat(64)}`,
          excerpt_policy: "digest_only",
          excerpt_digest: `sha256:${"c".repeat(64)}`,
        },
      ],
      workflows: [
        {
          id: "workflow:api:POST:/api/orders",
          name: "POST /api/orders",
          category: "api",
          origin: "source",
          discovery_status: "reconstructed",
          entry_point_ids: ["api:POST:/api/orders"],
          component_trace_ids: [],
          steps: [{ id: "step:api:POST:/api/orders#1", order: 1, entity_id: "api:POST:/api/orders", action: "handle" }],
          branches: [],
          unresolved_hops: [],
          completion: "partial",
          deepened: true,
          rank: 1,
          status: "source_verified",
          evidence_ids: [EV],
        },
      ],
      component_traces: [],
    },
    documents: { coverage: [{ area: "src/orders.ts", status: "analyzed" }], gaps: [] },
  } as unknown as SkbRun;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sys2qa-skb-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const PROJECT = "project:01JPROJECT0000000000000000";
const now = () => new Date("2026-10-25T10:00:00Z");

describe("SKB store [@req SAA-FR-012] [@req NFR-005]", () => {
  it("writes atomically and leaves no temporary files", () => {
    const file = join(home, "a.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(readdirSync(home)).toEqual(["a.json"]);
  });

  it("shards by ID hash within the limits, deterministically", () => {
    const records = Array.from({ length: 1000 }, (_, i) => ({ id: `module:m${i}` }));
    const shards = shardRecords(records, { maxRecords: 300, maxBytes: 1 << 30 });
    expect(shards.length).toBeGreaterThanOrEqual(4);
    expect(shards.every((s) => s.length <= 300)).toBe(true);
    expect(shards.flat().length).toBe(1000);
    expect(shardRecords([...records].reverse(), { maxRecords: 300, maxBytes: 1 << 30 })).toEqual(shards);
    // The byte limit splits further.
    expect(
      shardRecords(records, { maxRecords: 5000, maxBytes: 4000 }).every((s) => JSON.stringify(s).length <= 4000),
    ).toBe(true);
  });

  it("writes partitions and the manifest last, and detects tampering", () => {
    const dir = runDirectory(home, PROJECT, "run:01JRUNA");
    const manifest = writeSkbRun(dir, run("run:01JRUNA", 12), now, { maxRecords: 5, maxBytes: 1 << 30 });
    expect(manifest.counts).toMatchObject({ entities: 15, relationships: 1, workflows: 1, evidence: 1 });
    expect(manifest.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "entities/api/000.json",
        "entities/module/000.json",
        "relationships/000.json",
        "coverage.json",
      ]),
    );
    expect(manifest.files.filter((f) => f.path.startsWith("entities/module/")).length).toBeGreaterThanOrEqual(3);
    expect(readSkbManifest(dir)).toEqual(manifest);
    expect([...readSkbRecords(dir, manifest)].filter((r) => r.collection === "entities")).toHaveLength(15);
    expect(readSkbDocument(dir, manifest, "coverage")).toEqual([{ area: "src/orders.ts", status: "analyzed" }]);
    // Same content, same bytes.
    const again = runDirectory(home, PROJECT, "run:01JRUNB");
    writeSkbRun(again, { ...run("run:01JRUNA", 12) }, now, { maxRecords: 5, maxBytes: 1 << 30 });
    expect(readFileSync(join(again, "relationships/000.json"), "utf8")).toBe(
      readFileSync(join(dir, "relationships/000.json"), "utf8"),
    );
    // A changed file is refused.
    writeFileSync(
      join(dir, "relationships/000.json"),
      readFileSync(join(dir, "relationships/000.json"), "utf8").replace("WRITES_TO", "READS_FROM"),
    );
    expect(() => [...readSkbRecords(dir, manifest)]).toThrow(SkbIntegrityError);
    expect(() => writeSkbRun(dir, run("run:01JRUNA"), now)).toThrow(/already exists/);
    const escaping = run("run:01JRUNC");
    (escaping.records.entities as unknown[]).push(entity("x:y", "../../outside"));
    expect(() => writeSkbRun(runDirectory(home, PROJECT, "run:01JRUNC"), escaping, now)).toThrow(/invalid entity kind/);
  });

  it("ignores and sweeps incomplete runs, keeps the newest five and protected ones", () => {
    const skb = join(home, "projects", "01JPROJECT0000000000000000", "skb");
    for (let i = 0; i < 7; i++)
      writeSkbRun(join(skb, `01JRUN${i}`), run(`run:01JRUN${i}`), () => new Date(Date.UTC(2026, 9, 25, 10, i)));
    mkdirSync(join(skb, "01JCRASHED"));
    writeFileSync(join(skb, "01JCRASHED", "entities.json"), "{}");
    writeFileSync(join(skb, "01JRUN6", "x.json.tmp-abc123"), "partial");
    expect(listSkbRuns(skb).map((r) => r.manifest.run_id)).not.toContain("run:01JCRASHED");
    const removed = sweepSkbRuns(skb, { keep: 5, protect: new Set(["run:01JRUN0"]) });
    expect(removed.sort()).toEqual(["01JCRASHED", "01JRUN1"]);
    expect(listSkbRuns(skb).map((r) => r.manifest.run_id)).toEqual([
      "run:01JRUN0",
      "run:01JRUN2",
      "run:01JRUN3",
      "run:01JRUN4",
      "run:01JRUN5",
      "run:01JRUN6",
    ]);
    expect(existsSync(join(skb, "01JRUN6", "x.json.tmp-abc123"))).toBe(false);
  });
});

describe("SKB index [@req SAA-FR-012]", () => {
  it("indexes a run, answers queries, and gives identical answers after a rebuild", () => {
    const state = openStateDatabase({ path: ":memory:", now });
    const dir = runDirectory(home, PROJECT, "run:01JRUNA");
    const manifest = writeSkbRun(dir, run("run:01JRUNA", 3), now);
    expect(indexSkbRun(state.db, dir, manifest)).toMatchObject({
      entities: 6,
      relationships: 1,
      workflows: 1,
      evidence: 1,
    });
    const answers = () => ({
      apis: queryEntities(state.db, { run_id: "run:01JRUNA", kind: "api" }),
      text: queryEntities(state.db, { run_id: "run:01JRUNA", text: "10000" }),
      injection: queryEntities(state.db, { run_id: "run:01JRUNA", text: 'amount" OR *' }),
      edges: queryEdges(state.db, "run:01JRUNA", "api:POST:/api/orders"),
      workflows: queryWorkflows(state.db, "run:01JRUNA"),
    });
    const before = answers();
    expect(before.text.map((e) => e.id)).toEqual(["business_rule:order.amount_1_to_10000"]);
    expect(before.injection).toEqual([]);
    expect(before.edges).toEqual([
      { from_id: "api:POST:/api/orders", to_id: "entity:order", type: "WRITES_TO", status: "source_verified" },
    ]);
    expect(rebuildIndex(state.db, home)).toEqual({ runs: 1, failed: [] });
    expect(answers()).toEqual(before);
    state.close();
  });

  it("never half-indexes a run that breaks the contract", () => {
    const state = openStateDatabase({ path: ":memory:", now });
    const bad = run("run:01JBAD");
    (bad.records.relationships as unknown[]).push({
      id: "relationship:2",
      type: "NOT_A_TYPE",
      from: "a:b",
      to: "c:d",
      status: "source_verified",
      evidence_ids: [],
    });
    const dir = runDirectory(home, PROJECT, "run:01JBAD");
    const manifest = writeSkbRun(dir, bad, now);
    expect(() => indexSkbRun(state.db, dir, manifest)).toThrow(SkbIntegrityError);
    expect(queryEntities(state.db, { run_id: "run:01JBAD" })).toEqual([]);
    expect(rebuildIndex(state.db, home).failed.map((f) => f.run_id)).toEqual(["run:01JBAD"]);
    state.close();
  });
});
