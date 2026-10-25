import {
  checkGit,
  checkHome,
  checkNode,
  checkSqlite,
  ConfigError,
  createLlmBackend,
  doctorStatus,
  LlmService,
  loadConfig,
  Redactor,
  type DoctorCheck,
  type DoctorStatus,
  type LlmDisclosure,
} from "@sys2qa/platform";
import { checkBrowserRuntime, checkContainerRuntime } from "@sys2qa/runtime-observer";

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
  /** What the configured model provider receives (SEC-018). */
  llm_disclosure: LlmDisclosure | null;
}

/**
 * `sys2qa doctor` (NFR-007, OSS-001): every prerequisite with what it is needed for and how to fix it. Runs without a
 * host, so it also works when the state database or its driver cannot be opened.
 */
export async function runDoctor(options: {
  home: string;
  env?: Record<string, string | undefined>;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [checkNode(), checkSqlite(), ...checkHome(options.home), checkGit()];
  let disclosure: LlmDisclosure | null = null;
  try {
    const { config, file } = loadConfig({ home: options.home, env: options.env ?? {} });
    checks.push({
      id: "config",
      title: "Configuration",
      status: "ok",
      required_for: ["core"],
      detail: `valid (${file})`,
    });
    try {
      disclosure = new LlmService(createLlmBackend(config.llm), { redactor: new Redactor() }).disclosure();
      checks.push({
        id: "llm",
        title: "Model provider",
        status: "ok",
        required_for: ["narrative text", "scenario wording"],
        detail: disclosure.text.en,
      });
    } catch (error) {
      checks.push({
        id: "llm",
        title: "Model provider",
        status: "fail",
        required_for: ["narrative text", "scenario wording"],
        detail: (error as Error).message,
        remediation: "Set `remote_consent: true` for a remote endpoint, or use a local endpoint or `provider: none`.",
      });
    }
  } catch (error) {
    const e = error as ConfigError;
    checks.push({
      id: "config",
      title: "Configuration",
      status: "fail",
      required_for: ["core"],
      detail: e.message,
      ...(e.remediation ? { remediation: e.remediation } : {}),
    });
  }
  checks.push(...(await Promise.all([checkBrowserRuntime(), checkContainerRuntime()])));
  return { status: doctorStatus(checks), checks, llm_disclosure: disclosure };
}
