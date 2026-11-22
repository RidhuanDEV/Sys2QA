import { describe, expect, it } from "vitest";
import { validateDocument } from "../../packages/contract/src/index.js";
import { correlatePackages, type CorrelationModel } from "../../packages/qaa-core/src/index.js";

const SOURCE: CorrelationModel = {
  entities: [
    { id: "page:web:/register", kind: "page", route_pattern: "/register" },
    { id: "page:web:/orders/{id}", kind: "page", route_pattern: "/orders/{id}" },
    { id: "page:web:/admin/users", kind: "page", route_pattern: "/admin/users" },
    { id: "page:web:/reports", kind: "page", route_pattern: "/reports" },
    { id: "form:web:/register#register", kind: "form", page_id: "page:web:/register" },
    {
      id: "field:web:/register#register.nib",
      kind: "field",
      form_id: "form:web:/register#register",
      constraints: { max_length: 13, pattern: "[0-9]{13}" },
    },
    {
      id: "field:web:/register#register.password",
      kind: "field",
      form_id: "form:web:/register#register",
      constraints: { min_length: 12 },
    },
    {
      id: "business_rule:registration.nib_13_digits",
      kind: "business_rule",
      inputs: ["field:web:/register#register.nib"],
      boundaries: [{ field: "nib", min_length: 13, max_length: 13, pattern: "/^[0-9]{13}$/" }],
    },
    { id: "api:GET:/api/admin/users", kind: "api" },
  ],
  relationships: [{ type: "CONSUMES", from: "page:web:/admin/users", to: "api:GET:/api/admin/users" }],
};

const OBSERVED: CorrelationModel = {
  entities: [
    { id: "page:observed:/register", kind: "page", route_pattern: "/register" },
    { id: "page:observed:/orders/7", kind: "page", route_pattern: "/orders/7" },
    { id: "page:observed:/promo", kind: "page", route_pattern: "/promo" },
    { id: "form:observed:/register#register", kind: "form", page_id: "page:observed:/register" },
    {
      id: "field:observed:/register#nib",
      kind: "field",
      form_id: "form:observed:/register#register",
      constraints: { required: true, max_length: 16, pattern: "^(?:[0-9]{16})$" },
    },
    {
      id: "field:observed:/register#password",
      kind: "field",
      form_id: "form:observed:/register#register",
      constraints: { min_length: 12 },
    },
  ],
  relationships: [],
  coverage: [{ area: "/admin/users", status: "failed", reason: "The page answered HTTP 404." }],
};

const correlate = (revision: "unconfirmed" | "user_confirmed" = "unconfirmed") =>
  correlatePackages({
    report_id: "correlation:01JTEST",
    generated_at: "2026-11-22T10:00:00Z",
    saa: { package_id: "pkg:acme", package_version: 1, model: SOURCE },
    qaa: { package_id: "pkg:acme-observed", package_version: 1, model: OBSERVED },
    revision_correspondence: revision,
  });

describe("source–runtime correlation [@req QAA-FR-115] [@req CON-026]", () => {
  const report = correlate();

  it("produces a valid correlation report that names only IDs of the two packages", () => {
    const result = validateDocument("correlation-report", report);
    expect(result.ok ? [] : result.issues).toEqual([]);
    const known = new Set([...SOURCE.entities, ...OBSERVED.entities].map((e) => e.id));
    const named = [
      ...report.links.flatMap((l) => [l.observed_id, l.source_id]),
      ...report.unmatched.observed,
      ...report.unmatched.source,
      ...report.discrepancies.flatMap((d) => [...d.observed_ids, ...d.source_ids]),
    ];
    expect(named.filter((id) => !known.has(id))).toEqual([]);
  });

  it("links pages by path or route pattern, forms by id and fields by name, each with a rationale", () => {
    expect(report.links.map((l) => [l.observed_id, l.source_id, l.confidence])).toEqual([
      ["page:observed:/register", "page:web:/register", "high"],
      ["page:observed:/orders/7", "page:web:/orders/{id}", "medium"],
      ["form:observed:/register#register", "form:web:/register#register", "high"],
      ["field:observed:/register#nib", "field:web:/register#register.nib", "high"],
      ["field:observed:/register#password", "field:web:/register#register.password", "high"],
    ]);
    expect(report.links.every((l) => l.rationale.length > 0)).toBe(true);
  });

  it("detects a constraint mismatch, a route the environment did not serve, and a page without a source route", () => {
    const byType = (type: string) => report.discrepancies.filter((d) => d.type === type);
    expect(byType("constraint_mismatch")).toEqual([
      expect.objectContaining({
        observed_ids: ["field:observed:/register#nib"],
        source_ids: ["business_rule:registration.nib_13_digits"],
      }),
    ]);
    expect(byType("constraint_mismatch")[0]!.description).toMatch(/max_length 16, pattern \[0-9\]\{16\}/);
    expect(byType("route_unreachable")).toEqual([
      expect.objectContaining({ source_ids: ["page:web:/admin/users", "api:GET:/api/admin/users"], observed_ids: [] }),
    ]);
    expect(byType("unmatched_page").map((d) => d.observed_ids)).toEqual([["page:observed:/promo"]]);
    // /reports was never tried, so it is unmatched, not unreachable; /promo gets no invented source.
    expect(report.unmatched.source).toEqual(["page:web:/admin/users", "page:web:/reports"]);
    expect(report.unmatched.observed).toEqual(["page:observed:/promo"]);
  });

  it("labels every discrepancy possibly version-related until a person confirms the revision", () => {
    expect(report.revision_correspondence).toBe("unconfirmed");
    expect(report.discrepancies.every((d) => d.possibly_version_related)).toBe(true);
    expect(correlate("user_confirmed").discrepancies.every((d) => !d.possibly_version_related)).toBe(true);
  });
});
