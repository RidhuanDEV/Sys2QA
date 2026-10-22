import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectSecrets, validateJsonSchema } from "@sys2qa/contract";
import type { LlmConfig } from "../llm/config.js";
import type { LogLevel } from "../logging/logger.js";

/** Installation configuration (Architecture §7). Secrets appear only as `secretref:` references. */
export interface Sys2QaConfig {
  llm: LlmConfig;
  log_level: LogLevel;
  jobs: { max_concurrent: number; cancel_grace_ms: number; lease_ms: number };
  /** File patterns never sent to a model, in addition to the built-in exclusions (SEC-018). */
  llm_exclusions: string[];
}

export const DEFAULT_CONFIG: Sys2QaConfig = {
  llm: { provider: "none" },
  log_level: "info",
  jobs: { max_concurrent: 2, cancel_grace_ms: 10_000, lease_ms: 30_000 },
  llm_exclusions: [],
};

export const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    llm: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["provider"],
          properties: { provider: { const: "none" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["provider", "base_url", "model"],
          properties: {
            provider: { const: "openai_compatible" },
            base_url: { type: "string", pattern: "^https?://" },
            model: { type: "string", minLength: 1 },
            api_key_ref: { type: "string", pattern: "^secretref:[A-Za-z0-9._-]+$" },
            remote_consent: { type: "boolean" },
          },
        },
      ],
    },
    log_level: { enum: ["debug", "info", "warn", "error"] },
    jobs: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_concurrent: { type: "integer", minimum: 1, maximum: 64 },
        cancel_grace_ms: { type: "integer", minimum: 100, maximum: 600_000 },
        lease_ms: { type: "integer", minimum: 1000, maximum: 3_600_000 },
      },
    },
    llm_exclusions: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export type ConfigSource = "default" | "user_file" | "env" | "override";

export interface LoadedConfig {
  config: Sys2QaConfig;
  /** Where each top-level setting came from, so `config show` can explain it. */
  sources: Record<keyof Sys2QaConfig, ConfigSource>;
  file: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    readonly code: "CONFIG_INVALID" | "CONFIG_SECRET_SUSPECTED",
    message: string,
    readonly remediation: string,
  ) {
    super(message);
  }
}

type PartialConfig = { [K in keyof Sys2QaConfig]?: K extends "jobs" ? Partial<Sys2QaConfig["jobs"]> : Sys2QaConfig[K] };

/** `SYS2QA_*` environment variables (the layer above the user file). */
export function configFromEnv(env: Record<string, string | undefined>): PartialConfig {
  const out: PartialConfig = {};
  if (env.SYS2QA_LLM_PROVIDER === "none") out.llm = { provider: "none" };
  else if (env.SYS2QA_LLM_PROVIDER === "openai_compatible" || env.SYS2QA_LLM_BASE_URL) {
    out.llm = {
      provider: "openai_compatible",
      base_url: env.SYS2QA_LLM_BASE_URL ?? "",
      model: env.SYS2QA_LLM_MODEL ?? "",
      ...(env.SYS2QA_LLM_API_KEY_REF ? { api_key_ref: env.SYS2QA_LLM_API_KEY_REF as `secretref:${string}` } : {}),
      ...(env.SYS2QA_LLM_REMOTE_CONSENT === "1" || env.SYS2QA_LLM_REMOTE_CONSENT === "true"
        ? { remote_consent: true }
        : {}),
    };
  }
  if (env.SYS2QA_LOG_LEVEL) out.log_level = env.SYS2QA_LOG_LEVEL as LogLevel;
  if (env.SYS2QA_JOBS_MAX_CONCURRENT) out.jobs = { max_concurrent: Number(env.SYS2QA_JOBS_MAX_CONCURRENT) };
  return out;
}

/**
 * Loads the configuration layers: defaults → `<home>/config.json` → environment → overrides (CLI flags). Project-level
 * settings (languages, environments) live in the state database, never in a file inside the analyzed repository.
 * The result is validated, and a config file holding something that looks like a secret is refused (SEC-004).
 */
export function loadConfig(options: {
  home: string;
  env?: Record<string, string | undefined>;
  overrides?: PartialConfig;
}): LoadedConfig {
  const file = join(options.home, "config.json");
  let user: PartialConfig = {};
  let raw: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw !== undefined) {
    if (detectSecrets(raw).length > 0) {
      throw new ConfigError(
        "CONFIG_SECRET_SUSPECTED",
        `${file} appears to contain a secret`,
        "Store the value in the secret store and put its `secretref:` reference in the configuration instead.",
      );
    }
    try {
      user = JSON.parse(raw) as PartialConfig;
    } catch {
      throw new ConfigError(
        "CONFIG_INVALID",
        `${file} is not valid JSON`,
        "Fix the JSON syntax or delete the file to use the defaults.",
      );
    }
    check(user, file);
  }
  const env = configFromEnv(options.env ?? {});
  check(env, "SYS2QA_* environment variables");
  const overrides = options.overrides ?? {};
  check(overrides, "command-line options");
  const sources = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((k) => [k, "default"])) as LoadedConfig["sources"];
  const config: Sys2QaConfig = structuredClone(DEFAULT_CONFIG);
  for (const [layer, values] of [
    ["user_file", user],
    ["env", env],
    ["override", overrides],
  ] as const) {
    for (const [key, value] of Object.entries(values) as Array<[keyof Sys2QaConfig, unknown]>) {
      if (value === undefined) continue;
      (config as unknown as Record<string, unknown>)[key] =
        key === "jobs" ? { ...config.jobs, ...(value as object) } : value;
      sources[key] = layer;
    }
  }
  return { config, sources, file };
}

function check(partial: PartialConfig, where: string): void {
  const result = validateJsonSchema(CONFIG_SCHEMA, partial);
  if (!result.ok)
    throw new ConfigError(
      "CONFIG_INVALID",
      `invalid configuration in ${where}: ${result.errors.join("; ")}`,
      "Correct the listed settings; `sys2qa config show` prints the effective configuration.",
    );
}
