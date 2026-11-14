import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServices, openHost, type Host, type ServiceResult } from "../../packages/app-services/src/index.js";
import { validateScenario } from "../../packages/contract/src/index.js";
import { PackageQuery } from "../../packages/system-model/src/index.js";
import { buildF2Package, bundleSaaAdapters } from "../benchmark/harness/index.js";

/**
 * Gate 2 acceptance (IMP-212, PRD §29.1, Test Strategy §8): one block per checklist item, on the benchmark fixtures F1
 * (repository, Mode A) and F2 (URL-only package, Mode B), the contract's invalid package fixtures and a change of F1.
 * `scripts/gate-report.mjs --gate 2` maps these blocks to the checklist.
 */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const F1 = join(REPO, "fixtures", "benchmarks", "F1-repository-only", "repo");
const CONTRACT = join(REPO, "fixtures", "contract");
const TIMEOUT = 240_000;
const DECLARED = { mode: "manual", declared_environment: "tester laptop" } as const;

interface Text {
  value: string;
}
interface ExpectedResult {
  basis: string;
  oracle_class: string;
  trace: { saa_ids: string[]; evidence_ids: string[] };
}
interface ScenarioDoc {
  scenario_id: string;
  version: number;
  status: string;
  status_reason?: string;
  feature_ref: string;
  qa_objective: string;
  test_condition_ids: string[];
  state_changing: boolean;
  title: Text;
  open_gaps: unknown[];
  steps: Array<{ expected_result: ExpectedResult | null }>;
  baseline: { packages: Array<{ package_id: string; package_version: number }> };
}

let work: string;
let host: Host;
let services: AppServices;
const caller = { interface: "cli" as const, actor: "qa-lead@example.com" };
const raw = (operation: string, input: unknown): Promise<ServiceResult> => services.execute(operation, input, caller);
async function call<T>(operation: string, input: unknown): Promise<T> {
  const r = await raw(operation, input);
  if (!r.ok)
    throw new Error(`${operation}: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.details ?? {})}`);
  return r.data as T;
}
const codeOf = (r: ServiceResult) => (r.ok ? "ok" : r.error.code);

interface Analyzed {
  projectId: string;
  sourceId: string;
  packageId: string;
  version: number;
  path: string;
  repo: string;
}
async function analyzeF1(name: string): Promise<Analyzed> {
  const repo = mkdtempSync(join(work, "repo-"));
  cpSync(F1, repo, { recursive: true });
  const started = await call<{ source: { id: string }; project: { id: string } }>("saa.start", { name, root: repo });
  await call("project.declare", { source_id: started.source.id, declared_by: caller.actor, operation_level: "L1" });
  const run = await call<{ run_id: string }>("saa.analyze", { source_id: started.source.id });
  const exported = await call<{ package_id: string; version: number; path: string }>("saa.export", {
    run_id: run.run_id,
  });
  return {
    projectId: started.project.id,
    sourceId: started.source.id,
    packageId: exported.package_id,
    version: exported.version,
    path: exported.path,
    repo,
  };
}

async function scenariosOf(projectId: string, planId: string): Promise<ScenarioDoc[]> {
  const listed = await call<{ scenarios: Array<{ scenario_id: string }> }>("scenarios.list", {
    project_id: projectId,
    plan_id: planId,
  });
  return Promise.all(
    listed.scenarios.map(
      async (s) => (await call<{ scenario: ScenarioDoc }>("scenarios.show", { scenario_id: s.scenario_id })).scenario,
    ),
  );
}

let f1: Analyzed;
let f1Plan: string;
let f1Scenarios: ScenarioDoc[];
let f2: { projectId: string; packageId: string; version: number; path: string };
let f2Plan: string;
let f2Scenarios: ScenarioDoc[];

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "sys2qa-gate2-"));
  host = openHost({
    home: mkdtempSync(join(work, "home-")),
    adapters: await bundleSaaAdapters(join(work, "adapters")),
  });
  services = new AppServices(host);

  f1 = await analyzeF1("Acme portal");
  f1Plan = (
    await call<{ plan: { plan_id: string } }>("plan.create", {
      project_id: f1.projectId,
      package_id: f1.packageId,
      version: f1.version,
    })
  ).plan.plan_id;
  await call("scenarios.generate", { plan_id: f1Plan });
  await call("scenarios.critique", { plan_id: f1Plan });
  f1Scenarios = await scenariosOf(f1.projectId, f1Plan);

  const project = await call<{ id: string }>("project.create", { name: "Acme storefront (URL only)" });
  const imported = await call<{ package: { package_id: string; version: number; path: string } }>("package.import", {
    project_id: project.id,
    path: buildF2Package(join(work, "f2")),
  });
  f2 = { projectId: project.id, ...imported.package, packageId: imported.package.package_id };
  f2Plan = (
    await call<{ plan: { plan_id: string } }>("plan.create", {
      project_id: f2.projectId,
      package_id: f2.packageId,
      version: f2.version,
    })
  ).plan.plan_id;
  await call("scenarios.generate", { plan_id: f2Plan });
  await call("scenarios.critique", { plan_id: f2Plan });
  f2Scenarios = await scenariosOf(f2.projectId, f2Plan);
}, TIMEOUT);

afterAll(() => {
  host.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The codes of the PRD §13.10 table. */
function section1310Codes(): string[] {
  const prd = readFileSync(join(REPO, "docs", "PRD.md"), "utf8");
  const section = prd.split("### 13.10 ")[1]!.split("### 13.11 ")[0]!;
  return [...section.matchAll(/^\| `(PKG_[A-Z_]+)` \|/gm)].map((m) => m[1]!);
}

describe("Gate 2 item 1: a valid package is imported with its metadata and provenance; every §13.10 error code is produced by its invalid fixture [@req QAA-FR-009] [@req QAA-FR-010] [@req QAA-FR-012] [@req CON-009]", () => {
  it(
    "imports the F1 package into a new project, stores its provenance and keeps the original byte for byte",
    async () => {
      const project = await call<{ id: string }>("project.create", { name: "Imported Acme" });
      const imported = await call<{
        status: string;
        evidence_mode: string;
        package: { package_id: string; version: number; path: string };
        original: { kind: string; sha256: string };
        provenance: Record<string, unknown>;
      }>("package.import", { project_id: project.id, path: f1.path });
      expect(imported).toMatchObject({ status: "imported", evidence_mode: "D", original: { kind: "directory" } });
      const shown = await call<{
        package: { origin: string; manifest_sha256: string };
        provenance: {
          producer: { name: string };
          repository: { revision: { kind: string } };
          evidence_profile: { source_analysis: string; cannot_establish: string[] };
          analysis: { status: string; run_id: string };
        };
      }>("package.show", {
        project_id: project.id,
        package_id: imported.package.package_id,
        version: imported.package.version,
      });
      expect(shown.package.origin).toBe("imported");
      expect(shown.provenance.producer.name).toBe("SAA");
      expect(shown.provenance.repository.revision.kind).toBe("content_fingerprint");
      expect(shown.provenance.evidence_profile.source_analysis).toBe("available");
      expect(shown.provenance.analysis.status).toBe("completed_with_limitations");
      // The stored package equals what was imported.
      const manifest = (dir: string) => readFileSync(join(dir, "manifest.json"), "utf8");
      expect(manifest(imported.package.path)).toBe(manifest(f1.path));
    },
    TIMEOUT,
  );

  it(
    "produces every §13.10 code: the validator's from their invalid package fixtures, the others from the component that detects them",
    async () => {
      const seen = new Map<string, string>();
      const fixtures = join(CONTRACT, "invalid");
      for (const code of readdirSync(fixtures))
        for (const kase of readdirSync(join(fixtures, code))) {
          const dir = join(fixtures, code, kase);
          const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as {
            kind: string;
            code: string;
            ok: boolean;
          };
          if (expected.kind !== "package") continue;
          const project = await call<{ id: string }>("project.create", { name: `${code} ${kase}` });
          const r = await raw("package.import", { project_id: project.id, path: join(dir, "package") });
          if (expected.ok) {
            expect(r.ok, `${code}/${kase}`).toBe(true);
            const issues = ((r as { ok: true; data: { issues: Array<{ code: string }> } }).data.issues ?? []).map(
              (i) => i.code,
            );
            expect(issues, `${code}/${kase}`).toContain(expected.code);
          } else expect(codeOf(r), `${code}/${kase}`).toBe(expected.code);
          seen.set(expected.code, `${code}/${kase}`);
        }

      // Detected outside the contract validator: a missing path, a missing language, and freshness.
      const project = await call<{ id: string }>("project.create", { name: "component codes" });
      seen.set(
        codeOf(await raw("package.import", { project_id: project.id, path: join(work, "no-such-package") })),
        "missing path",
      );
      const french = await call<{ issues: Array<{ code: string }> }>("package.import", {
        project_id: project.id,
        path: join(CONTRACT, "packages", "valid", "mode-a-saa"),
        language: "fr",
      });
      for (const i of french.issues) if (i.code === "PKG_LANGUAGE_UNAVAILABLE") seen.set(i.code, "language fr");
      const urlOnly = await call<{ freshness: { code?: string } }>("readiness.assess", {
        project_id: f2.projectId,
        package_id: f2.packageId,
        version: f2.version,
      });
      if (urlOnly.freshness.code) seen.set(urlOnly.freshness.code, "URL-only package, deployed revision unknown");
      const changed = await analyzeF1("Acme checkout changed");
      writeFileSync(join(changed.repo, "README.md"), "Edited after the analysis.\n");
      const mismatched = await call<{ freshness: { code?: string } }>("readiness.assess", {
        project_id: changed.projectId,
        package_id: changed.packageId,
        version: changed.version,
      });
      if (mismatched.freshness.code) seen.set(mismatched.freshness.code, "checkout changed after the analysis");

      const missing = section1310Codes().filter((c) => !seen.has(c));
      expect(section1310Codes().length).toBe(20);
      expect(missing).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("Gate 2 item 2: readiness is computed per QA activity; no package is downgraded for evidence it does not claim [@req QAA-FR-013] [@req QAA-FR-014] [@req CON-022]", () => {
  it("assesses scenario design, manual preparation and automated execution separately, with reasons", async () => {
    const r = await call<{
      assessment: { activities: Record<string, { readiness: string; reasons: string[] }> };
      flows: Array<{ workflow_id: string; readiness: string }>;
    }>("readiness.assess", { project_id: f1.projectId, package_id: f1.packageId, version: f1.version });
    expect(Object.keys(r.assessment.activities).sort()).toEqual([
      "automated_execution",
      "manual_preparation",
      "scenario_design",
    ]);
    for (const a of Object.values(r.assessment.activities)) {
      expect(["ready", "review_only", "blocked"]).toContain(a.readiness);
      if (a.readiness !== "ready") expect(a.reasons.length).toBeGreaterThan(0);
    }
    expect(r.flows).toHaveLength(8);
  });

  it("neither lowers a source package for lacking an environment nor a URL package for lacking source", async () => {
    const source = await call<{ assessment: { activities: Record<string, { readiness: string; reasons: string[] }> } }>(
      "readiness.assess",
      { project_id: f1.projectId, package_id: f1.packageId, version: f1.version },
    );
    for (const activity of ["scenario_design", "manual_preparation"])
      expect(source.assessment.activities[activity]!.reasons.join(" "), activity).not.toMatch(
        /runtime|environment|observ/i,
      );
    const url = await call<{ assessment: { activities: Record<string, { readiness: string; reasons: string[] }> } }>(
      "readiness.assess",
      { project_id: f2.projectId, package_id: f2.packageId, version: f2.version },
    );
    for (const activity of ["scenario_design", "manual_preparation"])
      expect(url.assessment.activities[activity]!.reasons.join(" "), activity).not.toMatch(
        /source|repository|static analysis/i,
      );
  });
});

/** Every expected result's basis, oracle class and the scenario's QA objective agree (PRD §15.9, QAA-FR-111). */
const ORACLE: Record<string, string> = {
  saa_documented: "implemented",
  source_supported: "implemented",
  observed: "observed",
  inferred: "none",
  unresolved: "none",
};
const OBJECTIVE: Record<string, string> = {
  saa_documented: "implementation_conformance",
  source_supported: "implementation_conformance",
  observed: "characterization",
  inferred: "exploratory",
  unresolved: "exploratory",
};

describe("Gate 2 item 3: every scenario traces to the package or is gap-driven exploratory, with a basis, an oracle class and a consistent QA objective [@req QAA-FR-031] [@req QAA-FR-033] [@req QAA-FR-111] [@req QAA-FR-110]", () => {
  for (const [name, get] of [
    ["F1 (repository)", () => ({ docs: f1Scenarios, path: f1.path })],
    ["F2 (URL only)", () => ({ docs: f2Scenarios, path: f2.path })],
  ] as const)
    it(`holds for every scenario of ${name}`, () => {
      const { docs, path } = get();
      expect(docs.length).toBeGreaterThan(20);
      const model = PackageQuery.open(path);
      const known = (id: string) => model.entity(id) !== undefined || model.workflow(id) !== undefined;
      for (const s of docs) {
        const results = s.steps.map((step) => step.expected_result).filter((e): e is ExpectedResult => e !== null);
        expect(results.length, s.scenario_id).toBeGreaterThan(0);
        const traced = [s.feature_ref, ...results.flatMap((e) => e.trace.saa_ids)].filter(known);
        const gapDriven = s.qa_objective === "exploratory";
        expect(traced.length > 0 || gapDriven, s.scenario_id).toBe(true);
        for (const e of results) {
          expect(Object.keys(ORACLE), s.scenario_id).toContain(e.basis);
          expect(e.oracle_class, s.scenario_id).toBe(ORACLE[e.basis]);
        }
        const objectives = new Set(results.map((e) => OBJECTIVE[e.basis]));
        expect(objectives.has(s.qa_objective), s.scenario_id).toBe(true);
        if (["pending_review", "approved"].includes(s.status))
          expect(
            validateScenario(s).issues.filter((i) => i.severity === "error"),
            s.scenario_id,
          ).toEqual([]);
      }
    });

  it("labels no URL-only expectation as implemented behavior", () => {
    for (const s of f2Scenarios)
      for (const step of s.steps)
        if (step.expected_result) expect(step.expected_result.oracle_class, s.scenario_id).not.toBe("implemented");
  });
});

describe("Gate 2 item 4: ambiguous expectations are needs_clarification; staleness propagation behaves as specified on the change fixture [@req QAA-FR-034] [@req QAA-FR-016] [@req QAA-FR-046] [@req QAA-FR-047] [@req CON-014]", () => {
  it("puts every scenario with an unresolved expectation or an open contradiction in needs_clarification with the reason, and labels inferred ones exploratory", () => {
    for (const s of f1Scenarios) {
      const bases = s.steps.flatMap((step) => (step.expected_result ? [step.expected_result.basis] : []));
      if (bases.includes("unresolved")) {
        expect(s.status, s.scenario_id).toBe("needs_clarification");
        expect(s.status_reason, s.scenario_id).toBeTruthy();
      }
      // A heuristic expectation is never presented as documented behavior (QAA-FR-036): exploratory, no oracle.
      if (bases.includes("inferred")) expect(s.qa_objective, s.scenario_id).toBe("exploratory");
    }
    // The README says 8 characters, the code 12: the password rule's scenarios wait for a person, with the conflict.
    const contradicted = f1Scenarios.filter((s) =>
      s.test_condition_ids.includes("tc:registration.password_min_12_characters"),
    );
    expect(contradicted.length).toBeGreaterThan(0);
    for (const s of contradicted) {
      expect(s.status, s.scenario_id).toBe("needs_clarification");
      expect(s.status_reason, s.scenario_id).toMatch(/conflict/);
    }
  });

  it(
    "after the change: unchanged → current and suspended, changed → potentially stale and suspended, removed → stale and invalidated; revalidation rebinds only the unaffected",
    async () => {
      const change = await analyzeF1("Acme change");
      const plan = await call<{ plan: { plan_id: string } }>("plan.create", {
        project_id: change.projectId,
        package_id: change.packageId,
        version: change.version,
      });
      await call("scenarios.generate", { plan_id: plan.plan.plan_id });
      await call("scenarios.critique", { plan_id: plan.plan.plan_id });
      const docs = (await scenariosOf(change.projectId, plan.plan.plan_id)).filter(
        (s) => s.status === "pending_review" && !s.state_changing,
      );
      const pick = (condition: string) => docs.find((d) => d.test_condition_ids[0] === condition)!.scenario_id;
      const picked = {
        changed: pick("tc:auth.login.invalid_credentials"),
        removed: pick("tc:admin.users_access"),
        unchanged: pick("tc:order.amount_1_to_10000"),
      };
      for (const id of Object.values(picked)) {
        const preview = await call<{ preview_token: string }>("approvals.preview", {
          project_id: change.projectId,
          scenario_ids: [id],
          ...DECLARED,
        });
        await call("approvals.approve", {
          project_id: change.projectId,
          scenario_ids: [id],
          ...DECLARED,
          preview_token: preview.preview_token,
        });
      }
      // The change fixture: the login error is reworded and the admin endpoint moves; nothing else changes.
      const auth = join(change.repo, "src", "server", "routes", "auth.ts");
      writeFileSync(auth, readFileSync(auth, "utf8").replace('"invalid credentials"', '"wrong email or password"'));
      const admin = join(change.repo, "src", "server", "routes", "admin.ts");
      writeFileSync(admin, readFileSync(admin, "utf8").replace('"/api/admin/users"', '"/api/admin/accounts"'));
      const run = await call<{ run_id: string }>("saa.analyze", { source_id: change.sourceId });
      const v2 = await call<{ version: number; staleness: { diff: string } }>("saa.export", { run_id: run.run_id });
      expect(v2.staleness.diff).toBe("available");

      const state = (id: string) => {
        const approval = host.state.db
          .prepare("SELECT state FROM approvals WHERE scenario_id = ? ORDER BY approved_at DESC, rowid DESC LIMIT 1")
          .get(id) as { state: string };
        const version = host.state.db
          .prepare(
            "SELECT v.freshness FROM scenario_versions v JOIN scenarios s ON s.scenario_id = v.scenario_id AND v.version = s.latest_version WHERE s.scenario_id = ?",
          )
          .get(id) as { freshness: string };
        return [version.freshness, approval.state];
      };
      expect(state(picked.unchanged)).toEqual(["current", "suspended"]);
      expect(state(picked.changed)).toEqual(["potentially_stale", "suspended"]);
      expect(state(picked.removed)).toEqual(["stale", "invalidated"]);
      for (const id of Object.values(picked))
        expect((await call<{ allowed: boolean }>("execution.check", { scenario_id: id, ...DECLARED })).allowed).toBe(
          false,
        );

      const revalidated = await call<{ rebound: Array<{ scenario_id: string }> }>("approvals.revalidate", {
        project_id: change.projectId,
        package_id: change.packageId,
        version: v2.version,
      });
      expect(revalidated.rebound.map((r) => r.scenario_id)).toEqual([picked.unchanged]);
      expect(
        (await call<{ allowed: boolean }>("execution.check", { scenario_id: picked.unchanged, ...DECLARED })).allowed,
      ).toBe(true);
    },
    TIMEOUT,
  );
});

describe("Gate 2 item 5: users edit, reject, defer and approve; approvals bind to the full baseline [@req QAA-FR-050] [@req QAA-FR-051] [@req QAA-FR-052] [@req QAA-FR-053] [@req QAA-FR-055]", () => {
  it(
    "records each decision, and an approval binds the exact version to the package, revision, environment, scope policy and test data",
    async () => {
      const pending = f1Scenarios.filter((s) => s.status === "pending_review" && !s.state_changing);
      const [toEdit, toReject, toDefer, toApprove] = pending;
      expect(toApprove).toBeDefined();

      const edited = await call<{ version: number; status: string }>("scenarios.edit", {
        scenario_id: toEdit!.scenario_id,
        title: `${toEdit!.title.value} (reviewed wording)`,
      });
      expect(edited).toMatchObject({ version: toEdit!.version + 1, status: "draft" });
      await call("scenarios.decide", {
        scenario_id: toEdit!.scenario_id,
        version: edited.version,
        decision: "ready_for_review",
        reason: "Wording reviewed.",
      });
      await call("scenarios.decide", {
        scenario_id: toReject!.scenario_id,
        version: toReject!.version,
        decision: "reject",
        reason: "Duplicates an exploratory charter.",
      });
      await call("scenarios.decide", {
        scenario_id: toDefer!.scenario_id,
        version: toDefer!.version,
        decision: "defer",
        reason: "Next release.",
      });
      const status = async (id: string) =>
        (await call<{ scenario: { status: string } }>("scenarios.show", { scenario_id: id })).scenario.status;
      expect([await status(toReject!.scenario_id), await status(toDefer!.scenario_id)]).toEqual([
        "rejected",
        "deferred",
      ]);

      const ids = [toEdit!.scenario_id, toApprove!.scenario_id];
      const preview = await call<{
        items: Array<{ scenario_id: string; version: number }>;
        binding: {
          mode: string;
          declared_environment_id: string;
          scope_policy_version: number | null;
          test_data_profile: string;
        };
        baselines: Array<{
          packages: Array<{ package_id: string; package_version: number }>;
          revision: { kind: string; value: string };
        }>;
        preview_token: string;
      }>("approvals.preview", { project_id: f1.projectId, scenario_ids: ids, ...DECLARED });
      expect(preview.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scenario_id: toEdit!.scenario_id, version: edited.version }),
          expect.objectContaining({ scenario_id: toApprove!.scenario_id, version: toApprove!.version }),
        ]),
      );
      // A rejected scenario cannot be slipped into the approval.
      expect(
        codeOf(
          await raw("approvals.approve", {
            project_id: f1.projectId,
            scenario_ids: [...ids, toReject!.scenario_id],
            ...DECLARED,
            preview_token: preview.preview_token,
          }),
        ),
      ).not.toBe("ok");
      await call("approvals.approve", {
        project_id: f1.projectId,
        scenario_ids: ids,
        ...DECLARED,
        preview_token: preview.preview_token,
      });
      const approvals = await call<{
        approvals: Array<{
          scenario_version: number;
          state: string;
          baseline: { packages: Array<{ package_id: string; package_version: number }>; revision: { value: string } };
        }>;
      }>("approvals.list", { scenario_id: toApprove!.scenario_id });
      const active = approvals.approvals.find((a) => a.state === "active")!;
      expect(active.scenario_version).toBe(toApprove!.version);
      expect(active.baseline.packages).toEqual([{ package_id: f1.packageId, package_version: f1.version }]);
      expect(active.baseline.revision.value).toMatch(/^sha256:/);
      // The binding is stored with the approval: the declared environment, the scope policy and the test data profile.
      expect(JSON.stringify(active)).toContain("tester-laptop");
      expect(JSON.stringify(active)).toContain("test_data_profile");
      expect(
        (await call<{ allowed: boolean }>("execution.check", { scenario_id: toApprove!.scenario_id, ...DECLARED }))
          .allowed,
      ).toBe(true);
      // Another environment, or a new version, is not covered by this approval.
      expect(
        (
          await call<{ allowed: boolean }>("execution.check", {
            scenario_id: toApprove!.scenario_id,
            mode: "manual",
            declared_environment: "another laptop",
          })
        ).allowed,
      ).toBe(false);
      await call("scenarios.edit", { scenario_id: toApprove!.scenario_id, title: "Reworded after approval" });
      expect(
        (await call<{ allowed: boolean }>("execution.check", { scenario_id: toApprove!.scenario_id, ...DECLARED }))
          .allowed,
      ).toBe(false);
      expect(existsSync(f1.path)).toBe(true);
    },
    TIMEOUT,
  );
});
