// Generates TypeScript types from the canonical JSON Schemas in /schemas (ADR-003).
// Usage: node packages/contract/scripts/generate-types.mjs [--check]
// --check exits non-zero when the committed file is out of date (CI stage 1).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import prettier from "prettier";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const schemaDir = join(repoRoot, "schemas");
const outFile = join(here, "../src/generated/types.ts");
const SCHEMA_BASE = "https://sys2qa.dev/schemas/";

const files = readdirSync(schemaDir)
  .filter((f) => f.endsWith(".schema.json"))
  .sort();
const byId = new Map();
for (const f of files) {
  const schema = JSON.parse(readFileSync(join(schemaDir, f), "utf8"));
  byId.set(schema.$id, join(schemaDir, f));
}

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
// One synthetic root so that every shared definition is declared exactly once.
const root = {
  title: "Sys2qaContractDocuments",
  description: "Synthetic root used only for type generation. Not a contract document.",
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    [...byId.keys()].map((id) => [camel(id.slice(SCHEMA_BASE.length).split("/")[0]), { $ref: id }]),
  ),
};

const banner = [
  "/* eslint-disable */",
  "/**",
  " * GENERATED FILE — DO NOT EDIT.",
  " * Source: /schemas/*.schema.json (canonical contract, ADR-003).",
  " * Regenerate with: pnpm schemas:types",
  " */",
].join("\n");

const generated = await compile(root, "Sys2qaContractDocuments", {
  bannerComment: banner,
  additionalProperties: false,
  unreachableDefinitions: true,
  format: false,
  cwd: schemaDir,
  $refOptions: {
    resolve: {
      http: false,
      sys2qa: {
        order: 1,
        canRead: (file) => file.url.startsWith(SCHEMA_BASE),
        read: (file) => {
          const path = byId.get(file.url.split("#")[0]);
          if (!path) throw new Error(`Unknown schema reference: ${file.url}`);
          return readFileSync(path, "utf8");
        },
      },
    },
  },
});

const prettierConfig = (await prettier.resolveConfig(outFile)) ?? {};
const output = await prettier.format(generated, { ...prettierConfig, parser: "typescript" });

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outFile, "utf8");
  } catch {
    // missing file is reported below
  }
  if (current !== output) {
    console.error("Generated contract types are out of date. Run: pnpm schemas:types");
    process.exit(1);
  }
  console.log("Generated contract types are up to date.");
} else {
  writeFileSync(outFile, output);
  console.log(`Wrote ${outFile} from ${files.length} schemas.`);
}
