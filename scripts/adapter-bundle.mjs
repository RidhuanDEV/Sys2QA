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
    // CommonJS dependencies inside an ES module bundle need a real `require`.
    banner: {
      js: 'import { createRequire as __adapterRequire } from "node:module"; const require = __adapterRequire(import.meta.url);',
    },
    logLevel: "silent",
    legalComments: "none",
  });
  return outfile;
}
