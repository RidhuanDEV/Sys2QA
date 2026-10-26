import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ApiClient,
  AppServices,
  openHost,
  readHostEndpoint,
  runDoctor,
  type ErrorKind,
  type HostOptions,
  type ServiceResult,
} from "@sys2qa/app-services";

/** Stable exit codes (SAA-FR-014). Documented in Architecture §8. */
export const EXIT_CODES: Record<"ok" | ErrorKind | "usage", number> = {
  ok: 0,
  internal: 1,
  usage: 2,
  invalid_input: 2,
  denied: 3,
  not_found: 4,
  conflict: 5,
  unavailable: 6,
};

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Overrides how the host is opened (tests). */
  host?: Omit<HostOptions, "home">;
  /** Reads all of standard input (secret values are never taken from arguments). */
  readStdin?: () => Promise<string>;
}

interface Command {
  usage: string;
  /** Builds the operation name and input from positional arguments and options. */
  build(
    positionals: string[],
    values: Record<string, string | boolean | string[] | undefined>,
    cwd: string,
  ): { operation: string; input: Record<string, unknown> };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : undefined);
const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Commands take paths, URLs and generated IDs, never names the user must already know (PRD §23.4). */
const COMMANDS: Record<string, Command> = {
  info: { usage: "info", build: () => ({ operation: "system.info", input: {} }) },
  capabilities: {
    usage: "capabilities [--skill <skill-directory>]",
    // With --skill, the Skill's declared requirements (capabilities.json) are checked against this host (SAA-FR-016).
    build: (_p, v, cwd) => {
      const dir = str(v.skill);
      if (!dir) return { operation: "system.capabilities", input: {} };
      const manifest = JSON.parse(readFileSync(join(resolve(cwd, dir), "capabilities.json"), "utf8")) as {
        requires?: unknown;
      };
      return { operation: "system.capabilities", input: defined({ requires: manifest.requires }) };
    },
  },
  metrics: {
    usage: "metrics [--prometheus]",
    build: (_p, v) => ({ operation: "system.metrics", input: v.prometheus === true ? { format: "prometheus" } : {} }),
  },
  health: { usage: "health", build: () => ({ operation: "system.health", input: {} }) },
  doctor: { usage: "doctor", build: () => ({ operation: "system.doctor", input: {} }) },
  adapters: { usage: "adapters", build: () => ({ operation: "saa.adapters", input: {} }) },
  "config show": { usage: "config show", build: () => ({ operation: "system.config", input: {} }) },
  "settings set": {
    usage: "settings set <l4_enabled|local_owner_mode_enabled|telemetry_enabled> <on|off>",
    build: ([key, value]) => ({
      operation: "system.set_setting",
      input: defined({ key, value: value === "on" ? true : value === "off" ? false : value }),
    }),
  },
  "project create": {
    usage: "project create <name> [--language <code>]...",
    build: ([name], v) => ({ operation: "project.create", input: defined({ name, languages: list(v.language) }) }),
  },
  "project list": { usage: "project list", build: () => ({ operation: "project.list", input: {} }) },
  "project delete": {
    usage: "project delete <project-id> --confirm <project-name>",
    build: ([project_id], v) => ({
      operation: "project.delete",
      input: defined({ project_id, confirm_name: str(v.confirm) }),
    }),
  },
  "retention run": { usage: "retention run", build: () => ({ operation: "system.retention_run", input: {} }) },
  "project show": {
    usage: "project show <project-id>",
    build: ([project_id]) => ({ operation: "project.get", input: defined({ project_id }) }),
  },
  "source add": {
    usage: "source add <project-id> <source_root|environment|package> <path-or-url>",
    build: ([project_id, kind, ref], _v, cwd) => ({
      operation: "project.add_source",
      input: defined({ project_id, kind, ref: ref && kind !== "environment" ? resolve(cwd, ref) : ref }),
    }),
  },
  declare: {
    usage:
      "declare <source-id> --level <L0|L1|L2|L2r|L3|L4> [--by <name>] [--root <path>]... [--allow-state-changing-tests]",
    build: ([source_id], v, cwd) => ({
      operation: "project.declare",
      input: defined({
        source_id,
        declared_by: str(v.by) ?? safeUser(),
        operation_level: str(v.level),
        source_roots: list(v.root)?.map((r) => resolve(cwd, r)),
        allow_state_changing_tests: v["allow-state-changing-tests"] === true ? true : undefined,
      }),
    }),
  },
  "env configure": {
    usage:
      "env configure <source-id> --url <base-url> --class <development|staging|production> --host <host[:port]>... [--path <prefix>]... [--local-owner-mode]",
    build: ([source_id], v) => ({
      operation: "project.configure_environment",
      input: defined({
        source_id,
        base_url: str(v.url),
        classification: str(v.class),
        allowed_hosts: list(v.host),
        path_prefixes: list(v.path),
        local_owner_mode: v["local-owner-mode"] === true ? true : undefined,
      }),
    }),
  },
  "policy check": {
    usage: "policy check <source-id> <operation> [--path <path> | --url <url>]",
    build: ([source_id, operation], v, cwd) => ({
      operation: "policy.check",
      input: defined({
        source_id,
        operation,
        target_path: str(v.path) && resolve(cwd, str(v.path)!),
        target_url: str(v.url),
      }),
    }),
  },
  "secret put": {
    usage: "secret put <project-id> <name>   (reads the value from standard input)",
    build: ([project_id, name]) => ({ operation: "secret.put", input: defined({ project_id, name }) }),
  },
  "secret list": {
    usage: "secret list <project-id>",
    build: ([project_id]) => ({ operation: "secret.list", input: defined({ project_id }) }),
  },
  "secret remove": {
    usage: "secret remove <secretref>",
    build: ([ref]) => ({ operation: "secret.remove", input: defined({ ref }) }),
  },
  "validate package": {
    usage: "validate package <path>",
    build: ([path], _v, cwd) => ({
      operation: "package.validate",
      input: defined({ path: path && resolve(cwd, path) }),
    }),
  },
  start: {
    usage: "start <project-name> <repository-path> [--language <code>]...",
    build: ([name, root], v, cwd) => ({
      operation: "saa.start",
      input: defined({ name, root: root && resolve(cwd, root), languages: list(v.language) }),
    }),
  },
  analyze: {
    usage: "analyze <source-id> [--profile <overview|standard|deep>]",
    build: ([source_id], v) => ({ operation: "saa.analyze", input: defined({ source_id, profile: str(v.profile) }) }),
  },
  status: {
    usage: "status <project-id>",
    build: ([project_id]) => ({ operation: "saa.status", input: defined({ project_id }) }),
  },
  "workflows list": {
    usage: "workflows list <run-id> [--category <category>]",
    build: ([run_id], v) => ({
      operation: "saa.workflows.list",
      input: defined({ run_id, category: str(v.category) }),
    }),
  },
  "workflows show": {
    usage: "workflows show <run-id> <workflow-id> [--language <en|id>]",
    build: ([run_id, workflow_id], v) => ({
      operation: "saa.workflows.show",
      input: defined({ run_id, workflow_id, language: list(v.language)?.[0] }),
    }),
  },
  trace: {
    usage: "trace <run-id> <workflow-id> [--deepen]",
    build: ([run_id, workflow_id], v) => ({
      operation: "saa.trace",
      input: defined({ run_id, workflow_id, deepen: v.deepen === true ? true : undefined }),
    }),
  },
  validate: {
    usage: "validate <package-path>",
    build: ([path], _v, cwd) => ({
      operation: "package.validate",
      input: defined({ path: path && resolve(cwd, path) }),
    }),
  },
  export: {
    usage: "export <run-id> [--output <directory>] [--allow-in-repository]",
    build: ([run_id], v, cwd) => ({
      operation: "saa.export",
      input: defined({
        run_id,
        output_dir: str(v.output) && resolve(cwd, str(v.output)!),
        allow_in_repository: v["allow-in-repository"] === true ? true : undefined,
      }),
    }),
  },
  call: {
    usage: "call <operation> [--input <json>]",
    build: ([operation], v) => {
      const raw = str(v.input) ?? "{}";
      return { operation: operation ?? "", input: JSON.parse(raw) as Record<string, unknown> };
    },
  },
};

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  home: { type: "string" },
  language: { type: "string", multiple: true },
  by: { type: "string" },
  level: { type: "string" },
  root: { type: "string", multiple: true },
  "allow-state-changing-tests": { type: "boolean" },
  url: { type: "string" },
  class: { type: "string" },
  host: { type: "string", multiple: true },
  path: { type: "string", multiple: true },
  "local-owner-mode": { type: "boolean" },
  input: { type: "string" },
  prometheus: { type: "boolean" },
  confirm: { type: "string" },
  profile: { type: "string" },
  category: { type: "string" },
  deepen: { type: "boolean" },
  output: { type: "string" },
  "allow-in-repository": { type: "boolean" },
  skill: { type: "string" },
} as const;

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "local-user";
  }
}

export function defaultHome(env: Record<string, string | undefined>): string {
  if (env.SYS2QA_HOME) return env.SYS2QA_HOME;
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Sys2QA");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Sys2QA");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "sys2qa");
}

function usage(): string {
  return [
    "Usage: sys2qa <command> [options] [--json]",
    "",
    ...Object.values(COMMANDS).map((c) => `  sys2qa ${c.usage}`),
  ].join("\n");
}

const commandKey = (positionals: string[]) =>
  [positionals.slice(0, 2).join(" "), positionals[0] ?? ""].find((k) => COMMANDS[k]);

const buildRequest = (key: string, positionals: string[], values: object, cwd: string) =>
  COMMANDS[key]!.build(
    positionals.slice(key.split(" ").length),
    values as Record<string, string | boolean | string[] | undefined>,
    cwd,
  );

/**
 * The operation and input a command line maps to, without running it (the Skill conformance test checks its examples
 * with this); undefined when the arguments name no command.
 */
export function resolveCommand(
  argv: string[],
  cwd: string,
): { operation: string; input: Record<string, unknown> } | undefined {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const key = commandKey(positionals);
  return key ? buildRequest(key, positionals, values, cwd) : undefined;
}

/** Runs one CLI invocation and returns its exit code. Every command is exactly one application-service call. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${usage()}\n`);
    return EXIT_CODES.usage;
  }
  const { values, positionals } = parsed;
  const key = commandKey(positionals);
  if (values.help || !key) {
    (values.help ? io.stdout : io.stderr)(`${usage()}\n`);
    return values.help ? EXIT_CODES.ok : EXIT_CODES.usage;
  }
  let request: { operation: string; input: Record<string, unknown> };
  try {
    request = buildRequest(key, positionals, values, io.cwd);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return EXIT_CODES.usage;
  }
  if (request.operation === "secret.put") {
    if (!io.readStdin) {
      io.stderr("secret put reads the value from standard input\n");
      return EXIT_CODES.usage;
    }
    request.input.value = (await io.readStdin()).replace(/\r?\n$/, "");
  }
  const home = str(values.home) ?? defaultHome(io.env);
  // doctor runs without a host so that it can diagnose a host that cannot start; same report as system.doctor.
  const result: ServiceResult =
    key === "doctor"
      ? { ok: true, data: await runDoctor({ home, env: io.env }) }
      : await run(home, request.operation, request.input, io);
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) io.stdout(`${human(result.data)}\n`);
  else io.stderr(`error ${result.error.code}: ${result.error.message}\n  next: ${result.error.remediation}\n`);
  if (key === "doctor" && result.ok && (result.data as { status: string }).status === "fail")
    return EXIT_CODES.unavailable;
  if (key === "capabilities" && result.ok && (result.data as { compatible: boolean | null }).compatible === false)
    return EXIT_CODES.unavailable;
  return result.ok ? EXIT_CODES.ok : EXIT_CODES[result.error.kind];
}

/** Uses a running host's local API when one exists (it holds state.db); otherwise opens the host in this process. */
async function run(home: string, operation: string, input: Record<string, unknown>, io: CliIo): Promise<ServiceResult> {
  const endpoint = readHostEndpoint(home);
  if (endpoint) return new ApiClient(endpoint.url, endpoint.token).execute(operation, input);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(home, { recursive: true });
  let host;
  try {
    host = openHost({ home, env: io.env, ...io.host });
  } catch (error) {
    const e = error as { code?: string; message?: string; remediation?: string };
    return {
      ok: false,
      error: {
        code: e.code ?? "INTERNAL_ERROR",
        kind: "unavailable",
        message: e.message ?? String(error),
        remediation: e.remediation ?? "Retry.",
        retryable: false,
      },
    };
  }
  try {
    return await new AppServices(host).execute(operation, input, { interface: "cli", actor: safeUser() });
  } finally {
    host.close();
  }
}

function human(data: unknown): string {
  if (data === null || typeof data !== "object") return String(data);
  if ("checks" in data && Array.isArray((data as { checks: unknown }).checks) && "llm_disclosure" in data) {
    const report = data as unknown as {
      status: string;
      checks: Array<{ status: string; title: string; detail: string; remediation?: string }>;
    };
    const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as Record<string, string>;
    return [
      ...report.checks.map(
        (c) =>
          `[${mark[c.status] ?? c.status}] ${c.title}: ${c.detail}${c.remediation && c.status !== "ok" ? `\n       next: ${c.remediation}` : ""}`,
      ),
      `overall: ${report.status}`,
    ].join("\n");
  }
  if ("format" in data && ["prometheus", "support_matrix"].includes((data as { format: string }).format))
    return (data as unknown as { text: string }).text.trimEnd();
  // A workflow document is shown as written; the catalog as one line per workflow.
  if ("document" in data && typeof (data as { document: unknown }).document === "string")
    return (data as unknown as { document: string }).document.trimEnd();
  if ("workflows" in data && "count_scope" in data) {
    const list = data as unknown as {
      workflows: Array<{
        rank: number | null;
        id: string;
        category: string;
        discovery_status: string;
        completion: string;
      }>;
    };
    return [
      `${list.workflows.length} workflow(s) within the examined scope:`,
      ...list.workflows.map(
        (w) =>
          `  ${String(w.rank ?? "-").padStart(3)}  ${w.id}  [${w.category}] ${w.discovery_status}, ${w.completion}`,
      ),
    ].join("\n");
  }
  if ("capability_version" in data && "incompatibilities" in data) {
    const caps = data as unknown as {
      capability_version: number;
      operations: Array<{ name: string; level: string; effect: string }>;
      compatible: boolean | null;
      incompatibilities: Array<{ reason: string; operation?: string; expected: unknown; actual: unknown }>;
    };
    return [
      `capability version ${caps.capability_version}; ${caps.operations.length} operation(s)`,
      ...caps.operations.map((o) => `  ${o.name}  [${o.level}, ${o.effect}]`),
      ...(caps.compatible === null
        ? []
        : caps.compatible
          ? ["compatible: yes"]
          : [
              "compatible: no",
              ...caps.incompatibilities.map(
                (i) =>
                  `  ${i.reason}${i.operation ? ` ${i.operation}` : ""}: expected ${String(i.expected)}, found ${String(i.actual)}`,
              ),
            ]),
    ].join("\n");
  }
  if ("warning" in data && "path" in data) {
    const exported = data as unknown as { path: string; warning: { en: string } };
    return `warning: ${exported.warning.en}\n${JSON.stringify({ ...data, warning: undefined }, null, 2)}`;
  }
  return JSON.stringify(data, null, 2);
}
