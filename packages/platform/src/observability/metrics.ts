import { statSync } from "node:fs";
import type { Database } from "better-sqlite3";
import type { JobStore } from "../jobs/store.js";

/**
 * Operational metrics (OBS-001, QAA-FR-103), computed from persisted state so they survive restarts and need no
 * separate store. Sources that do not exist yet are reported as `null` in `not_collected`, never as zero.
 */
export interface MetricsSnapshot {
  generated_at: string;
  jobs: {
    queued_by_type: Record<string, number>;
    running: number;
    by_state: Record<string, number>;
    failures_by_code: Record<string, number>;
    cancellations: number;
    worker_crashes: number;
    stuck: number;
    duration_ms: { count: number; p50: number | null; p95: number | null; max: number | null };
  };
  model_usage: {
    calls: number;
    errors: number;
    tokens_in: number;
    tokens_out: number;
    by_model: Array<{ provider: string; model: string; calls: number; tokens_in: number; tokens_out: number }>;
  };
  process: { rss_bytes: number; heap_used_bytes: number; cpu_user_us: number; cpu_system_us: number; uptime_s: number };
  storage: { state_db_bytes: number | null };
  /** Metrics whose producers arrive with later tasks. */
  not_collected: Record<"evidence_volume" | "cache_hit_rate" | "adapter_failure_rate" | "browser_duration", null>;
}

export interface MetricsSources {
  db: Database;
  jobs: JobStore;
  now: () => Date;
  stateDbPath?: string;
  stuckAfterMs?: number;
}

const percentile = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

export function collectMetrics(sources: MetricsSources): MetricsSnapshot {
  const { db } = sources;
  const queued = db
    .prepare("SELECT type, count(*) AS n FROM jobs WHERE state = 'queued' GROUP BY type ORDER BY type")
    .all() as Array<{ type: string; n: number }>;
  const states = db.prepare("SELECT state, count(*) AS n FROM jobs GROUP BY state ORDER BY state").all() as Array<{
    state: string;
    n: number;
  }>;
  const failures = db
    .prepare(
      "SELECT json_extract(error_json, '$.code') AS code, count(*) AS n FROM jobs WHERE state = 'failed' AND error_json IS NOT NULL GROUP BY code ORDER BY code",
    )
    .all() as Array<{ code: string; n: number }>;
  const crashes = (
    db
      .prepare("SELECT count(*) AS n FROM job_events WHERE json_extract(data_json, '$.error.code') = 'WORKER_CRASHED'")
      .get() as { n: number }
  ).n;
  // Duration of every finished attempt: from its `state.running` event to the next terminal or retry event.
  const durations = (
    db
      .prepare(
        `SELECT (julianday(e2.at) - julianday(e1.at)) * 86400000.0 AS ms
         FROM job_events e1 JOIN job_events e2 ON e2.job_id = e1.job_id
          AND e2.seq = (SELECT min(seq) FROM job_events e3 WHERE e3.job_id = e1.job_id AND e3.seq > e1.seq
                        AND e3.event IN ('state.completed', 'state.failed', 'state.cancelled', 'state.queued'))
         WHERE e1.event = 'state.running'`,
      )
      .all() as Array<{ ms: number }>
  )
    .map((r) => Math.round(r.ms))
    .sort((a, b) => a - b);
  const usage = db
    .prepare(
      "SELECT count(*) AS calls, coalesce(sum(outcome = 'error'), 0) AS errors, coalesce(sum(tokens_in), 0) AS tin, coalesce(sum(tokens_out), 0) AS tout FROM model_usage",
    )
    .get() as {
    calls: number;
    errors: number;
    tin: number;
    tout: number;
  };
  const byModel = db
    .prepare(
      "SELECT provider, model, count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out FROM model_usage GROUP BY provider, model ORDER BY provider, model",
    )
    .all() as MetricsSnapshot["model_usage"]["by_model"];
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  let stateBytes: number | null = null;
  if (sources.stateDbPath) {
    try {
      stateBytes = statSync(sources.stateDbPath).size;
    } catch {
      stateBytes = null;
    }
  }
  const byState = Object.fromEntries(states.map((s) => [s.state, s.n]));
  return {
    generated_at: sources.now().toISOString(),
    jobs: {
      queued_by_type: Object.fromEntries(queued.map((q) => [q.type, q.n])),
      running: (byState.running ?? 0) + (byState.cancelling ?? 0),
      by_state: byState,
      failures_by_code: Object.fromEntries(failures.map((f) => [f.code, f.n])),
      cancellations: byState.cancelled ?? 0,
      worker_crashes: crashes,
      stuck: sources.jobs.findStuck(sources.stuckAfterMs ?? 15 * 60_000).length,
      duration_ms: {
        count: durations.length,
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        max: durations.at(-1) ?? null,
      },
    },
    model_usage: {
      calls: usage.calls,
      errors: usage.errors,
      tokens_in: usage.tin,
      tokens_out: usage.tout,
      by_model: byModel,
    },
    process: {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      uptime_s: Math.round(process.uptime()),
    },
    storage: { state_db_bytes: stateBytes },
    not_collected: { evidence_volume: null, cache_hit_rate: null, adapter_failure_rate: null, browser_duration: null },
  };
}

const label = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Prometheus text exposition format (version 0.0.4) for the metrics endpoint. */
export function renderPrometheus(m: MetricsSnapshot): string {
  const lines: string[] = [];
  const metric = (
    name: string,
    help: string,
    type: "gauge" | "counter",
    samples: Array<[Record<string, string>, number | null]>,
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      if (value === null) continue;
      const l = Object.entries(labels);
      lines.push(`${name}${l.length ? `{${l.map(([k, v]) => `${k}="${label(v)}"`).join(",")}}` : ""} ${value}`);
    }
  };
  metric(
    "sys2qa_jobs_queued",
    "Jobs waiting in the queue, by type.",
    "gauge",
    Object.entries(m.jobs.queued_by_type).map(([type, n]) => [{ type }, n]),
  );
  metric("sys2qa_jobs_running", "Jobs running or cancelling.", "gauge", [[{}, m.jobs.running]]);
  metric(
    "sys2qa_jobs",
    "Jobs by state.",
    "gauge",
    Object.entries(m.jobs.by_state).map(([state, n]) => [{ state }, n]),
  );
  metric(
    "sys2qa_job_failures_total",
    "Failed jobs by error code.",
    "counter",
    Object.entries(m.jobs.failures_by_code).map(([code, n]) => [{ code }, n]),
  );
  metric("sys2qa_job_worker_crashes_total", "Worker processes that exited without a result.", "counter", [
    [{}, m.jobs.worker_crashes],
  ]);
  metric("sys2qa_jobs_stuck", "Running jobs without recent progress or with an expired lease.", "gauge", [
    [{}, m.jobs.stuck],
  ]);
  metric("sys2qa_job_duration_ms", "Job attempt duration percentiles.", "gauge", [
    [{ quantile: "0.5" }, m.jobs.duration_ms.p50],
    [{ quantile: "0.95" }, m.jobs.duration_ms.p95],
  ]);
  metric("sys2qa_llm_calls_total", "Model calls, including failed ones.", "counter", [[{}, m.model_usage.calls]]);
  metric("sys2qa_llm_errors_total", "Model calls that failed.", "counter", [[{}, m.model_usage.errors]]);
  metric("sys2qa_llm_tokens_total", "Model tokens by direction.", "counter", [
    [{ direction: "in" }, m.model_usage.tokens_in],
    [{ direction: "out" }, m.model_usage.tokens_out],
  ]);
  metric("sys2qa_process_resident_memory_bytes", "Resident memory of the host process.", "gauge", [
    [{}, m.process.rss_bytes],
  ]);
  metric("sys2qa_state_db_bytes", "Size of state.db.", "gauge", [[{}, m.storage.state_db_bytes]]);
  return `${lines.join("\n")}\n`;
}
