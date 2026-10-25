/** What a producer hands the harness: contract documents plus, where they exist, scenarios and runtime facts. */
export interface ProducedWorkflow {
  id: string;
  category: string;
  discovery_status: string;
  entry_point_ids: string[];
  steps: Array<{ id: string; order: number; entity_id: string }>;
  branches: Array<{ from_step: string; outcome: string }>;
  unresolved_hops: Array<{ after_step?: string; reason_code: string }>;
}

export interface ProducerOutput {
  systemModel: {
    revision: unknown;
    entities: Array<{ id: string; kind: string; status: string }>;
    relationships: Array<{
      id: string;
      type: string;
      from: string;
      to: string;
      status: string;
      evidence_ids: string[];
    }>;
    workflows: ProducedWorkflow[];
    claims: Array<{
      id: string;
      text: { value: string } | Array<{ value: string }> | string;
      status: string;
      evidence_ids: string[];
    }>;
    gaps: Array<{ id: string; type: string; related_entity_ids?: string[] }>;
    coverage: Array<{ area: string; status: string }>;
  };
  evidenceIndex: { revision: unknown; evidence: Array<{ id: string }> };
  /** The completeness report: what the producer says it did not explore (SAA-FR-045, QAA-FR-114). */
  completeness?: { unexplored: Array<{ area: string }>; excluded: Array<{ area: string }> };
  /** Scenario documents (Gate 2 onwards). */
  scenarios?: Array<{
    test_condition?: string;
    techniques: string[];
    qa_objective: string;
    expected_results: Array<{ basis: string; oracle_class: string }>;
  }>;
  /** Runtime discovery facts (Gate 4 onwards). */
  runtime?: { visited_pages: string[]; discovered_forms: string[]; submitted_forms: string[] };
}
