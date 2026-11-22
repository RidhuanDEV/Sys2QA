import { describe, expect, it } from "vitest";
import { classifyForm, formKey, submissionDecision, type ObservedForm } from "../src/index.js";

const form = (over: Partial<ObservedForm>): ObservedForm => ({
  index: 0,
  page_url: "http://shop.test/catalog",
  method: "GET",
  action: "http://shop.test/search",
  fields: [{ name: "q", type: "search", label: "Search", required: false }],
  buttons: ["Search"],
  ...over,
});

const SEARCH = form({});
const LOGIN = form({
  action: "http://shop.test/login",
  method: "POST",
  fields: [
    { name: "email", type: "email", label: "Email", required: true },
    { name: "password", type: "password", label: "Password", required: true },
  ],
  buttons: ["Sign in"],
});
const DELETE = form({
  method: "POST",
  action: "http://shop.test/account/delete",
  fields: [],
  buttons: ["Delete account"],
});
const GET_DELETE = form({
  action: "http://shop.test/items",
  fields: [{ name: "id", type: "hidden", label: null, required: false }],
  buttons: ["Remove"],
});
const UNKNOWN = form({
  action: "http://shop.test/export",
  fields: [{ name: "format", type: "select", label: "Format", required: false }],
  buttons: ["Go"],
});
const SAFE_LABEL = form({
  action: "http://shop.test/export",
  fields: [{ name: "token", type: "text", label: null, required: false }],
  buttons: ["Search"],
});

describe("form classification proposes, never decides [@req SEC-024] [@req QAA-FR-025]", () => {
  it("names login, state-changing, read-only and unknown forms with their signals", () => {
    expect(classifyForm(LOGIN)).toEqual({ proposal: "login", signals: ["password field"] });
    expect(classifyForm(DELETE).proposal).toBe("state_changing");
    expect(classifyForm(DELETE).signals).toEqual(expect.arrayContaining(["method POST"]));
    expect(classifyForm(GET_DELETE).proposal).toBe("state_changing");
    expect(classifyForm(SEARCH).proposal).toBe("read_only");
    expect(classifyForm(UNKNOWN).proposal).toBe("unknown");
    expect(
      classifyForm(form({ fields: [{ name: "avatar", type: "file", label: null, required: false }] })).proposal,
    ).toBe("state_changing");
  });

  it("never takes a button label as evidence that a form is safe (OD-29)", () => {
    expect(classifyForm(SAFE_LABEL).proposal).toBe("unknown");
  });

  it("keys a form by page, method, target and field names, not by values or order", () => {
    const reordered = form({ fields: [...SEARCH.fields].reverse(), index: 3 });
    expect(formKey(reordered)).toBe(formKey(SEARCH));
    expect(formKey(form({ method: "POST" }))).not.toBe(formKey(SEARCH));
    expect(formKey(SEARCH)).toMatch(/^form:[0-9a-f]{24}$/);
  });

  it("submits only a confirmed read-only GET form under a declaration that allows read-only submissions", () => {
    const all = new Set([SEARCH, LOGIN, DELETE, GET_DELETE, UNKNOWN].map(formKey));
    const decide = (f: ObservedForm, declared: boolean, confirmed: Set<string>) =>
      submissionDecision(f, { readOnlySubmissionsDeclared: declared, confirmedReadOnly: confirmed }).submit;
    expect(decide(SEARCH, false, all)).toBe(false);
    expect(decide(SEARCH, true, new Set())).toBe(false);
    expect(decide(SEARCH, true, new Set([formKey(SEARCH)]))).toBe(true);
    for (const f of [LOGIN, DELETE, GET_DELETE]) expect(decide(f, true, all), f.action).toBe(false);
    // An unknown-effect GET form stays unsubmitted until a person confirms it; then the person's call decides.
    expect(decide(UNKNOWN, true, new Set([formKey(SEARCH)]))).toBe(false);
    expect(decide(UNKNOWN, true, new Set([formKey(UNKNOWN)]))).toBe(true);
  });
});
