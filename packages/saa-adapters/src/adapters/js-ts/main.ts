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
      // Each claim names the fixture that proves it (SAA-FR-047); the host links routes, mounts and pages (IMP-107).
      frameworks: [
        {
          name: "express",
          versions: "4.x and 5.x",
          entities: ["api"],
          relations: ["EXPOSES"],
          workflow_tracing: "partial",
          fixtures: ["fixtures/benchmarks/F1-repository-only"],
        },
        {
          name: "react-router",
          versions: "6.x and 7.x (createBrowserRouter objects and <Route> elements)",
          entities: ["page", "form", "field"],
          relations: ["CONTAINS", "SUBMITS_TO", "NAVIGATES_TO"],
          workflow_tracing: "partial",
          fixtures: ["fixtures/benchmarks/F1-repository-only"],
        },
        {
          name: "nextjs",
          versions: "13+ (app and pages directories)",
          entities: ["page", "api"],
          relations: ["EXPOSES"],
          workflow_tracing: "partial",
          fixtures: ["fixtures/saa/nextjs"],
        },
      ],
      prerequisites: ["none: files are parsed without installing dependencies or running a build"],
      limitations: [
        "imports are resolved by path only: tsconfig `paths`, bundler aliases and package `exports` maps are not applied",
        "imports of other workspace packages are recorded as package imports and linked by the host",
        "computed `require()` and `import()` arguments are reported as unresolved",
        "no type checking: references are linked by imported name, not by inferred type",
        "routes with computed paths, routers passed between functions and mounts through computed values are reported as unresolved",
        "form submissions are recognized through literal fetch() calls in the form's action or onSubmit handler",
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
