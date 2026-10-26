/** The documentation roles of PRD §12.2 (CON-011), in document order. */
export const DOC_ROLES = [
  "executive_summary",
  "system_context",
  "architecture",
  "project_inventory",
  "components",
  "workflow_catalog",
  "workflows",
  "routes_and_pages",
  "business_rules",
  "observed_behavior",
  "api_contracts",
  "data_model",
  "roles_and_permissions",
  "integrations_events",
  "configuration_deployment",
  "tests_coverage",
  "dependencies_impact",
  "risks_contradictions",
  "unknowns",
] as const;
export type DocRole = (typeof DOC_ROLES)[number];

/** Default file names (PRD §12.2); configurable by the exporter, while the role stays fixed. */
export const DEFAULT_FILES: Record<DocRole, string> = {
  executive_summary: "00-executive-summary.md",
  system_context: "01-system-context.md",
  architecture: "02-architecture.md",
  project_inventory: "03-project-inventory.md",
  components: "04-components.md",
  workflow_catalog: "05-workflow-catalog.md",
  workflows: "05-workflows",
  routes_and_pages: "05a-routes-pages-forms.md",
  business_rules: "05b-business-rules-and-states.md",
  observed_behavior: "05c-observed-behavior.md",
  api_contracts: "06-api-contracts.md",
  data_model: "07-data-model.md",
  roles_and_permissions: "08-authentication-authorization.md",
  integrations_events: "09-integrations-and-events.md",
  configuration_deployment: "10-configuration-and-deployment.md",
  tests_coverage: "11-tests-and-quality-coverage.md",
  dependencies_impact: "12-dependencies-and-impact.md",
  risks_contradictions: "13-risks-and-contradictions.md",
  unknowns: "14-unknowns-and-next-investigations.md",
};

export type DocLanguage = "en" | "id";

/**
 * Template text per language (SAA-FR-035, LOC-011). Only the words around the data change between languages: IDs,
 * paths, enum codes, numbers and code stay as they are, and machine text from the model (statements, gap
 * descriptions) is shown in the model's language and marked as such.
 */
export interface Messages {
  titles: Record<DocRole, string>;
  workflowTitle: (name: string) => string;
  header: { revision: string; analyzed: string; profile: string; language: string; run: string };
  scope: (analyzed: number, partial: number, unsupported: number) => string;
  machineText: string;
  none: string;
  notAnalyzed: string;
  gapsHere: string;
  columns: Record<
    | "id"
    | "name"
    | "kind"
    | "status"
    | "category"
    | "entry"
    | "discovery"
    | "completion"
    | "unresolved"
    | "deepened"
    | "rank"
    | "step"
    | "action"
    | "reads"
    | "writes"
    | "effects"
    | "validations"
    | "from"
    | "condition"
    | "outcome"
    | "reason"
    | "statement"
    | "technical"
    | "inputs"
    | "violation"
    | "boundary"
    | "languages"
    | "frameworks"
    | "manifests"
    | "files"
    | "path"
    | "evidence"
    | "type"
    | "constraints"
    | "sources"
    | "documented"
    | "fallback"
    | "target"
    | "count"
    | "question"
    | "suggestion"
    | "improves",
    string
  >;
  yes: string;
  no: string;
  sections: Record<
    | "summary"
    | "evidenceProfile"
    | "cannotEstablish"
    | "boundaries"
    | "keyWorkflows"
    | "completeness"
    | "limitations"
    | "highRiskUnknowns"
    | "actors"
    | "applications"
    | "externalServices"
    | "trustBoundaries"
    | "modules"
    | "dependencies"
    | "deployment"
    | "diagram"
    | "stack"
    | "entryPoints"
    | "commands"
    | "excluded"
    | "coverage"
    | "byCategory"
    | "steps"
    | "branches"
    | "unresolvedHops"
    | "traces"
    | "tests"
    | "pages"
    | "forms"
    | "navigation"
    | "rules"
    | "states"
    | "transitions"
    | "invalidTransitions"
    | "endpoints"
    | "errors"
    | "tables"
    | "columns"
    | "entities"
    | "queries"
    | "roles"
    | "checks"
    | "integrations"
    | "topics"
    | "keys"
    | "units"
    | "secrets"
    | "testModules"
    | "untested"
    | "cycles"
    | "hotspots"
    | "projects"
    | "contradictions"
    | "dynamic"
    | "adapters"
    | "inferred"
    | "questions"
    | "missingSources"
    | "suggestions",
    string
  >;
  text: {
    evidenceProfile: string;
    cannotEstablish: string;
    observedBehavior: string;
    notExecuted: string;
    valuesRedacted: string;
    noOwners: string;
    testsNotRun: string;
    noChangeEvidence: string;
    sensitivity: string;
    countsInScope: (kind: string, n: number) => string;
    notDeepened: string;
    responsibility: (exposes: number, renders: number, writes: number, reads: number) => string;
  };
}

const EN: Messages = {
  titles: {
    executive_summary: "Executive summary",
    system_context: "System context",
    architecture: "Architecture",
    project_inventory: "Project inventory",
    components: "Components",
    workflow_catalog: "Workflow catalog",
    workflows: "Workflows",
    routes_and_pages: "Routes, pages and forms",
    business_rules: "Business rules and states",
    observed_behavior: "Observed behavior",
    api_contracts: "API contracts",
    data_model: "Data model",
    roles_and_permissions: "Authentication and authorization",
    integrations_events: "Integrations and events",
    configuration_deployment: "Configuration and deployment",
    tests_coverage: "Tests and quality coverage",
    dependencies_impact: "Dependencies and impact",
    risks_contradictions: "Risks and contradictions",
    unknowns: "Unknowns and next investigations",
  },
  workflowTitle: (name) => `Workflow: ${name}`,
  header: { revision: "Revision", analyzed: "analyzed", profile: "profile", language: "language", run: "run" },
  scope: (a, p, u) =>
    `Counts are within the examined scope. Coverage: ${a} analyzed, ${p} partly analyzed, ${u} unsupported.`,
  machineText: "machine text, en",
  none: "None found within the examined scope.",
  notAnalyzed: "Not analyzed in this run; see the gaps below.",
  gapsHere: "Gaps",
  columns: {
    id: "ID",
    name: "Name",
    kind: "Kind",
    status: "Status",
    category: "Category",
    entry: "Entry point",
    discovery: "Discovery",
    completion: "Completion",
    unresolved: "Unresolved",
    deepened: "Deepened",
    rank: "Rank",
    step: "Step",
    action: "Action",
    reads: "Reads",
    writes: "Writes",
    effects: "Side effects",
    validations: "Validations",
    from: "From",
    condition: "Condition",
    outcome: "Outcome",
    reason: "Reason",
    statement: "Statement",
    technical: "Technical rule",
    inputs: "Inputs",
    violation: "On violation",
    boundary: "Boundary",
    languages: "Languages",
    frameworks: "Frameworks",
    manifests: "Manifests",
    files: "Files",
    path: "Path",
    evidence: "Evidence",
    type: "Type",
    constraints: "Constraints",
    sources: "Sources",
    documented: "Documented",
    fallback: "Read with fallback",
    target: "Target",
    count: "Count",
    question: "Question",
    suggestion: "Suggestion",
    improves: "Would improve",
  },
  yes: "yes",
  no: "no",
  sections: {
    summary: "Summary",
    evidenceProfile: "Evidence profile",
    cannotEstablish: "What this analysis cannot establish",
    boundaries: "Boundaries",
    keyWorkflows: "Key workflows",
    completeness: "Completeness",
    limitations: "Limitations",
    highRiskUnknowns: "High-risk unknowns",
    actors: "Actors and roles",
    applications: "Applications",
    externalServices: "External services",
    trustBoundaries: "Trust boundaries",
    modules: "Modules",
    dependencies: "Dependencies between boundaries",
    deployment: "Deployment units",
    diagram: "Diagram",
    stack: "Languages and frameworks",
    entryPoints: "Entry points",
    commands: "Build and test commands",
    excluded: "Generated, vendored and excluded files",
    coverage: "Coverage",
    byCategory: "Workflows by category",
    steps: "Steps",
    branches: "Branches",
    unresolvedHops: "Unresolved hops",
    traces: "Component traces",
    tests: "Tests",
    pages: "Pages",
    forms: "Forms and fields",
    navigation: "Navigation",
    rules: "Business rules",
    states: "State machines",
    transitions: "Transitions",
    invalidTransitions: "Known invalid transitions",
    endpoints: "Endpoints",
    errors: "Error responses",
    tables: "Tables",
    columns: "Columns",
    entities: "Domain entities",
    queries: "Reads and writes",
    roles: "Roles and permissions",
    checks: "Checks",
    integrations: "Integrations",
    topics: "Topics",
    keys: "Configuration keys",
    units: "Deployment units",
    secrets: "Secret references",
    testModules: "Test definitions",
    untested: "Rules without a test definition",
    cycles: "Import cycles",
    hotspots: "Most imported modules",
    projects: "Boundary dependencies",
    contradictions: "Contradictions",
    dynamic: "Dynamic and unsupported constructs",
    adapters: "Unavailable analyzers",
    inferred: "Inferred records",
    questions: "Open questions",
    missingSources: "Missing repositories and services",
    suggestions: "Evidence that would improve the analysis",
  },
  text: {
    evidenceProfile: "Source analysis: available. Runtime observation: not available. Requirements: not provided.",
    cannotEstablish:
      "Runtime and production behavior, the deployed configuration, what external providers do with requests, and anything outside the examined scope.",
    observedBehavior:
      "Runtime observation is produced by QAA (Mode B or C); this source-analysis package contains none (CON-025).",
    notExecuted: "Commands are recorded as text; none was executed.",
    valuesRedacted: "Values are never recorded; only names.",
    noOwners: "Owners: not provided.",
    testsNotRun: "Execution status: tests were not run; test definitions show intent, not results.",
    noChangeEvidence: "Change frequency: Git history was not analyzed in this run.",
    sensitivity: "Column contents were not read; sensitivity is not assessed beyond names.",
    countsInScope: (kind, n) => `${n} ${kind} within the examined scope.`,
    notDeepened: "not deepened",
    responsibility: (e, r, w, rd) =>
      `Inferred from code: exposes ${e} endpoint(s), renders ${r} page(s), writes ${w} and reads ${rd} entity type(s).`,
  },
};

const ID: Messages = {
  titles: {
    executive_summary: "Ringkasan eksekutif",
    system_context: "Konteks sistem",
    architecture: "Arsitektur",
    project_inventory: "Inventaris proyek",
    components: "Komponen",
    workflow_catalog: "Katalog alur kerja",
    workflows: "Alur kerja",
    routes_and_pages: "Rute, halaman, dan formulir",
    business_rules: "Aturan bisnis dan status",
    observed_behavior: "Perilaku teramati",
    api_contracts: "Kontrak API",
    data_model: "Model data",
    roles_and_permissions: "Autentikasi dan otorisasi",
    integrations_events: "Integrasi dan event",
    configuration_deployment: "Konfigurasi dan deployment",
    tests_coverage: "Pengujian dan cakupan kualitas",
    dependencies_impact: "Dependensi dan dampak",
    risks_contradictions: "Risiko dan kontradiksi",
    unknowns: "Hal yang belum diketahui dan investigasi berikutnya",
  },
  workflowTitle: (name) => `Alur kerja: ${name}`,
  header: { revision: "Revisi", analyzed: "dianalisis", profile: "profil", language: "bahasa", run: "run" },
  scope: (a, p, u) =>
    `Jumlah dihitung dalam lingkup yang diperiksa. Cakupan: ${a} dianalisis, ${p} dianalisis sebagian, ${u} tidak didukung.`,
  machineText: "teks mesin, en",
  none: "Tidak ditemukan dalam lingkup yang diperiksa.",
  notAnalyzed: "Tidak dianalisis pada run ini; lihat gap di bawah.",
  gapsHere: "Gap",
  columns: {
    id: "ID",
    name: "Nama",
    kind: "Jenis",
    status: "Status",
    category: "Kategori",
    entry: "Titik masuk",
    discovery: "Penemuan",
    completion: "Kelengkapan",
    unresolved: "Belum terselesaikan",
    deepened: "Didalami",
    rank: "Peringkat",
    step: "Langkah",
    action: "Aksi",
    reads: "Membaca",
    writes: "Menulis",
    effects: "Efek samping",
    validations: "Validasi",
    from: "Dari",
    condition: "Kondisi",
    outcome: "Hasil",
    reason: "Alasan",
    statement: "Pernyataan",
    technical: "Aturan teknis",
    inputs: "Masukan",
    violation: "Jika dilanggar",
    boundary: "Batas proyek",
    languages: "Bahasa",
    frameworks: "Framework",
    manifests: "Manifest",
    files: "Berkas",
    path: "Path",
    evidence: "Bukti",
    type: "Tipe",
    constraints: "Batasan",
    sources: "Sumber",
    documented: "Didokumentasikan",
    fallback: "Dibaca dengan nilai cadangan",
    target: "Target",
    count: "Jumlah",
    question: "Pertanyaan",
    suggestion: "Saran",
    improves: "Akan memperbaiki",
  },
  yes: "ya",
  no: "tidak",
  sections: {
    summary: "Ringkasan",
    evidenceProfile: "Profil bukti",
    cannotEstablish: "Yang tidak dapat dipastikan oleh analisis ini",
    boundaries: "Batas proyek",
    keyWorkflows: "Alur kerja utama",
    completeness: "Kelengkapan",
    limitations: "Keterbatasan",
    highRiskUnknowns: "Hal belum diketahui berisiko tinggi",
    actors: "Aktor dan peran",
    applications: "Aplikasi",
    externalServices: "Layanan eksternal",
    trustBoundaries: "Batas kepercayaan",
    modules: "Modul",
    dependencies: "Dependensi antar-batas proyek",
    deployment: "Unit deployment",
    diagram: "Diagram",
    stack: "Bahasa dan framework",
    entryPoints: "Titik masuk",
    commands: "Perintah build dan test",
    excluded: "Berkas hasil generate, vendor, dan yang dikecualikan",
    coverage: "Cakupan",
    byCategory: "Alur kerja per kategori",
    steps: "Langkah",
    branches: "Cabang",
    unresolvedHops: "Lompatan yang belum terselesaikan",
    traces: "Jejak komponen",
    tests: "Pengujian",
    pages: "Halaman",
    forms: "Formulir dan field",
    navigation: "Navigasi",
    rules: "Aturan bisnis",
    states: "Mesin status",
    transitions: "Transisi",
    invalidTransitions: "Transisi tidak valid yang diketahui",
    endpoints: "Endpoint",
    errors: "Respons galat",
    tables: "Tabel",
    columns: "Kolom",
    entities: "Entitas domain",
    queries: "Pembacaan dan penulisan",
    roles: "Peran dan izin",
    checks: "Pemeriksaan",
    integrations: "Integrasi",
    topics: "Topik",
    keys: "Kunci konfigurasi",
    units: "Unit deployment",
    secrets: "Referensi rahasia",
    testModules: "Definisi pengujian",
    untested: "Aturan tanpa definisi pengujian",
    cycles: "Siklus import",
    hotspots: "Modul yang paling banyak diimpor",
    projects: "Dependensi batas proyek",
    contradictions: "Kontradiksi",
    dynamic: "Konstruksi dinamis dan tidak didukung",
    adapters: "Penganalisis yang tidak tersedia",
    inferred: "Rekaman hasil inferensi",
    questions: "Pertanyaan terbuka",
    missingSources: "Repositori dan layanan yang hilang",
    suggestions: "Bukti yang akan memperbaiki analisis",
  },
  text: {
    evidenceProfile: "Analisis sumber: tersedia. Observasi runtime: tidak tersedia. Kebutuhan: tidak disediakan.",
    cannotEstablish:
      "Perilaku runtime dan produksi, konfigurasi yang di-deploy, apa yang dilakukan penyedia eksternal terhadap permintaan, dan apa pun di luar lingkup yang diperiksa.",
    observedBehavior:
      "Observasi runtime dihasilkan oleh QAA (Mode B atau C); paket analisis sumber ini tidak memuatnya (CON-025).",
    notExecuted: "Perintah dicatat sebagai teks; tidak ada yang dijalankan.",
    valuesRedacted: "Nilai tidak pernah dicatat; hanya nama.",
    noOwners: "Pemilik: tidak disediakan.",
    testsNotRun: "Status eksekusi: pengujian tidak dijalankan; definisi pengujian menunjukkan maksud, bukan hasil.",
    noChangeEvidence: "Frekuensi perubahan: riwayat Git tidak dianalisis pada run ini.",
    sensitivity: "Isi kolom tidak dibaca; sensitivitas tidak dinilai di luar nama.",
    countsInScope: (kind, n) => `${n} ${kind} dalam lingkup yang diperiksa.`,
    notDeepened: "tidak didalami",
    responsibility: (e, r, w, rd) =>
      `Disimpulkan dari kode: mengekspos ${e} endpoint, merender ${r} halaman, menulis ${w} dan membaca ${rd} jenis entitas.`,
  },
};

export const MESSAGES: Record<DocLanguage, Messages> = { en: EN, id: ID };
