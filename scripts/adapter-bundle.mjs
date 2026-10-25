// Bundles an analyzer adapter into one self-contained ES module (ADR-009, IMP-105). Adapters always run as bundles,
// so the same confined process (no child processes, no workers) is used in development, tests and releases.
import { build } from "esbuild";

/** @param {{ entry: string; outfile: string }} options */
export async function bundleAdapter({ entry, outfile }) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["source"],
    // CommonJS dependencies inside an ES module bundle need `require`, `__filename` and `__dirname`.
    banner: {
      js: [
        'import { createRequire as __adapterRequire } from "node:module";',
        'import { fileURLToPath as __adapterPath } from "node:url";',
        "const require = __adapterRequire(import.meta.url);",
        "const __filename = __adapterPath(import.meta.url);",
        'const __dirname = __adapterPath(new URL(".", import.meta.url));',
      ].join(" "),
    },
    logLevel: "silent",
    legalComments: "none",
  });
  return outfile;
}
