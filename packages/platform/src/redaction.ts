import { redactSecrets } from "@sys2qa/contract";

/** Field names whose values are always secrets, whatever they look like (SEC-004). */
const SENSITIVE_KEY =
  /^(?:password|passwd|pwd|passphrase|secret|client_secret|api_?key|access_?key|secret_?key|private_?key|token|auth_?token|access_token|refresh_token|id_token|session_?token|authorization|proxy_authorization|cookie|set_cookie|credentials?)$/i;
const MAX_DEPTH = 20;

export interface RedactionResult<T = unknown> {
  value: T;
  /** JSON-pointer-like paths whose values were replaced; never the values themselves. */
  redactedPaths: string[];
}

/**
 * Removes secrets from data bound for logs, audit records and other outputs (SEC-004, OBS-002).
 * Three layers: sensitive field names, the contract's secret detectors, and exact values registered by the
 * secret store when it injects a credential into a job (so a password that looks like plain text is still caught).
 */
export class Redactor {
  readonly #known = new Set<string>();

  /** Registers a secret value for exact-match redaction. Values shorter than 4 characters are ignored (too ambiguous). */
  addKnownSecret(value: string): void {
    if (value.length >= 4) this.#known.add(value);
  }

  redactText(text: string): { text: string; redacted: boolean } {
    let out = redactSecrets(text).text;
    for (const known of this.#known) if (out.includes(known)) out = out.split(known).join("[REDACTED:known_secret]");
    return { text: out, redacted: out !== text };
  }

  redact<T>(value: T): RedactionResult<T> {
    const redactedPaths: string[] = [];
    const seen = new WeakSet<object>();
    const walk = (v: unknown, path: string, depth: number): unknown => {
      if (typeof v === "string") {
        const r = this.redactText(v);
        if (r.redacted) redactedPaths.push(path || "/");
        return r.text;
      }
      if (v === null || typeof v !== "object") return typeof v === "bigint" ? v.toString() : v;
      if (depth >= MAX_DEPTH) return "[Truncated]";
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (v instanceof Error) {
        const code = (v as NodeJS.ErrnoException).code;
        return walk({ name: v.name, message: v.message, ...(code === undefined ? {} : { code }) }, path, depth + 1);
      }
      if (v instanceof Uint8Array) return `[binary ${v.byteLength} bytes]`;
      if (v instanceof Date) return v.toISOString();
      if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}/${i}`, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) {
        const p = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (
          SENSITIVE_KEY.test(key.replace(/-/g, "_")) &&
          !(typeof item === "string" && item.startsWith("secretref:")) &&
          item != null
        ) {
          redactedPaths.push(p);
          out[key] = "[REDACTED]";
        } else {
          out[key] = walk(item, p, depth + 1);
        }
      }
      return out;
    };
    return { value: walk(value, "", 0) as T, redactedPaths };
  }
}
