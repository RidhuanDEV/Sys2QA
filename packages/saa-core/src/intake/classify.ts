/** What a file is, decided from its path alone (contents are read later, through the sandbox). */
export type FileCategory =
  | "source"
  | "test"
  | "config"
  | "manifest"
  | "lockfile"
  | "documentation"
  | "binary"
  | "generated"
  | "build_output"
  | "dependency"
  | "vendor"
  | "vcs"
  | "other";

/** Directories excluded by default, with the reason recorded in the inventory (PRD §11.5, NFR-002). */
export const DEFAULT_EXCLUDED_DIRECTORIES: Readonly<Record<string, FileCategory>> = {
  ".git": "vcs",
  ".hg": "vcs",
  ".svn": "vcs",
  node_modules: "dependency",
  bower_components: "dependency",
  jspm_packages: "dependency",
  ".pnpm-store": "dependency",
  ".yarn": "dependency",
  ".venv": "dependency",
  venv: "dependency",
  __pycache__: "build_output",
  vendor: "vendor",
  dist: "build_output",
  build: "build_output",
  out: "build_output",
  target: "build_output",
  coverage: "build_output",
  ".next": "build_output",
  ".nuxt": "build_output",
  ".svelte-kit": "build_output",
  ".turbo": "build_output",
  ".cache": "build_output",
  ".gradle": "build_output",
  ".terraform": "dependency",
  generated: "generated",
  __generated__: "generated",
};

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  svelte: "svelte",
  sql: "sql",
  prisma: "prisma",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  rs: "rust",
  dart: "dart",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  ini: "ini",
  md: "markdown",
  mdx: "markdown",
  rst: "restructuredtext",
  adoc: "asciidoc",
  txt: "text",
};

const DOCUMENTATION = new Set(["markdown", "restructuredtext", "asciidoc", "text"]);
const CONFIG = new Set(["json", "yaml", "toml", "xml", "ini"]);
const MANIFESTS = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "deno.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "pipfile",
  "go.mod",
  "go.work",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "composer.json",
  "gemfile",
  "pubspec.yaml",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
]);
const MANIFEST_SUFFIXES = [".csproj", ".fsproj", ".vbproj", ".sln"];
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "composer.lock",
  "gemfile.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "go.sum",
  "pubspec.lock",
  "packages.lock.json",
]);
const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp ico webp avif tif tiff psd heic svgz woff woff2 ttf otf eot " +
    "zip gz tgz bz2 xz 7z rar tar jar war ear whl nupkg apk aab ipa dmg iso " +
    "exe dll so dylib a lib o obj class pyc pyo wasm node bin dat " +
    "mp3 mp4 m4a mov avi mkv webm wav flac ogg pdf doc docx xls xlsx ppt pptx " +
    "sqlite sqlite3 db mdb parquet avro onnx pt pth h5 pkl npy npz"
  ).split(" "),
);
const GENERATED_FILE = /(\.min\.(js|css|mjs)|\.map|\.generated\.[a-z]+|\.g\.dart|\.pb\.go|_pb2\.py|\.designer\.cs)$/i;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[a-z]+$/i;

export interface Classification {
  category: FileCategory;
  language?: string;
  /** Set for package and build manifests, which stack detection reads (SAA-FR-002). */
  manifest?: true;
}

/** Classifies a root-relative file path (`/` separators). */
export function classifyFile(path: string): Classification {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot + 1) : "";
  const language = LANGUAGES[extension];
  const withLanguage = (category: FileCategory): Classification =>
    language === undefined ? { category } : { category, language };
  if (LOCKFILES.has(lower)) return withLanguage("lockfile");
  if (MANIFESTS.has(lower) || MANIFEST_SUFFIXES.some((s) => lower.endsWith(s)))
    return { ...withLanguage("manifest"), manifest: true };
  if (BINARY_EXTENSIONS.has(extension)) return { category: "binary" };
  if (GENERATED_FILE.test(lower)) return withLanguage("generated");
  if (language === undefined) {
    if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return { category: "config" };
    return { category: "other" };
  }
  if (DOCUMENTATION.has(language)) return withLanguage("documentation");
  if (CONFIG.has(language)) return withLanguage("config");
  return withLanguage(TEST_FILE.test(path) ? "test" : "source");
}
