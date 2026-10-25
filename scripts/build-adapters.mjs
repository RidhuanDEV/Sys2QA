// `pnpm build:adapters`: bundles every built-in adapter listed in packages/saa-adapters/adapters.json.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleAdapter } from "./adapter-bundle.mjs";

const root = new URL("../packages/saa-adapters/", import.meta.url);
const { adapters } = JSON.parse(readFileSync(new URL("adapters.json", root), "utf8"));
for (const { id, source } of adapters) {
  const outfile = fileURLToPath(new URL(`dist/adapters/${id}.mjs`, root));
  await bundleAdapter({ entry: fileURLToPath(new URL(source, root)), outfile });
  console.log(`bundled ${id} -> ${outfile}`);
}
if (adapters.length === 0) console.log("no built-in adapters to bundle");
