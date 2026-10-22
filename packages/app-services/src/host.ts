import { join } from "node:path";
import {
  acquireHostLock,
  createIdGenerator,
  createLogger,
  fileSink,
  GlossaryRegistry,
  JobStore,
  LlmService,
  NoneBackend,
  openStateDatabase,
  ProjectService,
  Redactor,
  type HostLock,
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
}

/** The composition root of one host process: the only writer of state.db (Data Model §6). */
export interface Host {
  readonly home: string;
  readonly state: StateDatabase;
  readonly projects: ProjectService;
  readonly jobs: JobStore;
  readonly llm: LlmService;
  readonly glossary: GlossaryRegistry;
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
    const redactor = new Redactor();
    const logger = createLogger({ sink: options.logSink ?? fileSink(join(options.home, "logs"), now), redactor, now });
    const state = openStateDatabase({ path: join(options.home, "state.db"), now });
    const audit = { redactor, now };
    return {
      home: options.home,
      state,
      projects: new ProjectService(state.db, { audit, newId, logger }),
      jobs: new JobStore(state.db, { now, newId, logger }),
      llm: new LlmService(new NoneBackend(), { redactor, db: state.db, logger, now }),
      glossary: new GlossaryRegistry(),
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
