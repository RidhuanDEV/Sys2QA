// The web UI is presentation only (Architecture §3): every decision comes from the application services over the
// loopback API, which validates the UI like any other client.

export interface ServiceError {
  code: string;
  kind: string;
  message: string;
  remediation: string;
  details?: Record<string, unknown>;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

const KEY = "sys2qa.token";

/** The launcher passes the session token in the URL fragment (never sent to a server); it is kept for this tab only. */
export function takeToken(): string | null {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{20,200})/.exec(window.location.hash);
  if (match) {
    sessionStorage.setItem(KEY, match[1]!);
    window.history.replaceState(null, "", `${window.location.pathname}#/`);
  }
  return sessionStorage.getItem(KEY);
}

export async function call<T = unknown>(operation: string, input: Record<string, unknown> = {}): Promise<Result<T>> {
  const token = sessionStorage.getItem(KEY);
  try {
    const response = await fetch(`/api/v1/operations/${encodeURIComponent(operation)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token ?? ""}` },
      body: JSON.stringify(input),
    });
    return (await response.json()) as Result<T>;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "HOST_UNREACHABLE",
        kind: "unavailable",
        message: `the Sys2QA host did not answer (${String(error)})`,
        remediation: "Check that `sys2qa ui` is still running, then reload.",
      },
    };
  }
}
