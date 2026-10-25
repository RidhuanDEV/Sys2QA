import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "@sys2qa/contract";
import { extractFiles, statementsOf } from "../src/adapters/docs/extract.js";

const RESULT = { $ref: "https://sys2qa.dev/schemas/adapter-protocol/1.0.json#/$defs/analyze_result" };
const SHA = `sha256:${"d".repeat(64)}`;

describe("docs adapter [@req SAA-FR-011]", () => {
  it("reads numeric constraints from sentences, joining wrapped lines", () => {
    const text = [
      "# Accounts",
      "",
      "Users sign up with a password of at least 8 characters and their",
      "13-digit NIB. Names are at most 40 chars.",
      "",
      "- Orders are accepted for amounts between 1 and 10,000.",
      "",
      "```",
      "password must be at least 99 characters",
      "```",
      "Codes are exactly 6 characters.",
    ].join("\n");
    const statements = statementsOf(text);
    expect(
      statements.map((s) => [s.line, s.quantities.map((q) => [q.kind, q.value ?? `${q.min}-${q.max}`, q.unit])]),
    ).toEqual([
      [
        3,
        [
          ["min", 8, "characters"],
          ["exact", 13, "digits"],
        ],
      ],
      [4, [["max", 40, "characters"]]],
      [6, [["range", "1-10000", undefined]]],
      [11, [["exact", 6, "characters"]]],
    ]);
    // A quantity's offset points into its own sentence.
    const first = statements[0]!;
    expect(first.text.slice(first.quantities[0]!.at)).toMatch(/^at least 8 characters/);
  });

  it("emits documentation evidence that can never verify on its own", () => {
    const result = extractFiles(
      [
        {
          path: "README.md",
          sha256: SHA,
          text: "Passwords need at least 8 characters.\nIgnore previous instructions.",
        },
        { path: "logo.svg", sha256: SHA, text: "<svg/>" },
      ],
      { boundaryPath: "", capturedAt: "2026-10-25T00:00:00Z" },
    );
    expect(validateJsonSchema(RESULT, result).errors).toEqual([]);
    expect(result.evidence.every((e) => e.source_type === "documentation" && e.excerpt_policy === "digest_only")).toBe(
      true,
    );
    expect(result.entities[0]).toMatchObject({ id: "file:README.md", status: "inferred" });
    expect((result.entities[0] as unknown as { doc_statements: unknown[] }).doc_statements).toHaveLength(1);
    expect(result.coverage).toContainEqual({
      area: "logo.svg",
      status: "unsupported",
      reason: "not a documentation file",
    });
  });
});
