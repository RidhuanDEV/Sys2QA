import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServices, openHost, type ServiceResult } from "../../../packages/app-services/src/index.js";
import type { ProducerOutput } from "./producer-output.js";

type Scenarios = NonNullable<ProducerOutput["scenarios"]>;

interface ScenarioDoc {
  test_condition_ids: string[];
  test_techniques: Array<{ id: string }>;
  qa_objective: string;
  steps: Array<{ expected_result: { basis: string; oracle_class: string } | null }>;
}

/**
 * QA design as far as Gate 2 has built it (IMP-205): a package imported into a fresh project (or exported there from
 * a repository by SAA), its readiness, a plan over every workflow that is not blocked, conditions and template
 * scenarios. Returns the scenarios in the harness's shape.
 */
export async function qaaDesign(
  source: { repository: string; adapters: Array<{ id: string; entry: string }> } | { packageDir: string },
): Promise<Scenarios> {
  const work = mkdtempSync(join(tmpdir(), "sys2qa-qaa-bench-"));
  const host = openHost({ home: work, ...("adapters" in source ? { adapters: source.adapters } : {}) });
  const services = new AppServices(host);
  const caller = { interface: "cli" as const, actor: "benchmark" };
  const call = async <T>(operation: string, input: unknown): Promise<T> => {
    const r: ServiceResult = await services.execute(operation, input, caller);
    if (!r.ok) throw new Error(`${operation}: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  };
  try {
    let ref: { project: string; package_id: string; version: number };
    if ("repository" in source) {
      const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", {
        name: "Benchmark",
        root: source.repository,
      });
      await call("project.declare", { source_id: started.source.id, declared_by: "benchmark", operation_level: "L1" });
      const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
      const exported = await call<{ package_id: string; version: number }>("saa.export", { run_id: run.run_id });
      ref = { project: started.project.id, package_id: exported.package_id, version: exported.version };
    } else {
      const project = await call<{ id: string }>("project.create", { name: "Benchmark" });
      const imported = await call<{ package: { package_id: string; version: number } }>("package.import", {
        project_id: project.id,
        path: source.packageDir,
      });
      ref = { project: project.id, ...imported.package };
    }
    // The benchmark measures design, so the working tree is confirmed as the baseline (OD-04).
    await call("readiness.confirm_baseline", {
      project_id: ref.project,
      package_id: ref.package_id,
      version: ref.version,
      statement: "Benchmark: the fixture is the system under test.",
    });
    const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
      project_id: ref.project,
      package_id: ref.package_id,
      version: ref.version,
    });
    await call("conditions.derive", { plan_id: plan.plan.plan_id });
    const generated = await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.generate", {
      plan_id: plan.plan.plan_id,
    });
    const out: Scenarios = [];
    for (const s of generated.scenarios) {
      const doc = (await call<{ scenario: ScenarioDoc }>("scenarios.show", { scenario_id: s.scenario_id })).scenario;
      for (const condition of doc.test_condition_ids)
        out.push({
          test_condition: condition,
          techniques: doc.test_techniques.map((t) => t.id),
          qa_objective: doc.qa_objective,
          expected_results: doc.steps
            .map((st) => st.expected_result)
            .filter((r): r is { basis: string; oracle_class: string } => r !== null),
        });
    }
    return out;
  } finally {
    host.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** A package's model and evidence in the harness's shape, for a producer whose model comes from a package. */
export function packageOutput(packageDir: string): ProducerOutput {
  const read = (name: string) => JSON.parse(readFileSync(join(packageDir, name), "utf8"));
  return {
    systemModel: read("system-model.json"),
    evidenceIndex: read("evidence-index.json"),
    completeness: read("completeness-report.json"),
  } as ProducerOutput;
}
