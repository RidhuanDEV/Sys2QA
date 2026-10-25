import { join } from "node:path";
import {
  acquireHostLock,
  createIdGenerator,
  createLlmBackend,
  loadConfig,
  createLogger,
  fileSink,
  GlossaryRegistry,
  JobStore,
  LlmService,
  openStateDatabase,
  ProjectService,
  Redactor,
  SecretService,
  selectSecretBackend,
  type HostLock,
  type LoadedConfig,
  type Logger,
  type LogSink,
  type StateDatabase,
} from "@sys2qa/platform";

export interface HostOptions {
  /** `<sys2qa-home>` (Data Model §2). */
  home: string;
  now?: () => Date;
  newId?: (kind: string) => string;
  /** Defaults to daily files under `<home>/logs`. */
  logSink?: LogSink;
  /** Tests may share a home between hosts that never run concurrently. */
  lock?: boolean;
  /** Environment for the `SYS2QA_*` configuration layer (defaults to none, so tests are not affected by the shell). */
  env?: Record<string, string | undefined>;
  /** Overrides the OS credential-store probe (tests). */
  osSecretStoreAvailable?: () => Promise<boolean>;
}

/** The composition root of one host process: the only writer of state.db (Data Model §6). */
export interface Host {
  readonly home: string;
  readonly config: LoadedConfig;
  readonly state: StateDatabase;
  readonly projects: ProjectService;
  readonly jobs: JobStore;
  readonly llm: LlmService;
  readonly glossary: GlossaryRegistry;
  /** The secret store, selected on first use (ADR-011); rejects with SECRET_STORE_UNAVAILABLE when none is usable. */
  secrets(): Promise<SecretService>;
  readonly redactor: Redactor;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly newId: (kind: string) => string;
  close(): void;
}

export function openHost(options: HostOptions): Host {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? createIdGenerator(now);
  const lock: HostLock | undefined = options.lock === false ? undefined : acquireHostLock(options.home, now);
  try {
    const config = loadConfig({ home: options.home, env: options.env ?? {} });
    const redactor = new Redactor();
    const logger = createLogger({
      sink: options.logSink ?? fileSink(join(options.home, "logs"), now),
      redactor,
      now,
      level: config.config.log_level,
    });
    const state = openStateDatabase({ path: join(options.home, "state.db"), now });
    const audit = { redactor, now };
    let secrets: Promise<SecretService> | undefined;
    return {
      home: options.home,
      config,
      state,
      projects: new ProjectService(state.db, { audit, newId, logger }),
      jobs: new JobStore(state.db, { now, newId, logger }),
      // The secret store (IMP-010) will resolve `api_key_ref`; until then a configured key reference is not used.
      llm: new LlmService(createLlmBackend(config.config.llm), {
        redactor,
        db: state.db,
        logger,
        now,
        exclusions: config.config.llm_exclusions,
      }),
      glossary: new GlossaryRegistry(),
      secrets: () =>
        (secrets ??= selectSecretBackend({
          mode: config.config.secrets.backend,
          filePath: join(options.home, "secrets.enc"),
          ...(options.env?.SYS2QA_SECRETS_PASSPHRASE ? { passphrase: options.env.SYS2QA_SECRETS_PASSPHRASE } : {}),
          ...(options.osSecretStoreAvailable ? { osAvailable: options.osSecretStoreAvailable } : {}),
        }).then(
          (backend) => new SecretService(state.db, backend, audit),
          (error: unknown) => {
            secrets = undefined;
            throw error;
          },
        )),
      redactor,
      logger,
      now,
      newId,
      close: () => {
        state.close();
        lock?.release();
      },
    };
  } catch (error) {
    lock?.release();
    throw error;
  }
}
