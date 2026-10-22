import type { MetricsSnapshot } from "./metrics.js";

/**
 * Anonymous aggregate telemetry (OBS-005). Off by default and opt-in; the payload is built from an allowlist of
 * counts and versions only, so source, secrets, paths, IDs, names and knowledge-base content cannot be included.
 */
export interface TelemetryPayload {
  schema: "sys2qa.telemetry/1";
  product_version: string;
  os_family: "linux" | "darwin" | "win32" | "other";
  node_major: number;
  jobs_by_state: Record<string, number>;
  llm_calls: number;
}

const OS_FAMILIES = new Set(["linux", "darwin", "win32"]);
const JOB_STATES = new Set(["queued", "running", "cancelling", "completed", "failed", "cancelled"]);

export function buildTelemetryPayload(metrics: MetricsSnapshot, productVersion: string): TelemetryPayload {
  return {
    schema: "sys2qa.telemetry/1",
    product_version: /^\d+\.\d+\.\d+$/.test(productVersion) ? productVersion : "unknown",
    os_family: (OS_FAMILIES.has(process.platform) ? process.platform : "other") as TelemetryPayload["os_family"],
    node_major: Number(process.versions.node.split(".")[0]),
    jobs_by_state: Object.fromEntries(Object.entries(metrics.jobs.by_state).filter(([state]) => JOB_STATES.has(state))),
    llm_calls: metrics.model_usage.calls,
  };
}

export type TelemetryTransport = (payload: TelemetryPayload) => Promise<void>;

/**
 * Sends a payload only when telemetry is enabled and a transport is configured. No transport ships with Sys2QA; a
 * build that adds one must document its endpoint (OBS-005). Returns whether anything was sent.
 */
export async function maybeSendTelemetry(
  enabled: boolean,
  transport: TelemetryTransport | undefined,
  payload: () => TelemetryPayload,
): Promise<boolean> {
  if (!enabled || !transport) return false;
  await transport(payload());
  return true;
}
