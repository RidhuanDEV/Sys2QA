// `pnpm bench`: runs the benchmark harness over every fixture in fixtures/benchmarks/ (IMP-014).
// The stub producer (it echoes the ground truth) checks the harness itself. The SAA producer is measured on the
// repository-only fixtures (F1, F4) from IMP-111 on; the other producers join as their gates build them.
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleSaaAdapters,
  computeMetrics,
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
  if (SAA_FIXTURES.has(name))
    report(
      name,
      "saa",
      computeMetrics(
        truth,
        await saaProducer(join(fixtures, name, "repo"), { adapters, scratch: join(work, "scratch", name) }),
      ),
    );
}
rmSync(work, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
