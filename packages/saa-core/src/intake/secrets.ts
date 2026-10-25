import { detectSecrets, redactSecrets } from "@sys2qa/contract";
import type { RootSandbox } from "./sandbox.js";

/** Files whose content is withheld from every later stage, whatever it contains (SEC-004, PRD §11.5). */
export type SensitiveFileKind =
  "env_file" | "private_key" | "keystore" | "credentials_file" | "registry_auth" | "netrc";

/** Where a secret was found and by which detector. Never the value (PRD W2 failure paths, CON-017). */
export interface SecretLocation {
  root: number;
  path: string;
  /** 1-based line of the match; absent for a withheld file. */
  line?: number;
  detector: string;
}

export type AnalysisRead =
  | { kind: "text"; text: string; bytes: number; generated_marker: boolean; secrets: SecretLocation[] }
  | {
      kind: "withheld";
      sensitive: SensitiveFileKind;
      /** Variable names of an environment file, for configuration analysis; values are never returned. */
      env_names: string[];
      secrets: SecretLocation[];
    }
  | { kind: "binary"; bytes: number }
  | { kind: "too_large"; bytes: number };

const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$|\.env\.(example|sample|template)$/i;
const ENV_NAME = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

/** Classifies a path as a sensitive file by its name. Templates such as `.env.example` are read (redacted). */
export function sensitiveFileKind(path: string): SensitiveFileKind | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if ((name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) && !ENV_TEMPLATE.test(name))
    return "env_file";
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) || /\.(pem|key|ppk)$/.test(name)) return "private_key";
  if (/\.(p12|pfx|jks|keystore|kdbx|gpg|asc)$/.test(name)) return "keystore";
  if (
    /^(credentials|service[-_]account|client[-_]secrets?)(\.[a-z]+)?$/.test(name) ||
    /^secrets?\.(json|ya?ml|toml)$/.test(name)
  )
    return "credentials_file";
  if (name === ".npmrc" || name === ".pypirc" || name === ".yarnrc.yml" || name === ".dockercfg")
    return "registry_auth";
  if (name === ".netrc" || name === "_netrc" || name === ".git-credentials") return "netrc";
  return undefined;
}

/**
 * Reads a file for analysis (SAA-FR-018, SEC-004). Sensitive files are withheld: only their kind and, for environment
 * files, the variable names come back. Other text is returned with every detected secret replaced by
 * `[REDACTED:<detector>]`, and each finding is reported by location and detector only. Adapters, the LLM port and every
 * writer downstream therefore never receive a detected secret value.
 */
export async function readForAnalysis(
  sandbox: RootSandbox,
  entry: { root: number; path: string },
  maxBytes: number,
): Promise<AnalysisRead> {
  const resolved = await sandbox.resolve(entry.root, entry.path);
  const sensitive = sensitiveFileKind(entry.path);
  if (sensitive !== undefined) {
    const read = sensitive === "env_file" ? await sandbox.readText(resolved, maxBytes) : undefined;
    const env_names = read?.kind === "text" ? read.text.split(/\r?\n/).flatMap((l) => ENV_NAME.exec(l)?.[1] ?? []) : [];
    return {
      kind: "withheld",
      sensitive,
      env_names,
      secrets: [{ root: entry.root, path: entry.path, detector: `sensitive_file:${sensitive}` }],
    };
  }
  const read = await sandbox.readText(resolved, maxBytes);
  if (read.kind !== "text") return read;
  const lines = lineStarts(read.text);
  // Locations come from detection on the original text; redaction shifts offsets as it replaces.
  const findings = detectSecrets(read.text);
  return {
    kind: "text",
    text: redactSecrets(read.text).text,
    bytes: read.bytes,
    generated_marker: read.generated_marker,
    secrets: findings
      .map((f) => ({ root: entry.root, path: entry.path, line: lineOf(lines, f.index), detector: f.detector }))
      .sort((a, b) => a.line - b.line || (a.detector < b.detector ? -1 : 1)),
  };
}

/**
 * The last check before anything leaves the analysis (SKB, documentation, package, report): every string in the value
 * passes through the secret detectors and is redacted. Returns how many strings were changed, so the writer can record
 * that its input still contained a secret.
 */
export function redactOutput<T>(value: T): { value: T; redacted: number } {
  let redacted = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v);
      if (r.findings.length > 0) redacted++;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, walk(item)]));
    return v;
  };
  return { value: walk(value) as T, redacted };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
