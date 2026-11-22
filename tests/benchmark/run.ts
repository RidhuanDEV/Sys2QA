// `pnpm bench`: runs the benchmark harness over every fixture in fixtures/benchmarks/ (IMP-014).
// The stub producer (it echoes the ground truth) checks the harness itself. The SAA producer is measured on the
// repository-only fixtures (F1, F4) from IMP-111 on. From IMP-205 QA design is measured on F1 (on SAA's package); from
// Gate 4 F2 is measured on the package runtime discovery publishes from its URL alone (needs Chromium).
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleSaaAdapters,
  computeMetrics,
  discoverF2,
  packageOutput,
  qaaDesign,
  loadGroundTruth,
  saaProducer,
  storeBenchmarkResult,
  stubProducer,
  type BenchmarkMetrics,
} from "./harness/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = join(root, "fixtures", "benchmarks");
const out = join(root, "reports", "benchmarks");
const at = new Date().toISOString();
let commit: string | undefined;
try {
  commit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
} catch {
  commit = undefined;
}
let failed = false;
const SAA_FIXTURES = new Set(["F1-repository-only", "F4-incomplete-evidence"]);
const work = mkdtempSync(join(tmpdir(), "sys2qa-bench-"));
const adapters = await bundleSaaAdapters(join(work, "adapters"));
const report = (name: string, producer: string, metrics: BenchmarkMetrics) => {
  storeBenchmarkResult(out, metrics, producer, at, commit);
  const gates = metrics.gates.filter((g) => !g.passed);
  failed ||= gates.length > 0;
  console.log(
    `${name} [${producer}]: recall ${JSON.stringify(metrics.discovery.recall)}, precision ${JSON.stringify(metrics.discovery.precision)}, step F1 ${JSON.stringify(metrics.reconstruction.step_f1)}, stop points ${JSON.stringify(metrics.reconstruction.stop_point_accuracy)}, gate failures ${gates.length}`,
  );
};
const names = existsSync(fixtures)
  ? readdirSync(fixtures).filter((f) => existsSync(join(fixtures, f, "ground-truth", "workflows.json")))
  : [];
if (names.length === 0) console.log("No benchmark fixtures with ground truth yet (IMP-013).");
for (const name of names) {
  const truth = loadGroundTruth(join(fixtures, name, "ground-truth"), name);
  report(name, "stub", computeMetrics(truth, stubProducer(truth)));
  if (SAA_FIXTURES.has(name)) {
    const saa = await saaProducer(join(fixtures, name, "repo"), { adapters, scratch: join(work, "scratch", name) });
    report(name, "saa", computeMetrics(truth, saa));
    // QA design on SAA's package of the same repository (Gate 2): the scenario metrics and gate rule.
    if (name === "F1-repository-only")
      report(
        name,
        "saa+qaa",
        computeMetrics(truth, {
          ...saa,
          scenarios: await qaaDesign({ repository: join(fixtures, name, "repo"), adapters }),
        }),
      );
  }
  // F2 in Mode B: runtime discovery from the URL alone, its published QAA package, and QA design on that package.
  if (name === "F2-url-only") {
    const discovered = await discoverF2(join(work, "f2-packages"));
    report(
      name,
      "qaa",
      computeMetrics(truth, {
        ...packageOutput(discovered.packageDir),
        runtime: discovered.runtime,
        scenarios: await qaaDesign({ packageDir: discovered.packageDir }),
      }),
    );
  }
}
rmSync(work, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
