import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Host } from "./host.js";

/** A path with links resolved on its existing part, so a link cannot carry it out of a root (SEC-001). */
function realish(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]/, ""));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return rest.length > 0 ? resolve(base, ...rest) : base;
}

function inside(path: string, root: string): boolean {
  const rel = relative(realish(root), realish(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep));
}

/**
 * The roots an MCP client may name in path arguments (SAA-FR-017): the Sys2QA home and every source root or package a
 * person registered. An AI client works inside what was approved; it cannot point a tool at any other path.
 */
export function approvedRoots(host: Host): string[] {
  const refs = host.state.db
    .prepare("SELECT ref FROM evidence_sources WHERE kind IN ('source_root', 'package')")
    .all() as Array<{ ref: string }>;
  return [host.home, ...refs.map((r) => r.ref)];
}

/** The first path outside every approved root, or undefined when all are inside. */
export function pathOutsideApprovedRoots(host: Host, paths: readonly string[]): string | undefined {
  const roots = approvedRoots(host);
  return paths.find((p) => !isAbsolute(p) || !roots.some((root) => inside(p, root)));
}
