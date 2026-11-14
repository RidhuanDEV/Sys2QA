import { useEffect, useRef, useState } from "react";
import { ErrorBox, Loaded, Page, Status, useAction, useLoad } from "../ui";

interface RunStep {
  step_id: string;
  instruction: string;
  expected_result: { description: string; basis: string; oracle_class: string } | null;
  not_applicable_allowed: boolean;
  result: { status: string; actual: string | null; notes: string | null; evidence_refs: string[] } | null;
  attachments: Array<{ evidence_ref: string; name: string; media_type: string; size_bytes: number }>;
}
interface RunCase {
  scenario_id: string;
  outcome: string;
  defect_ids: string[];
  version: number;
  display_key: string;
  title: string;
  qa_objective: string;
  priority: string;
  risk: { score: number; rationale: string };
  preconditions: string[];
  steps: RunStep[];
}
interface RunView {
  run: {
    run_id: string;
    state: string;
    tester: string;
    label: string;
    environment: { environment_id?: string; declared?: { name: string; url?: string } };
    baseline_changed: boolean;
    abandon_reason: string | null;
  };
  language: { requested: string; shown: string[]; fallback: boolean };
  progress: { steps_total: number; steps_recorded: number };
  cases: RunCase[];
}

const STATUS_LABEL: Record<string, string> = {
  pass: "Pass",
  fail: "Fail",
  blocked: "Blocked",
  not_applicable: "Not applicable",
};

/** Reads a file the tester picked as base64 (the service checks its type and size). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
    reader.readAsDataURL(file);
  });
}

/** The manual runner (PRD §16, §23 screen 7): one step at a time, expected versus actual, evidence, pause and resume. */
export function RunScreen({ runId }: { runId: string }) {
  const shown = useLoad<RunView>("runs.show", { run_id: runId }, runId);
  return (
    <Loaded result={shown.result} what="the manual run">
      {(view) => <Runner view={view} reload={shown.reload} />}
    </Loaded>
  );
}

function firstOpen(view: RunView): [number, number] {
  for (const [c, kase] of view.cases.entries())
    for (const [s, step] of kase.steps.entries()) if (!step.result) return [c, s];
  return [0, 0];
}

function Runner({ view, reload }: { view: RunView; reload: () => void }) {
  const [[ci, si], setAt] = useState<[number, number]>(() => firstOpen(view));
  const kase = view.cases[ci]!;
  const step = kase.steps[si]!;
  const [status, setStatus] = useState(step.result?.status ?? "");
  const [actual, setActual] = useState(step.result?.actual ?? "");
  const [notes, setNotes] = useState(step.result?.notes ?? "");
  const [reason, setReason] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const action = useAction();
  const running = view.run.state === "running";
  const key = `${kase.scenario_id}/${step.step_id}`;

  useEffect(() => {
    setStatus(step.result?.status ?? "");
    setActual(step.result?.actual ?? "");
    setNotes(step.result?.notes ?? "");
    // The current step heading takes focus when the step changes, so a keyboard user continues there.
    stepHeading.current?.focus();
    // `key` identifies the step; the result fields follow it.
  }, [key]);

  const flat = view.cases.flatMap((c, i) => c.steps.map((_, j) => [i, j] as [number, number]));
  const index = flat.findIndex(([a, b]) => a === ci && b === si);
  const go = (to: number) => flat[to] && setAt(flat[to]!);

  async function record() {
    const done = await action.run(
      "runs.record_step",
      {
        run_id: view.run.run_id,
        scenario_id: kase.scenario_id,
        step_id: step.step_id,
        status,
        ...(actual.trim() ? { actual } : {}),
        ...(notes.trim() ? { notes } : {}),
        ...(step.attachments.length > 0 ? { evidence_refs: step.attachments.map((a) => a.evidence_ref) } : {}),
      },
      `Step ${step.step_id} of ${kase.display_key} recorded as ${STATUS_LABEL[status] ?? status}.`,
    );
    if (done) {
      reload();
      // A failed step stays open, so its defect can be created right away.
      if (status !== "fail") go(index + 1);
    }
  }
  async function attach() {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    const content_base64 = await readBase64(file);
    const done = await action.run(
      "runs.attach",
      {
        run_id: view.run.run_id,
        scenario_id: kase.scenario_id,
        step_id: step.step_id,
        name: file.name,
        content_base64,
      },
      `${file.name} attached to step ${step.step_id}.`,
    );
    if (done) {
      if (fileInput.current) fileInput.current.value = "";
      reload();
    }
  }
  const simple = (operation: string, done: string, extra: Record<string, unknown> = {}) =>
    action.run(operation, { run_id: view.run.run_id, ...extra }, done);

  const env = view.run.environment.declared
    ? `${view.run.environment.declared.name}${view.run.environment.declared.url ? ` (${view.run.environment.declared.url})` : ""}`
    : (view.run.environment.environment_id ?? "unknown");

  return (
    <Page
      title={`Manual run: ${kase.display_key}`}
      lead={
        <>
          <p>
            <Status value={view.run.state} label="run" /> <strong>Results are {view.run.label}</strong> by{" "}
            {view.run.tester}. Environment: {env}.
          </p>
          <p>
            Progress: {view.progress.steps_recorded} of {view.progress.steps_total} steps recorded.
          </p>
          {view.run.baseline_changed ? (
            <p className="error" role="note">
              The project&apos;s baseline changed after this run started; the run continues and its report states it.
            </p>
          ) : null}
          {view.language.fallback ? (
            <p role="note">
              Shown in {view.language.shown.join(", ")}: these scenario versions are not available in{" "}
              {view.language.requested}.
            </p>
          ) : null}
        </>
      }
    >
      <section aria-labelledby="case-heading">
        <h2 id="case-heading">
          {kase.display_key}: {kase.title}
        </h2>
        <p>
          Version {kase.version} · {kase.qa_objective.replaceAll("_", " ")} · priority {kase.priority} · risk{" "}
          {kase.risk.score}
        </p>
        {kase.preconditions.length > 0 ? (
          <>
            <h3>Preconditions</h3>
            <ul>
              {kase.preconditions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        ) : null}
        <ol className="steps" aria-label="Steps of this scenario">
          {kase.steps.map((s, j) => (
            <li key={s.step_id} aria-current={j === si ? "step" : undefined}>
              {s.step_id}: {s.result ? <Status value={s.result.status} /> : <Status value="not_recorded" />}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="step-heading" className="panel">
        <h3 id="step-heading" ref={stepHeading} tabIndex={-1}>
          Step {step.step_id} of {kase.display_key} ({index + 1} of {flat.length})
        </h3>
        <p>{step.instruction}</p>
        {step.expected_result ? (
          <p>
            <strong>Expected:</strong> {step.expected_result.description}{" "}
            <span className="muted">
              (basis {step.expected_result.basis.replaceAll("_", " ")}, oracle{" "}
              {step.expected_result.oracle_class.replaceAll("_", " ")})
            </span>
          </p>
        ) : (
          <p className="muted">This step has no expected result of its own.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
        >
          <fieldset disabled={!running}>
            <legend>Result of this step</legend>
            {(["pass", "fail", "blocked", "not_applicable"] as const).map((s) => (
              <div className="choice" key={s}>
                <input
                  type="radio"
                  id={`status-${s}`}
                  name="status"
                  value={s}
                  checked={status === s}
                  disabled={s === "not_applicable" && !step.not_applicable_allowed}
                  onChange={() => setStatus(s)}
                />
                <label htmlFor={`status-${s}`}>
                  {STATUS_LABEL[s]}
                  {s === "not_applicable" && !step.not_applicable_allowed
                    ? " (not allowed: this step checks a result)"
                    : ""}
                </label>
              </div>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="actual">Actual result{status === "fail" ? " (required)" : ""}</label>
            <textarea
              id="actual"
              rows={3}
              value={actual}
              required={status === "fail"}
              disabled={!running}
              onChange={(e) => setActual(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="notes">Notes{status === "blocked" ? " (required: why it is blocked)" : ""}</label>
            <textarea
              id="notes"
              rows={2}
              value={notes}
              required={status === "blocked"}
              disabled={!running}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" disabled={!running || !status || action.busy}>
              Record step
            </button>
            <button type="button" className="secondary" disabled={index === 0} onClick={() => go(index - 1)}>
              Previous step
            </button>
            <button
              type="button"
              className="secondary"
              disabled={index === flat.length - 1}
              onClick={() => go(index + 1)}
            >
              Next step
            </button>
          </div>
        </form>
        <div className="field">
          <label htmlFor="attachment">
            Attach a screenshot or file (PNG, JPEG, GIF, WebP, PDF or text, up to 5 MB)
          </label>
          <input id="attachment" type="file" ref={fileInput} disabled={!running} />
          <button type="button" className="secondary" disabled={!running || action.busy} onClick={() => void attach()}>
            Attach
          </button>
        </div>
        {step.attachments.length > 0 ? (
          <ul aria-label="Attachments of this step">
            {step.attachments.map((a) => (
              <li key={a.evidence_ref}>
                {a.name} ({a.media_type}, {Math.ceil(a.size_bytes / 1024)} KB) <code>{a.evidence_ref}</code>
              </li>
            ))}
          </ul>
        ) : null}
        {action.error ? <ErrorBox error={action.error} /> : null}
        {step.result?.status === "fail" ? (
          <DefectForm runId={view.run.run_id} scenarioId={kase.scenario_id} stepId={step.step_id} onDone={reload} />
        ) : null}
        {kase.defect_ids.length > 0 ? (
          <p>
            Defects of {kase.display_key}:{" "}
            {kase.defect_ids.map((d) => (
              <code key={d}>{d} </code>
            ))}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="run-actions">
        <h2 id="run-actions">Run</h2>
        <div className="actions">
          {view.run.state === "running" ? (
            <button
              type="button"
              className="secondary"
              onClick={() => void simple("runs.pause", "Run paused.").then(reload)}
            >
              Pause run
            </button>
          ) : null}
          {view.run.state === "paused" ? (
            <button type="button" onClick={() => void simple("runs.resume", "Run resumed.").then(reload)}>
              Resume run
            </button>
          ) : null}
          {view.run.state === "running" ? (
            <button
              type="button"
              disabled={view.progress.steps_recorded < view.progress.steps_total || action.busy}
              onClick={() => void simple("runs.submit", "Run submitted.").then(reload)}
            >
              Submit run
            </button>
          ) : null}
        </div>
        {view.run.state === "running" || view.run.state === "paused" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void simple("runs.abandon", "Run abandoned.", { reason }).then(reload);
            }}
          >
            <div className="field">
              <label htmlFor="abandon-reason">Reason to abandon the run</label>
              <input
                id="abandon-reason"
                type="text"
                value={reason}
                required
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <button type="submit" className="secondary" disabled={!reason.trim()}>
              Abandon run
            </button>
          </form>
        ) : null}
        {view.run.abandon_reason ? <p>Abandoned: {view.run.abandon_reason}</p> : null}
        {view.run.state === "completed" || view.run.state === "abandoned" ? (
          <ul aria-label="Outcomes">
            {view.cases.map((c) => (
              <li key={c.scenario_id}>
                {c.display_key} <code>{c.scenario_id}</code>: <Status value={c.outcome} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </Page>
  );
}

/** Creates a defect from the failed step, pre-linked to the scenario version, run, step and evidence (QAA-FR-084). */
function DefectForm(props: { runId: string; scenarioId: string; stepId: string; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("");
  const [priority, setPriority] = useState("");
  const [suspected, setSuspected] = useState("unknown");
  const action = useAction();
  return (
    <form
      className="panel"
      aria-labelledby="defect-heading"
      onSubmit={(e) => {
        e.preventDefault();
        void action
          .run<{ defect: { defect_id: string } }>(
            "defects.create",
            {
              run_id: props.runId,
              scenario_id: props.scenarioId,
              step_id: props.stepId,
              title,
              severity,
              priority,
              suspected_type: suspected,
            },
            "Defect created and linked to this step.",
          )
          .then((r) => {
            if (r) {
              setTitle("");
              props.onDone();
            }
          });
      }}
    >
      <h4 id="defect-heading">Create a defect from this failed step</h4>
      <div className="field">
        <label htmlFor="defect-title">Defect title (required)</label>
        <input id="defect-title" type="text" value={title} required onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="defect-severity">Severity: impact on the system (required)</label>
        <select id="defect-severity" value={severity} required onChange={(e) => setSeverity(e.target.value)}>
          <option value="">Choose…</option>
          <option value="critical">Critical</option>
          <option value="major">Major</option>
          <option value="minor">Minor</option>
          <option value="trivial">Trivial</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="defect-priority">Priority: urgency to fix (required)</label>
        <select id="defect-priority" value={priority} required onChange={(e) => setPriority(e.target.value)}>
          <option value="">Choose…</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="defect-suspected">Suspected cause</label>
        <select id="defect-suspected" value={suspected} onChange={(e) => setSuspected(e.target.value)}>
          <option value="unknown">Unknown</option>
          <option value="product_defect">Product defect</option>
          <option value="test_defect">Test defect</option>
        </select>
      </div>
      <button type="submit" disabled={action.busy || !title.trim() || !severity || !priority}>
        Create defect
      </button>
      {action.error ? <ErrorBox error={action.error} /> : null}
    </form>
  );
}
