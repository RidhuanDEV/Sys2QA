/**
 * Secret detectors (CR-060, SEC-004). Findings never contain the matched value.
 * Detectors are deliberately specific. The credential-assignment detector accepts prefixed names (`DB_PASSWORD`,
 * `AWS_SECRET_ACCESS_KEY`) and skips obvious placeholders and code references (`process.env.X`, `req.body.password`).
 */
export interface SecretFinding {
  detector: string;
  /** Character offset of the match in the scanned text. */
  index: number;
}

const DETECTORS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: "private_key_block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { name: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { name: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: "anthropic_or_openai_key", pattern: /\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20,}/g },
  { name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: "credential_assignment",
    pattern:
      /\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?(?!REDACTED\b|\[REDACTED|secretref:|<|\$\{|\*{3,}|x{3,}|changeme\b|process\.env\b|os\.environ\b|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:[\s;,)]|$))[^\s"'<>]{8,}/gi,
  },
];

export function detectSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, pattern } of DETECTORS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ detector: name, index: match.index });
  }
  return findings.sort((a, b) => a.index - b.index);
}

export const SECRET_DETECTOR_NAMES: readonly string[] = DETECTORS.map((d) => d.name);

/** For redaction, a private key is masked through its END marker (or the end of the text), not just its header. */
const REDACTION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = DETECTORS.map((d) =>
  d.name === "private_key_block"
    ? {
        name: d.name,
        pattern:
          /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
      }
    : d,
);

/** Replaces every detected secret with `[REDACTED:<detector>]` (SEC-004). */
export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  let out = text;
  for (const { name, pattern } of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (_match, ...args: unknown[]) => {
      const index = args.find((a): a is number => typeof a === "number") ?? 0;
      findings.push({ detector: name, index });
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, findings };
}
