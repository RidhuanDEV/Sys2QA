/** Normalized LLM failures (OSS-009). `retryable` marks transient provider conditions. */
export type LlmErrorCode =
  | "LLM_UNAVAILABLE"
  | "LLM_REMOTE_NOT_CONSENTED"
  | "LLM_TIMEOUT"
  | "LLM_CANCELLED"
  | "LLM_RATE_LIMITED"
  | "LLM_PROVIDER_ERROR"
  | "LLM_REQUEST_REJECTED"
  | "LLM_OUTPUT_INVALID"
  | "LLM_REPLAY_MISSING";

export class LlmError extends Error {
  override readonly name = "LlmError";
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What a backend receives: final messages after redaction and data wrapping. */
export interface BackendRequest {
  model: string;
  messages: LlmMessage[];
  maxOutputTokens: number;
  temperature: number;
  signal: AbortSignal;
}

export interface BackendResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported model version, when it differs from the requested model name. */
  modelVersion?: string;
}

/** A provider backend (hosted, local endpoint, replay). It never sees policy; it only turns messages into text. */
export interface LlmBackend {
  readonly provider: string;
  readonly model: string;
  /** "remote" when data leaves the machine (SEC-018). */
  readonly locality: "local" | "remote" | "none";
  /** Origin of the endpoint, for the disclosure (no credentials). */
  readonly endpoint?: string;
  generate(request: BackendRequest): Promise<BackendResponse>;
}
