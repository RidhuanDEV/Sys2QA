import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_CODES, main } from "../../apps/cli/src/index.js";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { loadSkbView, type SkbView } from "../../packages/saa-core/src/index.js";
import { PackageQuery } from "../../packages/system-model/src/index.js";
import { bundleSaaAdapters, computeMetrics, loadGroundTruth, saaProducer } from "../benchmark/harness/index.js";

/**
 * Gate 1 acceptance (IMP-121, PRD §29.1, Test Strategy §8): one block per checklist item, run on the benchmark
 * fixtures F1 and F4 and the monorepo fixture. `scripts/gate-report.mjs` maps these blocks to the checklist.
 */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const BENCH = join(REPO, "fixtures", "benchmarks");
const F1 = join(BENCH, "F1-repository-only", "repo");
const F4 = join(BENCH, "F4-incomplete-evidence", "repo");
const MONOREPO = join(REPO, "fixtures", "saa", "monorepo");
const TIMEOUT = 180_000;

const data = (r: ServiceResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as Record<string, unknown>;
};

/** Path → sha256 of every file and directory below `dir`, so any write (even an empty directory) shows. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const key = relative(dir, path).split(sep).join("/");
      if (statSync(path).isDirectory()) {
        out[`${key}/`] = "dir";
        walk(path);
      } else out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

interface Analyzed {
  run: Record<string, unknown>;
  view: SkbView;
  pkg: PackageQuery;
  pkgPath: string;
  validation: Record<string, unknown>;
}

let work: string;
let adapters: Array<{ id: string; entry: string }>;
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "owner@example.com" };
const call = async (operation: string, input: unknown) => services.execute(operation, input, caller);
const runs: Record<"f1" | "f4" | "mono", Analyzed> = {} as never;

async function analyze(name: string, root: string): Promise<Analyzed> {
  const started = data(await call("saa.start", { name, root }));
  const source = (started.source as { id: string }).id;
  data(await call("project.declare", { source_id: source, declared_by: caller.actor, operation_level: "L1" }));
  const run = data(await call("saa.analyze", { source_id: source }));
  const row = host.state.db.prepare("SELECT artifact_path FROM analysis_runs WHERE id = ?").get(run.run_id) as {
    artifact_path: string;
  };
  const exported = data(await call("saa.export", { run_id: run.run_id }));
  const pkgPath = exported.path as string;
  return {
    run,
    view: loadSkbView(row.artifact_path),
    pkg: PackageQuery.open(pkgPath),
    pkgPath,
    validation: data(await call("package.validate", { path: pkgPath })),
  };
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "sys2qa-gate1-"));
  adapters = await bundleSaaAdapters(join(work, "adapters"));
  host = openHost({ home: mkdtempSync(join(work, "home-")), adapters });
  services = new AppServices(host);
  runs.f1 = await analyze("Acme portal", F1);
  runs.f4 = await analyze("Shop front", F4);
  runs.mono = await analyze("Acme mono", join(MONOREPO, "repo"));
}, TIMEOUT);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("Gate 1 item 1: the CLI analyzes a repository with no AI agent; read-only, static, no scripts run [@req SAA-FR-001] [@req SAA-FR-004] [@req SAA-FR-014] [@req SAA-FR-036]", () => {
  it(
    "runs start → declare → analyze → export → validate from the CLI alone and leaves the repository byte-identical",
    async () => {
      const repo = join(work, "cli-acme-portal");
      cpSync(F1, repo, { recursive: true });
      const before = tree(repo);
      const home = mkdtempSync(join(work, "cli-home-"));
      let out = "";
      const io = { stdout: (t: string) => (out += t), stderr: () => {}, cwd: work, env: {}, host: { adapters } };
      const json = async (...argv: string[]) => {
        out = "";
        const code = await main([...argv, "--home", home, "--json"], io);
        return { code, result: JSON.parse(out) as ServiceResult };
      };
      const started = await json("start", "Acme portal", repo);
      expect(started.code).toBe(EXIT_CODES.ok);
      const source = (data(started.result).source as { id: string }).id;
      // Without a declaration nothing is read.
      expect((await json("analyze", source)).code).toBe(EXIT_CODES.denied);
      expect((await json("declare", source, "--level", "L1", "--by", "owner@example.com")).code).toBe(EXIT_CODES.ok);
      const analyzed = await json("analyze", source);
      expect(analyzed.code).toBe(EXIT_CODES.ok);
      const runId = data(analyzed.result).run_id as string;
      const exported = await json("export", runId);
      expect(exported.code).toBe(EXIT_CODES.ok);
      const validated = await json("validate", data(exported.result).path as string);
      expect(data(validated.result)).toMatchObject({ ok: true, stage: "complete" });
      // An export into the repository is refused and writes nothing there.
      expect((await json("export", runId, "--output", join(repo, ".saa"))).code).toBe(EXIT_CODES.conflict);
      // `postinstall: prisma generate` and every other script stayed unrun: no file was added, changed or removed.
      expect(tree(repo)).toEqual(before);
    },
    TIMEOUT,
  );

  it("authorizes the analysis as L1 static reading only", () => {
    const levels = host.state.db
      .prepare("SELECT DISTINCT operation_level FROM authorization_declarations")
      .all() as Array<{
      operation_level: string;
    }>;
    expect(levels).toEqual([{ operation_level: "L1" }]);
    expect(runs.f1.view.run).toMatchObject({ profile: "standard" });
  });
});

describe("Gate 1 item 2: the supported stack is detected with support levels; unsupported areas are explicit [@req SAA-FR-003] [@req SAA-FR-020] [@req SAA-FR-047]", () => {
  it("names F1's frameworks and every adapter's support level", () => {
    const stack = runs.f1.view.stack!;
    expect(stack.boundaries.flatMap((b) => b.frameworks.map((f) => f.name)).sort()).toEqual([
      "express",
      "node-cron",
      "prisma",
      "react",
      "react-router",
    ]);
    for (const b of stack.boundaries) for (const f of b.frameworks) expect(f.support, f.name).toMatch(/\S/);
    const adaptersUsed = (runs.f1.view.run as { adapters: Array<{ id: string; support_level?: unknown }> }).adapters;
    expect(adaptersUsed.map((a) => a.id).sort()).toEqual(["config", "docs", "js-ts", "sql"]);
  });

  it("states what no adapter covers instead of leaving it out", () => {
    const { run, view } = runs.mono;
    expect(run.status).toBe("completed_with_limitations");
    expect(run.unavailable_adapters).toEqual([expect.objectContaining({ adapter: "python" })]);
    expect(view.completeness!.unexplored).toContainEqual({
      area: "services/worker/app/main.py",
      reason: "unsupported: no analyzer adapter for python",
    });
    expect(view.stack!.unknown).toEqual({ ".tf": 1 });
    expect(runs.mono.pkg.manifest.coverage_summary).toMatchObject({ modules: "partial" });
  });
});

describe("Gate 1 item 3: boundaries and dependency graphs are correct for the benchmark monorepo [@req SAA-FR-002] [@req SAA-FR-005] [@req SAA-FR-006]", () => {
  const expected = JSON.parse(readFileSync(join(MONOREPO, "expected.json"), "utf8")) as {
    boundaries: Array<{ id: string; kind: string; status: string }>;
    dependencies: Array<{ from: string; to: string; type: string }>;
    unexplored: string[];
  };

  it("finds exactly the expected boundaries with their kind and status", () => {
    const found = runs.mono.view.stack!.boundaries.map((b) => ({ id: b.id, kind: b.kind, status: b.status }));
    expect(found).toEqual(expected.boundaries.map((b) => ({ id: b.id, kind: b.kind, status: b.status })));
  });

  it("finds exactly the expected boundary dependencies, each with evidence", () => {
    const deps = runs.mono.view.relationships.filter((r) => r.type === "DEPENDS_ON");
    expect(
      deps.map((r) => ({ from: r.from, to: r.to, type: r.type })).sort((a, b) => a.from.localeCompare(b.from)),
    ).toEqual(expected.dependencies);
    for (const d of deps) expect(d.evidence_ids.length).toBeGreaterThan(0);
  });

  it("keeps F1 as one application without inventing boundary dependencies", () => {
    expect(runs.f1.view.stack!.boundaries.map((b) => b.id)).toEqual(["project:."]);
    expect(runs.f1.view.relationships.filter((r) => r.type === "DEPENDS_ON")).toEqual([]);
  });
});

describe("Gate 1 item 4: workflows are discovered with no names supplied; discovery, reconstruction and uncertainty are measured separately [@req SAA-FR-040] [@req SAA-FR-046]", () => {
  it("discovers F1's workflows from the repository alone", () => {
    // saa.start took a project name and a path; no workflow, route or entity name was supplied.
    const ids = runs.f1.pkg.workflows().map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining(["workflow:page:web:/register", "workflow:job:cleanup.nightly"]));
  });

  it(
    "reports the three metric families separately and meets the gate rules on F1 and F4",
    async () => {
      for (const fixture of ["F1-repository-only", "F4-incomplete-evidence"]) {
        const truth = loadGroundTruth(join(BENCH, fixture, "ground-truth"), fixture);
        const metrics = computeMetrics(
          truth,
          await saaProducer(join(BENCH, fixture, "repo"), { adapters, scratch: join(work, "bench", fixture) }),
        );
        expect(Object.keys(metrics)).toEqual(
          expect.arrayContaining([
            "discovery",
            "reconstruction",
            "uncertainty",
            "over_claiming",
            "evidence_traceability",
          ]),
        );
        expect(metrics.over_claiming.count, fixture).toBe(0);
        expect(metrics.evidence_traceability, fixture).toBe(1);
        expect(
          metrics.gates.filter((g) => !g.passed),
          fixture,
        ).toEqual([]);
      }
    },
    TIMEOUT,
  );

  it("never counts a gap or a known-not-traceable entry as a discovered workflow", () => {
    for (const { pkg } of Object.values(runs))
      for (const w of pkg.workflows()) expect(w.id, w.id).toMatch(/^workflow:/);
  });
});

describe("Gate 1 item 5: every catalog entry has a discovery status; traces and workflows are distinct; stops are explained [@req CON-024] [@req SAA-FR-041] [@req SAA-FR-009]", () => {
  it("gives every workflow a discovery status and completion, and explains every unresolved hop", () => {
    for (const [name, { pkg }] of Object.entries(runs))
      for (const w of pkg.workflows()) {
        expect(
          ["reconstructed", "partially_reconstructed", "known_not_traceable", "excluded", "not_observed"],
          `${name} ${w.id}`,
        ).toContain(w.discovery_status);
        expect(w.completion, w.id).toMatch(/\S/);
        for (const hop of w.unresolved_hops) {
          expect(hop.reason_code, w.id).toMatch(/\S/);
          expect(hop.gap_id ?? hop.description, w.id).toBeTruthy();
        }
      }
  });

  it("keeps component traces separate from end-to-end workflows", () => {
    const { view } = runs.f1;
    const traceIds = new Set(view.component_traces.map((t) => t.id));
    expect(traceIds.size).toBeGreaterThan(0);
    for (const w of view.workflows) {
      expect(traceIds.has(w.id)).toBe(false);
      for (const t of w.component_trace_ids) expect(traceIds.has(t), `${w.id} → ${t}`).toBe(true);
    }
  });

  it("explains F4's stops: missing repository, unconsumed topic, run-time condition", () => {
    const reasons = runs.f4.pkg.workflows().flatMap((w) => w.unresolved_hops.map((h) => h.reason_code));
    expect(reasons).toEqual(expect.arrayContaining(["missing_repository"]));
    expect(runs.f4.pkg.unknowns().gaps.map((g) => g.id)).toEqual(
      expect.arrayContaining(["gap:consumer:orders.placed", "gap:route-condition:app:/loyalty"]),
    );
  });
});

describe("Gate 1 item 6: the completeness report states scope, unresolved links, adapters, unexplored areas and helpful evidence, never a system total [@req SAA-FR-045] [@req CON-028]", () => {
  it("has every section, within the examined scope", () => {
    for (const [name, { view }] of Object.entries(runs)) {
      const report = view.completeness!;
      expect(report.count_scope, name).toBe("within_examined_scope");
      expect(report.examined.roots?.length, name).toBe(1);
      for (const key of ["unresolved_workflow_ids", "unavailable_adapters", "unexplored", "improvement_suggestions"])
        expect(Array.isArray((report as unknown as Record<string, unknown>)[key]), `${name} ${key}`).toBe(true);
    }
    expect(runs.f4.view.completeness!.unresolved_workflow_ids.length).toBeGreaterThan(0);
    expect(runs.f4.view.completeness!.improvement_suggestions.length).toBeGreaterThan(0);
  });

  it("never states a total workflow count for the system", () => {
    for (const [name, { view, pkgPath }] of Object.entries(runs)) {
      expect(JSON.stringify(view.completeness), name).not.toMatch(/"total/i);
      const docs = readdirSync(join(pkgPath, "docs", "en"), { recursive: true })
        .filter((f) => String(f).endsWith(".md"))
        .map((f) => readFileSync(join(pkgPath, "docs", "en", String(f)), "utf8"))
        .join("\n");
      expect(docs, name).not.toMatch(/total (number of )?workflows|workflows in the system|all workflows/i);
      expect(docs, name).toMatch(/within the examined scope/i);
    }
  });
});

describe("Gate 1 item 7: roles, routes/pages/forms, business rules and state machines are emitted or gap-recorded [@req SAA-FR-030] [@req SAA-FR-031] [@req SAA-FR-032] [@req SAA-FR-033] [@req SAA-FR-034] [@req CON-007]", () => {
  it("emits them for F1", () => {
    const { pkg } = runs.f1;
    expect(pkg.byKind("actor_role").map((e) => e.id)).toHaveLength(2);
    expect(pkg.byKind("page").length).toBe(7);
    expect(pkg.byKind("form").length).toBe(5);
    expect(pkg.rules().map((e) => e.id)).toEqual(
      expect.arrayContaining([
        "business_rule:registration.password_min_12_characters",
        "business_rule:registration.nib_13_digits",
      ]),
    );
    expect(pkg.stateMachines().map((e) => e.id)).toEqual(["state_machine:order.status"]);
  });

  it("records a gap for every category that is absent or unsupported", () => {
    for (const [name, { pkg }] of Object.entries(runs)) {
      const summary = pkg.manifest.coverage_summary as Record<string, string>;
      const gaps = pkg.unknowns().gaps;
      for (const [category, value] of Object.entries(summary))
        if (["absent", "unsupported", "unobservable"].includes(value))
          expect(
            gaps.some((g) => g.coverage_category === category),
            `${name}: ${category} is ${value}`,
          ).toBe(true);
    }
    // F4 has no business rules, roles or state machines: each is absent with its gap.
    expect(runs.f4.pkg.manifest.coverage_summary).toMatchObject({
      business_rules: "absent",
      roles_permissions: "absent",
      state_transitions: "absent",
    });
  });
});

describe("Gate 1 item 8: SKB and package pass validation; claims are evidence-backed or classified; partial and failed runs are never complete [@req SAA-FR-012] [@req SAA-FR-029] [@req SAA-FR-043] [@req SAA-FR-010] [@req CON-023]", () => {
  it("validates every package completely with the shared contract library", () => {
    for (const [name, { validation }] of Object.entries(runs))
      expect(validation, name).toMatchObject({ ok: true, stage: "complete" });
  });

  it("backs every source-verified claim with source-type evidence and classifies the rest", () => {
    // CR-001: source-verified needs code, configuration, schema, migration or manifest evidence.
    const sourceTypes = new Set(["source_code", "configuration", "schema", "migration", "manifest"]);
    for (const [name, { view }] of Object.entries(runs))
      for (const claim of view.claims) {
        expect(claim.status, `${name} ${claim.id}`).toMatch(/\S/);
        if (claim.status === "source_verified") {
          const cited = (claim as { evidence_ids?: string[] }).evidence_ids ?? [];
          const evidence = view.evidence.filter((e) => cited.includes(e.id));
          expect(evidence.length, claim.id).toBeGreaterThan(0);
          expect(
            evidence.some((e) => sourceTypes.has(e.source_type)),
            claim.id,
          ).toBe(true);
        }
      }
    // A contradiction keeps the code as the evidence of behavior and is recorded as an open question (F1 ground truth).
    const rule = runs.f1.pkg.entity("business_rule:registration.password_min_12_characters") as unknown as {
      contradiction_ids: string[];
    };
    expect(rule.contradiction_ids).toEqual(["gap:contradiction:registration.password_min_12_characters"]);
    expect(runs.f1.pkg.unknowns().questions.map((g) => g.id)).toContain(
      "gap:contradiction:registration.password_min_12_characters",
    );
  });

  it(
    "marks runs with gaps as limited, and a failed run is shown failed and cannot be exported",
    async () => {
      expect(runs.f1.run.status).toBe("completed_with_limitations");
      const gone = join(work, "vanishing-repo");
      cpSync(F4, gone, { recursive: true });
      const started = data(await call("saa.start", { name: "Vanishing", root: gone }));
      const source = (started.source as { id: string }).id;
      data(await call("project.declare", { source_id: source, declared_by: caller.actor, operation_level: "L1" }));
      rmSync(gone, { recursive: true, force: true });
      expect((await call("saa.analyze", { source_id: source })).ok).toBe(false);
      const status = data(await call("saa.status", { project_id: (started.project as { id: string }).id }));
      const [failed] = status.runs as Array<{ run_id: string; status: string; stored: boolean }>;
      expect(failed).toMatchObject({ status: "failed", stored: false });
      expect((await call("saa.export", { run_id: failed!.run_id })).ok).toBe(false);
    },
    TIMEOUT,
  );
});

describe("Gate 1 item 9: docs and package share one model and revision; docs render in en and id [@req SAA-FR-013] [@req SAA-FR-035] [@req CON-012]", () => {
  it("states the package revision in every document and keeps one revision across the package", () => {
    for (const [name, { pkg, run }] of Object.entries(runs)) {
      const revision = (pkg.revision as { value: string }).value;
      expect((run.revision as { value: string }).value, name).toBe(revision);
      expect((pkg.manifest.repository as { revision: { value: string } }).revision.value, name).toBe(revision);
      const artifacts = pkg.manifest.artifacts as Array<{ path: string; media_type: string; language?: string }>;
      const markdown = artifacts.filter((a) => a.media_type === "text/markdown");
      expect(new Set(markdown.map((a) => a.language)), name).toEqual(new Set(["en", "id"]));
      for (const a of markdown) {
        // Every Markdown artifact carries a BCP 47 tag and states the revision it describes.
        expect(a.language, a.path).toMatch(/^[a-z]{2,3}(-[A-Z]{2})?$/);
        expect(readFileSync(join(runs[name as keyof typeof runs].pkgPath, a.path), "utf8"), a.path).toContain(
          revision.slice(0, 12),
        );
      }
    }
  });

  it("tags the model's natural-language text with a language", () => {
    for (const [name, { pkg, view }] of Object.entries(runs)) {
      const model = JSON.parse(
        readFileSync(join(runs[name as keyof typeof runs].pkgPath, "system-model.json"), "utf8"),
      ) as {
        machine_text_language: string;
      };
      expect(model.machine_text_language, name).toMatch(/^[a-z]{2,3}(-[A-Z]{2})?$/);
      for (const claim of view.claims)
        for (const text of [claim.text].flat())
          expect((text as { language?: string }).language, claim.id).toMatch(/\S/);
      expect(pkg.document("executive_summary", "id"), name).toMatch(/\S/);
    }
  });
});

describe("Gate 1 item 10: SAA packages pass the contract conformance checks on their own [@req CON-001] [@req CON-002] [@req CON-019] [@req CON-020] [@req CON-025] [@req CON-027]", () => {
  it("are SAA-produced, source-only, checksummed packages that the contract library accepts without QAA", () => {
    for (const [name, { pkg, validation }] of Object.entries(runs)) {
      expect(validation, name).toMatchObject({ ok: true, stage: "complete" });
      expect((pkg.manifest.producer as { name: string }).name, name).toBe("SAA");
      expect(pkg.manifest.evidence_profile, name).toMatchObject({ runtime_observation: "unavailable" });
      for (const a of pkg.manifest.artifacts as Array<{ sha256: string }>)
        expect(a.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});
