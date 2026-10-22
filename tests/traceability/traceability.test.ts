import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  outcomesFromResults,
  parseContractRules,
  parseGateOwnership,
  parseRequirements,
  renderReport,
  scanTags,
} from "../../scripts/traceability.mjs";

const PRD = `
| ID | Requirement | Pri | St | Acceptance criteria | Source |
|---|---|:-:|:-:|---|---|
| SAA-FR-001 | Intake | P0 | C | x | y |
| SAA-FR-002 | Diff | P0 (propagation) / P1 (diff) | P | x | y |
| SAA-FR-003 | Old | — | W | — | — |

| ID | Requirement | Owner | Pri | St | Acceptance criteria | Source |
|---|---|---|:-:|:-:|---|---|
| SEC-001 | Sandbox | SAA | P1 | C | x | y |

| Source | Unified | Disposition |
|---|---|---|
| FR-003 | QAA-FR-003 | Modified |
`;
// Built from parts so that the tag scanner does not read these sample titles as tags of this file.
const tag = (id: string) => `[@${"req"} ${id}]`;
const PLAN = `
### Gate 0 — Foundation
| ID | Task | Reqs | Deps | Done when | Status |
|---|---|---|---|---|---|
| IMP-001 | Scaffold | SEC-001 | — | x | done |
### Gate 1 — Repo
| IMP-101 | Intake | SAA-FR-001, SEC-001 | IMP-001 | x | todo |
### Release candidate
| IMP-901 | Release | SAA-FR-002 | — | x | todo |
`;

describe("traceability tooling", () => {
  it("parses requirement tables, skips withdrawn and mapping rows, and takes the strictest priority", () => {
    const reqs = parseRequirements(PRD);
    expect([...reqs.keys()]).toEqual(["SAA-FR-001", "SAA-FR-002", "SEC-001"]);
    expect(reqs.get("SAA-FR-002")?.priority).toBe("P0");
    expect(reqs.get("SEC-001")?.priority).toBe("P1");
  });

  it("assigns each requirement to the earliest gate that lists it", () => {
    const owner = parseGateOwnership(PLAN);
    expect(owner.get("SEC-001")?.label).toBe("Gate 0");
    expect(owner.get("SAA-FR-001")?.label).toBe("Gate 1");
    expect(owner.get("SAA-FR-002")?.label).toBe("Release candidate");
  });

  it("counts a requirement as covered only by a passing test, with tags on describe blocks or tests", () => {
    const outcomes = outcomesFromResults({
      testResults: [
        {
          assertionResults: [
            { ancestorTitles: [`intake ${tag("SAA-FR-001")}`], title: "works", status: "passed" },
            { ancestorTitles: [], title: `diff ${tag("SAA-FR-002")}`, status: "failed" },
          ],
        },
      ],
    });
    const report = buildReport({
      requirements: parseRequirements(PRD),
      contractRules: new Set(["CR-001"]),
      gateOwner: parseGateOwnership(PLAN),
      tags: [
        { id: "SAA-FR-001", file: "a.test.ts", line: 1 },
        { id: "SAA-FR-002", file: "a.test.ts", line: 2 },
        { id: "CR-001", file: "a.test.ts", line: 3 },
        { id: "SAA-FR-999", file: "a.test.ts", line: 4 },
      ],
      outcomes,
    });
    expect(report.unknownTags).toEqual([{ id: "SAA-FR-999", file: "a.test.ts", line: 4 }]);
    expect(report.blockers.map((r) => r.id)).toEqual(["SAA-FR-002"]);
    const text = renderReport(report, "2026-10-22T00:00:00Z");
    expect(text).toContain("### Release candidate (1)");
    expect(text).toContain("SAA-FR-002 (tagged, not passing)");
    expect(text).toContain("| SAA-FR-002 | P0 | Release candidate | 0 passed, 1 failed |");
  });

  it("without results, nothing counts as covered", () => {
    const report = buildReport({
      requirements: parseRequirements(PRD),
      contractRules: new Set(),
      gateOwner: parseGateOwnership(PLAN),
      tags: [{ id: "SAA-FR-001", file: "a.test.ts", line: 1 }],
      outcomes: undefined,
    });
    expect(report.blockers.map((r) => r.id).sort()).toEqual(["SAA-FR-001", "SAA-FR-002"]);
    expect(renderReport(report, "t")).toContain("tagged, not run");
  });
});

describe("traceability of this repository", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const requirements = parseRequirements(read("docs/PRD.md"));
  const rules = parseContractRules(read("docs/02-contracts/contract-specification.md"));

  it("finds the PRD requirements and the contract rules", () => {
    expect(requirements.size).toBeGreaterThan(200);
    expect(rules.has("CR-001")).toBe(true);
    expect(rules.has("CR-070")).toBe(true);
  });

  it("every P0 requirement is owned by a task in the implementation plan", () => {
    const owner = parseGateOwnership(read("docs/00-project/implementation-plan.md"));
    const unowned = [...requirements.values()].filter((r) => r.priority === "P0" && !owner.has(r.id)).map((r) => r.id);
    expect(unowned).toEqual([]);
  });

  it("every test tag references a known requirement or contract rule", () => {
    const tags = scanTags(process.cwd(), ["apps", "packages", "tests"]);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((t) => !requirements.has(t.id) && !rules.has(t.id))).toEqual([]);
  });
});
