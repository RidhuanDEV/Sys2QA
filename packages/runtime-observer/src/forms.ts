import { createHash } from "node:crypto";

/** A form as the browser shows it: what discovery may inspect without submitting anything (PRD §21.4). */
export interface ObservedForm {
  /** Position on the page, for the worker to act on. */
  index: number;
  /** The form's `id` attribute, when it has one. */
  dom_id?: string | null;
  page_url: string;
  method: string;
  /** Scheme, host and path the form submits to; no query string. */
  action: string;
  fields: Array<{
    name: string;
    type: string;
    label: string | null;
    required: boolean;
    /** Constraint attributes as the page sets them (maxlength, minlength, pattern, min, max, inputmode, step). */
    constraints?: Record<string, string>;
  }>;
  buttons: string[];
  /** Hint texts inside the form (page text: data, never instructions). */
  hints?: string[];
}

export type FormProposal = "read_only" | "login" | "state_changing" | "unknown";

export interface FormClassification {
  proposal: FormProposal;
  /** Why: the signals the heuristics saw. */
  signals: string[];
}

const SEARCH_FIELDS =
  /^(q|query|search|s|keyword|keywords|term|filter|filters|sort|order|orderby|page|per_page|limit|category|tag|from|to)$/i;
const DESTRUCTIVE_WORDS =
  /\b(delete|remove|destroy|erase|drop|cancel|invite|send|pay|purchase|buy|order|checkout|transfer|subscribe|unsubscribe|approve|reject|reset|register|sign ?up|create|save|update|confirm)\b|hapus|kirim|bayar|undang|daftar|simpan/i;

/**
 * Proposes what a form does (OD-29): heuristics only propose, a person confirms each form on first use. A password
 * field is a login; a method other than GET, a file input or a destructive word changes state; a GET form whose fields
 * are all search, filter, sort or paging fields may be read-only. Button labels alone never make a form read-only:
 * they can only push it toward changing state.
 */
export function classifyForm(form: ObservedForm): FormClassification {
  const signals: string[] = [];
  const method = form.method.toUpperCase();
  // Search, filter, sort and paging field names ("order", "sort") are not taken as intentions.
  const words = [
    ...form.buttons,
    ...form.fields.map((f) => `${SEARCH_FIELDS.test(f.name) ? "" : f.name} ${f.label ?? ""}`),
    form.action,
  ];
  const destructive = words.find((w) => DESTRUCTIVE_WORDS.test(w));
  const stateWord = destructive ? `state-changing word in "${destructive.trim().slice(0, 60)}"` : null;
  if (form.fields.some((f) => f.type === "password"))
    // A password with a state-changing word (create account, register, reset) sets a credential rather than using one.
    return stateWord
      ? { proposal: "state_changing", signals: ["password field", stateWord] }
      : { proposal: "login", signals: ["password field"] };
  if (method !== "GET") signals.push(`method ${method}`);
  if (form.fields.some((f) => f.type === "file")) signals.push("file input");
  if (stateWord) signals.push(stateWord);
  if (signals.length > 0) return { proposal: "state_changing", signals };
  const named = form.fields.filter((f) => !["submit", "button", "reset", "hidden"].includes(f.type));
  if (named.length > 0 && named.every((f) => SEARCH_FIELDS.test(f.name)))
    return {
      proposal: "read_only",
      signals: [`GET with only search, filter, sort or paging fields (${named.map((f) => f.name).join(", ")})`],
    };
  return { proposal: "unknown", signals: ["no signal that the effect is read-only"] };
}

/** A stable identity for a form across visits: page, method, target and field names (not their values). */
export function formKey(form: ObservedForm): string {
  const page = new URL(form.page_url);
  const identity = [
    `${page.protocol}//${page.host}${page.pathname}`,
    form.method.toUpperCase(),
    form.action,
    [...form.fields.map((f) => `${f.name}:${f.type}`)].sort().join(","),
  ].join("|");
  return `form:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export interface SubmissionContext {
  /** The declaration allows read-only submissions (L2r, opt-in per declaration). */
  readOnlySubmissionsDeclared: boolean;
  /** Form keys a person confirmed as read-only. */
  confirmedReadOnly: ReadonlySet<string>;
}

export interface SubmissionDecision {
  form_key: string;
  submit: boolean;
  reason: string;
}

/**
 * Whether discovery may submit a form (SEC-024, PRD §21.4): never by default; only with read-only submissions
 * declared, a person's confirmation of this exact form as read-only, a GET method, and no login or state-changing
 * signal. Everything else stops for approval with what remains unknown.
 */
export function submissionDecision(form: ObservedForm, ctx: SubmissionContext): SubmissionDecision {
  const key = formKey(form);
  const { proposal } = classifyForm(form);
  const refuse = (reason: string) => ({ form_key: key, submit: false, reason });
  if (proposal === "login") return refuse("login forms are never submitted by discovery");
  if (proposal === "state_changing") return refuse("state-changing forms are submitted only as approved tests");
  if (form.method.toUpperCase() !== "GET") return refuse("only GET forms can be read-only submissions");
  if (!ctx.readOnlySubmissionsDeclared) return refuse("read-only submissions are not declared (L2r)");
  if (!ctx.confirmedReadOnly.has(key)) return refuse("no person confirmed this form as read-only");
  return { form_key: key, submit: true, reason: "confirmed read-only GET form" };
}
