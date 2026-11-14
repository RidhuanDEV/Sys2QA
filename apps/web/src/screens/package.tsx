import { useState } from "react";
import { ErrorBox, EvidenceProfile, Field, href, Loaded, Page, Status, useAction, useLoad } from "../ui";

interface Brief {
  id: string;
  kind: string | null;
  name: string;
  status: string | null;
}
interface Catalog {
  evidence_profile: Record<string, unknown> | null;
  workflows: Array<{
    id: string;
    name: string;
    category: string;
    status: string;
    discovery_status: string;
    completion: string;
    entry_points: Brief[];
    steps: Array<Brief & { action: string }>;
    branches: Array<{ condition: string; outcome: string; status: string }>;
    stops: Array<{ after_step: string | null; reason_code: string; description: string | null }>;
  }>;
  entities: Array<{ kind: string; count: number; items: Array<{ id: string; name: string; status: string }> }>;
  gaps: Array<{ id: string; type: string; description: string; status: string; requires_human_clarification: boolean }>;
}
interface Readiness {
  assessment: {
    execution_status: string;
    freshness: string;
    activities: Record<string, { readiness: string; reasons: string[] }>;
  };
  flows: Array<{
    workflow_id: string;
    readiness: string;
    gaps: Array<{ gap_id: string; effect: string; overridden: boolean }>;
  }>;
  freshness: { value: string; reason: string };
}

const ACTIVITY: Record<string, string> = {
  scenario_design: "Scenario design",
  manual_preparation: "Manual test preparation",
  automated_execution: "Automated execution",
};

export function PackageScreen(props: { projectId: string; packageId: string; version: number }) {
  const ref = { project_id: props.projectId, package_id: props.packageId, version: props.version };
  const key = `${props.projectId}/${props.packageId}/${props.version}`;
  const catalog = useLoad<Catalog>("package.catalog", ref, key);
  const readiness = useLoad<Readiness>("readiness.assess", ref, key);
  const action = useAction();
  const [statement, setStatement] = useState("");

  async function createPlan() {
    const created = await action.run<{ plan: { plan_id: string } }>("plan.create", ref, "Test plan created.");
    if (created) window.location.hash = href("plan", created.plan.plan_id);
  }
  async function confirmBaseline() {
    if (
      await action.run("readiness.confirm_baseline", { ...ref, statement }, "Baseline confirmed; readiness reassessed.")
    )
      readiness.reload();
  }

  return (
    <Page
      title={`Package ${props.packageId} version ${props.version}`}
      lead={
        <p>
          <a href={href("project", props.projectId)}>Back to the project</a>
        </p>
      }
    >
      <Loaded result={catalog.result} what="the package">
        {(c) => <EvidenceProfile profile={c.evidence_profile} />}
      </Loaded>

      <section aria-labelledby="readiness">
        <h2 id="readiness">Readiness</h2>
        <Loaded result={readiness.result} what="readiness">
          {(r) => (
            <>
              <p>
                <Status value={r.assessment.execution_status} label="analysis" />{" "}
                <Status value={r.freshness.value} label="freshness" /> {r.freshness.reason}
              </p>
              <table>
                <caption>Readiness per activity (no aggregate score)</caption>
                <thead>
                  <tr>
                    <th scope="col">Activity</th>
                    <th scope="col">Readiness</th>
                    <th scope="col">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(r.assessment.activities).map(([activity, a]) => (
                    <tr key={activity}>
                      <th scope="row">{ACTIVITY[activity] ?? activity}</th>
                      <td>
                        <Status value={a.readiness} />
                      </td>
                      <td>
                        {a.reasons.length === 0 ? (
                          "No blocking reason."
                        ) : (
                          <ul>
                            {a.reasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table>
                <caption>Readiness per workflow</caption>
                <thead>
                  <tr>
                    <th scope="col">Workflow</th>
                    <th scope="col">Readiness</th>
                    <th scope="col">Gaps on it</th>
                  </tr>
                </thead>
                <tbody>
                  {r.flows.map((f) => (
                    <tr key={f.workflow_id}>
                      <th scope="row">
                        <code>{f.workflow_id}</code>
                      </th>
                      <td>
                        <Status value={f.readiness} />
                      </td>
                      <td>
                        {f.gaps.length === 0
                          ? "None"
                          : f.gaps
                              .map((g) => `${g.gap_id} (${g.effect}${g.overridden ? ", overridden" : ""})`)
                              .join("; ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Loaded>
        <details>
          <summary>Confirm the baseline (a dirty or non-Git working tree)</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirmBaseline();
            }}
          >
            <Field
              id="statement"
              label="Your statement"
              hint="For example: the test environment runs exactly this working tree."
              value={statement}
              onChange={setStatement}
              required
            />
            <button type="submit" disabled={action.busy}>
              Confirm baseline
            </button>
          </form>
        </details>
        {action.error ? <ErrorBox error={action.error} /> : null}
        <p>
          <button type="button" onClick={() => void createPlan()} disabled={action.busy}>
            Create a test plan from this package
          </button>
        </p>
      </section>

      <Loaded result={catalog.result} what="the catalog">
        {(c) => (
          <>
            <section aria-labelledby="system-map">
              <h2 id="system-map">System map: {c.workflows.length} workflow(s)</h2>
              <p className="hint">Each workflow lists its steps in order, its branches and where the trace stopped.</p>
              {c.workflows.map((w) => (
                <details key={w.id} className="workflow">
                  <summary>
                    {w.name} <Status value={w.discovery_status} /> <Status value={w.status} label="evidence" />
                  </summary>
                  <p>
                    <code>{w.id}</code> · {w.category.replaceAll("_", " ")} · completion{" "}
                    {w.completion.replaceAll("_", " ")}
                  </p>
                  <h3>Steps</h3>
                  <ol>
                    {w.steps.map((s, i) => (
                      <li key={`${s.id}-${i}`}>
                        {s.action}: {s.name} <span className="muted">({s.kind ?? "unknown kind"})</span>{" "}
                        <Status value={s.status} />
                      </li>
                    ))}
                  </ol>
                  {w.branches.length > 0 ? (
                    <>
                      <h3>Branches</h3>
                      <ul>
                        {w.branches.map((b, i) => (
                          <li key={i}>
                            When <code>{b.condition}</code>: {b.outcome.replaceAll("_", " ")}{" "}
                            <Status value={b.status} />
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {w.stops.length > 0 ? (
                    <>
                      <h3>Where the trace stops</h3>
                      <ul>
                        {w.stops.map((s, i) => (
                          <li key={i}>
                            {s.reason_code.replaceAll("_", " ")}
                            {s.after_step ? ` after ${s.after_step}` : ""}
                            {s.description ? `: ${s.description}` : ""}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </details>
              ))}
            </section>
            <section aria-labelledby="catalog">
              <h2 id="catalog">Catalog by kind</h2>
              {c.entities.map((group) => (
                <details key={group.kind}>
                  <summary>
                    {group.kind.replaceAll("_", " ")} ({group.count})
                  </summary>
                  <ul>
                    {group.items.map((e) => (
                      <li key={e.id}>
                        {e.name} <code>{e.id}</code> <Status value={e.status} />
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </section>
            <section aria-labelledby="gaps">
              <h2 id="gaps">Gaps and unknowns ({c.gaps.length})</h2>
              <ul>
                {c.gaps.map((g) => (
                  <li key={g.id}>
                    <Status value={g.type} /> {g.description}
                    {g.requires_human_clarification ? " (needs a person to clarify)" : ""}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </Loaded>
    </Page>
  );
}
