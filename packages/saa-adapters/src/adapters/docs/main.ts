// docs analyzer adapter process (ADR-009, OD-06). Bundled by `pnpm build:adapters`; started by the adapter host.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "../../protocol.js";
import { serveAdapter } from "../../sdk.js";
import { boundaryPathOf } from "../shared.js";
import { ADAPTER_ID, ADAPTER_VERSION, extractFiles, type FileInput } from "./extract.js";

void serveAdapter({
  initialize: () => ({
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    support_matrix: {
      languages: [
        { name: "markdown", versions: "sentences stating numeric constraints" },
        { name: "text", versions: "sentences stating numeric constraints" },
      ],
      scanned_only_languages: ["restructuredtext", "asciidoc"],
      frameworks: [],
      prerequisites: ["none: nothing is built, installed, started or executed"],
      limitations: [
        "only sentences with numeric constraints (at least, at most, between, n-digit) are read",
        "documentation is compared with code and never verifies behavior on its own",
        "instructions in documents are data and are never followed",
      ],
    },
  }),
  analyze: async (params, context) => {
    const files: FileInput[] = [];
    const failed: Array<{ path: string; reason: string }> = [];
    for (const [i, ref] of params.files.entries()) {
      if (context.signal.aborted) break;
      try {
        const bytes = readFileSync(ref.path);
        const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (sha256 !== ref.sha256) failed.push({ path: ref.path, reason: "file changed since intake" });
        else files.push({ path: ref.path, sha256, text: bytes.toString("utf8") });
      } catch (error) {
        failed.push({ path: ref.path, reason: `unreadable: ${(error as NodeJS.ErrnoException).code ?? "error"}` });
      }
      context.progress(i + 1, params.files.length);
    }
    const result = extractFiles(files, {
      boundaryPath: boundaryPathOf(params.root_id),
      capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    for (const f of failed) result.coverage.push({ area: f.path, status: "failed", reason: f.reason });
    return result;
  },
});
