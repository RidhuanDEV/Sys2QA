import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes `data` so that readers see either the old file or the whole new one (Data Model §6.1): a temporary file
 * `<target>.tmp-<random>` in the same directory, fsync, rename, then fsync of the directory where the platform allows it.
 */
export function writeFileAtomic(target: string, data: string | Uint8Array): void {
  const temp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  syncDirectory(dirname(target));
}

/** Makes a rename durable. Directories cannot be opened for fsync on Windows; there the rename is already durable. */
export function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some file systems refuse fsync on directories; the data itself is already synced.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
