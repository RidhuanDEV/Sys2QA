import type { ServiceResult } from "../services.js";

/** Calls a running host's local API (IPC for the CLI when a host already holds the state database). */
export class ApiClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async execute(name: string, input: unknown): Promise<ServiceResult> {
    const response = await fetch(`${this.url}/api/v1/operations/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(input ?? {}),
    });
    return (await response.json()) as ServiceResult;
  }

  async catalog(): Promise<ServiceResult> {
    const response = await fetch(`${this.url}/api/v1/operations`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    return (await response.json()) as ServiceResult;
  }
}
