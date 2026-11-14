import { describe, expect, it } from "vitest";
import { staleness, type PackageDiff } from "../src/index.js";

const diff = (over: Partial<PackageDiff> = {}): PackageDiff => ({
  added: [],
  changed: [],
  removed: [],
  contradicted: [],
  renamed: [],
  ...over,
});

describe("staleness rules of PRD §13.11 [@req QAA-FR-046] [@req CON-014]", () => {
  it("suspends everything as potentially stale when no diff is available", () => {
    expect(staleness(["api:x"], null)).toMatchObject({
      freshness: "potentially_stale",
      approval: "suspended",
      revalidatable: false,
    });
  });

  it("keeps a scenario current but suspended, and revalidatable, when its links are unchanged", () => {
    expect(staleness(["api:x"], diff({ changed: ["api:y"] }))).toMatchObject({
      freshness: "current",
      approval: "suspended",
      revalidatable: true,
    });
  });

  it("makes a changed link potentially stale and a removed or contradicted link stale", () => {
    expect(staleness(["api:x"], diff({ changed: ["api:x"] }))).toMatchObject({
      freshness: "potentially_stale",
      approval: "suspended",
    });
    expect(staleness(["api:x"], diff({ removed: ["api:x"] }))).toMatchObject({
      freshness: "stale",
      approval: "invalidated",
    });
    expect(staleness(["rule:x"], diff({ contradicted: ["rule:x"] }))).toMatchObject({
      freshness: "stale",
      approval: "invalidated",
    });
  });

  it("holds a rename with uncertain mapping until it is confirmed, and follows a confident one", () => {
    const low = diff({
      removed: ["page:a"],
      added: ["page:b"],
      renamed: [{ from: "page:a", to: "page:b", confidence: "low" }],
    });
    expect(staleness(["page:a"], low)).toMatchObject({
      freshness: "potentially_stale",
      approval: "suspended",
      revalidatable: false,
    });
    const high = diff({
      removed: ["page:a"],
      added: ["page:b"],
      renamed: [{ from: "page:a", to: "page:b", confidence: "high" }],
    });
    expect(staleness(["page:a"], high)).toMatchObject({ freshness: "current", revalidatable: true });
  });
});
