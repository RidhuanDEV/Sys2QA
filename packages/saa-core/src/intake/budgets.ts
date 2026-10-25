/** Analysis profiles (PRD W2 step 1). */
export type AnalysisProfile = "overview" | "standard" | "deep";

/** Per-run limits (SAA-FR-039, NFR-002). Exhausting one makes the run `partial` with the unvisited scope listed. */
export interface AnalysisBudget {
  /** Files included in the inventory. */
  max_files: number;
  /** Larger files are skipped with reason `too_large`. */
  max_file_bytes: number;
  /** Total size of included files. */
  max_total_bytes: number;
  /** Directory depth below a root; deeper directories are skipped with reason `depth_budget`. */
  max_depth: number;
  max_minutes: number;
  max_llm_tokens: number;
}

const MIB = 1024 ** 2;

/**
 * Starting defaults, to be tuned against the Gate 1 baseline (PRD §26.4 forbids numeric targets before a baseline).
 * A run may override any field.
 */
export const ANALYSIS_PROFILES: Readonly<Record<AnalysisProfile, AnalysisBudget>> = {
  overview: {
    max_files: 20_000,
    max_file_bytes: 1 * MIB,
    max_total_bytes: 512 * MIB,
    max_depth: 32,
    max_minutes: 10,
    max_llm_tokens: 0,
  },
  standard: {
    max_files: 100_000,
    max_file_bytes: 2 * MIB,
    max_total_bytes: 2048 * MIB,
    max_depth: 64,
    max_minutes: 30,
    max_llm_tokens: 200_000,
  },
  deep: {
    max_files: 500_000,
    max_file_bytes: 5 * MIB,
    max_total_bytes: 8192 * MIB,
    max_depth: 128,
    max_minutes: 120,
    max_llm_tokens: 1_000_000,
  },
};

export function budgetFor(profile: AnalysisProfile, overrides: Partial<AnalysisBudget> = {}): AnalysisBudget {
  return { ...ANALYSIS_PROFILES[profile], ...overrides };
}
