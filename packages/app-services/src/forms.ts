import { appendAudit } from "@sys2qa/platform";
import {
  classifyForm,
  formKey,
  runL2Job,
  submissionDecision,
  type FormClassification,
  type ObservedForm,
  type SubmissionDecision,
} from "@sys2qa/runtime-observer";
import { observation } from "./environments.js";
import { serviceError, ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const FORM_KEY = { type: "string", pattern: "^form:[0-9a-f]{24}$" } as const;

interface StoredForm {
  form: ObservedForm;
  classification: FormClassification;
}

/** The latest confirmation of each form of an environment. */
function confirmations(host: Host, environmentId: string): Map<string, { decision: string; by: string; at: string }> {
  const rows = host.state.db
    .prepare(
      "SELECT form_key, decision, confirmed_by, created_at FROM form_confirmations WHERE environment_id = ? ORDER BY created_at, rowid",
    )
    .all(environmentId) as Array<{ form_key: string; decision: string; confirmed_by: string; created_at: string }>;
  return new Map(rows.map((r) => [r.form_key, { decision: r.decision, by: r.confirmed_by, at: r.created_at }]));
}

/** What remains unknown about a form that discovery did not submit (SEC-024: shown in the UI and report). */
const unknownOf = (form: ObservedForm, decision: SubmissionDecision) =>
  `The effect of submitting ${form.method} ${form.action} (fields: ${form.fields.map((f) => f.name).join(", ") || "none"}) was not observed: ${decision.reason}.`;

const view = (key: string, stored: StoredForm, confirmation?: { decision: string; by: string; at: string }) => ({
  form_key: key,
  page_url: stored.form.page_url,
  method: stored.form.method,
  action: stored.form.action,
  fields: stored.form.fields,
  buttons: stored.form.buttons,
  proposal: stored.classification.proposal,
  signals: stored.classification.signals,
  confirmation: confirmation ?? null,
});

const formsInspect = defineOperation<{ source_id: string; url?: string }, unknown>({
  name: "forms.inspect",
  title: "Inspect the forms of a page",
  description:
    "Opens one in-scope page in an L2 browser worker and reads its forms (fields, labels, buttons, method and target), proposing what each does: login, state-changing, read-only or unknown (OD-29: heuristics only propose; button labels never make a form safe). By default nothing is submitted (SEC-024, QAA-FR-025). A form is submitted only when the declaration allows read-only submissions (L2r), a person confirmed that exact form as read-only, and it uses GET; login and state-changing forms never are. The browser lets no request other than GET or HEAD leave, and downloads are refused (SEC-019). Every form not submitted is listed with what remains unknown.",
  level: "L2",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id"],
    properties: { source_id: ID, url: { type: "string", minLength: 8, maxLength: 2048 } },
  },
  run: async ({ host, caller }, input) => {
    const { source, scope, jobId, proxy, target } = await observation(host, input.source_id, input.url);
    const readOnlyDeclared = host.projects.authorize(source.id, "submit_read_only_form", {
      kind: "url",
      url: target,
    }).allowed;
    const confirmed = confirmations(host, source.id);
    const confirmedReadOnly = new Set([...confirmed].filter(([, c]) => c.decision === "read_only").map(([k]) => k));
    const decisions = new Map<number, SubmissionDecision>();
    let result;
    try {
      result = await runL2Job({ action: "inspect", url: target, scope }, proxy, {
        budgetMs: 90_000,
        onForms: (forms) => {
          for (const form of forms)
            decisions.set(
              form.index,
              submissionDecision(form, { readOnlySubmissionsDeclared: readOnlyDeclared, confirmedReadOnly }),
            );
          return [...decisions].filter(([, d]) => d.submit).map(([index]) => index);
        },
      });
    } finally {
      await proxy.close();
    }
    if (result.error && !result.forms?.length)
      throw new ServiceError(
        "ENVIRONMENT_UNREACHABLE",
        "unavailable",
        `the page could not be inspected: ${result.error}`,
        "Check that the environment is up and the URL is in scope, then try again.",
      );
    const forms = result.forms ?? [];
    const at = host.now().toISOString();
    const submitted = new Set((result.submissions ?? []).map((s) => s.index));
    host.state.transaction(() => {
      const upsert = host.state.db.prepare(
        `INSERT INTO observed_forms (environment_id, form_key, project_id, page_url, proposal, doc_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment_id, form_key) DO UPDATE SET proposal = excluded.proposal, doc_json = excluded.doc_json, last_seen_at = excluded.last_seen_at`,
      );
      for (const form of forms) {
        const classification = classifyForm(form);
        upsert.run(
          source.id,
          formKey(form),
          source.project_id,
          form.page_url,
          classification.proposal,
          JSON.stringify({ form, classification }),
          at,
          at,
        );
      }
      appendAudit(
        host.state.db,
        {
          projectId: source.project_id,
          actor: caller.actor,
          action: "forms.inspected",
          target: source.id,
          details: {
            job_id: jobId,
            page: result.final_url ?? null,
            forms: forms.length,
            submitted: [...submitted].map((i) => formKey(forms[i]!)),
            read_only_declared: readOnlyDeclared,
            downloads_refused: result.downloads?.length ?? 0,
          },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    const entries = forms.map((form) => {
      const key = formKey(form);
      const decision = decisions.get(form.index)!;
      return {
        ...view(key, { form, classification: classifyForm(form) }, confirmed.get(key)),
        submitted: submitted.has(form.index),
        decision,
      };
    });
    return {
      environment_id: source.id,
      job_id: jobId,
      page: result.final_url ?? null,
      read_only_submissions_declared: readOnlyDeclared,
      forms: entries,
      submissions: (result.submissions ?? []).map((s) => ({
        form_key: formKey(forms[s.index]!),
        status: s.status,
        final_url: s.final_url,
      })),
      stopped_for_approval: entries
        .filter((e) => !e.submitted)
        .map((e) => ({
          form_key: e.form_key,
          proposal: e.proposal,
          unknown: unknownOf(
            forms.find((f) => formKey(f) === e.form_key)!,
            e.decision,
          ),
        })),
      downloads_refused: result.downloads ?? [],
      blocked: result.blocked,
    };
  },
});

const formsList = defineOperation<{ source_id: string }, unknown>({
  name: "forms.list",
  title: "List observed forms",
  description:
    "The forms discovery has seen in an environment, with the proposed effect, its signals and the latest confirmation by a person.",
  level: "none",
  effect: "read",
  input: { type: "object", additionalProperties: false, required: ["source_id"], properties: { source_id: ID } },
  run: ({ host }, input) => {
    const source = host.projects.getEvidenceSource(input.source_id);
    const confirmed = confirmations(host, source.id);
    const rows = host.state.db
      .prepare("SELECT form_key, doc_json FROM observed_forms WHERE environment_id = ? ORDER BY page_url, form_key")
      .all(source.id) as Array<{ form_key: string; doc_json: string }>;
    return {
      environment_id: source.id,
      forms: rows.map((r) => view(r.form_key, JSON.parse(r.doc_json) as StoredForm, confirmed.get(r.form_key))),
    };
  },
});

const formsConfirm = defineOperation<
  { source_id: string; form_key: string; decision: "read_only" | "not_read_only"; reason?: string },
  unknown
>({
  name: "forms.confirm",
  title: "Confirm what a form does",
  description:
    "Records a person's confirmation that an observed form is read-only (search, filter, sort) or not (OD-29). Only a GET form without login or state-changing signals can be confirmed read-only; the confirmation allows its submission only under a declaration that also allows read-only submissions (L2r). Append-only and audited.",
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "form_key", "decision"],
    properties: {
      source_id: ID,
      form_key: FORM_KEY,
      decision: { enum: ["read_only", "not_read_only"] },
      reason: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
    },
  },
  run: ({ host, caller }, input) => {
    const source = host.projects.getEvidenceSource(input.source_id);
    const row = host.state.db
      .prepare("SELECT doc_json FROM observed_forms WHERE environment_id = ? AND form_key = ?")
      .get(source.id, input.form_key) as { doc_json: string } | undefined;
    if (!row)
      throw serviceError("NOT_FOUND", `no observed form ${input.form_key} in this environment; inspect its page first`);
    const stored = JSON.parse(row.doc_json) as StoredForm;
    if (input.decision === "read_only") {
      const why =
        stored.classification.proposal === "login"
          ? "a login form is never read-only for discovery"
          : stored.classification.proposal === "state_changing"
            ? `it shows state-changing signals (${stored.classification.signals.join("; ")})`
            : stored.form.method !== "GET"
              ? `it uses ${stored.form.method}`
              : null;
      if (why)
        throw new ServiceError(
          "CONFLICT",
          "conflict",
          `${input.form_key} cannot be confirmed read-only: ${why}`,
          "Leave it unsubmitted; test its effect with an approved scenario instead.",
        );
    }
    const at = host.now().toISOString();
    host.state.transaction(() => {
      host.state.db
        .prepare(
          "INSERT INTO form_confirmations (id, environment_id, form_key, project_id, decision, confirmed_by, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          host.newId("formconf"),
          source.id,
          input.form_key,
          source.project_id,
          input.decision,
          caller.actor,
          input.reason ?? null,
          at,
          at,
        );
      appendAudit(
        host.state.db,
        {
          projectId: source.project_id,
          actor: caller.actor,
          action: "form.confirmed",
          target: input.form_key,
          details: {
            environment_id: source.id,
            decision: input.decision,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return view(input.form_key, stored, { decision: input.decision, by: caller.actor, at });
  },
});

export const FORM_OPERATIONS = [formsInspect, formsList, formsConfirm];
