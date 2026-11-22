import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit, localIdPart, projectDirectory } from "@sys2qa/platform";
import { classifyForm, formKey, runL2Job, submissionDecision, type SubmissionDecision } from "@sys2qa/runtime-observer";
import { observation } from "./environments.js";
import { serviceError, ServiceError } from "./errors.js";
import type { Host } from "./host.js";
import { defineOperation } from "./operations.js";

const ID = { type: "string", minLength: 3, maxLength: 300 } as const;
const ROLE = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$" } as const;

/** Discovery budgets (NFR-002): defaults, and the most a caller may ask for. */
export const DISCOVERY_BUDGET = { pages: 50, depth: 6, ms: 120_000, variants: 3 } as const;
const BUDGET_LIMITS = { pages: 500, depth: 20, ms: 900_000, variants: 10 } as const;

const credentialProfileAdd = defineOperation<
  { source_id: string; role_name: string; secret_ref: string; login_url: string },
  unknown
>({
  name: "environment.add_credential_profile",
  title: "Add a credential profile",
  description:
    'Names a role\'s test credential for an environment (QAA-FR-023, SEC-011): a reference to a secret of the same project holding `{"username": …, "password": …}` and the login page to use it on. Only the reference is stored; the values are released to one discovery worker at a time and never written to state, logs or results.',
  level: "none",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "role_name", "secret_ref", "login_url"],
    properties: {
      source_id: ID,
      role_name: ROLE,
      secret_ref: { type: "string", pattern: "^secretref:[A-Za-z0-9._-]{1,128}$" },
      login_url: { type: "string", minLength: 8, maxLength: 2048 },
    },
  },
  run: async ({ host, caller }, input) => {
    const source = host.projects.getEvidenceSource(input.source_id);
    if (source.kind !== "environment")
      throw serviceError("INPUT_INVALID", "credential profiles belong to environments", { field: "source_id" });
    const secrets = (await host.secrets()).list(source.project_id) as Array<{ ref: string }>;
    if (!secrets.some((s) => s.ref === input.secret_ref))
      throw serviceError("NOT_FOUND", `no secret ${input.secret_ref} in this project`, { field: "secret_ref" });
    const decision = host.projects.authorize(source.id, "observe", { kind: "url", url: input.login_url });
    if (!decision.allowed)
      throw new ServiceError(
        "SCOPE_DENIED",
        "denied",
        `the login page is outside the environment's scope (${decision.reason})`,
        "Use a login page inside the declared hosts and paths.",
      );
    const at = host.now().toISOString();
    host.state.transaction(() => {
      host.state.db
        .prepare(
          `INSERT INTO credential_profiles (id, environment_id, role_name, secret_ref, login_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (environment_id, role_name) DO UPDATE SET secret_ref = excluded.secret_ref, login_url = excluded.login_url, updated_at = excluded.updated_at`,
        )
        .run(host.newId("credprofile"), source.id, input.role_name, input.secret_ref, input.login_url, at, at);
      appendAudit(
        host.state.db,
        {
          projectId: source.project_id,
          actor: caller.actor,
          action: "credential_profile.added",
          target: source.id,
          details: { role_name: input.role_name, secret_ref: input.secret_ref, login_url: input.login_url },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return {
      environment_id: source.id,
      role_name: input.role_name,
      secret_ref: input.secret_ref,
      login_url: input.login_url,
    };
  },
});

/** The username and password of a credential profile, released to one job (SEC-011). */
async function credentials(host: Host, projectId: string, environmentId: string, role: string, jobId: string) {
  const profile = host.state.db
    .prepare("SELECT secret_ref, login_url FROM credential_profiles WHERE environment_id = ? AND role_name = ?")
    .get(environmentId, role) as { secret_ref: string; login_url: string | null } | undefined;
  if (!profile?.login_url) throw serviceError("NOT_FOUND", `no credential profile ${role} for this environment`);
  const values = await (await host.secrets()).injectForJob(projectId, jobId, [profile.secret_ref]);
  let parsed: { username?: unknown; password?: unknown };
  try {
    parsed = JSON.parse(values.get(profile.secret_ref)!) as typeof parsed;
  } catch {
    throw serviceError("INPUT_INVALID", `the secret of profile ${role} must be {"username": …, "password": …}`);
  }
  if (typeof parsed.username !== "string" || typeof parsed.password !== "string")
    throw serviceError("INPUT_INVALID", `the secret of profile ${role} must be {"username": …, "password": …}`);
  host.redactor.addKnownSecret(parsed.password);
  return { url: profile.login_url, username: parsed.username, password: parsed.password };
}

const discoveryRun = defineOperation<
  {
    source_id: string;
    budget?: Partial<Record<keyof typeof DISCOVERY_BUDGET, number>>;
    credential_profile?: string;
    seeds?: string[];
  },
  unknown
>({
  name: "discovery.run",
  title: "Discover an environment",
  description:
    "Walks an environment from its base URL in an L2 browser worker (QAA-FR-021, QAA-FR-022, QAA-FR-024): in-scope pages, links, forms with their visible fields, constraints and hints, within a page, depth and time budget; a path counts once and its query variants are capped, so crawler traps stop. Links and redirects outside the scope are recorded, never followed; pages behind a login are recorded as needing authentication. Forms follow the form-interaction policy (SEC-024): nothing is submitted unless a person confirmed a read-only GET form under an L2r declaration. Page content is data and changes nothing (SEC-003). With a credential profile it logs in first, and stops with guidance when the site asks for MFA or a CAPTCHA (QAA-FR-023, QAA-FR-026). Production environments are refused (SEC-009). Optional seeds add in-scope entry URLs that no link leads to. The observations are stored as the run's artifact.",
  level: "L2",
  effect: "write",
  input: {
    type: "object",
    additionalProperties: false,
    required: ["source_id"],
    properties: {
      source_id: ID,
      budget: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(BUDGET_LIMITS).map(([k, max]) => [k, { type: "integer", minimum: 1, maximum: max }]),
        ),
      },
      credential_profile: ROLE,
      /** Extra entry URLs inside the scope (a sitemap, bookmarks): pages no link leads to. */
      seeds: {
        type: "array",
        maxItems: 100,
        uniqueItems: true,
        items: { type: "string", minLength: 8, maxLength: 2048 },
      },
    },
  },
  run: async ({ host, caller }, input) => {
    const { source, policy, scope, jobId, proxy, target } = await observation(host, input.source_id);
    for (const seed of input.seeds ?? []) {
      const allowed = host.projects.authorize(source.id, "observe", { kind: "url", url: seed });
      if (!allowed.allowed) {
        await proxy.close();
        throw new ServiceError(
          "SCOPE_DENIED",
          "denied",
          `the seed ${seed} is outside the scope (${allowed.reason})`,
          "Give only entry URLs inside the declared hosts and paths.",
        );
      }
    }
    const startedAt = host.now().toISOString();
    const readOnlyDeclared = host.projects.authorize(source.id, "submit_read_only_form", {
      kind: "url",
      url: target,
    }).allowed;
    // The latest confirmation of each form decides.
    const latest = new Map<string, string>();
    for (const r of host.state.db
      .prepare("SELECT form_key, decision FROM form_confirmations WHERE environment_id = ? ORDER BY created_at, rowid")
      .all(source.id) as Array<{ form_key: string; decision: string }>)
      latest.set(r.form_key, r.decision);
    const confirmed = new Set([...latest].filter(([, d]) => d === "read_only").map(([k]) => k));
    const decisions: SubmissionDecision[] = [];
    let result;
    try {
      const login = input.credential_profile
        ? await credentials(host, source.project_id, source.id, input.credential_profile, jobId)
        : undefined;
      const budget = { ...DISCOVERY_BUDGET, ...(input.budget ?? {}) };
      result = await runL2Job(
        { action: "discover", url: target, scope, budget, seeds: input.seeds ?? [], ...(login ? { login } : {}) },
        proxy,
        {
          budgetMs: budget.ms + 60_000,
          onForms: (forms) => {
            const out: number[] = [];
            for (const form of forms) {
              const d = submissionDecision(form, {
                readOnlySubmissionsDeclared: readOnlyDeclared,
                confirmedReadOnly: confirmed,
              });
              decisions.push(d);
              if (d.submit) out.push(form.index);
            }
            return out;
          },
        },
      );
    } finally {
      await proxy.close();
    }
    const finishedAt = host.now().toISOString();
    if (!result.pages && result.error)
      throw new ServiceError(
        "ENVIRONMENT_UNREACHABLE",
        "unavailable",
        `discovery could not run: ${result.error}`,
        "Check that the environment is up and the URL is in scope, then try again.",
      );
    const forms = new Map<
      string,
      { form: unknown; proposal: string; signals: string[]; submitted: boolean; decision: string }
    >();
    const submittedActions = new Set((result.submissions ?? []).map((s) => `${s.page}|${s.index}`));
    for (const f of result.forms_seen ?? []) {
      const key = formKey(f);
      if (forms.has(key)) continue;
      const c = classifyForm(f);
      const d = decisions.find((x) => x.form_key === key);
      forms.set(key, {
        form: f,
        proposal: c.proposal,
        signals: c.signals,
        submitted: submittedActions.has(`${f.page_url}|${f.index}`),
        decision: d?.reason ?? "not decided",
      });
    }
    const status =
      result.stopped === "login"
        ? "stopped"
        : !result.ok
          ? "failed"
          : result.budget?.exhausted ||
              (result.traps ?? []).length > 0 ||
              (result.pages ?? []).some((p) => p.observability)
            ? "completed_with_limitations"
            : "completed";
    const artifact = {
      schema: "sys2qa.discovery-observations/1",
      job_id: jobId,
      environment_id: source.id,
      scope_policy_version: policy.version,
      base_url: target,
      started_at: startedAt,
      finished_at: finishedAt,
      status,
      login: result.login ?? null,
      budget: result.budget ?? null,
      pages: result.pages ?? [],
      links_not_followed: result.links_not_followed ?? [],
      traps: result.traps ?? [],
      forms: [...forms].map(([form_key, f]) => ({ form_key, ...f })),
      submissions: result.submissions ?? [],
      blocked_requests: result.blocked,
      downloads_refused: result.downloads ?? [],
    };
    const dir = join(projectDirectory(host.home, source.project_id), "discovery");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${localIdPart(jobId)}.json`);
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    const summary = {
      status,
      pages: artifact.pages.length,
      auth_required: artifact.pages.filter((p) => p.observability === "auth_required").map((p) => p.path),
      forms: artifact.forms.length,
      submitted: artifact.forms.filter((f) => f.submitted).length,
      not_followed: artifact.links_not_followed.length,
      traps: artifact.traps.map((t) => t.path),
      budget_exhausted: result.budget?.exhausted ?? null,
      login: result.login?.status ?? null,
    };
    host.state.transaction(() => {
      host.state.db
        .prepare(
          `INSERT INTO discovery_runs (id, project_id, environment_id, scope_policy_version, status, summary_json, artifact_path, started_at, finished_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          source.project_id,
          source.id,
          policy.version,
          status,
          JSON.stringify(summary),
          path,
          startedAt,
          finishedAt,
          finishedAt,
          finishedAt,
        );
      appendAudit(
        host.state.db,
        {
          projectId: source.project_id,
          actor: caller.actor,
          action: "discovery.completed",
          target: source.id,
          details: { job_id: jobId, ...summary },
        },
        { redactor: host.redactor, now: host.now },
      );
    });
    return {
      job_id: jobId,
      environment_id: source.id,
      ...summary,
      ...(result.login && result.login.status !== "logged_in"
        ? {
            guidance: `${result.login.reason}. Sys2QA never bypasses login controls; log in another way or discover without the profile.`,
          }
        : {}),
      artifact: path,
    };
  },
});

export const DISCOVERY_OPERATIONS = [credentialProfileAdd, discoveryRun];
