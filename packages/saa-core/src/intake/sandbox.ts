import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import type { Logger } from "@sys2qa/platform";

/** Why the sandbox refused a path (SEC-001). */
export type SandboxDenialReason =
  "absolute_path" | "parent_traversal" | "invalid_path" | "symlink_outside_root" | "not_regular_file";

export class SandboxError extends Error {
  override readonly name = "SandboxError";
  constructor(
    readonly code: "SANDBOX_DENIED" | "ROOT_INVALID" | "NOT_FOUND",
    message: string,
    readonly reason?: SandboxDenialReason,
  ) {
    super(message);
  }
}

export interface ResolvedPath {
  root: number;
  /** Root-relative path with `/` separators; `""` is the root itself. */
  path: string;
  /** Real (symlink-free) absolute path, inside the root. */
  real: string;
}

export type TextRead =
  | { kind: "text"; text: string; bytes: number; generated_marker: boolean }
  | { kind: "binary"; bytes: number }
  | { kind: "too_large"; bytes: number };

export interface SandboxOptions {
  /**
   * Receives a `sandbox.denied` warning for every refused path (Threat Model ST-01). It names the path as requested,
   * never the target outside the root.
   */
  logger?: Logger;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
/** Git's binary heuristic: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;
/** `// Code generated … DO NOT EDIT.` and similar headers (Go convention, also used by Prisma, protoc, GraphQL codegen). */
const GENERATED_MARKER =
  /^\s*(\/\/|#|\/\*|--|<!--)\s*(@generated|Code generated\b.*\bDO NOT EDIT\b|auto-?generated\b)/im;

/** True if `target` equals `root` or lies beneath it. Both must be real absolute paths. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Every file access of source intake goes through this sandbox (SEC-001, Threat Model T-01). A requested path must be
 * root-relative: absolute paths, drive letters, UNC paths and `..` segments are refused before touching the
 * filesystem, and the resolved real path (after symlinks and Windows junctions) must still be inside the root. Files
 * are opened without following a final symlink and must be regular files, so a FIFO or device never blocks a read.
 */
export class RootSandbox {
  readonly #logger: Logger | undefined;

  private constructor(
    /** Real absolute paths of the approved roots. */
    readonly roots: readonly string[],
    options: SandboxOptions,
  ) {
    this.#logger = options.logger;
  }

  static async open(roots: readonly string[], options: SandboxOptions = {}): Promise<RootSandbox> {
    if (roots.length === 0) throw new SandboxError("ROOT_INVALID", "at least one root is required");
    const real: string[] = [];
    for (const root of roots) {
      let resolved: string;
      try {
        resolved = await realpath(root);
      } catch {
        throw new SandboxError("ROOT_INVALID", `root does not exist or is not accessible: ${root}`);
      }
      if (!(await stat(resolved)).isDirectory())
        throw new SandboxError("ROOT_INVALID", `root is not a directory: ${root}`);
      real.push(resolved);
    }
    return new RootSandbox(real, options);
  }

  /** Validates a root-relative path lexically and resolves it to a real path inside the root. */
  async resolve(root: number, requested: string): Promise<ResolvedPath> {
    const base = this.roots[root];
    if (base === undefined) throw new SandboxError("ROOT_INVALID", `unknown root ${root}`);
    const segments = this.#segments(root, requested);
    const lexical = join(base, ...segments);
    let real: string;
    try {
      real = await realpath(lexical);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw new SandboxError("NOT_FOUND", `not found: ${segments.join("/")}`);
      throw error;
    }
    // The lexical path was inside the root, so an escape here came through a symlink or junction.
    if (!isInside(base, real)) this.#deny(root, requested, "symlink_outside_root");
    return { root, path: segments.join("/"), real };
  }

  /** Reads a regular file inside the root, at most `maxBytes`. */
  async readFile(resolved: ResolvedPath, maxBytes: number): Promise<Buffer | { too_large: number }> {
    const handle = await open(resolved.real, constants.O_RDONLY | NOFOLLOW | NONBLOCK).catch((error: unknown) => {
      // ELOOP: the final component became a symlink after resolution.
      if ((error as NodeJS.ErrnoException).code === "ELOOP")
        this.#deny(resolved.root, resolved.path, "symlink_outside_root");
      throw error;
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) this.#deny(resolved.root, resolved.path, "not_regular_file");
      if (info.size > maxBytes) return { too_large: info.size };
      const buffer = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < info.size) {
        const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  /** Reads a file as UTF-8 text, or reports it as binary or too large (PRD §11.5: never feed bytes onward). */
  async readText(resolved: ResolvedPath, maxBytes: number): Promise<TextRead> {
    const data = await this.readFile(resolved, maxBytes);
    if (!Buffer.isBuffer(data)) return { kind: "too_large", bytes: data.too_large };
    if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary", bytes: data.length };
    let text = data.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { kind: "text", text, bytes: data.length, generated_marker: GENERATED_MARKER.test(text.slice(0, 1024)) };
  }

  #segments(root: number, requested: string): string[] {
    if (typeof requested !== "string" || requested.includes("\0")) this.#deny(root, String(requested), "invalid_path");
    if (isAbsolute(requested) || win32.isAbsolute(requested) || /^[A-Za-z]:/.test(requested))
      this.#deny(root, requested, "absolute_path");
    const segments = requested.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
    if (segments.includes("..")) this.#deny(root, requested, "parent_traversal");
    return segments;
  }

  #deny(root: number, requested: string, reason: SandboxDenialReason): never {
    this.#logger?.warn("sandbox.denied", { root, path: requested, reason });
    throw new SandboxError("SANDBOX_DENIED", `path refused (${reason}): ${requested}`, reason);
  }
}
