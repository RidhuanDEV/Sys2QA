import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AdapterSpec } from "./host.js";

const PACKAGE_ROOT = new URL("../", import.meta.url);

/** Built-in adapters with their bundled entries; `built: false` until `pnpm build:adapters` has run. */
export function builtinAdapters(): Array<AdapterSpec & { built: boolean }> {
  const registry = JSON.parse(readFileSync(new URL("adapters.json", PACKAGE_ROOT), "utf8")) as {
    adapters: Array<{ id: string; source: string }>;
  };
  return registry.adapters.map(({ id }) => {
    const entry = fileURLToPath(new URL(`dist/adapters/${id}.mjs`, PACKAGE_ROOT));
    return { id, entry, built: existsSync(entry) };
  });
}
