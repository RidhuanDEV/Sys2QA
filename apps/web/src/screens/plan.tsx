import { useEffect, useRef, useState } from "react";
import { ErrorBox, Field, href, Loaded, Page, Status, useAction, useLoad } from "../ui";

interface PlanShow {
  project_id: string;
  plan: {
    plan_id: string;
    objectives: Array<{ value: string }>;
    qa_objectives: string[];
    baseline: { packages: Array<{ package_id: string; package_version: number }> };
    scope: { in_scope: string[]; out_of_scope: string[]; exclusions_reason?: string };
  };
}
interface Listed {
  scenario_id: string;
  display_key: string;
  version: number;
  status: string;
  freshness: string;
  title: string;
  qa_objective: string;
  priority: string;
}
interface Text {
  value: string;
}
interface ScenarioDoc {
  scenario_id: string;
  display_key: string;
  version: number;
  title: Text;
  feature_ref: string;
  qa_objective: string;
  category: string;
  status: string;
  status_reason?: string;
  freshness: string;
  state_changing: boolean;
  execution_classification: string;
  test_techniques: Array<{ id: string; rationale: string }>;
  preconditions: Array<{ id: string; text: Text }>;
  steps: Array<{
    step_id: string;
    instruction: Text;
    expected_result: null | { description: Text; basis: string; oracle_class: string; saa_status?: string };
  }>;
  open_gaps: Array<{ gap_id?: string; description?: string } | string>;
}
interface Preview {
  items: Array<{
    scenario_id: string;
    version: number;
    display_key: string;
    title: string;
    state_changing: boolean;
    execution_classification: string;
  }>;
  binding: {
    mode: string;
    environment_id?: string;
    declared_environment_id?: string;
    scope_policy_version: number | null;
    test_data_profile: string;
  };
  baselines: Array<{ packages: Array<{ package_id: string; package_version: number }> }>;
  state_changing: string[];
  preview_token: string;
}
interface Ratio {
  covered: number;
  of: number;
  ratio: number | null;
}
interface Coverage {
  coverage: {
    scope_statement: string;
    workflows: {
      designed: Ratio;
      approved: Ratio;
      branches: { designed: Ratio; approved: Ratio };
      outside_scope: string[];
    };
    rules: { designed: Ratio; approved: Ratio };
    role_permissions: { designed: Ratio; approved: Ratio };
    pages: { designed: Ratio; approved: Ratio };
    execution: { executed: number; of: number; ratio: number | null };
  };
}

const STATUSES = ["", "pending_review", "needs_clarification", "draft", "approved", "rejected", "deferred"];
const pct = (r: Ratio) => `${r.covered} of ${r.of}${r.ratio === null ? "" : ` (${Math.round(r.ratio * 100)}%)`}`;

export function PlanScreen({ planId }: { planId: string }) {
  const plan = useLoad<PlanShow>("plan.show", { plan_id: planId }, planId);
  return (
    <Loaded result={plan.result} what="the test plan">
      {(p) => <PlanBody planId={planId} data={p} />}
    </Loaded>
  );
}

function PlanBody({ planId, data }: { planId: string; data: PlanShow }) {
  const projectId = data.project_id;
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const listInput = { project_id: projectId, plan_id: planId, ...(status ? { status } : {}) };
  const list = useLoad<{ scenarios: Listed[] }>("scenarios.list", listInput, `${planId}/${status}`);
  const coverage = useLoad<Coverage>("coverage.report", { plan_id: planId }, planId);
  const action = useAction();
  const refresh = () => {
    list.reload();
    coverage.reload();
  };
  const pkg = data.plan.baseline.packages[0];

  async function generate() {
    const r = await action.run<{ created: number; versioned: number }>("scenarios.generate", { plan_id: planId });
    if (!r) return;
    const c = await action.run<{ by_status: Record<string, number> }>(
      "scenarios.critique",
      { plan_id: planId },
      "Scenarios generated and checked against the quality checklist.",
    );
    if (c) refresh();
  }

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Page
      title="Test plan"
      lead={
        <p>
          <a href={href("project", projectId)}>Back to the project</a>
          {pkg ? (
            <>
              {" · "}
              <a href={href("project", projectId, "package", pkg.package_id, String(pkg.package_version))}>
                Package {pkg.package_id} version {pkg.package_version}
              </a>
            </>
          ) : null}
        </p>
      }
    >
      <section aria-labelledby="scope">
        <h2 id="scope">Objectives and scope</h2>
        <ul>
          {data.plan.objectives.map((o) => (
            <li key={o.value}>{o.value}</li>
          ))}
        </ul>
        <p>QA objectives: {data.plan.qa_objectives.map((o) => o.replaceAll("_", " ")).join(", ")}</p>
        <details>
          <summary>In scope ({data.plan.scope.in_scope.length})</summary>
          <ul>
            {data.plan.scope.in_scope.map((w) => (
              <li key={w}>
                <code>{w}</code>
              </li>
            ))}
          </ul>
        </details>
        <details>
          <summary>Out of scope ({data.plan.scope.out_of_scope.length})</summary>
          <ul>
            {data.plan.scope.out_of_scope.map((w) => (
              <li key={w}>
                <code>{w}</code>
              </li>
            ))}
          </ul>
          {data.plan.scope.exclusions_reason ? <p>{data.plan.scope.exclusions_reason}</p> : null}
        </details>
        <p>
          <button type="button" onClick={() => void generate()} disabled={action.busy}>
            {action.busy ? "Working…" : "Generate and check scenarios"}
          </button>
        </p>
        {action.error ? <ErrorBox error={action.error} /> : null}
      </section>

      <section aria-labelledby="coverage">
        <h2 id="coverage">Coverage</h2>
        <Loaded result={coverage.result} what="coverage">
          {({ coverage: c }) => (
            <>
              <p>{c.scope_statement}</p>
              <table>
                <caption>Coverage relative to the model and the plan's scope</caption>
                <thead>
                  <tr>
                    <th scope="col">Dimension</th>
                    <th scope="col">Designed</th>
                    <th scope="col">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Workflows", c.workflows],
                      ["Workflow branches", c.workflows.branches],
                      ["Rules (every applicable technique)", c.rules],
                      ["Role-permission pairs (allowed and denied)", c.role_permissions],
                      ["Pages", c.pages],
                    ] as const
                  ).map(([label, r]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td>{pct(r.designed)}</td>
                      <td>{pct(r.approved)}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Execution (approved scenarios run)</th>
                    <td>—</td>
                    <td>{pct({ covered: c.execution.executed, of: c.execution.of, ratio: c.execution.ratio })}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </Loaded>
      </section>

      <section aria-labelledby="review">
        <h2 id="review">Scenario review</h2>
        <div className="field">
          <label htmlFor="status-filter">Show scenarios with status</label>
          <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? s.replaceAll("_", " ") : "any status"}
              </option>
            ))}
          </select>
        </div>
        <Loaded result={list.result} what="scenarios">
          {(d) =>
            d.scenarios.length === 0 ? (
              <p>No scenario {status ? `with status ${status.replaceAll("_", " ")}` : "yet"}.</p>
            ) : (
              <table>
                <caption>{d.scenarios.length} scenario(s); select the ones to approve</caption>
                <thead>
                  <tr>
                    <th scope="col">Select</th>
                    <th scope="col">Key</th>
                    <th scope="col">Title</th>
                    <th scope="col">Status</th>
                    <th scope="col">Freshness</th>
                    <th scope="col">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {d.scenarios.map((s) => (
                    <tr key={s.scenario_id} aria-current={open === s.scenario_id ? "true" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          id={`select-${s.display_key}`}
                          aria-label={`Select ${s.display_key}`}
                          checked={selected.includes(s.scenario_id)}
                          onChange={() => toggle(s.scenario_id)}
                        />
                      </td>
                      <td>{s.display_key}</td>
                      <td>
                        <button type="button" className="link" onClick={() => setOpen(s.scenario_id)}>
                          {s.title}
                        </button>
                      </td>
                      <td>
                        <Status value={s.status} />
                      </td>
                      <td>
                        <Status value={s.freshness} />
                      </td>
                      <td>{s.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </Loaded>
        {open ? <ScenarioDetail scenarioId={open} onChanged={refresh} onClose={() => setOpen(null)} /> : null}
      </section>

      <Approval
        projectId={projectId}
        selected={selected}
        onDone={() => {
          setSelected([]);
          refresh();
        }}
      />
    </Page>
  );
}

function ScenarioDetail(props: { scenarioId: string; onChanged: () => void; onClose: () => void }) {
  const shown = useLoad<{ scenario: ScenarioDoc }>(
    "scenarios.show",
    { scenario_id: props.scenarioId },
    props.scenarioId,
  );
  const [decision, setDecision] = useState("ready_for_review");
  const [reason, setReason] = useState("");
  const action = useAction();
  const heading = useRef<HTMLHeadingElement>(null);
  const loaded = shown.result?.ok ? props.scenarioId : null;
  // Opening a scenario moves focus to it, so keyboard and screen-reader users continue there.
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [loaded]);
  return (
    <section aria-labelledby="scenario-detail" className="panel">
      <Loaded result={shown.result} what="the scenario">
        {({ scenario: s }) => (
          <>
            <h3 id="scenario-detail" tabIndex={-1} ref={heading}>
              {s.display_key}: {s.title.value}
            </h3>
            <p>
              <Status value={s.status} /> <Status value={s.freshness} label="freshness" /> version {s.version} ·{" "}
              {s.qa_objective.replaceAll("_", " ")} · {s.category} · {s.execution_classification.replaceAll("_", " ")}
              {s.state_changing ? " · changes state" : ""}
            </p>
            {s.status_reason ? <p>Why: {s.status_reason}</p> : null}
            <p>
              Workflow <code>{s.feature_ref}</code>; techniques:{" "}
              {s.test_techniques.map((t) => `${t.id.replaceAll("_", " ")} (${t.rationale})`).join("; ")}
            </p>
            {s.preconditions.length > 0 ? (
              <>
                <h4>Preconditions</h4>
                <ul>
                  {s.preconditions.map((p) => (
                    <li key={p.id}>{p.text.value}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <h4>Steps</h4>
            <ol>
              {s.steps.map((step) => (
                <li key={step.step_id}>
                  {step.instruction.value}
                  {step.expected_result ? (
                    <p>
                      Expected: {step.expected_result.description.value}{" "}
                      <span className="muted">
                        (basis {step.expected_result.basis.replaceAll("_", " ")}, oracle{" "}
                        {step.expected_result.oracle_class.replaceAll("_", " ")})
                      </span>
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action
                  .run(
                    "scenarios.decide",
                    { scenario_id: s.scenario_id, version: s.version, decision, reason },
                    "Decision recorded.",
                  )
                  .then((r) => {
                    if (r) {
                      setReason("");
                      shown.reload();
                      props.onChanged();
                    }
                  });
              }}
            >
              <div className="field">
                <label htmlFor="decision">Decision</label>
                <select id="decision" value={decision} onChange={(e) => setDecision(e.target.value)}>
                  <option value="ready_for_review">Ready for review</option>
                  <option value="request_regeneration">Request regeneration</option>
                  <option value="defer">Defer</option>
                  <option value="reject">Reject</option>
                </select>
              </div>
              <Field id="decision-reason" label="Reason" value={reason} onChange={setReason} required />
              {action.error ? <ErrorBox error={action.error} /> : null}
              <div className="actions">
                <button type="submit" disabled={action.busy}>
                  Record decision
                </button>
                <button type="button" className="secondary" onClick={props.onClose}>
                  Close
                </button>
              </div>
            </form>
          </>
        )}
      </Loaded>
    </section>
  );
}

/**
 * Approval (QAA-FR-051): the exact versions and the full binding are shown before anything is approved; state-changing
 * scenarios need an explicit acknowledgement. The approval itself is decided by the service, against the preview token.
 */
function Approval(props: { projectId: string; selected: string[]; onDone: () => void }) {
  const [mode, setMode] = useState("manual");
  const [environment, setEnvironment] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ack, setAck] = useState(false);
  const action = useAction();
  const binding = {
    project_id: props.projectId,
    scenario_ids: props.selected,
    mode,
    declared_environment: environment,
  };

  return (
    <section aria-labelledby="approval">
      <h2 id="approval">Approval</h2>
      {props.selected.length === 0 ? (
        <p>Select scenarios in the review table to approve them.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAck(false);
            void action
              .run<Preview>("approvals.preview", binding, "Approval preview ready; check it before approving.")
              .then((p) => setPreview(p ?? null));
          }}
        >
          <p>{props.selected.length} scenario(s) selected.</p>
          <div className="field">
            <label htmlFor="mode">Execution mode</label>
            <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="manual">Manual</option>
              <option value="automated">Automated</option>
            </select>
          </div>
          <Field
            id="environment"
            label="Environment the tests will run in"
            hint="A name for where testers run them, for example: staging, or tester laptop."
            value={environment}
            onChange={setEnvironment}
            required
          />
          <button type="submit" disabled={action.busy}>
            Preview approval
          </button>
        </form>
      )}
      {action.error ? <ErrorBox error={action.error} /> : null}
      {preview ? (
        <div className="panel" aria-labelledby="preview-heading">
          <h3 id="preview-heading">You are about to approve {preview.items.length} scenario version(s)</h3>
          <dl>
            <dt>Mode</dt>
            <dd>{preview.binding.mode}</dd>
            <dt>Environment</dt>
            <dd>
              {preview.binding.environment_id ??
                (preview.binding.declared_environment_id
                  ? `${environment} (declared, ${preview.binding.declared_environment_id})`
                  : "none")}
            </dd>
            <dt>Scope policy version</dt>
            <dd>{preview.binding.scope_policy_version ?? "none"}</dd>
            <dt>Test data profile</dt>
            <dd>{preview.binding.test_data_profile}</dd>
            <dt>Baseline</dt>
            <dd>
              {preview.baselines
                .flatMap((b) => b.packages.map((k) => `${k.package_id} version ${k.package_version}`))
                .join("; ")}
            </dd>
          </dl>
          <table>
            <caption>Exactly these versions</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Title</th>
                <th scope="col">Version</th>
                <th scope="col">Changes state</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((i) => (
                <tr key={i.scenario_id}>
                  <td>{i.display_key}</td>
                  <td>{i.title}</td>
                  <td>{i.version}</td>
                  <td>{i.state_changing ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.state_changing.length > 0 ? (
            <div className="choice">
              <input type="checkbox" id="ack" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <label htmlFor="ack">
                I understand that {preview.state_changing.length} of these scenarios change state in the environment.
              </label>
            </div>
          ) : null}
          <div className="actions">
            <button
              type="button"
              disabled={action.busy || (preview.state_changing.length > 0 && !ack)}
              onClick={() =>
                void action
                  .run(
                    "approvals.approve",
                    {
                      ...binding,
                      scenario_ids: preview.items.map((i) => i.scenario_id),
                      preview_token: preview.preview_token,
                      ...(ack ? { state_changing_ack: true } : {}),
                    },
                    `${preview.items.length} scenario(s) approved.`,
                  )
                  .then((r) => {
                    if (r) {
                      setPreview(null);
                      props.onDone();
                    }
                  })
              }
            >
              Approve {preview.items.length} scenario(s)
            </button>
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
