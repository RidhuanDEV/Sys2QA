import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  bundleSaaAdapters,
  computeMetrics,
  lcs,
  loadGroundTruth,
  saaProducer,
  storeBenchmarkResult,
  stubProducer,
  workflowMatches,
  type GroundTruth,
} from "./harness/index.js";

/** A small ground truth whose metric values under each stub defect can be computed by hand. */
const TRUTH: GroundTruth = {
  fixture: "harness-selftest",
  entities: [
    { id: "page:web:/register", kind: "page" },
    { id: "form:web:/register#form", kind: "form" },
    { id: "api:POST:/api/register", kind: "api" },
    { id: "integration:email", kind: "integration" },
    { id: "page:web:/login", kind: "page" },
    { id: "api:POST:/api/login", kind: "api" },
    { id: "job:cleanup", kind: "job" },
  ],
  workflows: [
    {
      key: "register",
      category: "business_process",
      entry_point: "page:web:/register",
      steps: ["page:web:/register", "form:web:/register#form", "api:POST:/api/register", "integration:email"],
      branches: [
        { from: "form:web:/register#form", outcome: "validation_error" },
        { from: "integration:email", outcome: "retry" },
      ],
      stop_points: [{ after: "integration:email", reason_code: "external_service" }],
      external_boundaries: ["integration:email"],
      area: "web",
    },
    {
      key: "login",
      category: "auth",
      entry_point: "page:web:/login",
      steps: ["page:web:/login", "api:POST:/api/login"],
      branches: [],
      stop_points: [],
      external_boundaries: [],
      area: "web",
    },
    {
      key: "cleanup",
      category: "scheduled_processing",
      entry_point: "job:cleanup",
      steps: ["job:cleanup"],
      branches: [],
      stop_points: [],
      external_boundaries: [],
      area: "jobs",
    },
  ],
  gaps: [{ key: "email", type: "external_boundary", related: ["integration:email"] }],
  forbidden_claims: [
    {
      key: "runtime-writes",
      description: "WRITES_TO from runtime-only evidence",
      relationship: { type: "WRITES_TO", from: "form:web:/register#form" },
    },
    {
      key: "email-delivered",
      description: "Email delivery is outside the repository",
      claim_text: "email (is|was) delivered",
    },
  ],
  scenarios: {
    expected: [{ key: "nib-boundary", condition: "tc:nib-length", technique: "boundary_value_analysis" }],
    forbidden: [
      {
        key: "requirement-on-observed",
        description: "requirement conformance from observed behavior",
        objective: "requirement_conformance",
        basis: "observed",
      },
    ],
  },
  runtime: {
    pages: ["/", "/register", "/search"],
    forms: [
      { id: "form:search", withhold: false },
      { id: "form:delete-account", withhold: true },
    ],
  },
};

describe("benchmark harness (IMP-014)", () => {
  it("matches workflows by entry point and at least half of the canonical steps in order", () => {
    expect(lcs(["a", "b", "c", "d"], ["a", "x", "c", "d"])).toBe(3);
    const produced = {
      id: "w",
      category: "x",
      discovery_status: "reconstructed",
      entry_point_ids: ["page:web:/register"],
      steps: [],
      branches: [],
      unresolved_hops: [],
    };
    const step = (entity: string, order: number) => ({ id: `s${order}`, order, entity_id: entity });
    expect(
      workflowMatches(TRUTH.workflows[0]!, {
        ...produced,
        steps: [step("page:web:/register", 1), step("form:web:/register#form", 2)],
      }),
    ).toBe(true);
    expect(workflowMatches(TRUTH.workflows[0]!, { ...produced, steps: [step("page:web:/register", 1)] })).toBe(false);
    expect(
      workflowMatches(TRUTH.workflows[0]!, {
        ...produced,
        entry_point_ids: ["page:web:/login"],
        steps: [step("page:web:/register", 1), step("form:web:/register#form", 2)],
      }),
    ).toBe(false);
    expect(
      workflowMatches(TRUTH.workflows[0]!, {
        ...produced,
        discovery_status: "known_not_traceable",
        steps: [step("page:web:/register", 1), step("form:web:/register#form", 2)],
      }),
    ).toBe(false);
  });

  it("reports perfect scores for a producer that echoes the ground truth, and marks what it cannot measure", () => {
    const m = computeMetrics(TRUTH, stubProducer(TRUTH));
    expect(m.discovery).toEqual({ expected: 3, discovered: 3, matched: 3, recall: 1, precision: 1 });
    expect(m.reconstruction).toEqual({
      step_f1: 1,
      branch_recall: 1,
      stop_point_accuracy: 1,
      external_boundary_accuracy: 1,
    });
    expect(m.uncertainty).toEqual({
      true_gap_ratio: 1,
      misses_in_unexplored_areas: { not_measured: "no missed workflows" },
    });
    expect(m.over_claiming.count).toBe(0);
    expect(m.evidence_traceability).toBe(1);
    expect(m.scenarios.expected_covered).toEqual({ not_measured: "producer emits no scenarios" });
    expect(m.runtime.withheld_form_errors).toEqual({
      not_measured: "no runtime discovery for this fixture or producer",
    });
    expect(m.gates.every((g) => g.passed)).toBe(true);
  });

  it("measures misses, inventions and honest reporting of unexplored areas", () => {
    const m = computeMetrics(
      TRUTH,
      stubProducer(TRUTH, { miss: ["cleanup"], honest: true, inventWorkflows: 1, falseGaps: 1 }),
    );
    expect(m.discovery).toEqual({ expected: 3, discovered: 3, matched: 2, recall: 0.6667, precision: 0.6667 });
    expect(m.uncertainty).toEqual({ true_gap_ratio: 0.5, misses_in_unexplored_areas: 1 });
    expect(
      computeMetrics(TRUTH, stubProducer(TRUTH, { miss: ["cleanup"] })).uncertainty.misses_in_unexplored_areas,
    ).toBe(0);
  });

  it("measures reconstruction quality when the last step is lost", () => {
    const m = computeMetrics(TRUTH, stubProducer(TRUTH, { dropLastStep: true }));
    // Expected steps 4 + 2 + 1 = 7; produced 3 + 1 + 1 = 5; common 5 → P = 1, R = 5/7, F1 = 10/12.
    expect(m.reconstruction.step_f1).toBe(0.8333);
    expect(m.reconstruction.branch_recall).toBe(0.5);
    expect(m.reconstruction.stop_point_accuracy).toBe(0);
  });

  it("fails the gates on over-claiming, untraceable claims, forbidden expectations and submitted withheld forms", () => {
    const overClaimed = computeMetrics(TRUTH, stubProducer(TRUTH, { overClaim: true }));
    expect(overClaimed.over_claiming).toEqual({ count: 1, items: ["runtime-writes"] });
    const dangling = computeMetrics(TRUTH, stubProducer(TRUTH, { danglingEvidence: true }));
    expect(dangling.evidence_traceability).toBe(0.8571);

    const output = stubProducer(TRUTH);
    output.systemModel.claims.push({
      id: "claim:x",
      text: { value: "The confirmation email was delivered." },
      status: "inferred",
      evidence_ids: ["evidence:missing"],
    });
    output.scenarios = [
      {
        test_condition: "tc:nib-length",
        techniques: ["boundary_value_analysis"],
        qa_objective: "characterization",
        expected_results: [{ basis: "source_supported", oracle_class: "implemented" }],
      },
      {
        techniques: ["exploratory_charter"],
        qa_objective: "requirement_conformance",
        expected_results: [{ basis: "observed", oracle_class: "observed" }],
      },
    ];
    output.runtime = {
      visited_pages: ["/", "/register"],
      discovered_forms: ["form:search", "form:delete-account"],
      submitted_forms: ["form:delete-account"],
    };
    const m = computeMetrics(TRUTH, output);
    expect(m.over_claiming.items).toEqual(["email-delivered"]);
    expect(m.scenarios).toEqual({
      expected_covered: 1,
      forbidden_present: 1,
      forbidden_items: ["requirement-on-observed"],
    });
    expect(m.runtime).toEqual({ page_recall: 0.6667, form_recall: 1, withheld_form_errors: 1 });
    expect(m.gates.filter((g) => !g.passed).map((g) => g.metric)).toEqual([
      "over_claiming",
      "evidence_traceability",
      "scenarios.forbidden_present",
      "runtime.withheld_form_errors",
    ]);
  });

  it("stores a report, the raw metrics and a trend line per run", () => {
    const dir = mkdtempSync(join(tmpdir(), "sys2qa-bench-"));
    try {
      const m = computeMetrics(TRUTH, stubProducer(TRUTH, { overClaim: true }));
      storeBenchmarkResult(dir, m, "stub", "2026-10-25T10:00:00Z", "abc123");
      storeBenchmarkResult(dir, m, "stub", "2026-10-25T11:00:00Z", "def456");
      expect(readFileSync(join(dir, "harness-selftest", "stub.md"), "utf8")).toContain(
        "| over_claiming | must be 0 | 1 | **FAIL** |",
      );
      const trend = readFileSync(join(dir, "trend.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { commit: string; gates_passed: boolean });
      expect(trend.map((t) => [t.commit, t.gates_passed])).toEqual([
        ["abc123", false],
        ["def456", false],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SAA producer on the repository fixtures (IMP-111) [@req SAA-FR-040]", () => {
  const fixtures = fileURLToPath(new URL("../../fixtures/benchmarks/", import.meta.url));

  it("produces discovery, reconstruction and uncertainty metrics on F1 and F4, separately", async () => {
    const work = mkdtempSync(join(tmpdir(), "sys2qa-bench-saa-"));
    try {
      const adapters = await bundleSaaAdapters(join(work, "adapters"));
      const measure = async (name: string) =>
        computeMetrics(
          loadGroundTruth(join(fixtures, name, "ground-truth"), name),
          await saaProducer(join(fixtures, name, "repo"), { adapters, scratch: join(work, name) }),
        );
      const f1 = await measure("F1-repository-only");
      expect(f1.discovery).toMatchObject({ expected: 7, matched: 7, recall: 1 });
      expect(f1.reconstruction.stop_point_accuracy).toBe(1);
      expect(f1.reconstruction.external_boundary_accuracy).toBe(1);
      expect(f1.over_claiming.count).toBe(0);
      expect(f1.gates.every((g) => g.passed)).toBe(true);
      // F4: the fulfillment consumer is known_not_traceable, which never counts as discovered (Test Strategy §5).
      const f4 = await measure("F4-incomplete-evidence");
      expect(f4.discovery).toMatchObject({ expected: 3, matched: 2 });
      expect(f4.reconstruction.stop_point_accuracy).toBe(1);
      expect(f4.uncertainty.true_gap_ratio).toBe(1);
      expect(f4.over_claiming.count).toBe(0);
      expect(f4.gates.every((g) => g.passed)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
