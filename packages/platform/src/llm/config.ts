import { NoneBackend, OpenAiCompatibleBackend, type FetchLike } from "./backends.js";
import type { LlmBackend } from "./types.js";

/** Model provider settings (QAA-FR-100). Credentials are secret references, resolved at use time. */
export type LlmConfig =
  | { provider: "none" }
  | {
      provider: "openai_compatible";
      base_url: string;
      model: string;
      api_key_ref?: `secretref:${string}`;
      /** Explicit opt-in for endpoints not on this machine (SEC-018). */
      remote_consent?: boolean;
    };

export function createLlmBackend(
  config: LlmConfig,
  deps: { resolveSecret?: (ref: string) => string | undefined; fetch?: FetchLike } = {},
): LlmBackend {
  if (config.provider === "none") return new NoneBackend();
  const apiKey = config.api_key_ref ? deps.resolveSecret?.(config.api_key_ref) : undefined;
  return new OpenAiCompatibleBackend({
    baseUrl: config.base_url,
    model: config.model,
    ...(apiKey ? { apiKey } : {}),
    ...(config.remote_consent ? { remoteConsent: true } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
