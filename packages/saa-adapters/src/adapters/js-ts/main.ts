// js-ts analyzer adapter process (ADR-009, OD-06). Bundled by `pnpm build:adapters`; started by the adapter host.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import ts from "typescript";
import { PROTOCOL_VERSION } from "../../protocol.js";
import { serveAdapter } from "../../sdk.js";
import { ADAPTER_ID, ADAPTER_VERSION, boundaryPathOf, extractFiles, type FileInput } from "./extract.js";

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

void serveAdapter({
  initialize: () => ({
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    support_matrix: {
      languages: [
        { name: "typescript", versions: `syntax of TypeScript ${ts.versionMajorMinor} and earlier` },
        { name: "javascript", versions: "ES2024 and JSX" },
      ],
      scanned_only_languages: [],
      // Framework conventions (routes, pages, forms) arrive with the framework layer (IMP-107).
      frameworks: [],
      prerequisites: ["none: files are parsed without installing dependencies or running a build"],
      limitations: [
        "imports are resolved by path only: tsconfig `paths`, bundler aliases and package `exports` maps are not applied",
        "imports of other workspace packages are recorded as package imports and linked by the host",
        "computed `require()` and `import()` arguments are reported as unresolved",
        "no type checking: references are linked by imported name, not by inferred type",
      ],
    },
  }),
  analyze: async (params, context) => {
    const files: FileInput[] = [];
    const unreadable: Array<{ path: string; reason: string }> = [];
    for (const [i, ref] of params.files.entries()) {
      if (context.signal.aborted) break;
      try {
        const bytes = readFileSync(ref.path);
        const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        // The host hashed the file at intake; a different hash means it changed during the run.
        if (sha256 !== ref.sha256) unreadable.push({ path: ref.path, reason: "file changed since intake" });
        else files.push({ path: ref.path, sha256, text: bytes.toString("utf8") });
      } catch (error) {
        unreadable.push({ path: ref.path, reason: `unreadable: ${(error as NodeJS.ErrnoException).code ?? "error"}` });
      }
      context.progress(i + 1, params.files.length);
    }
    const result = extractFiles(files, {
      boundaryPath: boundaryPathOf(params.root_id),
      exists: isFile,
      capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    for (const u of unreadable) result.coverage.push({ area: u.path, status: "failed", reason: u.reason });
    return result;
  },
});
