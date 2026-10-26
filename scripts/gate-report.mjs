// Gate acceptance report (Test Strategy §7 stage 5 and §8, IMP-121).
// Usage:
//   node scripts/gate-report.mjs --gate 1 [--results <vitest-json>] [--out <dir>]
// Without --results it runs the whole test suite with the JSON reporter. It runs the benchmarks, then writes
// reports/gates/gate-<n>/<date>/ (or --out): test-results.json, traceability.md, benchmarks/ and report.md, which maps
// every checklist item of PRD §29.1 to its acceptance tests (tests/acceptance/gate-<n>.test.ts, one `describe` per item
// named "Gate <n> item <k>: …") and lists the gate's requirements (PRD §27.2 and §27.4), benchmark gate rules and
// manual evidence. Exits 1 when an item or a requirement of the gate fails; pending manual evidence is reported, not
// failed.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildReport,
  outcomesFromResults,
  parseContractRules,
  parseGateOwnership,
  parseRequirements,
  renderReport,
  scanTags,
} from "./traceability.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: { gate: { type: "string" }, results: { type: "string" }, out: { type: "string" } },
});
const gate = Number(values.gate);
if (gate !== 1) {
  console.error("Only --gate 1 has an acceptance suite so far.");
  process.exit(2);
}
const date = new Date().toISOString().slice(0, 10);
const out = resolve(values.out ?? join(REPO, "reports", "gates", `gate-${gate}`, date));
mkdirSync(out, { recursive: true });
const read = (p) => readFileSync(join(REPO, p), "utf8");
const node = (args) => spawnSync(process.execPath, args, { cwd: REPO, stdio: "inherit" }).status;

// 1. Test results.
const resultsPath = values.results ? resolve(values.results) : join(out, "test-results.json");
if (!values.results)
  node([
    join(REPO, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${resultsPath}`,
  ]);
else cpSync(resultsPath, join(out, "test-results.json"));
const results = JSON.parse(readFileSync(resultsPath, "utf8"));

// 2. Benchmarks.
const benchStatus = node(["--conditions=source", "--import", "tsx", join(REPO, "tests", "benchmark", "run.ts")]);
const benchDir = join(REPO, "reports", "benchmarks");
const bench = [];
for (const fixture of existsSync(benchDir) ? readdirSync(benchDir) : []) {
  const file = join(benchDir, fixture, "saa.json");
  if (!existsSync(file)) continue;
  cpSync(join(benchDir, fixture), join(out, "benchmarks", fixture), { recursive: true });
  bench.push({ fixture, ...JSON.parse(readFileSync(file, "utf8")) });
}

// 3. Traceability over the same results.
const prd = read("docs/PRD.md");
const plan = read("docs/00-project/implementation-plan.md");
const trace = buildReport({
  requirements: parseRequirements(prd),
  contractRules: parseContractRules(read("docs/02-contracts/contract-specification.md")),
  gateOwner: parseGateOwnership(plan),
  tags: scanTags(REPO, ["apps", "packages", "tests"]),
  outcomes: outcomesFromResults(results),
});
writeFileSync(join(out, "traceability.md"), renderReport(trace, new Date().toISOString()));

// 4. The gate's checklist (PRD §29.1) and its acceptance tests.
// The checklist block starts on its own line (the §27.2 table row carries the same bold title).
const checklistBlock = prd.split(`\n**Gate ${gate} — `)[1]?.split(/\n\s*\n/)[0] ?? "";
const checklist = [...checklistBlock.matchAll(/^- \[[ x]\] (.+)$/gm)].map((m) => m[1]);
const acceptance = (results.testResults ?? []).find((f) =>
  f.name.replace(/\\/g, "/").endsWith(`tests/acceptance/gate-${gate}.test.ts`),
);
const itemTests = new Map();
for (const t of acceptance?.assertionResults ?? []) {
  const m = new RegExp(`^Gate ${gate} item (\\d+):`).exec(t.ancestorTitles?.[0] ?? "");
  if (m) itemTests.set(Number(m[1]), [...(itemTests.get(Number(m[1])) ?? []), t]);
}
const items = checklist.map((text, i) => {
  const tests = itemTests.get(i + 1) ?? [];
  return { n: i + 1, text, tests, passed: tests.length > 0 && tests.every((t) => t.status === "passed") };
});

// 5. The gate's requirements: PRD §27.2 row and, for Gate 1, the L0–L1 security release gate (§27.4).
const expand = (list) =>
  list.split(";").flatMap((group) => {
    const prefix = /([A-Z]+(?:-[A-Z]+)?)-\d{3}/.exec(group)?.[1];
    return [...group.matchAll(/(\d{3})(?:\s*[–-]\s*(\d{3}))?/g)].flatMap(([, a, b]) =>
      Array.from(
        { length: Number(b ?? a) - Number(a) + 1 },
        (_, k) => `${prefix}-${String(Number(a) + k).padStart(3, "0")}`,
      ),
    );
  });
const gateRow = prd.split("\n").find((l) => l.startsWith(`| **Gate ${gate} — `)) ?? "";
const ids = new Set(expand(gateRow.split("|").at(-2) ?? ""));
const securityRow = prd.split("\n").find((l) => l.startsWith("| Any source read (L0–L1)")) ?? "";
for (const m of securityRow.matchAll(/SEC-\d{3}/g)) ids.add(m[0]);
const rows = trace.rows.filter((r) => ids.has(r.id));
const ownerOrder = (r) => r.gateOrder;
const requirementState = (r) => {
  if (r.covered) return "covered";
  if (r.manual) return "manual evidence";
  if (r.priority !== "P0") return `not covered (${r.priority})`;
  return ownerOrder(r) > gate ? `deferred to ${r.gate}` : "BLOCKER";
};
const blockers = rows.filter((r) => requirementState(r) === "BLOCKER");
// Earlier gates' P0 requirements that still lack a passing test: reported, since they are not this gate's.
const earlier = trace.rows.filter(
  (r) => r.priority === "P0" && !r.covered && !r.manual && r.gateOrder < gate && !ids.has(r.id),
);

// 6. Manual evidence: the human ground-truth review of the benchmark fixtures (Test Strategy §8).
// The monorepo fixture's expected boundaries are the reference of checklist item 3 ("expert-reviewed").
const reviewed = [
  ...readdirSync(join(REPO, "fixtures", "benchmarks"))
    .map((f) => ({ fixture: f, readme: `fixtures/benchmarks/${f}/ground-truth/README.md` }))
    .filter((r) => existsSync(join(REPO, r.readme))),
  { fixture: "saa/monorepo", readme: "fixtures/saa/monorepo/README.md" },
];
const reviews = reviewed.map(({ fixture, readme }) => {
  const review = read(readme).split("## Review")[1] ?? "";
  return { fixture, pending: !review || /pending/i.test(review) };
});
const pendingReviews = reviews.filter((r) => r.pending);

const benchFailures = bench.flatMap((b) =>
  (b.metrics.gates ?? []).filter((g) => !g.passed).map((g) => `${b.fixture}: ${g.metric}`),
);
const skipped = (results.testResults ?? []).flatMap((f) =>
  f.assertionResults.filter((t) => t.status !== "passed" && t.status !== "failed"),
);
const automatedPass =
  items.length > 0 &&
  items.every((i) => i.passed) &&
  blockers.length === 0 &&
  benchFailures.length === 0 &&
  benchStatus === 0 &&
  results.numFailedTests === 0;
const verdict = !automatedPass
  ? "FAILED"
  : pendingReviews.length > 0
    ? "PASSED on automated evidence; manual evidence pending"
    : "PASSED";

let commit = "unknown";
try {
  commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim() || commit;
} catch {
  // not a Git checkout
}
const pct = (v) => (typeof v === "number" ? `${Math.round(v * 1000) / 10}%` : "not measured");
const report = [
  `# Gate ${gate} acceptance report`,
  "",
  `Generated by \`node scripts/gate-report.mjs --gate ${gate}\` on ${new Date().toISOString()} at commit \`${commit}\` (Node ${process.version}, ${process.platform}).`,
  "",
  `**Verdict: ${verdict}.**`,
  "",
  `- Tests: ${results.numPassedTests} passed, ${results.numFailedTests} failed, ${skipped.length} skipped or quarantined, in ${results.numTotalTestSuites} suites.`,
  `- Checklist items with passing acceptance tests: ${items.filter((i) => i.passed).length} of ${items.length}.`,
  `- Gate requirements: ${rows.length}; covered by a passing tagged test: ${rows.filter((r) => r.covered).length}; blockers: ${blockers.length}.`,
  `- Benchmark gate rules: ${benchFailures.length === 0 ? "all pass" : `failing: ${benchFailures.join(", ")}`}.`,
  `- Manual evidence pending: ${pendingReviews.length === 0 ? "none" : pendingReviews.map((r) => `ground-truth review of ${r.fixture}`).join(", ")}.`,
  "",
  "## Checklist (PRD §29.1)",
  "",
  ...items.flatMap((i) => [
    `### ${i.n}. ${i.passed ? "pass" : "FAIL"}: ${i.text}`,
    "",
    ...(i.tests.length === 0
      ? ["No acceptance test."]
      : i.tests.map((t) => `- ${t.status === "passed" ? "pass" : t.status.toUpperCase()}: ${t.title}`)),
    "",
  ]),
  "## Benchmarks (SAA producer)",
  "",
  "| Fixture | Recall | Precision | Step F1 | Branch recall | Stop points | True gaps | Honest misses | Over-claiming | Evidence traceability | Gate rules |",
  "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|",
  ...bench.map((b) => {
    const m = b.metrics;
    return `| ${b.fixture} | ${pct(m.discovery.recall)} | ${pct(m.discovery.precision)} | ${pct(m.reconstruction.step_f1)} | ${pct(m.reconstruction.branch_recall)} | ${pct(m.reconstruction.stop_point_accuracy)} | ${pct(m.uncertainty.true_gap_ratio)} | ${pct(m.uncertainty.misses_in_unexplored_areas)} | ${m.over_claiming.count} | ${pct(m.evidence_traceability)} | ${(m.gates ?? []).every((g) => g.passed) ? "pass" : "FAIL"} |`;
  }),
  "",
  "## Requirements of the gate (PRD §27.2, §27.4)",
  "",
  "A requirement whose acceptance criterion belongs to a later gate's backlog (Implementation Plan §4) is deferred there.",
  "",
  "| Requirement | Priority | Owning gate | State | Tests |",
  "|---|:-:|---|---|---|",
  ...rows
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (r) =>
        `| ${r.id} | ${r.priority} | ${r.gate} | ${requirementState(r)} | ${r.outcome ? `${r.outcome.passed} passed${r.outcome.failed ? `, ${r.outcome.failed} failed` : ""}` : "—"} |`,
    ),
  "",
  "## Earlier gates: P0 requirements without a passing tagged test",
  "",
  earlier.length === 0 ? "None." : earlier.map((r) => `${r.id} (${r.gate})`).join(", "),
  "",
  "## Manual evidence (Test Strategy §8)",
  "",
  "| Evidence | State |",
  "|---|---|",
  ...reviews.map(
    (r) => `| Human review of the ${r.fixture} ground truth (IMP-013) | ${r.pending ? "pending" : "recorded"} |`,
  ),
  "",
  "## Quarantined or skipped tests",
  "",
  skipped.length === 0 ? "None." : skipped.map((t) => `- ${t.fullName}`).join("\n"),
  "",
].join("\n");
writeFileSync(join(out, "report.md"), report);
console.log(`\nGate ${gate}: ${verdict} → ${out}`);
process.exit(automatedPass ? 0 : 1);
