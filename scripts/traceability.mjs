// Traceability report (Test Strategy §1, IMP-017): PRD requirement IDs ↔ `[@req ID]` test tags.
// Usage:
//   node scripts/traceability.mjs [--results <vitest-json>] [--out <file>]
// Writes the report (default reports/traceability.md). Exits 1 when a tag references an unknown ID.
// With --results (Vitest JSON reporter output) a requirement counts as covered only by passing tests;
// without it, tagged tests are listed as "not run".
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIREMENT_ID = /^[A-Z]+(?:-[A-Z]+)?-\d{3}$/;
const TAG = /\[@req ([^\]]+)\]/g;
const TEST_FILE = /\.test\.(?:ts|tsx|mts|js|mjs)$/;

/** Requirements whose acceptance may rest on manual evidence only (Test Strategy §8). */
export const MANUAL_EVIDENCE = {
  "NFR-009": "web UI usability checks (also has automated a11y checks)",
  "LOC-002": "localization quality review for id",
};

function tableRows(markdown) {
  const tables = [];
  let header = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (header === null) {
      header = cells;
      tables.push({ header, rows: [] });
    } else if (!/^[\s|:-]+$/.test(line)) {
      tables.at(-1).rows.push(cells);
    }
  }
  return tables;
}

/** PRD requirements: rows of tables headed `ID | Requirement | … | Pri | St | …`. Withdrawn rows (St = W) are skipped. */
export function parseRequirements(prd) {
  const requirements = new Map();
  for (const { header, rows } of tableRows(prd)) {
    if (header[0] !== "ID" || header[1] !== "Requirement") continue;
    const pri = header.indexOf("Pri");
    const st = header.indexOf("St");
    if (pri < 0 || st < 0) continue;
    for (const cells of rows) {
      const id = cells[0];
      if (!REQUIREMENT_ID.test(id) || /^W\b/.test(cells[st] ?? "")) continue;
      // "P0 (propagation) / P1 (diff)" counts as P0: the strictest part decides.
      const priorities = [...(cells[pri] ?? "").matchAll(/P([0-2])/g)].map((m) => Number(m[1]));
      requirements.set(id, {
        id,
        priority: priorities.length ? `P${Math.min(...priorities)}` : "P?",
        status: cells[st],
      });
    }
  }
  return requirements;
}

/** Contract rule IDs (CR-xxx) from Contract Specification §8; tests may tag them like requirements. */
export function parseContractRules(spec) {
  return new Set([...spec.matchAll(/^\| \*{0,2}(CR-\d{3})\*{0,2} \|/gm)].map((m) => m[1]));
}

/** Earliest gate whose backlog lists the requirement (Implementation Plan §4). */
export function parseGateOwnership(plan) {
  const owner = new Map();
  let gate = null;
  let order = 0;
  for (const line of plan.split(/\r?\n/)) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      const g = /^Gate (\d+)/.exec(heading[1]);
      gate = g ? { label: `Gate ${g[1]}`, order: Number(g[1]) } : { label: heading[1].trim(), order: 100 + order++ };
      continue;
    }
    if (!gate || !/^\| IMP-\d{3} \|/.test(line)) continue;
    const reqs = line.split("|")[3] ?? "";
    for (const id of reqs.match(/[A-Z]+(?:-[A-Z]+)?-\d{3}/g) ?? []) {
      const current = owner.get(id);
      if (!current || gate.order < current.order) owner.set(id, gate);
    }
  }
  return owner;
}

/** Every `[@req ID]` occurrence in test files under the given roots. */
export function scanTags(repoRoot, roots) {
  const tags = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (TEST_FILE.test(name)) {
        readFileSync(path, "utf8")
          .split(/\r?\n/)
          .forEach((text, i) => {
            for (const m of text.matchAll(TAG))
              tags.push({ id: m[1].trim(), file: relative(repoRoot, path).split("\\").join("/"), line: i + 1 });
          });
      }
    }
  };
  for (const root of roots) {
    try {
      walk(join(repoRoot, root));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return tags;
}

/** Test outcomes per tagged ID from Vitest's JSON reporter (tags may sit on a describe block or on the test). */
export function outcomesFromResults(results) {
  const outcomes = new Map();
  for (const file of results.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      const name = [...(test.ancestorTitles ?? []), test.title].join(" ");
      for (const m of name.matchAll(TAG)) {
        const id = m[1].trim();
        const o = outcomes.get(id) ?? { passed: 0, failed: 0, skipped: 0 };
        if (test.status === "passed") o.passed++;
        else if (test.status === "failed") o.failed++;
        else o.skipped++;
        outcomes.set(id, o);
      }
    }
  }
  return outcomes;
}

export function buildReport({ requirements, contractRules, gateOwner, tags, outcomes }) {
  const unknownTags = tags.filter((t) => !requirements.has(t.id) && !contractRules.has(t.id));
  const taggedIds = new Set(tags.map((t) => t.id));
  const covered = (id) => (outcomes ? (outcomes.get(id)?.passed ?? 0) > 0 : false);
  const rows = [...requirements.values()].map((r) => ({
    ...r,
    gate: gateOwner.get(r.id)?.label ?? "unassigned",
    gateOrder: gateOwner.get(r.id)?.order ?? 1000,
    tagged: taggedIds.has(r.id),
    outcome: outcomes?.get(r.id),
    covered: covered(r.id),
    manual: MANUAL_EVIDENCE[r.id],
  }));
  const blockers = rows.filter((r) => r.priority === "P0" && !r.covered && !r.manual);
  return { rows, unknownTags, blockers, resultsUsed: outcomes !== undefined };
}

export function renderReport(report, generatedAt) {
  const { rows, unknownTags, blockers, resultsUsed } = report;
  const lines = [];
  const p0 = rows.filter((r) => r.priority === "P0");
  lines.push("# Traceability report", "");
  lines.push(`Generated by \`pnpm trace\` (IMP-017) at ${generatedAt}. Do not edit by hand (Test Strategy §1).`, "");
  if (!resultsUsed)
    lines.push(
      '> Test results were not supplied, so no requirement counts as covered; tagged tests are listed as "not run".',
      "",
    );
  lines.push("| Measure | Count |", "|---|--:|");
  lines.push(`| Requirements (not withdrawn) | ${rows.length} |`);
  lines.push(`| P0 requirements | ${p0.length} |`);
  lines.push(`| P0 covered by a passing tagged test | ${p0.filter((r) => r.covered).length} |`);
  lines.push(`| P0 without a passing tagged test (gate blockers) | ${blockers.length} |`);
  lines.push(`| Unknown tags | ${unknownTags.length} |`, "");

  lines.push("## Unknown tags", "");
  if (unknownTags.length === 0) lines.push("None.", "");
  else {
    lines.push("| Tag | Location |", "|---|---|");
    for (const t of unknownTags) lines.push(`| \`${t.id}\` | ${t.file}:${t.line} |`);
    lines.push("");
  }

  lines.push("## P0 requirements without a passing tagged test, by owning gate", "");
  const byGate = new Map();
  for (const r of blockers.sort((a, b) => a.gateOrder - b.gateOrder || a.id.localeCompare(b.id))) {
    byGate.set(r.gate, [...(byGate.get(r.gate) ?? []), r]);
  }
  if (byGate.size === 0) lines.push("None.", "");
  for (const [gate, list] of byGate) {
    lines.push(
      `### ${gate} (${list.length})`,
      "",
      list.map((r) => `${r.id}${r.tagged ? " (tagged, not passing)" : ""}`).join(", "),
      "",
    );
  }

  lines.push("## Manual acceptance evidence (Test Strategy §8)", "");
  lines.push("| Requirement | Evidence | Automated test passing |", "|---|---|:-:|");
  for (const r of rows.filter((x) => x.manual)) lines.push(`| ${r.id} | ${r.manual} | ${r.covered ? "yes" : "no"} |`);
  lines.push("");

  lines.push("## All requirements", "");
  lines.push("| Requirement | Priority | Gate | Tests |", "|---|:-:|---|---|");
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const tests = r.outcome
      ? `${r.outcome.passed} passed${r.outcome.failed ? `, ${r.outcome.failed} failed` : ""}${r.outcome.skipped ? `, ${r.outcome.skipped} skipped` : ""}`
      : r.tagged
        ? "tagged, not run"
        : "—";
    lines.push(`| ${r.id} | ${r.priority} | ${r.gate} | ${tests} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function main(argv) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const resultsPath = arg("--results");
  const out = resolve(repoRoot, arg("--out") ?? "reports/traceability.md");
  const read = (p) => readFileSync(join(repoRoot, p), "utf8");
  const report = buildReport({
    requirements: parseRequirements(read("docs/PRD.md")),
    contractRules: parseContractRules(read("docs/02-contracts/contract-specification.md")),
    gateOwner: parseGateOwnership(read("docs/00-project/implementation-plan.md")),
    tags: scanTags(repoRoot, ["apps", "packages", "tests"]),
    outcomes: resultsPath
      ? outcomesFromResults(JSON.parse(readFileSync(resolve(repoRoot, resultsPath), "utf8")))
      : undefined,
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReport(report, new Date().toISOString()));
  const p0 = report.rows.filter((r) => r.priority === "P0");
  const coveredP0 = p0.filter((r) => r.covered).length;
  console.log(
    `Traceability: ${report.rows.length} requirements, ${coveredP0}/${p0.length} P0 with a passing tagged test${report.resultsUsed ? "" : " (no results supplied)"}, ${report.unknownTags.length} unknown tags → ${relative(repoRoot, out)}`,
  );
  for (const t of report.unknownTags) console.error(`Unknown requirement tag ${t.id} at ${t.file}:${t.line}`);
  return report.unknownTags.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
