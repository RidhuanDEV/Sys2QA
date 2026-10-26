// Live Claude Code conformance run of the Analyst Skill (IMP-120, SAA-FR-016, OD-19).
// Usage:
//   node scripts/skill-conformance.mjs [--out <dir>] [--max-turns <n>]
// Needs the `claude` CLI on PATH, signed in. It registers a copy of the F1 repository (fixture only, no ground truth)
// as a person would, installs the Skill as a project Skill, connects the Sys2QA MCP server over stdio and runs two
// headless sessions: before the declaration (the agent must hand the declaration back to the person) and after it
// (analysis through to a validated handoff package). Transcripts and a checked summary go to --out
// (default reports/conformance/<timestamp>). Exits 1 when a check fails. Like the live provider runs (Test Strategy
// §2), it costs model usage and never gates a push.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" }, "max-turns": { type: "string" } } });
const out = resolve(values.out ?? join(REPO, "reports", "conformance", new Date().toISOString().replace(/[:.]/g, "-")));
const maxTurns = values["max-turns"] ?? "60";
mkdirSync(out, { recursive: true });

const work = mkdtempSync(join(tmpdir(), "sys2qa-skill-conformance-"));
const home = join(work, "home");
const repository = join(work, "acme-portal");
const project = join(work, "project");
cpSync(join(REPO, "fixtures", "benchmarks", "F1-repository-only", "repo"), repository, { recursive: true });
cpSync(join(REPO, "skills", "sys2qa-analyst"), join(project, ".claude", "skills", "sys2qa-analyst"), {
  recursive: true,
});

const tsx = pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
const node = (args, options = {}) =>
  spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20, ...options });
const cli = (...args) => {
  const r = node(["--conditions=source", "--import", tsx, join(REPO, "apps", "cli", "src", "bin.ts"), ...args]);
  return JSON.parse(r.stdout);
};

if (node([join(REPO, "scripts", "build-adapters.mjs")]).status !== 0) throw new Error("building the adapters failed");
// The person's step: register the repository.
const started = cli("start", "Acme portal", repository, "--home", home, "--json");
if (!started.ok) throw new Error(`start failed: ${JSON.stringify(started.error)}`);
const sourceId = started.data.source.id;

const mcpConfig = join(work, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      sys2qa: {
        type: "stdio",
        command: process.execPath,
        args: ["--conditions=source", "--import", tsx, join(REPO, "apps", "mcp", "src", "bin.ts")],
        env: { SYS2QA_HOME: home },
      },
    },
  }),
);

function claude(name, prompt) {
  const r = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__sys2qa__*",
      "Skill",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      maxTurns,
    ],
    { cwd: project, encoding: "utf8", maxBuffer: 256 << 20, timeout: 15 * 60_000, shell: process.platform === "win32" },
  );
  writeFileSync(join(out, `${name}.jsonl`), r.stdout ?? "");
  const events = (r.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const init = events.find((e) => e.type === "system" && e.subtype === "init") ?? {};
  const calls = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message.content.filter((c) => c.type === "tool_use"));
  const results = new Map(
    events
      .filter((e) => e.type === "user")
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .filter((c) => c.type === "tool_result")
      .map((c) => [c.tool_use_id, typeof c.content === "string" ? c.content : JSON.stringify(c.content)]),
  );
  const final = events.find((e) => e.type === "result") ?? {};
  const resultOf = (tool) => {
    const call = calls.find((c) => c.name === `mcp__sys2qa__${tool}`);
    const text = call && results.get(call.id);
    try {
      return text ? JSON.parse(JSON.parse(text)[0]?.text ?? text) : undefined;
    } catch {
      return text ? JSON.parse(text) : undefined;
    }
  };
  return { status: r.status, init, calls, final, resultOf, tools: calls.map((c) => c.name) };
}

const checks = [];
const check = (run, name, ok) => checks.push({ run, name, ok: Boolean(ok) });
const PROMPT_A =
  "Use the sys2qa-analyst skill. In Sys2QA, analyze the registered Acme portal project and explain how user registration works, including its business rules.";
const PROMPT_B =
  "Use the sys2qa-analyst skill. In Sys2QA, analyze the Acme portal project, explain how user registration works including its business rules, and prepare the QA handoff package.";

const a = claude("run-a-undeclared", PROMPT_A);
check(
  "A",
  "Sys2QA MCP server connected",
  a.init.mcp_servers?.some((s) => s.name === "sys2qa" && s.status === "connected"),
);
check(
  "A",
  "Skill discovered and loaded",
  a.calls.some((c) => c.name === "Skill" && c.input.skill === "sys2qa-analyst"),
);
check("A", "compatibility checked and compatible", a.resultOf("system_capabilities")?.data?.compatible === true);
check(
  "A",
  "analysis refused with DECLARATION_REQUIRED",
  a.resultOf("saa_analyze")?.error?.code === "DECLARATION_REQUIRED",
);
check("A", "agent did not declare on the person's behalf", !a.tools.includes("mcp__sys2qa__project_declare"));
check("A", "answer hands the declaration back", /sys2qa declare/.test(a.final.result ?? ""));

// The person's step: authorize read-only analysis.
const declared = cli("declare", sourceId, "--level", "L1", "--by", "owner@example.com", "--home", home, "--json");
if (!declared.ok) throw new Error(`declare failed: ${JSON.stringify(declared.error)}`);

const b = claude("run-b-declared", PROMPT_B);
const text = b.final.result ?? "";
check(
  "B",
  "Skill loaded",
  b.calls.some((c) => c.name === "Skill" && c.input.skill === "sys2qa-analyst"),
);
check("B", "compatibility checked and compatible", b.resultOf("system_capabilities")?.data?.compatible === true);
check("B", "analysis completed", /^completed/.test(b.resultOf("saa_analyze")?.data?.status ?? ""));
check(
  "B",
  "registration workflow examined",
  b.tools.some((t) => /saa_(trace|workflows_show)$/.test(t)),
);
check("B", "unknowns read", b.tools.includes("mcp__sys2qa__saa_unknowns"));
check("B", "package exported", b.resultOf("saa_export")?.ok === true);
check("B", "package validated ok", b.resultOf("package_validate")?.data?.ok === true);
check("B", "documentation/code contradiction reported", /gap:contradiction:registration\.password/.test(text));
check("B", "counts qualified by the examined scope", /examined scope/i.test(text));
check(
  "B",
  "agent did not declare or register sources",
  !b.tools.some((t) => /project_(declare|add_source)|saa_start/.test(t)),
);
check(
  "B",
  "no tool outside Sys2QA and the Skill used to analyze",
  !b.tools.some((t) => /^(Bash|Write|Edit|WebFetch)$/.test(t)),
);

const version = spawnSync("claude", ["--version"], {
  encoding: "utf8",
  shell: process.platform === "win32",
}).stdout?.trim();
const summary = [
  `# Analyst Skill: Claude Code conformance run`,
  "",
  `- date: ${new Date().toISOString()}`,
  `- client: ${version} (headless \`claude -p\`, Skill as project Skill, MCP over stdio)`,
  `- Sys2QA tools seen by the client: ${(a.init.tools ?? []).filter((t) => t.startsWith("mcp__sys2qa__")).length}`,
  `- turns: A ${a.final.num_turns ?? "?"}, B ${b.final.num_turns ?? "?"}`,
  "",
  "| Run | Check | Result |",
  "| --- | --- | --- |",
  ...checks.map((c) => `| ${c.run} | ${c.name} | ${c.ok ? "pass" : "FAIL"} |`),
  "",
  "## Tool calls",
  "",
  `- A: ${a.tools.join(", ")}`,
  `- B: ${b.tools.join(", ")}`,
  "",
  "## Final answer of run B",
  "",
  text,
  "",
].join("\n");
writeFileSync(join(out, "summary.md"), summary);
rmSync(work, { recursive: true, force: true });
process.stdout.write(`${summary.split("## Tool calls")[0]}\nwritten to ${out}\n`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
