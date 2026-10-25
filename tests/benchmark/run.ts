// `pnpm bench`: runs the benchmark harness over every fixture in fixtures/benchmarks/ (IMP-014).
// Until the producers exist (Gate 1+), the stub producer is measured; it echoes the ground truth.
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMetrics, loadGroundTruth, storeBenchmarkResult, stubProducer } from "./harness/index.js";

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
const names = existsSync(fixtures)
  ? readdirSync(fixtures).filter((f) => existsSync(join(fixtures, f, "ground-truth", "workflows.json")))
  : [];
if (names.length === 0) console.log("No benchmark fixtures with ground truth yet (IMP-013).");
for (const name of names) {
  const truth = loadGroundTruth(join(fixtures, name, "ground-truth"), name);
  const metrics = computeMetrics(truth, stubProducer(truth));
  storeBenchmarkResult(out, metrics, "stub", at, commit);
  const gates = metrics.gates.filter((g) => !g.passed);
  failed ||= gates.length > 0;
  console.log(
    `${name}: recall ${JSON.stringify(metrics.discovery.recall)}, precision ${JSON.stringify(metrics.discovery.precision)}, gate failures ${gates.length}`,
  );
}
process.exitCode = failed ? 1 : 0;
