import type { Revision } from "../generated/types.js";
import { issue, type ContractIssue } from "./errors.js";
import { revisionKey, revisionsEqual } from "./revision.js";
import { asArray, asObject, asString, asStrings, isObject, ptr, type JsonObject } from "./shared.js";

/** Parsed, schema-valid documents of one package (Contract Specification §3–§5). */
export interface PackageDocuments {
  manifest: JsonObject;
  model: JsonObject;
  evidenceIndex: JsonObject;
  completeness?: JsonObject;
  diff?: JsonObject;
}

const SM = "system-model";
const EI = "evidence-index";
const CR = "completeness-report";

const SOURCE_TYPES = new Set([
  "source_code",
  "configuration",
  "schema",
  "migration",
  "manifest",
  "test_definition",
  "documentation",
  "git_history",
]);
const VERIFYING_SOURCE_TYPES = new Set(["source_code", "configuration", "schema", "migration", "manifest"]);
const RUNTIME_FORBIDDEN_RELATIONSHIPS = new Set([
  "CALLS",
  "READS_FROM",
  "WRITES_TO",
  "PUBLISHES",
  "SUBSCRIBES_TO",
  "TRIGGERS",
  "SENDS_TO",
  "CONFIGURED_BY",
  "DEPLOYED_AS",
  "DEPENDS_ON",
  "USES_SCHEMA",
  "AUTHENTICATES_WITH",
  "AUTHORIZES_WITH",
  "VALIDATES",
]);
const DISCLOSING_DIMENSIONS = ["source_analysis", "runtime_observation", "documentation_import"] as const;

// ------------------------------------------------------------------ CR-021 (manifest only)

/** Evidence-profile checks that need only the manifest. Runs before schema validation so the specific code wins. */
export function manifestProfileIssues(manifest: JsonObject): ContractIssue[] {
  const out: ContractIssue[] = [];
  const profile = manifest.evidence_profile;
  if (!isObject(profile)) return out;
  const producer = asString(asObject(manifest.producer).name);
  const source = asString(profile.source_analysis);
  const runtime = asString(profile.runtime_observation);
  const add = (pointer: string, message: string) =>
    out.push(
      issue("PKG_EVIDENCE_PROFILE_INCONSISTENT", message, {
        rule: "CR-021",
        artifact: "manifest",
        json_pointer: pointer,
      }),
    );

  if ("repository" in manifest) {
    if (source === "unavailable" && manifest.repository !== null)
      add("/repository", "repository must be null when source_analysis is unavailable");
    if (source !== undefined && source !== "unavailable" && manifest.repository === null)
      add("/repository", "repository is required when source analysis is available");
  }
  const environments = asArray(manifest.observed_environments);
  if (runtime !== undefined && runtime !== "unavailable" && environments.length === 0)
    add("/observed_environments", "observed_environments is required when runtime observation is available");
  if (runtime === "unavailable" && environments.length > 0)
    add("/observed_environments", "observed_environments must be absent when runtime observation is unavailable");
  if (producer === "SAA" && runtime !== undefined && runtime !== "unavailable")
    add("/evidence_profile/runtime_observation", "SAA packages cannot contain runtime observation (CR-020)");
  if (producer === "QAA" && source !== undefined && source !== "unavailable")
    add("/evidence_profile/source_analysis", "QAA packages cannot contain source analysis (CR-020)");
  const limited = DISCLOSING_DIMENSIONS.some((d) => profile[d] === "unavailable" || profile[d] === "partial");
  if (limited && Array.isArray(profile.cannot_establish) && profile.cannot_establish.length === 0) {
    add("/evidence_profile/cannot_establish", "cannot_establish must list what the evidence profile cannot establish");
  }
  return out;
}

// ------------------------------------------------------------------ consistency stage (CR-011, CR-020, CR-021)

/** The revision every artifact of the package must share. */
export function packageRevision(docs: PackageDocuments): Revision | undefined {
  const repository = docs.manifest.repository;
  if (isObject(repository) && isObject(repository.revision)) return repository.revision as unknown as Revision;
  return isObject(docs.model.revision) ? (docs.model.revision as unknown as Revision) : undefined;
}

export function consistencyIssues(docs: PackageDocuments): ContractIssue[] {
  const out: ContractIssue[] = [];
  const { manifest, model, evidenceIndex } = docs;
  const producer = asString(asObject(manifest.producer).name);
  const revision = packageRevision(docs);
  const profile = asObject(manifest.evidence_profile);
  const evidence = asArray(evidenceIndex.evidence).map(asObject);

  // CR-011 — one revision or observation window for the whole package.
  const modelRevision = model.revision as Revision;
  if (producer === "SAA" && revision && !revisionsEqual(modelRevision, revision)) {
    out.push(
      issue("PKG_EVIDENCE_REVISION_MISMATCH", "system model revision differs from the manifest repository revision", {
        rule: "CR-011",
        artifact: SM,
        json_pointer: "/revision",
      }),
    );
  }
  if (producer === "QAA") {
    const window = asObject(model.revision);
    const env = asArray(manifest.observed_environments)
      .map(asObject)
      .find((e) => e.environment_id === window.environment_id);
    if (
      window.kind !== "observation_window" ||
      !env ||
      env.observed_from !== window.observed_from ||
      env.observed_to !== window.observed_to
    ) {
      out.push(
        issue(
          "PKG_EVIDENCE_REVISION_MISMATCH",
          "system model observation window does not match an observed environment in the manifest",
          { rule: "CR-011", artifact: SM, json_pointer: "/revision" },
        ),
      );
    }
  }
  if (!revisionsEqual(evidenceIndex.revision as Revision, modelRevision)) {
    out.push(
      issue("PKG_EVIDENCE_REVISION_MISMATCH", "evidence index revision differs from the system model revision", {
        rule: "CR-011",
        artifact: EI,
        json_pointer: "/revision",
      }),
    );
  }
  const environments = new Map(
    asArray(manifest.observed_environments)
      .map(asObject)
      .map((e) => [asString(e.environment_id), e]),
  );
  // A package without observation windows cannot carry runtime evidence at all; CR-020/CR-021 report that.
  evidence.forEach((e, i) => {
    if (e.source_type !== "runtime_observation" || environments.size === 0) return;
    const env = environments.get(asString(e.environment_id));
    const at = Date.parse(asString(e.observed_at) ?? "");
    const inWindow =
      env && at >= Date.parse(asString(env.observed_from) ?? "") && at <= Date.parse(asString(env.observed_to) ?? "");
    if (!inWindow) {
      out.push(
        issue(
          "PKG_EVIDENCE_REVISION_MISMATCH",
          `runtime evidence ${String(e.id)} is outside every observed environment window`,
          { rule: "CR-011", artifact: EI, json_pointer: ptr("evidence", i) },
        ),
      );
    }
  });
  if (revision) {
    const key = revisionKey(producer === "QAA" ? modelRevision : revision);
    asArray(model.claims)
      .map(asObject)
      .forEach((c, i) => {
        if (
          c.status !== "stale" &&
          typeof c.last_validated_revision === "string" &&
          c.last_validated_revision !== key
        ) {
          out.push(
            issue(
              "PKG_EVIDENCE_REVISION_MISMATCH",
              `claim ${String(c.id)} was validated against another revision but is not marked stale`,
              { rule: "CR-011", artifact: SM, json_pointer: ptr("claims", i, "last_validated_revision") },
            ),
          );
        }
      });
  }

  // CR-020 — producers publish only their own evidence types and origins.
  const mismatch = (artifact: string, pointer: string, message: string, rule: "CR-020" | "CR-021" = "CR-020") =>
    out.push(issue("PKG_EVIDENCE_PROFILE_INCONSISTENT", message, { rule, artifact, json_pointer: pointer }));
  if (model.producer !== producer)
    mismatch(SM, "/producer", "system model producer differs from the manifest producer");
  if (docs.completeness && docs.completeness.producer !== producer)
    mismatch(CR, "/producer", "completeness report producer differs from the manifest producer");
  evidence.forEach((e, i) => {
    const type = asString(e.source_type);
    if (producer === "SAA" && type === "runtime_observation")
      mismatch(EI, ptr("evidence", i), `SAA package contains runtime evidence ${String(e.id)}`);
    if (producer === "QAA" && type !== "runtime_observation" && type !== "human_annotation")
      mismatch(EI, ptr("evidence", i), `QAA package contains ${String(type)} evidence ${String(e.id)}`);
  });
  const allowedOrigins = producer === "SAA" ? ["source", "annotation"] : ["runtime", "annotation"];
  asArray(model.entities)
    .map(asObject)
    .forEach((e, i) => {
      if (typeof e.origin === "string" && !allowedOrigins.includes(e.origin))
        mismatch(
          SM,
          ptr("entities", i, "origin"),
          `entity ${String(e.id)} has origin ${e.origin} in a ${String(producer)} package`,
        );
    });
  asArray(model.workflows)
    .map(asObject)
    .forEach((w, i) => {
      if (typeof w.origin === "string" && !allowedOrigins.includes(w.origin))
        mismatch(
          SM,
          ptr("workflows", i, "origin"),
          `workflow ${String(w.id)} has origin ${w.origin} in a ${String(producer)} package`,
        );
    });

  // CR-021 — the evidence profile agrees with the evidence actually present.
  const hasSource = evidence.some((e) => SOURCE_TYPES.has(asString(e.source_type) ?? ""));
  const hasRuntime = evidence.some((e) => e.source_type === "runtime_observation");
  const claims = (dimension: string) => profile[dimension] === "available" || profile[dimension] === "partial";
  if (claims("source_analysis") && !hasSource)
    mismatch(
      "manifest",
      "/evidence_profile/source_analysis",
      "profile declares source analysis but the package has no source evidence",
      "CR-021",
    );
  if (claims("runtime_observation") && !hasRuntime)
    mismatch(
      "manifest",
      "/evidence_profile/runtime_observation",
      "profile declares runtime observation but the package has no runtime evidence",
      "CR-021",
    );

  // Diff and completeness reports must describe this package and run.
  if (docs.diff) {
    const target = asObject(docs.diff.target);
    if (target.package_id !== manifest.package_id || target.package_version !== manifest.package_version) {
      out.push(
        issue("PKG_ARTIFACT_INVALID", "diff report target is not this package version", {
          artifact: "diff-report",
          json_pointer: "/target",
        }),
      );
    }
    const previous = asObject(manifest.previous_package);
    const base = asObject(docs.diff.base);
    if (
      base.package_id !== manifest.package_id ||
      (previous.package_version !== undefined && base.package_version !== previous.package_version)
    ) {
      out.push(
        issue("PKG_ARTIFACT_INVALID", "diff report base is not the previous version of this package", {
          artifact: "diff-report",
          json_pointer: "/base",
        }),
      );
    }
  }
  if (docs.completeness && docs.completeness.run_id !== asObject(manifest.analysis).run_id) {
    out.push(
      issue("PKG_ARTIFACT_INVALID", "completeness report belongs to another analysis run", {
        artifact: CR,
        json_pointer: "/run_id",
      }),
    );
  }
  return out;
}

// ------------------------------------------------------------------ references (CR-010)

interface Index {
  entities: Map<string, JsonObject>;
  relationships: Map<string, JsonObject>;
  claims: Set<string>;
  gaps: Map<string, JsonObject>;
  traces: Map<string, JsonObject>;
  workflows: Set<string>;
  evidence: Map<string, JsonObject>;
}

function buildIndex(docs: PackageDocuments, out: ContractIssue[]): Index {
  const collect = <T extends Map<string, JsonObject> | Set<string>>(
    target: T,
    items: unknown,
    artifact: string,
    collection: string,
  ): T => {
    asArray(items)
      .map(asObject)
      .forEach((item, i) => {
        const id = asString(item.id);
        if (id === undefined) return;
        if (target.has(id)) {
          out.push(
            issue("PKG_ARTIFACT_INVALID", `duplicate id ${id}`, {
              rule: "CR-010",
              artifact,
              json_pointer: ptr(collection, i, "id"),
            }),
          );
        }
        if (target instanceof Map) target.set(id, item);
        else target.add(id);
      });
    return target;
  };
  const m = docs.model;
  return {
    entities: collect(new Map(), m.entities, SM, "entities"),
    relationships: collect(new Map(), m.relationships, SM, "relationships"),
    claims: collect(new Set(), m.claims, SM, "claims"),
    gaps: collect(new Map(), m.gaps, SM, "gaps"),
    traces: collect(new Map(), m.component_traces, SM, "component_traces"),
    workflows: collect(new Set(), m.workflows, SM, "workflows"),
    evidence: collect(new Map(), docs.evidenceIndex.evidence, EI, "evidence"),
  };
}

export function referenceIssues(docs: PackageDocuments): { issues: ContractIssue[]; index: Index } {
  const out: ContractIssue[] = [];
  const index = buildIndex(docs, out);
  const check = (
    target: { has(id: string): boolean },
    kind: string,
    id: unknown,
    artifact: string,
    pointer: string,
  ) => {
    if (typeof id === "string" && !target.has(id)) {
      out.push(
        issue("PKG_REFERENCE_BROKEN", `${kind} ${id} does not exist`, {
          rule: "CR-010",
          artifact,
          json_pointer: pointer,
          details: { id, kind },
        }),
      );
    }
  };
  const checkAll = (
    target: { has(id: string): boolean },
    kind: string,
    ids: unknown,
    artifact: string,
    pointer: string,
  ) => asArray(ids).forEach((id, i) => check(target, kind, id, artifact, `${pointer}/${i}`));
  const { entities, relationships, claims, gaps, traces, workflows, evidence } = index;
  const anyKnown = { has: (id: string) => entities.has(id) || workflows.has(id) || claims.has(id) || gaps.has(id) };

  asArray(docs.model.entities)
    .map(asObject)
    .forEach((e, i) => {
      const p = (...t: Array<string | number>) => ptr("entities", i, ...t);
      checkAll(evidence, "evidence", e.evidence_ids, SM, p("evidence_ids"));
      checkAll(claims, "claim", e.claim_ids, SM, p("claim_ids"));
      checkAll(gaps, "gap", e.gap_ids, SM, p("gap_ids"));
      checkAll(gaps, "gap", e.contradiction_ids, SM, p("contradiction_ids"));
      for (const field of [
        "project_boundary",
        "module_id",
        "page_id",
        "form_id",
        "submits_to",
        "handler_id",
        "subject",
      ])
        check(entities, "entity", e[field], SM, p(field));
      for (const field of ["access_preconditions", "permissions", "inputs"])
        checkAll(entities, "entity", e[field], SM, p(field));
      for (const field of ["transitions", "invalid_transitions_known"]) {
        asArray(e[field])
          .map(asObject)
          .forEach((t, j) => {
            check(entities, "entity", t.trigger, SM, p(field, j, "trigger"));
            check(entities, "entity", t.guard, SM, p(field, j, "guard"));
            checkAll(evidence, "evidence", t.evidence_ids, SM, p(field, j, "evidence_ids"));
          });
      }
    });
  asArray(docs.model.relationships)
    .map(asObject)
    .forEach((r, i) => {
      check(entities, "entity", r.from, SM, ptr("relationships", i, "from"));
      check(entities, "entity", r.to, SM, ptr("relationships", i, "to"));
      checkAll(evidence, "evidence", r.evidence_ids, SM, ptr("relationships", i, "evidence_ids"));
    });
  asArray(docs.model.component_traces)
    .map(asObject)
    .forEach((t, i) => {
      check(entities, "entity", t.entry_point_id, SM, ptr("component_traces", i, "entry_point_id"));
      checkAll(relationships, "relationship", t.relationship_ids, SM, ptr("component_traces", i, "relationship_ids"));
      asArray(t.stopped_at)
        .map(asObject)
        .forEach((s, j) => {
          check(entities, "entity", s.entity_id, SM, ptr("component_traces", i, "stopped_at", j, "entity_id"));
          check(gaps, "gap", s.gap_id, SM, ptr("component_traces", i, "stopped_at", j, "gap_id"));
        });
    });
  asArray(docs.model.workflows)
    .map(asObject)
    .forEach((w, i) => {
      const p = (...t: Array<string | number>) => ptr("workflows", i, ...t);
      const steps = new Set(
        asArray(w.steps)
          .map((s) => asString(asObject(s).id))
          .filter((s): s is string => s !== undefined),
      );
      check(entities, "entity", w.actor, SM, p("actor"));
      checkAll(entities, "entity", w.entry_point_ids, SM, p("entry_point_ids"));
      checkAll(traces, "component trace", w.component_trace_ids, SM, p("component_trace_ids"));
      checkAll(evidence, "evidence", w.evidence_ids, SM, p("evidence_ids"));
      asArray(w.steps)
        .map(asObject)
        .forEach((s, j) => {
          check(entities, "entity", s.entity_id, SM, p("steps", j, "entity_id"));
          for (const field of ["validations", "reads", "writes", "side_effects"])
            checkAll(entities, "entity", s[field], SM, p("steps", j, field));
        });
      asArray(w.branches)
        .map(asObject)
        .forEach((b, j) => check(steps, "workflow step", b.from_step, SM, p("branches", j, "from_step")));
      asArray(w.unresolved_hops)
        .map(asObject)
        .forEach((h, j) => {
          check(steps, "workflow step", h.after_step, SM, p("unresolved_hops", j, "after_step"));
          check(gaps, "gap", h.gap_id, SM, p("unresolved_hops", j, "gap_id"));
        });
    });
  asArray(docs.model.claims)
    .map(asObject)
    .forEach((c, i) => {
      check(entities, "entity", c.subject_entity_id, SM, ptr("claims", i, "subject_entity_id"));
      checkAll(relationships, "relationship", c.relationship_ids, SM, ptr("claims", i, "relationship_ids"));
      checkAll(evidence, "evidence", c.evidence_ids, SM, ptr("claims", i, "evidence_ids"));
      checkAll(gaps, "gap", c.gap_ids, SM, ptr("claims", i, "gap_ids"));
    });
  asArray(docs.model.gaps)
    .map(asObject)
    .forEach((g, i) => {
      checkAll(evidence, "evidence", g.evidence_ids, SM, ptr("gaps", i, "evidence_ids"));
      checkAll(entities, "entity", g.related_entity_ids, SM, ptr("gaps", i, "related_entity_ids"));
    });
  if (docs.completeness) {
    const c = docs.completeness;
    checkAll(workflows, "workflow", c.unresolved_workflow_ids, CR, "/unresolved_workflow_ids");
    checkAll(entities, "entity", asObject(c.examined).boundaries, CR, "/examined/boundaries");
    asArray(c.forms_not_submitted)
      .map(asObject)
      .forEach((f, i) => check(entities, "entity", f.form_id, CR, ptr("forms_not_submitted", i, "form_id")));
    asArray(c.improvement_suggestions)
      .map(asObject)
      .forEach((s, i) =>
        checkAll(anyKnown, "item", s.would_improve, CR, ptr("improvement_suggestions", i, "would_improve")),
      );
  }
  return { issues: out, index };
}

// ------------------------------------------------------------------ evidence strength (CR-001, CR-002, CR-030, CR-042)

export function evidenceStrengthIssues(docs: PackageDocuments, index: Index): ContractIssue[] {
  const out: ContractIssue[] = [];
  const producer = asString(asObject(docs.manifest.producer).name);
  const revision = packageRevision(docs);
  const currentKey = revision
    ? revisionKey(producer === "QAA" ? (docs.model.revision as Revision) : revision)
    : undefined;
  const exceeds = (rule: "CR-001" | "CR-002", pointer: string, message: string) =>
    out.push(issue("PKG_CLAIM_EXCEEDS_EVIDENCE", message, { rule, artifact: SM, json_pointer: pointer }));
  const typesOf = (ids: unknown) =>
    asStrings(ids)
      .map((id) => index.evidence.get(id))
      .filter((e): e is JsonObject => e !== undefined);
  const relationshipEvidence = (relIds: unknown) =>
    asStrings(relIds).flatMap((id) => asStrings(index.relationships.get(id)?.evidence_ids));

  const checkStatus = (
    label: string,
    pointer: string,
    status: unknown,
    evidenceIds: unknown,
    linkedGaps: string[],
    extra: { lastValidated?: unknown } = {},
  ) => {
    const records = typesOf(evidenceIds);
    const types = new Set(records.map((e) => asString(e.source_type)));
    const has = (...wanted: string[]) => wanted.some((t) => types.has(t));
    const gapTypes = linkedGaps.map((id) => index.gaps.get(id)?.type);
    switch (status) {
      case "source_verified":
        if (![...types].some((t) => VERIFYING_SOURCE_TYPES.has(t ?? "")))
          exceeds(
            "CR-001",
            pointer,
            `${label} is source_verified without source, configuration, schema, migration or manifest evidence`,
          );
        if (producer !== "SAA")
          exceeds("CR-001", pointer, `${label} is source_verified in a ${String(producer)} package`);
        break;
      case "test_verified":
        if (!has("test_result")) exceeds("CR-001", pointer, `${label} is test_verified without test_result evidence`);
        break;
      case "runtime_observed":
        if (!has("runtime_observation"))
          exceeds("CR-001", pointer, `${label} is runtime_observed without runtime observation evidence`);
        if (producer !== "QAA")
          exceeds("CR-001", pointer, `${label} is runtime_observed in a ${String(producer)} package`);
        break;
      case "human_asserted":
        if (!has("human_annotation", "requirement_document"))
          exceeds("CR-001", pointer, `${label} is human_asserted without an annotation or requirement document`);
        break;
      case "contradicted":
        if (records.length < 2 || types.size < 2)
          exceeds("CR-001", pointer, `${label} is contradicted without evidence of two different origins`);
        if (!gapTypes.includes("contradiction"))
          exceeds("CR-001", pointer, `${label} is contradicted without a linked contradiction gap`);
        break;
      case "stale":
        if (extra.lastValidated !== undefined && extra.lastValidated === currentKey)
          exceeds("CR-001", pointer, `${label} is stale but was validated against the current revision`);
        break;
      default:
        break; // inferred and unresolved are covered by schema rules (rationale / gap required)
    }
  };

  asArray(docs.model.entities)
    .map(asObject)
    .forEach((e, i) => {
      const label = `entity ${String(e.id)}`;
      checkStatus(label, ptr("entities", i, "status"), e.status, e.evidence_ids, [
        ...asStrings(e.gap_ids),
        ...asStrings(e.contradiction_ids),
      ]);
      for (const field of ["transitions", "invalid_transitions_known"]) {
        asArray(e[field])
          .map(asObject)
          .forEach((t, j) =>
            checkStatus(
              `${label} ${field}[${j}]`,
              ptr("entities", i, field, j, "status"),
              t.status,
              t.evidence_ids,
              [],
            ),
          );
      }
    });
  asArray(docs.model.relationships)
    .map(asObject)
    .forEach((r, i) => {
      const label = `relationship ${String(r.id)}`;
      checkStatus(label, ptr("relationships", i, "status"), r.status, r.evidence_ids, []);
      const records = typesOf(r.evidence_ids);
      const runtimeOnly = records.length > 0 && records.every((e) => e.source_type === "runtime_observation");
      if (
        (runtimeOnly || r.status === "runtime_observed") &&
        RUNTIME_FORBIDDEN_RELATIONSHIPS.has(asString(r.type) ?? "")
      ) {
        exceeds(
          "CR-002",
          ptr("relationships", i, "type"),
          `${label}: ${String(r.type)} cannot be established from runtime observation`,
        );
      }
      if (
        (runtimeOnly || r.status === "runtime_observed") &&
        r.type === "SUBMITS_TO" &&
        !records.some((e) => e.submission === "read_only" || e.submission === "approved_test")
      ) {
        exceeds(
          "CR-002",
          ptr("relationships", i, "type"),
          `${label}: SUBMITS_TO needs evidence from a read-only submission or an approved test`,
        );
      }
    });
  asArray(docs.model.claims)
    .map(asObject)
    .forEach((c, i) => {
      checkStatus(`claim ${String(c.id)}`, ptr("claims", i, "status"), c.status, c.evidence_ids, asStrings(c.gap_ids), {
        lastValidated: c.last_validated_revision,
      });
    });
  asArray(docs.model.component_traces)
    .map(asObject)
    .forEach((t, i) => {
      checkStatus(
        `component trace ${String(t.id)}`,
        ptr("component_traces", i, "status"),
        t.status,
        relationshipEvidence(t.relationship_ids),
        [],
      );
    });
  asArray(docs.model.workflows)
    .map(asObject)
    .forEach((w, i) => {
      const own = asStrings(w.evidence_ids);
      const viaTraces = asStrings(w.component_trace_ids).flatMap((id) =>
        relationshipEvidence(index.traces.get(id)?.relationship_ids),
      );
      const gapsOfHops = asArray(w.unresolved_hops)
        .map((h) => asString(asObject(h).gap_id))
        .filter((g): g is string => g !== undefined);
      checkStatus(
        `workflow ${String(w.id)}`,
        ptr("workflows", i, "status"),
        w.status,
        own.length > 0 ? own : viaTraces,
        gapsOfHops,
      );
      if (w.discovery_status === "known_not_traceable") {
        if (own.length === 0)
          out.push(
            issue(
              "PKG_ARTIFACT_INVALID",
              `workflow ${String(w.id)} is known_not_traceable without evidence of its existence`,
              { rule: "CR-042", artifact: SM, json_pointer: ptr("workflows", i, "evidence_ids") },
            ),
          );
        if (asArray(w.component_trace_ids).length > 0)
          out.push(
            issue(
              "PKG_ARTIFACT_INVALID",
              `workflow ${String(w.id)} is known_not_traceable but lists component traces`,
              { rule: "CR-042", artifact: SM, json_pointer: ptr("workflows", i, "component_trace_ids") },
            ),
          );
      }
    });

  // CR-030 — every absent, unsupported or unobservable coverage category is explained by a gap.
  const explained = new Set([...index.gaps.values()].map((g) => asString(g.coverage_category)));
  for (const [category, value] of Object.entries(asObject(docs.manifest.coverage_summary))) {
    if ((value === "absent" || value === "unsupported" || value === "unobservable") && !explained.has(category)) {
      out.push(
        issue(
          "PKG_ARTIFACT_INVALID",
          `coverage category ${category} is ${String(value)} without a gap that explains it`,
          { rule: "CR-030", artifact: "manifest", json_pointer: ptr("coverage_summary", category) },
        ),
      );
    }
  }
  return out;
}
