import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { StorageError } from "./errors.js";

interface LockContent {
  pid: number;
  hostname: string;
  acquired_at: string;
}

export interface HostLock {
  readonly path: string;
  release(): void;
}

/**
 * Ensures a single host process per Sys2QA home: only the host writes state.db (Data Model §6.5).
 * A lock left by a process that no longer exists on this machine is taken over.
 */
export function acquireHostLock(home: string, now: () => Date = () => new Date()): HostLock {
  const path = join(home, "host.lock");
  const content: LockContent = { pid: process.pid, hostname: hostname(), acquired_at: now().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify(content));
      } finally {
        closeSync(fd);
      }
      return { path, release: () => releaseIfOwned(path) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLock(path);
      if (holder && isAlive(holder)) {
        throw new StorageError(
          "HOST_ALREADY_RUNNING",
          `another Sys2QA host (pid ${holder.pid} on ${holder.hostname}) is using this home directory`,
          "Use the running instance, or stop it first. If no Sys2QA process is running, delete the host.lock file.",
        );
      }
      unlinkSync(path); // stale: its process is gone
    }
  }
  throw new StorageError(
    "HOST_ALREADY_RUNNING",
    "could not acquire the host lock",
    "Retry; another process is starting at the same time.",
  );
}

function readLock(path: string): LockContent | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContent>;
    return typeof parsed.pid === "number" && typeof parsed.hostname === "string" ? (parsed as LockContent) : undefined;
  } catch {
    return undefined; // unreadable or half-written: treated as stale
  }
}

function isAlive(lock: LockContent): boolean {
  if (lock.hostname !== hostname()) return true; // cannot check another machine's processes; assume it is running
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists but belongs to another user
  }
}

function releaseIfOwned(path: string): void {
  const holder = readLock(path);
  if (holder?.pid === process.pid && holder.hostname === hostname()) unlinkSync(path);
}
