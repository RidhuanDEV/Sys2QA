import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { classifyHost } from "../policy/network.js";
import { LlmError, type BackendRequest, type BackendResponse, type LlmBackend } from "./types.js";

/** Deterministic-only mode (ADR-008): every call fails with LLM_UNAVAILABLE and callers mark narrative output unavailable. */
export class NoneBackend implements LlmBackend {
  readonly provider = "none";
  readonly model = "none";
  readonly locality = "none" as const;
  generate(): Promise<BackendResponse> {
    return Promise.reject(new LlmError("LLM_UNAVAILABLE", "no model provider is configured (deterministic-only mode)"));
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface OpenAiCompatibleOptions {
  /** Base URL of an OpenAI-compatible API, e.g. `http://localhost:11434/v1` (Ollama, llama.cpp, vLLM, LM Studio). */
  baseUrl: string;
  model: string;
  provider?: string;
  /** Resolved from the secret store by the caller; never part of a prompt (OSS-009). */
  apiKey?: string;
  /** Required when the endpoint is not on this machine (SEC-018). */
  remoteConsent?: boolean;
  fetch?: FetchLike;
}

export function endpointLocality(baseUrl: string): "local" | "remote" {
  const host = new URL(baseUrl).hostname;
  return classifyHost(host) === "loopback" ? "local" : "remote";
}

/** Chat Completions protocol, which local runtimes and many hosted providers implement. */
export class OpenAiCompatibleBackend implements LlmBackend {
  readonly provider: string;
  readonly model: string;
  readonly locality: "local" | "remote";
  readonly endpoint: string;
  readonly #options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions) {
    this.#options = options;
    this.provider = options.provider ?? "openai_compatible";
    this.model = options.model;
    this.locality = endpointLocality(options.baseUrl);
    this.endpoint = new URL(options.baseUrl).origin;
    if (this.locality === "remote" && !options.remoteConsent) {
      throw new LlmError(
        "LLM_REMOTE_NOT_CONSENTED",
        `sending data to ${new URL(options.baseUrl).host} needs explicit consent (SEC-018)`,
      );
    }
  }

  async generate(request: BackendRequest): Promise<BackendResponse> {
    const doFetch = this.#options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#options.apiKey) headers.authorization = `Bearer ${this.#options.apiKey}`;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${this.#options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new LlmError("LLM_PROVIDER_ERROR", `provider unreachable: ${(error as Error).message}`, true);
    }
    if (response.status === 429) throw new LlmError("LLM_RATE_LIMITED", "provider rate limit", true);
    if (response.status >= 500)
      throw new LlmError("LLM_PROVIDER_ERROR", `provider returned HTTP ${response.status}`, true);
    if (response.status >= 400)
      throw new LlmError("LLM_REQUEST_REJECTED", `provider rejected the request with HTTP ${response.status}`);
    const body = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string")
      throw new LlmError("LLM_PROVIDER_ERROR", "provider response has no message content", true);
    return {
      text,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
      ...(body.model ? { modelVersion: body.model } : {}),
    };
  }
}

/**
 * Cassette key: a hash of the prompt (messages and generation settings). The model is recorded in the cassette but is
 * not part of the key, so a replay does not depend on which model produced the recording.
 */
export function cassetteKey(request: Pick<BackendRequest, "messages" | "maxOutputTokens" | "temperature">): string {
  return createHash("sha256")
    .update(
      canonicalJson({ messages: request.messages, max: request.maxOutputTokens, temperature: request.temperature }),
    )
    .digest("hex")
    .slice(0, 32);
}

interface Cassette {
  key: string;
  provider: string;
  model: string;
  request: { messages: BackendRequest["messages"] };
  response: BackendResponse;
}

/** Records real responses into cassettes (run by a maintainer against a live provider, then committed). */
export class RecordingBackend implements LlmBackend {
  constructor(
    private readonly inner: LlmBackend,
    private readonly directory: string,
  ) {
    mkdirSync(directory, { recursive: true });
  }
  get provider() {
    return this.inner.provider;
  }
  get model() {
    return this.inner.model;
  }
  get locality() {
    return this.inner.locality;
  }
  async generate(request: BackendRequest): Promise<BackendResponse> {
    const response = await this.inner.generate(request);
    const key = cassetteKey(request);
    const cassette: Cassette = {
      key,
      provider: this.inner.provider,
      model: this.inner.model,
      request: { messages: request.messages },
      response,
    };
    writeFileSync(join(this.directory, `${key}.json`), `${JSON.stringify(cassette, null, 2)}\n`);
    return response;
  }
}

/** Replays cassettes; CI never calls a live provider (Test Strategy §3). A request without a cassette fails loudly. */
export class ReplayBackend implements LlmBackend {
  readonly locality = "local" as const;
  constructor(
    private readonly directory: string,
    readonly provider = "replay",
    readonly model = "replay",
  ) {}
  generate(request: BackendRequest): Promise<BackendResponse> {
    const key = cassetteKey(request);
    try {
      const cassette = JSON.parse(readFileSync(join(this.directory, `${key}.json`), "utf8")) as Cassette;
      return Promise.resolve(cassette.response);
    } catch {
      return Promise.reject(
        new LlmError(
          "LLM_REPLAY_MISSING",
          `no cassette ${key} in ${this.directory}; record it against a live provider`,
        ),
      );
    }
  }
}
