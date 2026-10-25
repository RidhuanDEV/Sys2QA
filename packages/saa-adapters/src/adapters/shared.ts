// Helpers shared by the built-in adapters; kept free of parser dependencies so every bundle stays small.

/** `project:.` → `""`; `project:apps/web` → `apps/web`; `project:root1/apps/web` → `apps/web` (the cwd is that root). */
export function boundaryPathOf(rootId: string): string {
  const local = rootId.startsWith("project:") ? rootId.slice("project:".length) : rootId;
  const path = local.replace(/^root\d+\//, "");
  return path === "." || path === "root" ? "" : path.replace(/^\.\//, "");
}
