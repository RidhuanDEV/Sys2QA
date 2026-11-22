import { validateDocument } from "@sys2qa/contract";
import { describe, expect, it } from "vitest";
import { buildObservedModel, type DiscoveryObservations, type ObservedForm } from "../src/index.js";

const O = "http://127.0.0.1:4100";
const AT = "2026-11-22T10:00:01.000Z";
const page = (path: string, links: string[], extra: Record<string, unknown> = {}) => ({
  path,
  url: `${O}${path}`,
  status: 200,
  title: path,
  observed_at: AT,
  depth: path === "/" ? 0 : 1,
  source: "runtime_observation" as const,
  confidence: "observed" as const,
  links: links.map((l) => `${O}${l}`),
  ...extra,
});
const form = (path: string, over: Partial<ObservedForm>, submitted = false, decision = "not decided") => {
  const f: ObservedForm & { observed_at: string } = {
    index: 0,
    page_url: `${O}${path}`,
    method: "POST",
    action: `${O}${path}`,
    fields: [],
    buttons: [],
    observed_at: AT,
    ...over,
  };
  return {
    form_key: `form:${"0".repeat(20)}${path.length.toString(16).padStart(4, "0")}`,
    form: f,
    proposal: "",
    signals: [],
    submitted,
    decision,
  };
};

const NAV = ["/", "/products", "/contact", "/login", "/search", "/account/delete"];
const OBS: DiscoveryObservations = {
  schema: "sys2qa.discovery-observations/1",
  job_id: "job:01JTEST0000000000000000000",
  environment_id: "src:01JENV00000000000000000000",
  scope_policy_version: 1,
  base_url: `${O}/`,
  started_at: "2026-11-22T10:00:00.000Z",
  finished_at: "2026-11-22T10:01:00.000Z",
  status: "completed_with_limitations",
  login: null,
  budget: { pages: 50, depth: 6, ms: 120000, variants: 3, exhausted: null },
  pages: [
    page("/", NAV),
    page("/products", [...NAV, "/products/1", "/products/2"]),
    page("/products/1", NAV),
    page("/products/2", NAV),
    page("/contact", NAV),
    page("/login", NAV),
    page("/search", NAV),
    page("/account/delete", NAV),
    page("/calendar", NAV),
    page("/account", [], { redirected_to: `${O}/login`, observability: "auth_required" }),
  ],
  links_not_followed: [{ target: `${O}/out`, from: `${O}/partners`, reason: "redirect outside the scope, refused" }],
  traps: [{ path: "/calendar", reason: "more than 3 query variants of one path" }],
  forms: [
    form("/contact", {
      dom_id: "contact",
      fields: [
        { name: "email", type: "email", label: "Email", required: true, constraints: {} },
        // A page-chosen name that reads like an outcome must never become a sentence of a claim.
        {
          name: "account was deleted",
          type: "textarea",
          label: null,
          required: true,
          constraints: { maxlength: "500" },
        },
      ],
      buttons: ["Send"],
    }),
    form("/login", {
      dom_id: "login",
      fields: [
        { name: "email", type: "email", label: "Email", required: true },
        { name: "password", type: "password", label: "Password", required: true },
      ],
      buttons: ["Log in"],
    }),
    form(
      "/search",
      {
        dom_id: "search",
        method: "GET",
        fields: [{ name: "q", type: "text", label: "Query", required: false, constraints: { maxlength: "50" } }],
        buttons: ["Search"],
      },
      false,
      "read-only submissions are not declared (L2r)",
    ),
    form("/account/delete", {
      dom_id: "delete-account",
      fields: [{ name: "confirm", type: "checkbox", label: "I understand", required: true }],
      buttons: ["Delete my account"],
    }),
  ],
  submissions: [],
  blocked_requests: [],
  downloads_refused: [],
};

const built = buildObservedModel(OBS, { system_id: "system:test-site" });
const model = built.model as {
  entities: Array<{ id: string; kind: string; status: string; inputs?: string[]; gap_ids?: string[] }>;
  relationships: Array<{ type: string; from: string; to: string }>;
  workflows: Array<{
    id: string;
    discovery_status: string;
    entry_point_ids: string[];
    steps: Array<{ entity_id: string }>;
    unresolved_hops: Array<{ reason_code: string; gap_id?: string }>;
  }>;
  claims: Array<{ text: { value: string }; status: string }>;
  gaps: Array<{ id: string; type: string; related_entity_ids: string[] }>;
  coverage: Array<{ area: string; status: string }>;
};
const workflow = (entry: string, last: string) =>
  model.workflows.find(
    (w) => w.entry_point_ids[0] === `page:observed:${entry}` && w.steps[w.steps.length - 1]!.entity_id === last,
  );

describe("observed-model builder [@req QAA-FR-114] [@req CON-023]", () => {
  it("produces documents that pass the contract schemas", () => {
    for (const [name, doc] of [
      ["system-model", built.model],
      ["evidence-index", built.evidence_index],
      ["completeness-report", built.completeness],
    ] as const) {
      const result = validateDocument(name, doc);
      expect(result.ok ? [] : result.issues, name).toEqual([]);
    }
  });

  it("models pages, forms and fields as runtime_observed, with navigation and containment only (CR-002)", () => {
    expect(model.entities.every((e) => e.status === "runtime_observed")).toBe(true);
    expect(model.entities.filter((e) => e.kind === "page")).toHaveLength(10);
    expect(model.entities.map((e) => e.id)).toEqual(
      expect.arrayContaining(["form:observed:/contact#contact", "field:observed:/contact#account_was_deleted"]),
    );
    expect([...new Set(model.relationships.map((r) => r.type))].sort()).toEqual(["CONTAINS", "NAVIGATES_TO"]);
    expect(model.relationships).toContainEqual(
      expect.objectContaining({
        type: "NAVIGATES_TO",
        from: "page:observed:/products",
        to: "page:observed:/products/1",
      }),
    );
  });

  it("turns visible constraints into rules that name their inputs, and keeps page text out of claim sentences", () => {
    const rule = model.entities.find((e) => e.id === "business_rule:observed:/contact#account_was_deleted")!;
    expect(rule.inputs).toEqual(["field:observed:/contact#account_was_deleted"]);
    expect(model.claims.map((c) => c.text.value).join("\n")).not.toMatch(/account (is|was|has been) deleted/i);
    expect(model.claims.map((c) => c.text.value)).toContain(
      "In the browser, field account_was_deleted of form contact on /contact accepts at most 500 characters (maxlength).",
    );
  });

  it("builds the candidate workflow catalog with stop points where discovery may not continue", () => {
    const browse = workflow("/", "page:observed:/products/1")!;
    expect(browse.steps.map((s) => s.entity_id)).toEqual([
      "page:observed:/",
      "page:observed:/products",
      "page:observed:/products/1",
    ]);
    expect(browse.discovery_status).toBe("reconstructed");
    expect(workflow("/contact", "form:observed:/contact#contact")!.unresolved_hops).toEqual([
      expect.objectContaining({
        reason_code: "submission_requires_approval",
        gap_id: "gap:observed.form-effects-unknown",
      }),
    ]);
    expect(workflow("/login", "form:observed:/login#login")!.unresolved_hops[0]!.reason_code).toBe("auth_required");
    const gated = workflow("/account", "page:observed:/login")!;
    expect(gated.unresolved_hops).toEqual([
      expect.objectContaining({ reason_code: "auth_required", gap_id: "gap:observed.behind-login" }),
    ]);
    expect(built.summary.statement).toBe("10 pages and 6 candidate workflows observed within the declared scope.");
  });

  it("records what was not observed as gaps, coverage and a completeness report", () => {
    const gap = (key: string) => model.gaps.find((g) => g.id === `gap:observed.${key}`)!;
    expect(gap("behind-login").related_entity_ids.slice().sort()).toEqual([
      "form:observed:/login#login",
      "page:observed:/account",
    ]);
    expect(gap("destructive-form").related_entity_ids).toEqual(["form:observed:/account/delete#delete-account"]);
    expect(gap("form-effects-unknown").related_entity_ids.slice().sort()).toEqual([
      "form:observed:/contact#contact",
      "form:observed:/search#search",
    ]);
    expect(gap("crawler-trap").related_entity_ids).toEqual(["page:observed:/calendar"]);
    expect(gap("outside-scope").type).toBe("external_boundary");
    expect(model.gaps.filter((g) => g.id.endsWith("-unobservable"))).toHaveLength(4);
    expect(model.coverage).toEqual(
      expect.arrayContaining([
        { area: "/account", status: "skipped", reason: "Authentication required; no credential profile supplied." },
        expect.objectContaining({ area: "/calendar", status: "partial" }),
        expect.objectContaining({ area: `${O}/out`, status: "excluded" }),
      ]),
    );
    const c = built.completeness as {
      forms_not_submitted: Array<{ form_id: string; reason: string }>;
      unexplored: Array<{ area: string }>;
      count_scope: string;
    };
    expect(c.count_scope).toBe("within_examined_scope");
    expect(Object.fromEntries(c.forms_not_submitted.map((f) => [f.form_id, f.reason]))).toEqual({
      "form:observed:/contact#contact": "state_changing",
      "form:observed:/login#login": "login_form",
      "form:observed:/search#search": "read_only_not_enabled",
      "form:observed:/account/delete#delete-account": "state_changing",
    });
    expect(c.unexplored.map((u) => u.area)).toEqual(["/account"]);
  });

  it("is deterministic and marks a submitted read-only form's evidence as a read-only submission", () => {
    expect(buildObservedModel(OBS, { system_id: "system:test-site" })).toEqual(built);
    const submitted = buildObservedModel(
      { ...OBS, forms: OBS.forms.map((f) => (f.form.dom_id === "search" ? { ...f, submitted: true } : f)) },
      { system_id: "system:test-site" },
    );
    const evidence = (submitted.evidence_index as { evidence: Array<{ submission: string }> }).evidence;
    expect(evidence.filter((e) => e.submission === "read_only")).toHaveLength(1);
    const search = (submitted.model as typeof model).workflows.find((w) => w.id.includes("form.search"))!;
    expect(search.discovery_status).toBe("reconstructed");
  });
});
