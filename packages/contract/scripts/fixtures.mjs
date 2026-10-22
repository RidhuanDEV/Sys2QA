// Maintains contract fixtures (Contract Specification §12, IMP-005).
//   node packages/contract/scripts/fixtures.mjs          rewrite checksums of valid packages and regenerate invalid cases
//   node packages/contract/scripts/fixtures.mjs --check  fail if anything on disk differs from what would be generated
//
// Valid packages in fixtures/contract/packages/valid/ are hand-maintained; only their manifest checksums are computed.
// Invalid cases in fixtures/contract/invalid/<CODE>/<case>/ are generated from the mutations below, so each rule
// violation is defined exactly once. Every case has an expected.json: { kind, code, rule?, severity, ok }.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const contractFixtures = join(repoRoot, "fixtures/contract");
const validPackagesDir = join(contractFixtures, "packages/valid");
const validDocsDir = join(contractFixtures, "valid");
const invalidDir = join(contractFixtures, "invalid");
const check = process.argv.includes("--check");
const prettierConfig = (await prettier.resolveConfig(join(contractFixtures, "x.json"))) ?? {};

const formatJson = (value) => prettier.format(JSON.stringify(value), { ...prettierConfig, parser: "json" });
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const clone = (v) => structuredClone(v);

function readTree(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(dir, p).split("\\").join("/"), readFileSync(p));
    }
  };
  walk(dir);
  return files;
}

/** A package held as { files: Map<path, string|Buffer> } with helpers to edit JSON artifacts. */
class Pkg {
  constructor(files) {
    this.files = new Map([...files].map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString("utf8") : v]));
  }
  json(path) {
    return JSON.parse(this.files.get(path));
  }
  edit(path, fn) {
    const doc = this.json(path);
    fn(doc);
    this.files.set(path, JSON.stringify(doc));
    return this;
  }
  /** Formats JSON files and writes artifact checksums into the manifest (what a correct producer does). */
  async seal() {
    for (const [path, text] of this.files)
      if (path.endsWith(".json")) this.files.set(path, await formatJson(JSON.parse(text)));
    if (this.files.has("manifest.json")) {
      const manifest = this.json("manifest.json");
      for (const a of manifest.artifacts ?? [])
        if (this.files.has(a.path)) a.sha256 = sha256(Buffer.from(this.files.get(a.path)));
      this.files.set("manifest.json", await formatJson(manifest));
    }
    return this;
  }
}

// Valid packages are sealed once in memory; invalid cases derive from the sealed versions so the output
// does not depend on whether the checksums on disk were already up to date.
const sealedValid = new Map();
for (const name of readdirSync(validPackagesDir).sort())
  sealedValid.set(name, await new Pkg(readTree(join(validPackagesDir, name))).seal());
const validPackage = (name) => new Pkg(sealedValid.get(name).files);
const validDoc = (name) => JSON.parse(readFileSync(join(validDocsDir, `${name}.json`), "utf8"));

// ---------------------------------------------------------------- shared bases for document-level cases
function approvedScenario() {
  const s = validDoc("scenario.nib-12-digits");
  s.status = "approved";
  delete s.status_reason;
  s.open_gaps = [];
  return s;
}
function executionRequest() {
  const scenario = approvedScenario();
  const approval = validDoc("approval.manual");
  return {
    scenario,
    approval,
    mode: "manual",
    baseline: clone(scenario.baseline),
    declared_environment_id: approval.declared_environment_id,
    scope_policy_version: 1,
    test_data_profile: "default",
  };
}

// ---------------------------------------------------------------- cases
// Each case: { code, rule?, severity?, ok?, kind, build() } where build returns a Pkg (kind "package") or a JSON value.
// `tamper` packages are sealed first and then modified (checksum cases).
const A = "mode-a-saa";
const B = "mode-b-qaa";
const cases = {
  PKG_MANIFEST_INVALID: {
    "missing-manifest": { kind: "package", build: (p = validPackage(A)) => (p.files.delete("manifest.json"), p) },
    "bad-package-id": {
      kind: "package",
      build: () => validPackage(A).edit("manifest.json", (m) => (m.package_id = "not an id")),
    },
  },
  PKG_SCHEMA_UNSUPPORTED_MAJOR: {
    "major-2": {
      kind: "package",
      build: () => validPackage(A).edit("manifest.json", (m) => (m.package_schema_version = "2.0.0")),
    },
  },
  PKG_ANALYSIS_FAILED: {
    failed: {
      kind: "package",
      build: () => validPackage(A).edit("manifest.json", (m) => (m.analysis.status = "failed")),
    },
  },
  PKG_ARTIFACT_MISSING: {
    "listed-file-missing": { kind: "package", build: (p = validPackage(A)) => (p.files.delete("diff-report.json"), p) },
    "evidence-index-role-missing": {
      kind: "package",
      build: () => {
        const p = validPackage(A).edit(
          "manifest.json",
          (m) => (m.artifacts = m.artifacts.filter((a) => a.role !== "evidence_index")),
        );
        p.files.delete("evidence-index.json");
        return p;
      },
    },
  },
  PKG_CHECKSUM_MISMATCH: {
    "tampered-system-model": {
      kind: "package",
      tamper: (p) =>
        p.files.set(
          "system-model.json",
          p.files.get("system-model.json").replace("Registration page", "Registration page (edited)"),
        ),
      build: () => validPackage(A),
    },
  },
  PKG_ARTIFACT_INVALID: {
    "reconstructed-with-unresolved-hops": {
      kind: "package",
      rule: "CR-040",
      build: () =>
        validPackage(A).edit("system-model.json", (m) => (m.workflows[0].discovery_status = "reconstructed")),
    },
    "known-not-traceable-with-traces": {
      kind: "package",
      rule: "CR-042",
      build: () =>
        validPackage(A).edit("system-model.json", (m) =>
          Object.assign(m.workflows[0], {
            discovery_status: "known_not_traceable",
            unresolved_hops: [],
            evidence_ids: ["evidence:api-routes-5-30"],
          }),
        ),
    },
    "partially-reconstructed-without-hops": {
      kind: "package",
      rule: "CR-041",
      build: () => validPackage(A).edit("system-model.json", (m) => (m.workflows[0].unresolved_hops = [])),
    },
    "unscoped-counts": {
      kind: "package",
      rule: "CR-043",
      build: () => validPackage(A).edit("completeness-report.json", (c) => (c.count_scope = "system_total")),
    },
    "unobservable-without-gap": {
      kind: "package",
      rule: "CR-030",
      build: () =>
        validPackage(B).edit(
          "system-model.json",
          (m) => (m.gaps = m.gaps.filter((g) => g.coverage_category !== "data_model")),
        ),
    },
    "duplicate-entity-id": {
      kind: "package",
      rule: "CR-010",
      build: () => validPackage(A).edit("system-model.json", (m) => m.entities.push(clone(m.entities[2]))),
    },
    "diff-target-other-version": {
      kind: "package",
      build: () => validPackage(A).edit("diff-report.json", (d) => (d.target.package_version = 9)),
    },
  },
  PKG_SECRET_SUSPECTED: {
    "aws-key-in-excerpt": {
      kind: "package",
      rule: "CR-060",
      build: () =>
        validPackage(A).edit(
          "evidence-index.json",
          (e) => (e.evidence.find((x) => x.excerpt).excerpt = 'const awsKey = "AKIAIOSFODNN7EXAMPLE";'),
        ),
    },
    "excerpt-too-long": {
      kind: "package",
      rule: "CR-060",
      build: () =>
        validPackage(A).edit(
          "evidence-index.json",
          (e) => (e.evidence.find((x) => x.excerpt).excerpt = "x".repeat(401)),
        ),
    },
  },
  PKG_EVIDENCE_REVISION_MISMATCH: {
    "model-other-commit": {
      kind: "package",
      rule: "CR-011",
      build: () => validPackage(A).edit("system-model.json", (m) => (m.revision.value = "1".repeat(40))),
    },
    "claim-validated-elsewhere": {
      kind: "package",
      rule: "CR-011",
      build: () =>
        validPackage(A).edit("system-model.json", (m) => (m.claims[0].last_validated_revision = "2".repeat(40))),
    },
    "observation-outside-window": {
      kind: "package",
      rule: "CR-011",
      build: () =>
        validPackage(B).edit("evidence-index.json", (e) => (e.evidence[0].observed_at = "2026-10-21T10:00:00Z")),
    },
  },
  PKG_EVIDENCE_PROFILE_INCONSISTENT: {
    "qaa-with-repository": {
      kind: "package",
      rule: "CR-021",
      build: () =>
        validPackage(B).edit(
          "manifest.json",
          (m) =>
            (m.repository = {
              provider: "git",
              identity: "github.com/example/acme-portal",
              identity_source: "user_supplied",
              revision: {
                kind: "git_commit",
                value: "4b775e0c2a9d1f3e5b7c9d0e1f2a3b4c5d6e7f80",
                worktree_dirty: false,
              },
            }),
        ),
    },
    "saa-with-runtime-evidence": {
      kind: "package",
      rule: "CR-020",
      build: () =>
        validPackage(A).edit("evidence-index.json", (e) =>
          e.evidence.push({
            id: "evidence:obs-page",
            source_type: "runtime_observation",
            subtype: "page",
            environment_id: "env:acme-staging",
            url: "https://staging.acme.example/",
            observed_at: "2026-10-21T08:45:30Z",
            submission: "none",
            extractor: { component: "runtime-observer", version: "0.1.0", method: "dom_snapshot" },
            excerpt_policy: "none",
            captured_at: "2026-10-21T08:45:30Z",
          }),
        ),
    },
  },
  PKG_REFERENCE_BROKEN: {
    "step-entity-missing": {
      kind: "package",
      rule: "CR-010",
      build: () =>
        validPackage(A).edit(
          "system-model.json",
          (m) => (m.workflows[0].steps[0].entity_id = "page:web:/does-not-exist"),
        ),
    },
    "claim-evidence-missing": {
      kind: "package",
      rule: "CR-010",
      build: () => validPackage(A).edit("system-model.json", (m) => m.claims[0].evidence_ids.push("evidence:missing")),
    },
  },
  PKG_CLAIM_EXCEEDS_EVIDENCE: {
    "source-verified-from-readme": {
      kind: "package",
      rule: "CR-001",
      build: () =>
        validPackage(A).edit("system-model.json", (m) => (m.entities[2].evidence_ids = ["evidence:readme-40-41"])),
    },
    "runtime-writes-to": {
      kind: "package",
      rule: "CR-002",
      build: () =>
        validPackage(B).edit("system-model.json", (m) =>
          m.relationships.push({
            id: "rel:obs-form-writes",
            type: "WRITES_TO",
            from: "form:observed:/registrasi#registration",
            to: "page:observed:/registrasi",
            status: "runtime_observed",
            evidence_ids: ["evidence:obs-form-registration"],
          }),
        ),
    },
    "runtime-submits-without-submission": {
      kind: "package",
      rule: "CR-002",
      build: () =>
        validPackage(B).edit("system-model.json", (m) =>
          m.relationships.push({
            id: "rel:obs-form-submits",
            type: "SUBMITS_TO",
            from: "form:observed:/registrasi#registration",
            to: "page:observed:/registrasi",
            status: "runtime_observed",
            evidence_ids: ["evidence:obs-form-registration"],
          }),
        ),
    },
  },
  PKG_ANALYSIS_PARTIAL: {
    partial: {
      kind: "package",
      ok: true,
      build: () => validPackage(A).edit("manifest.json", (m) => (m.analysis.status = "partial")),
    },
  },
  PKG_MARKDOWN_ONLY: {
    "docs-only": {
      kind: "package",
      ok: true,
      build: () => {
        const p = validPackage(A).edit(
          "manifest.json",
          (m) => (m.artifacts = m.artifacts.filter((a) => a.media_type === "text/markdown")),
        );
        for (const f of ["system-model.json", "evidence-index.json", "diff-report.json", "completeness-report.json"])
          p.files.delete(f);
        return p;
      },
    },
  },
  PKG_DIRTY_OR_NON_GIT: {
    "dirty-worktree": {
      kind: "package",
      ok: true,
      build: () => {
        const fp = `sha256:${"d".repeat(64)}`;
        const dirty = (r) => Object.assign(r, { worktree_dirty: true, dirty_fingerprint: fp });
        return validPackage(A)
          .edit("manifest.json", (m) => dirty(m.repository.revision))
          .edit("system-model.json", (m) => {
            dirty(m.revision);
            for (const c of m.claims) c.last_validated_revision = `${m.revision.value}+${fp}`;
          })
          .edit("evidence-index.json", (e) => dirty(e.revision));
      },
    },
  },
  PKG_MINOR_NEWER: {
    "minor-1": {
      kind: "package",
      ok: true,
      build: () => validPackage(A).edit("manifest.json", (m) => (m.package_schema_version = "1.1.0")),
    },
  },
  PKG_UNLISTED_FILE: {
    "extra-file": {
      kind: "package",
      ok: true,
      build: (p = validPackage(A)) => (p.files.set("notes.txt", "Notes not listed in the manifest.\n"), p),
    },
  },
  CONTRACT_SCHEMA_INVALID: {
    "scenario-without-title": {
      kind: "scenario",
      build: () => ((s) => (delete s.title, s))(validDoc("scenario.nib-12-digits")),
    },
  },
  SCN_ORACLE_INCONSISTENT: {
    "implemented-claimed-intended": {
      kind: "scenario",
      rule: "CR-052",
      build: () =>
        ((s) => ((s.steps[2].expected_result.oracle_class = "intended"), s))(validDoc("scenario.nib-12-digits")),
    },
  },
  SCN_BASIS_INVALID: {
    "saa-documented-contradicted": {
      kind: "scenario",
      rule: "CR-053",
      build: () =>
        ((s) => (
          (s.steps[2].expected_result.saa_status = "contradicted"),
          (s.steps[2].expected_result.oracle_class = "none"),
          s
        ))(validDoc("scenario.nib-12-digits")),
    },
    "approved-with-unresolved": {
      kind: "scenario",
      rule: "CR-054",
      build: () =>
        ((s) => (
          Object.assign(s.steps[2].expected_result, { basis: "unresolved", oracle_class: "none" }),
          delete s.steps[2].expected_result.saa_status,
          (s.qa_objective = "exploratory"),
          s
        ))(approvedScenario()),
    },
  },
  SCN_OBJECTIVE_INCONSISTENT: {
    "requirement-conformance-on-implementation": {
      kind: "scenario",
      rule: "CR-050",
      build: () =>
        ((s) => ((s.status = "pending_review"), (s.qa_objective = "requirement_conformance"), s))(approvedScenario()),
    },
  },
  SCN_NOT_AUTOMATABLE: {
    "automation-ready-without-oracle": {
      kind: "scenario",
      rule: "CR-051",
      build: () =>
        ((s) => (
          (s.execution_classification = "automation_ready"),
          Object.assign(s.steps[2].expected_result, { basis: "inferred", oracle_class: "none" }),
          delete s.steps[2].expected_result.saa_status,
          (s.qa_objective = "exploratory"),
          s
        ))(validDoc("scenario.nib-12-digits")),
    },
  },
  APPROVAL_REQUIRED: {
    "approval-suspended": {
      kind: "execution",
      rule: "CR-055",
      build: () => ((r) => ((r.approval.state = "suspended"), r))(executionRequest()),
    },
    "state-changing-without-ack": {
      kind: "execution",
      rule: "CR-056",
      build: () => ((r) => ((r.scenario.state_changing = true), r))(executionRequest()),
    },
  },
  APPROVAL_MISMATCH: {
    "scope-policy-changed": {
      kind: "execution",
      rule: "CR-055",
      build: () => ((r) => ((r.scope_policy_version = 2), r))(executionRequest()),
    },
    "other-baseline": {
      kind: "execution",
      rule: "CR-055",
      build: () => ((r) => ((r.baseline.packages[0].package_version = 4), r))(executionRequest()),
    },
  },
  DEFECT_TRANSITION_INVALID: {
    "new-to-closed": {
      kind: "defect_transition",
      rule: "CR-070",
      build: () => ({ from: "new", to: "closed", context: { retest_passed: true } }),
    },
    "close-without-retest-or-reason": {
      kind: "defect_transition",
      rule: "CR-070",
      build: () => ({ from: "ready_for_retest", to: "closed", context: {} }),
    },
  },
};

const WARNING_OR_INFO = {
  PKG_ANALYSIS_PARTIAL: "warning",
  PKG_MARKDOWN_ONLY: "warning",
  PKG_DIRTY_OR_NON_GIT: "warning",
  PKG_MINOR_NEWER: "info",
  PKG_UNLISTED_FILE: "info",
};

// ---------------------------------------------------------------- generate
const expectedFiles = new Map(); // absolute path -> string|Buffer

for (const [name, pkg] of sealedValid) {
  for (const [path, text] of pkg.files) expectedFiles.set(join(validPackagesDir, name, path), text);
}
for (const [code, byCase] of Object.entries(cases)) {
  for (const [caseName, def] of Object.entries(byCase)) {
    const dir = join(invalidDir, code, caseName);
    const severity = WARNING_OR_INFO[code] ?? "error";
    const expected = {
      kind: def.kind,
      code,
      ...(def.rule ? { rule: def.rule } : {}),
      severity,
      ok: def.ok ?? severity !== "error",
    };
    expectedFiles.set(join(dir, "expected.json"), await formatJson(expected));
    if (def.kind === "package") {
      const pkg = await def.build().seal();
      if (def.tamper) def.tamper(pkg);
      for (const [path, text] of pkg.files) expectedFiles.set(join(dir, "package", path), text);
    } else {
      expectedFiles.set(join(dir, "input.json"), await formatJson(def.build()));
    }
  }
}

// ---------------------------------------------------------------- write or check
const managedRoots = [validPackagesDir, invalidDir];
const onDisk = new Set(
  managedRoots.filter(existsSync).flatMap((root) => [...readTree(root).keys()].map((p) => join(root, p))),
);
const problems = [];
for (const [path, content] of expectedFiles) {
  const want = Buffer.from(content);
  const have = existsSync(path) ? readFileSync(path) : undefined;
  if (!have || !have.equals(want)) {
    if (check) problems.push(`${relative(repoRoot, path)} is ${have ? "out of date" : "missing"}`);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, want);
    }
  }
  onDisk.delete(path);
}
for (const stale of onDisk) {
  if (check) problems.push(`${relative(repoRoot, stale)} is not generated by this script`);
  else rmSync(stale);
}
if (check && problems.length) {
  console.error(problems.join("\n"));
  console.error("Contract fixtures are out of date. Run: pnpm fixtures");
  process.exit(1);
}
console.log(check ? "Contract fixtures are up to date." : `Wrote contract fixtures (${expectedFiles.size} files).`);
