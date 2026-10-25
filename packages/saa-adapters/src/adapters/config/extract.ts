import { createHash } from "node:crypto";
import type { CoverageItem, Entity, Evidence } from "@sys2qa/contract";
import { parse as parseYaml } from "yaml";
import type { AnalyzeResult } from "../../protocol.js";

export const ADAPTER_ID = "config";
export const ADAPTER_VERSION = "0.1.0";

export interface FileInput {
  path: string;
  sha256: string;
  text: string;
}

/** npm lifecycle scripts that run on `npm install` or before publishing; reported, never run (SEC-002). */
const INSTALL_LIFECYCLE = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export type ConfigKind = "package_scripts" | "env_template" | "dockerfile" | "compose" | "ci_workflow";

/** Which configuration format a path holds, if any. */
export function configKind(path: string): ConfigKind | undefined {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name === "package.json") return "package_scripts";
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return "env_template";
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name)) return "compose";
  if (
    /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(lower) ||
    name === ".gitlab-ci.yml" ||
    /(^|\/)\.circleci\/config\.ya?ml$/.test(lower) ||
    name === "azure-pipelines.yml" ||
    name === "bitbucket-pipelines.yml"
  )
    return "ci_workflow";
  return undefined;
}

function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/** Variable names from `environment:` / `env:` blocks given as a list (`A=1`, `A`) or a map. Values are dropped. */
function envNames(block: unknown): string[] {
  if (Array.isArray(block))
    return block.map((item) => String(item).split("=")[0]!.trim()).filter((n) => ENV_NAME.test(n));
  if (block && typeof block === "object") return Object.keys(block).filter((n) => ENV_NAME.test(n));
  return [];
}

function lineOf(text: string, needle: RegExp): number {
  const index = text.search(needle);
  return index === -1 ? 1 : text.slice(0, index).split("\n").length;
}

/**
 * Configuration and deployment facts (IMP-109, SAA-FR-020). One `file` entity per recognized file carries its facts;
 * the host turns them into configuration keys and deployment units. Values are never emitted: environment templates
 * give names, Compose and CI give variable names, Dockerfiles give `ENV`/`ARG` names. Commands (package scripts,
 * `RUN`, CI `run:` steps) are recorded as text for the reader and are never executed; install lifecycle scripts are
 * flagged. The host redacts all text before it is stored.
 */
export function extractFiles(
  files: readonly FileInput[],
  context: { boundaryPath: string; capturedAt: string },
): AnalyzeResult {
  const out: AnalyzeResult = { entities: [], relationships: [], evidence: [], coverage: [] };
  const boundary = context.boundaryPath === "" ? "project:." : `project:${context.boundaryPath}`;
  for (const file of files) {
    const kind = configKind(file.path);
    if (!kind) {
      out.coverage.push({
        area: file.path,
        status: "analyzed",
        reason: "no configuration or deployment facts in this format",
      });
      continue;
    }
    const lines = file.text.split("\n");
    const sourceType = kind === "package_scripts" ? "manifest" : "configuration";
    const evidence = (start: number, end = start): string => {
      const id = `evidence:${hash16(sourceType, file.path, `${start}-${end}`, file.sha256, ADAPTER_ID, ADAPTER_VERSION, kind)}`;
      if (!out.evidence.some((e) => e.id === id))
        out.evidence.push({
          id,
          source_type: sourceType,
          captured_at: context.capturedAt,
          extractor: { adapter: ADAPTER_ID, version: ADAPTER_VERSION, method: kind },
          path: file.path,
          range: { start_line: start, end_line: Math.max(start, end) },
          file_fingerprint: file.sha256,
          excerpt_policy: "digest_only",
          excerpt_digest: `sha256:${createHash("sha256")
            .update(lines.slice(start - 1, Math.max(start, end)).join("\n"))
            .digest("hex")}`,
        } as Evidence);
      return id;
    };
    const facts: Record<string, unknown> = { config_kind: kind };
    let problem: string | undefined;
    try {
      if (kind === "package_scripts") {
        const manifest = JSON.parse(file.text) as { scripts?: Record<string, unknown> };
        facts.scripts = Object.entries(manifest.scripts ?? {})
          .filter(([, command]) => typeof command === "string")
          .map(([name, command]) => ({
            name,
            command,
            runs_on_install: INSTALL_LIFECYCLE.has(name),
            evidence: evidence(lineOf(file.text, new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`))),
          }));
      } else if (kind === "env_template") {
        facts.variables = lines.flatMap((line, i) => {
          const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
          return m ? [{ name: m[1]!, documented_value: m[2]!.trim() !== "", evidence: evidence(i + 1) }] : [];
        });
      } else if (kind === "dockerfile") {
        const images: string[] = [];
        const ports: string[] = [];
        const variables: Array<{ name: string; kind: "ENV" | "ARG"; evidence: string }> = [];
        const commands: Array<{ instruction: string; text: string; evidence: string }> = [];
        lines.forEach((raw, i) => {
          const line = raw.trim();
          const m = /^(FROM|EXPOSE|ENV|ARG|CMD|ENTRYPOINT|RUN)\s+(.*)$/i.exec(line);
          if (!m) return;
          const instruction = m[1]!.toUpperCase();
          const rest = m[2]!;
          if (instruction === "FROM") images.push(rest.split(/\s+/)[0]!);
          else if (instruction === "EXPOSE") ports.push(...rest.split(/\s+/).filter((p) => p !== ""));
          else if (instruction === "ENV" || instruction === "ARG") {
            const names = rest.includes("=")
              ? [...rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)].map((x) => x[1]!)
              : [rest.split(/\s+/)[0]!];
            for (const name of names.filter((n) => ENV_NAME.test(n)))
              variables.push({ name, kind: instruction, evidence: evidence(i + 1) });
          } else commands.push({ instruction, text: rest.slice(0, 500), evidence: evidence(i + 1) });
        });
        Object.assign(facts, { base_images: images, exposed_ports: ports, variables, commands });
      } else if (kind === "compose") {
        const doc = parseYaml(file.text, { maxAliasCount: 100, uniqueKeys: false }) as {
          services?: Record<string, Record<string, unknown>>;
        } | null;
        facts.services = Object.entries(doc?.services ?? {}).map(([name, service]) => {
          const dependsOn = service?.depends_on;
          return {
            name,
            ...(typeof service?.image === "string" ? { image: service.image } : {}),
            builds: service?.build !== undefined,
            ports: Array.isArray(service?.ports) ? service.ports.map(String) : [],
            variables: envNames(service?.environment),
            env_files: (Array.isArray(service?.env_file)
              ? service.env_file
              : service?.env_file
                ? [service.env_file]
                : []
            ).map(String),
            depends_on: Array.isArray(dependsOn)
              ? dependsOn.map(String)
              : dependsOn && typeof dependsOn === "object"
                ? Object.keys(dependsOn)
                : [],
            evidence: evidence(
              lineOf(file.text, new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m")),
            ),
          };
        });
      } else if (kind === "ci_workflow") {
        const doc = parseYaml(file.text, { maxAliasCount: 100, uniqueKeys: false }) as Record<string, unknown> | null;
        const on = doc?.on ?? doc?.true; // YAML 1.1 readers turn `on:` into `true:`
        const triggers =
          typeof on === "string"
            ? [on]
            : Array.isArray(on)
              ? on.map(String)
              : on && typeof on === "object"
                ? Object.keys(on)
                : [];
        const jobs = (doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {}) as Record<
          string,
          Record<string, unknown>
        >;
        facts.triggers = triggers;
        facts.variables = envNames(doc?.env);
        facts.jobs = Object.entries(jobs).map(([name, job]) => {
          const steps = Array.isArray(job?.steps) ? (job.steps as Array<Record<string, unknown>>) : [];
          return {
            name,
            variables: envNames(job?.env),
            uses: steps.map((s) => s?.uses).filter((u): u is string => typeof u === "string"),
            runs: steps
              .map((s) => s?.run)
              .filter((r): r is string => typeof r === "string")
              .map((r) => r.slice(0, 500)),
            secrets: [
              ...new Set([...JSON.stringify(job).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!)),
            ],
            evidence: evidence(
              lineOf(file.text, new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m")),
            ),
          };
        });
      }
    } catch (error) {
      problem = `could not be read: ${(error as Error).message.split("\n")[0]!.slice(0, 160)}`;
    }
    out.entities.push({
      id: `file:${file.path}`,
      kind: "file",
      name: file.path,
      project_boundary: boundary,
      status: "source_verified",
      origin: "source",
      evidence_ids: [evidence(1, lines.length)],
      path: file.path,
      ...(problem ? {} : { config: facts }),
    } as unknown as Entity);
    const item: CoverageItem = problem
      ? { area: file.path, status: "failed", reason: problem }
      : { area: file.path, status: "analyzed" };
    out.coverage.push(item);
  }
  return out;
}
