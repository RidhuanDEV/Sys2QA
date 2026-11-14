// Bundles the web UI (apps/web) into one directory of static files that the local API serves (Architecture §8).
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const web = fileURLToPath(new URL("../apps/web/", import.meta.url));

/** Writes index.html, app.css and app.js into `outDir`. */
export async function bundleWebUi(outDir) {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [join(web, "src", "main.tsx")],
    outfile: join(outDir, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  for (const name of readdirSync(join(web, "static"))) copyFileSync(join(web, "static", name), join(outDir, name));
  return outDir;
}

/** Where the CLI looks for the built UI. */
export const WEB_UI_DIST = join(web, "dist");
