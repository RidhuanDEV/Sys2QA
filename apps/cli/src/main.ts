import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ApiClient,
  AppServices,
  openHost,
  readHostEndpoint,
  removeHostEndpoint,
  runDoctor,
  startApiServer,
  writeHostEndpoint,
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
  /** Stops `sys2qa ui` (tests); otherwise it runs until SIGINT or SIGTERM. */
  signal?: AbortSignal;
  /** The built web UI (tests); apps/web/dist otherwise. */
  webRoot?: string;
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
/** Approval binding options shared by preview, approve and the execution check. */
const bindingOptions = (v: Record<string, string | boolean | string[] | undefined>) => ({
  mode: str(v.mode),
  environment_id: str(v.environment),
  declared_environment: str(v["declared-environment"]),
  test_data_profile: str(v["test-data-profile"]),
});
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
  "package import": {
    usage: "package import <project-id> <package-directory-or-zip> [--language <code>]",
    build: ([project_id, path], v, cwd) => ({
      operation: "package.import",
      input: defined({ project_id, path: path && resolve(cwd, path), language: list(v.language)?.[0] }),
    }),
  },
  "package list": {
    usage: "package list <project-id>",
    build: ([project_id]) => ({ operation: "package.list", input: defined({ project_id }) }),
  },
  "package show": {
    usage: "package show <project-id> <package-id> <version>",
    build: ([project_id, package_id, version]) => ({
      operation: "package.show",
      input: defined({ project_id, package_id, version: version === undefined ? undefined : Number(version) }),
    }),
  },
  "plan create": {
    usage:
      "plan create <project-id> <package-id> <version> [--workflow <workflow-id>]... [--language <code>] [--objective <text>]",
    build: ([project_id, package_id, version], v) => ({
      operation: "plan.create",
      input: defined({
        project_id,
        package_id,
        version: version === undefined ? undefined : Number(version),
        workflow_ids: list(v.workflow),
        language: list(v.language)?.[0],
        objective: str(v.objective),
      }),
    }),
  },
  "plan show": {
    usage: "plan show <plan-id>",
    build: ([plan_id]) => ({ operation: "plan.show", input: defined({ plan_id }) }),
  },
  "plan list": {
    usage: "plan list <project-id>",
    build: ([project_id]) => ({ operation: "plan.list", input: defined({ project_id }) }),
  },
  "plan risk": {
    usage:
      "plan risk <plan-id> <risk-id> [--impact <1-5>] [--likelihood <1-5>] [--exposure <flag>]... --rationale <text>",
    build: ([plan_id, risk_id], v) => ({
      operation: "plan.update_risk",
      input: defined({
        plan_id,
        risk_id,
        impact: str(v.impact) === undefined ? undefined : Number(v.impact),
        likelihood: str(v.likelihood) === undefined ? undefined : Number(v.likelihood),
        exposure: list(v.exposure),
        rationale: str(v.rationale),
      }),
    }),
  },
  "conditions derive": {
    usage: "conditions derive <plan-id>",
    build: ([plan_id]) => ({ operation: "conditions.derive", input: defined({ plan_id }) }),
  },
  "conditions list": {
    usage: "conditions list <plan-id> [--technique <technique>]",
    build: ([plan_id], v) => ({
      operation: "conditions.list",
      input: defined({ plan_id, technique: str(v.technique) }),
    }),
  },
  "scenarios generate": {
    usage: "scenarios generate <plan-id> [--language <en|id>] [--wording <templates|model>]",
    build: ([plan_id], v) => ({
      operation: "scenarios.generate",
      input: defined({ plan_id, language: list(v.language)?.[0], wording: str(v.wording) }),
    }),
  },
  "scenarios list": {
    usage: "scenarios list <project-id> [--status <status>]",
    build: ([project_id], v) => ({
      operation: "scenarios.list",
      input: defined({ project_id, status: str(v.status) }),
    }),
  },
  "scenarios show": {
    usage: "scenarios show <scenario-id> [--version <n>]",
    build: ([scenario_id], v) => ({
      operation: "scenarios.show",
      input: defined({ scenario_id, version: str(v.version) === undefined ? undefined : Number(v.version) }),
    }),
  },
  "scenarios critique": {
    usage: "scenarios critique <plan-id>",
    build: ([plan_id]) => ({ operation: "scenarios.critique", input: defined({ plan_id }) }),
  },
  "findings list": {
    usage: "findings list <project-id> [--kind <checklist|duplicate|conflict>]",
    build: ([project_id], v) => ({ operation: "findings.list", input: defined({ project_id, kind: str(v.kind) }) }),
  },
  "scenarios decide": {
    usage:
      "scenarios decide <scenario-id> <version> <ready_for_review|reject|defer|request_regeneration> --reason <text>",
    build: ([scenario_id, version, decision], v) => ({
      operation: "scenarios.decide",
      input: defined({
        scenario_id,
        version: version === undefined ? undefined : Number(version),
        decision,
        reason: str(v.reason),
      }),
    }),
  },
  "scenarios classify": {
    usage: "scenarios classify <scenario-id> <manual_only|automation_candidate|automation_ready|both> --reason <text>",
    build: ([scenario_id, classification], v) => ({
      operation: "scenarios.classify",
      input: defined({ scenario_id, classification, reason: str(v.reason) }),
    }),
  },
  "approvals preview": {
    usage:
      "approvals preview <project-id> <scenario-id>... --mode <manual|automated> [--environment <environment-id> | --declared-environment <name>] [--test-data-profile <name>]",
    build: ([project_id, ...scenario_ids], v) => ({
      operation: "approvals.preview",
      input: defined({ project_id, scenario_ids, ...bindingOptions(v) }),
    }),
  },
  "approvals approve": {
    usage:
      "approvals approve <project-id> <scenario-id>... --mode <manual|automated> [--environment <id> | --declared-environment <name>] [--test-data-profile <name>] --token <preview-token> [--state-changing-ack]",
    build: ([project_id, ...scenario_ids], v) => ({
      operation: "approvals.approve",
      input: defined({
        project_id,
        scenario_ids,
        ...bindingOptions(v),
        preview_token: str(v.token),
        state_changing_ack: v["state-changing-ack"] === true ? true : undefined,
      }),
    }),
  },
  "approvals revoke": {
    usage: "approvals revoke <approval-id> --reason <text>",
    build: ([approval_id], v) => ({
      operation: "approvals.revoke",
      input: defined({ approval_id, reason: str(v.reason) }),
    }),
  },
  "approvals list": {
    usage: "approvals list <scenario-id>",
    build: ([scenario_id]) => ({ operation: "approvals.list", input: defined({ scenario_id }) }),
  },
  "execution check": {
    usage:
      "execution check <scenario-id> --mode <manual|automated> [--environment <id> | --declared-environment <name>] [--test-data-profile <name>]",
    build: ([scenario_id], v) => ({
      operation: "execution.check",
      input: defined({ scenario_id, ...bindingOptions(v) }),
    }),
  },
  "source verify": {
    usage: "source verify <project-id> <package-id> <version> <record-id>",
    build: ([project_id, package_id, version, record_id]) => ({
      operation: "source.verify",
      input: defined({
        project_id,
        package_id,
        version: version === undefined ? undefined : Number(version),
        record_id,
      }),
    }),
  },
  "package catalog": {
    usage: "package catalog <project-id> <package-id> <version>",
    build: ([project_id, package_id, version]) => ({
      operation: "package.catalog",
      input: defined({ project_id, package_id, version: version === undefined ? undefined : Number(version) }),
    }),
  },
  "run start": {
    usage:
      "run start <project-id> <scenario-id>... (--declared-environment <name> [--url <url>] [--env-version <v>] | --environment <id>) [--test-data-profile <name>] [--language <code>] [--by <tester>]",
    build: ([project_id, ...scenario_ids], v) => ({
      operation: "runs.start_manual",
      input: defined({
        project_id,
        scenario_ids,
        environment_id: str(v.environment),
        declared_environment: str(v["declared-environment"]),
        declared_environment_url: str(v.url),
        declared_environment_version: str(v["env-version"]),
        test_data_profile: str(v["test-data-profile"]),
        language: list(v.language)?.[0],
        tester: str(v.by),
      }),
    }),
  },
  "run show": {
    usage: "run show <run-id> [--language <code>]",
    build: ([run_id], v) => ({ operation: "runs.show", input: defined({ run_id, language: list(v.language)?.[0] }) }),
  },
  "run list": {
    usage: "run list <project-id>",
    build: ([project_id]) => ({ operation: "runs.list", input: defined({ project_id }) }),
  },
  "run step": {
    usage:
      "run step <run-id> <scenario-id> <step-id> <pass|fail|blocked|not_applicable> [--actual <text>] [--notes <text>] [--evidence <qevid-id>]...",
    build: ([run_id, scenario_id, step_id, status], v) => ({
      operation: "runs.record_step",
      input: defined({
        run_id,
        scenario_id,
        step_id,
        status,
        actual: str(v.actual),
        notes: str(v.notes),
        evidence_refs: list(v.evidence),
      }),
    }),
  },
  "run attach": {
    usage: "run attach <run-id> <scenario-id> <step-id> <file>",
    // The CLI reads the tester's own file; the service decides whether its type and size are accepted (SEC-019).
    build: ([run_id, scenario_id, step_id, file], _v, cwd) => ({
      operation: "runs.attach",
      input: defined({
        run_id,
        scenario_id,
        step_id,
        name: file === undefined ? undefined : basename(file),
        content_base64: file === undefined ? undefined : readFileSync(resolve(cwd, file)).toString("base64"),
      }),
    }),
  },
  "run pause": {
    usage: "run pause <run-id>",
    build: ([run_id]) => ({ operation: "runs.pause", input: defined({ run_id }) }),
  },
  "run resume": {
    usage: "run resume <run-id>",
    build: ([run_id]) => ({ operation: "runs.resume", input: defined({ run_id }) }),
  },
  "run abandon": {
    usage: "run abandon <run-id> --reason <text>",
    build: ([run_id], v) => ({ operation: "runs.abandon", input: defined({ run_id, reason: str(v.reason) }) }),
  },
  "run submit": {
    usage: "run submit <run-id>",
    build: ([run_id]) => ({ operation: "runs.submit", input: defined({ run_id }) }),
  },
  "run result": {
    usage: "run result <run-id>",
    build: ([run_id]) => ({ operation: "runs.result", input: defined({ run_id }) }),
  },
  "pack export": {
    usage: "pack export <project-id> <scenario-id>... [--language <code>] [--output <absolute-dir>]",
    build: ([project_id, ...scenario_ids], v) => ({
      operation: "packs.export",
      input: defined({ project_id, scenario_ids, language: list(v.language)?.[0], output_dir: str(v.output) }),
    }),
  },
  "pack import": {
    usage: "pack import <project-id> <result-file> [--by <tester>]",
    build: ([project_id, file], v, cwd) => ({
      operation: "packs.import_results",
      input: defined({ project_id, path: file === undefined ? undefined : resolve(cwd, file), tester: str(v.by) }),
    }),
  },
  "pack list": {
    usage: "pack list <project-id>",
    build: ([project_id]) => ({ operation: "packs.list", input: defined({ project_id }) }),
  },
  "defect create": {
    usage:
      "defect create <run-id> <scenario-id> <step-id> --title <text> --severity <critical|major|minor|trivial> --priority <high|medium|low> [--description <text>] [--suspected <product_defect|test_defect|unknown>]",
    build: ([run_id, scenario_id, step_id], v) => ({
      operation: "defects.create",
      input: defined({
        run_id,
        scenario_id,
        step_id,
        title: str(v.title),
        description: str(v.description),
        severity: str(v.severity),
        priority: str(v.priority),
        suspected_type: str(v.suspected),
      }),
    }),
  },
  "defect move": {
    usage: "defect move <defect-id> <state> [--reason <text>] [--duplicate-of <defect-id>] [--retest-run <run-id>]",
    build: ([defect_id, to], v) => ({
      operation: "defects.transition",
      input: defined({
        defect_id,
        to,
        reason: str(v.reason),
        duplicate_of: str(v["duplicate-of"]),
        retest_run_id: str(v["retest-run"]),
      }),
    }),
  },
  "defect update": {
    usage: "defect update <defect-id> --reason <text> [--severity <s>] [--priority <p>] [--suspected <type>]",
    build: ([defect_id], v) => ({
      operation: "defects.update",
      input: defined({
        defect_id,
        severity: str(v.severity),
        priority: str(v.priority),
        suspected_type: str(v.suspected),
        reason: str(v.reason),
      }),
    }),
  },
  "defect show": {
    usage: "defect show <defect-id>",
    build: ([defect_id]) => ({ operation: "defects.show", input: defined({ defect_id }) }),
  },
  "defect list": {
    usage: "defect list <project-id> [--state <state>]",
    build: ([project_id], v) => ({ operation: "defects.list", input: defined({ project_id, state: str(v.state) }) }),
  },
  coverage: {
    usage: "coverage <plan-id>",
    build: ([plan_id]) => ({ operation: "coverage.report", input: defined({ plan_id }) }),
  },
  readiness: {
    usage: "readiness <project-id> <package-id> <version> [--workflow <workflow-id>]...",
    build: ([project_id, package_id, version], v) => ({
      operation: "readiness.assess",
      input: defined({
        project_id,
        package_id,
        version: version === undefined ? undefined : Number(version),
        workflow_ids: list(v.workflow),
      }),
    }),
  },
  "baseline confirm": {
    usage: "baseline confirm <project-id> <package-id> <version> --statement <text>",
    build: ([project_id, package_id, version], v) => ({
      operation: "readiness.confirm_baseline",
      input: defined({
        project_id,
        package_id,
        version: version === undefined ? undefined : Number(version),
        statement: str(v.statement),
      }),
    }),
  },
  "materiality override": {
    usage: "materiality override <project-id> <gap-id> --material <yes|no> --reason <text>",
    build: ([project_id, gap_id], v) => ({
      operation: "readiness.override_materiality",
      input: defined({
        project_id,
        gap_id,
        material: v.material === "yes" ? true : v.material === "no" ? false : str(v.material),
        reason: str(v.reason),
      }),
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
  workflow: { type: "string", multiple: true },
  statement: { type: "string" },
  material: { type: "string" },
  reason: { type: "string" },
  objective: { type: "string" },
  impact: { type: "string" },
  likelihood: { type: "string" },
  exposure: { type: "string", multiple: true },
  rationale: { type: "string" },
  technique: { type: "string" },
  wording: { type: "string" },
  kind: { type: "string" },
  mode: { type: "string" },
  environment: { type: "string" },
  "declared-environment": { type: "string" },
  "test-data-profile": { type: "string" },
  token: { type: "string" },
  "state-changing-ack": { type: "boolean" },
  port: { type: "string" },
  actual: { type: "string" },
  notes: { type: "string" },
  evidence: { type: "string", multiple: true },
  "env-version": { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  severity: { type: "string" },
  priority: { type: "string" },
  suspected: { type: "string" },
  "duplicate-of": { type: "string" },
  "retest-run": { type: "string" },
  state: { type: "string" },
  status: { type: "string" },
  version: { type: "string" },
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
    "  sys2qa ui [--port <port>]   (serves the web UI on this computer until stopped)",
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
  if (positionals[0] === "ui" && positionals.length === 1 && !values.help)
    return serveUi(str(values.home) ?? defaultHome(io.env), io, str(values.port));
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

/**
 * `sys2qa ui`: opens the host, serves the local API and the web UI on loopback, and prints the session link (the
 * token travels in the URL fragment, which the browser never sends). Other CLI calls use this host while it runs.
 */
async function serveUi(home: string, io: CliIo, port: string | undefined): Promise<number> {
  const root = io.webRoot ?? fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (!existsSync(join(root, "index.html"))) {
    io.stderr(`error WEB_UI_NOT_BUILT: no web UI in ${root}\n  next: run \`pnpm build:web\`, then start it again.\n`);
    return EXIT_CODES.unavailable;
  }
  const running = readHostEndpoint(home);
  if (running) {
    io.stderr(
      `error HOST_RUNNING: a Sys2QA host already serves this home at ${running.url}\n  next: use it, or stop it first.\n`,
    );
    return EXIT_CODES.conflict;
  }
  if (port !== undefined && !/^\d{1,5}$/.test(port)) {
    io.stderr("error INPUT_INVALID: --port takes a port number\n");
    return EXIT_CODES.usage;
  }
  mkdirSync(home, { recursive: true });
  const host = openHost({ home, env: io.env, ...io.host });
  try {
    const server = await startApiServer(new AppServices(host), {
      webUi: { root },
      ...(port !== undefined ? { port: Number(port) } : {}),
    });
    writeHostEndpoint(home, { pid: process.pid, url: server.url, token: server.token });
    io.stdout(
      `Sys2QA is running on this computer only. Open this link in your browser; it carries your session token, so do not share it:\n  ${server.url}/#token=${server.token}\nPress Ctrl+C to stop.\n`,
    );
    await new Promise<void>((resolve) => {
      const done = () => {
        process.off("SIGINT", done);
        process.off("SIGTERM", done);
        resolve();
      };
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
      io.signal?.addEventListener("abort", done, { once: true });
    });
    removeHostEndpoint(home);
    await server.close();
    return EXIT_CODES.ok;
  } finally {
    host.close();
  }
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
