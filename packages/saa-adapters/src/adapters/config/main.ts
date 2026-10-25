// config analyzer adapter process (ADR-009, OD-06). Bundled by `pnpm build:adapters`; started by the adapter host.
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
        { name: "dotenv", versions: "environment templates (names only)" },
        { name: "dockerfile" },
        {
          name: "yaml",
          versions: "Docker Compose and CI workflows (GitHub Actions, GitLab CI, CircleCI, Azure, Bitbucket)",
        },
        { name: "json", versions: "package.json scripts" },
      ],
      scanned_only_languages: [],
      frameworks: [],
      prerequisites: ["none: nothing is built, installed, started or executed"],
      limitations: [
        "values are never extracted: environment templates, Compose and CI files give variable names only",
        "commands are recorded as text and never run; install lifecycle scripts are flagged",
        "Kubernetes, Helm and Terraform files are inventoried but not modeled",
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
