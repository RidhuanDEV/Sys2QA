import type { DiscoveryObservations, ObservedForm } from "../src/index.js";

/** Observations of a small site like F2: the input shared by the builder and package tests. */
export const O = "http://127.0.0.1:4100";
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
export const OBS: DiscoveryObservations = {
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
