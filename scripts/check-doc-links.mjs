// Fails when a relative Markdown link in docs/ (or the repository root) points to a missing file.
// External (http/https/mailto) links are not checked here.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipDirs = new Set(["node_modules", ".git", "dist", "coverage", "reports"]);

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (entry.endsWith(".md")) yield path;
  }
}

const link = /\]\(([^)\s#]+)(#[^)]*)?\)/g;
let broken = 0;
let checked = 0;
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(link)) {
    const target = match[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    checked++;
    if (!existsSync(normalize(join(dirname(file), target)))) {
      broken++;
      console.error(`${relative(root, file)}: broken link -> ${target}`);
    }
  }
}
if (broken) {
  console.error(`${broken} broken link(s) out of ${checked} checked.`);
  process.exit(1);
}
console.log(`All ${checked} relative documentation links resolve.`);
