import type { GroundTruth } from "./ground-truth.js";
import type { ProducerOutput } from "./producer-output.js";

/** Controlled defects, so the harness can be checked against known metric values (IMP-014). */
export interface StubDefects {
  /** Expected workflows (by key) the stub fails to discover; it reports their area as unexplored when `honest`. */
  miss?: string[];
  honest?: boolean;
  /** Extra workflows that match nothing. */
  inventWorkflows?: number;
  /** Drops the last canonical step of every discovered workflow. */
  dropLastStep?: boolean;
  /** Asserts every forbidden relationship of the ground truth. */
  overClaim?: boolean;
  /** Cites an evidence ID that does not exist on the first claim. */
  danglingEvidence?: boolean;
  /** Reports gaps that are not true gaps. */
  falseGaps?: number;
}

const REVISION = { kind: "git_commit", value: "0".repeat(40), worktree_dirty: false };

/** A producer that echoes the ground truth (plus defects). It stands in for SAA/QAA until Gate 1. */
export function stubProducer(truth: GroundTruth, defects: StubDefects = {}): ProducerOutput {
  const missed = new Set(defects.miss ?? []);
  const evidence: Array<{ id: string }> = [];
  const claims: ProducerOutput["systemModel"]["claims"] = [];
  const entities = truth.entities.map((e) => {
    const evidenceId = `evidence:${e.id
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 24)
      .toLowerCase()}${evidence.length}`;
    evidence.push({ id: evidenceId });
    claims.push({
      id: `claim:${claims.length + 1}`,
      text: { value: `${e.id} exists` },
      status: "source_verified",
      evidence_ids: [evidenceId],
    });
    return { id: e.id, kind: e.kind, status: "source_verified" };
  });
  if (defects.danglingEvidence && claims[0]) claims[0].evidence_ids = ["evidence:missing"];

  const workflows: ProducerOutput["systemModel"]["workflows"] = truth.workflows
    .filter((w) => !missed.has(w.key))
    .map((w) => {
      const steps = (defects.dropLastStep && w.steps.length > 1 ? w.steps.slice(0, -1) : w.steps).map((entity, i) => ({
        id: `step:${w.key}.${i + 1}`,
        order: i + 1,
        entity_id: entity,
      }));
      const stepOf = (entity: string | null) => steps.find((s) => s.entity_id === entity)?.id;
      return {
        id: `workflow:${w.key}`,
        category: w.category,
        discovery_status: w.stop_points.length > 0 ? "partially_reconstructed" : "reconstructed",
        entry_point_ids: [w.entry_point],
        steps,
        branches: w.branches.flatMap((b) => {
          const from = stepOf(b.from);
          return from ? [{ from_step: from, outcome: b.outcome }] : [];
        }),
        unresolved_hops: w.stop_points.map((s) => {
          const after = stepOf(s.after);
          return after ? { after_step: after, reason_code: s.reason_code } : { reason_code: s.reason_code };
        }),
      };
    });
  for (let i = 0; i < (defects.inventWorkflows ?? 0); i++) {
    workflows.push({
      id: `workflow:invented.${i}`,
      category: "api",
      discovery_status: "reconstructed",
      entry_point_ids: [`api:GET:/invented/${i}`],
      steps: [{ id: `step:invented.${i}.1`, order: 1, entity_id: `api:GET:/invented/${i}` }],
      branches: [],
      unresolved_hops: [],
    });
  }

  const gaps: ProducerOutput["systemModel"]["gaps"] = truth.gaps.map((g) => ({
    id: `gap:${g.key}`,
    type: g.type,
    related_entity_ids: g.related,
  }));
  for (const boundary of new Set(
    truth.workflows.filter((w) => !missed.has(w.key)).flatMap((w) => w.external_boundaries),
  )) {
    if (!gaps.some((g) => g.type === "external_boundary" && g.related_entity_ids?.includes(boundary)))
      gaps.push({ id: `gap:boundary.${boundary}`, type: "external_boundary", related_entity_ids: [boundary] });
  }
  for (let i = 0; i < (defects.falseGaps ?? 0); i++)
    gaps.push({ id: `gap:false.${i}`, type: "missing_evidence", related_entity_ids: [`module:not.real.${i}`] });

  const relationships = defects.overClaim
    ? truth.forbidden_claims
        .filter((f) => f.relationship)
        .map((f, i) => ({
          id: `rel:forbidden.${i}`,
          type: f.relationship!.type,
          from: f.relationship!.from ?? "x",
          to: f.relationship!.to ?? "y",
          status: "runtime_observed",
          evidence_ids: [],
        }))
    : [];
  const coverage = [...new Set(truth.workflows.map((w) => w.area))].map((area) => ({
    area,
    status:
      defects.honest && truth.workflows.some((w) => w.area === area && missed.has(w.key)) ? "unsupported" : "analyzed",
  }));
  return {
    systemModel: { revision: REVISION, entities, relationships, workflows, claims, gaps, coverage },
    evidenceIndex: { revision: REVISION, evidence },
  };
}
