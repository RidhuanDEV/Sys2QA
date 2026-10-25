// Module dependency rules of Software Architecture §4.1, enforced by dependency-cruiser (IMP-002).
// `root` prefixes every repository path so the same rules can run against fixtures/dependency-rules/.

/** Internal modules each module may import, besides itself (Architecture §4.1). */
export const ALLOWED_INTERNAL = {
  "app-services": ["saa-core", "qaa-core", "runtime-observer", "platform", "contract"],
  "saa-core": ["saa-adapters", "system-model", "evidence", "platform", "contract"],
  "qaa-core": ["system-model", "evidence", "platform", "contract"],
  "runtime-observer": ["evidence", "platform", "contract"],
  "saa-adapters": ["contract"],
  "test-runner": ["contract"],
  "system-model": ["contract"],
  evidence: ["contract"],
  platform: ["contract"],
  contract: [],
};

/** Packages that open connections toward targets (SEC-025). Playwright is also allowed in test-runner, which drives the browser inside L3 containers. */
const NETWORK_CORE = ["http", "https", "http2", "net", "tls", "dgram", "dns"];
const NETWORK_NPM = ["undici", "axios", "got", "node-fetch", "ws", "puppeteer", "puppeteer-core"];
const BROWSER_NPM = ["playwright", "playwright-core", "@playwright/test"];
const LLM_SDKS = [
  "@anthropic-ai/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "openai",
  "@google/genai",
  "@google/generative-ai",
  "@mistralai/mistralai",
  "cohere-ai",
  "ollama",
  "ai",
  "@ai-sdk/[^/]+",
  "langchain",
  "@langchain/[^/]+",
];
const CONTRACT_TOOLING = ["ajv", "ajv-formats", "json-schema-to-typescript"];
/** Modules that start processes. Analysis and QA design modules never do (SEC-002); workers, the adapter host, the observer and the runner do. */
const PROCESS_CORE = ["child_process", "cluster"];
const NO_PROCESS_MODULES = ["saa-core", "system-model", "evidence", "qaa-core", "contract"];

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
/** Matches an npm package whether resolved (any node_modules layout, including pnpm's) or unresolved (bare specifier). */
const npm = (names) => `(^|node_modules/)(${names.join("|")})(/|$)`;
const core = (names) => `^(node:)?(${names.join("|")})$`;

export function dependencyRules(root = "") {
  const r = escape(root);
  const modules = Object.keys(ALLOWED_INTERNAL);
  const perModule = modules.map((module) => ({
    name: `${module}-allowed-modules`,
    comment: `${module} may import only: ${ALLOWED_INTERNAL[module].join(", ") || "nothing internal"} (Architecture §4.1)`,
    severity: "error",
    from: { path: `^${r}packages/${escape(module)}/` },
    to: { path: `^${r}(apps/|packages/(?!(${[module, ...ALLOWED_INTERNAL[module]].map(escape).join("|")})/))` },
  }));
  return [
    ...perModule,
    {
      name: "apps-only-app-services",
      comment: "Interfaces call application services only; no domain logic in apps (SYS-005)",
      severity: "error",
      from: { path: `^${r}apps/` },
      to: { path: `^${r}packages/(?!(app-services|contract)/)` },
    },
    {
      name: "apps-contract-types-only",
      comment: "Apps may use contract types, not contract runtime code (Architecture §4.1)",
      severity: "error",
      from: { path: `^${r}apps/` },
      to: { path: `^${r}packages/contract/`, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "apps-independent",
      comment: "Apps do not import each other",
      severity: "error",
      from: { path: `^${r}apps/([^/]+)/` },
      to: { path: `^${r}apps/`, pathNot: `^${r}apps/$1/` },
    },
    {
      name: "public-entry-only",
      comment: "Cross-module imports go through the module's public entry (src/index.ts)",
      severity: "error",
      from: { path: `^${r}(apps|packages)/([^/]+)/` },
      to: { path: `^${r}(apps|packages)/`, pathNot: [`^${r}$1/$2/`, `^${r}packages/[^/]+/src/index\\.ts$`] },
    },
    {
      name: "network-only-in-runtime-observer",
      comment: "Only runtime-observer opens connections toward targets (SEC-025)",
      severity: "error",
      from: { path: `^${r}(apps|packages)/`, pathNot: `^${r}packages/runtime-observer/` },
      to: { path: [core(NETWORK_CORE), npm(NETWORK_NPM)] },
    },
    {
      name: "browser-only-in-runtime-observer-and-test-runner",
      comment: "Playwright runs in runtime-observer workers and the L3 test-runner only (SEC-025)",
      severity: "error",
      from: { path: `^${r}(apps|packages)/`, pathNot: `^${r}packages/(runtime-observer|test-runner)/` },
      to: { path: npm(BROWSER_NPM) },
    },
    {
      name: "llm-sdk-only-in-platform",
      comment: "LLM SDKs are used only behind the platform LLM port (Architecture §4.1)",
      severity: "error",
      from: { path: `^${r}(apps|packages)/`, pathNot: `^${r}packages/platform/` },
      to: { path: npm(LLM_SDKS) },
    },
    {
      name: "contract-validation-only-in-contract",
      comment: "Contract types and validators are declared only in packages/contract (CON-027)",
      severity: "error",
      from: { path: `^${r}(apps|packages)/`, pathNot: `^${r}packages/contract/` },
      to: { path: npm(CONTRACT_TOOLING) },
    },
    {
      name: "no-process-spawn-in-analysis",
      comment: "Analysis, model, evidence, QA design and contract code never starts a process (SEC-002, SAA-FR-004)",
      severity: "error",
      from: { path: `^${r}packages/(${NO_PROCESS_MODULES.join("|")})/src/` },
      to: { path: core(PROCESS_CORE) },
    },
    {
      name: "no-circular",
      severity: "error",
      from: { path: `^${r}(apps|packages)/` },
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "Every import resolves (catches missing dependencies and typos)",
      severity: "error",
      from: { path: `^${r}(apps|packages)/` },
      to: { couldNotResolve: true },
    },
  ];
}

export const cruiseOptions = {
  doNotFollow: { path: "node_modules" },
  exclude: { path: "^(apps|packages)/[^/]+/(dist|coverage)/" },
  tsPreCompilationDeps: true,
  tsConfig: { fileName: "tsconfig.json" },
  enhancedResolveOptions: {
    exportsFields: ["exports"],
    conditionNames: ["source", "import", "node", "default"],
    extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    mainFields: ["module", "main", "types"],
  },
};
