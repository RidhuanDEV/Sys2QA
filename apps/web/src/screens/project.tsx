import { useRef, useState } from "react";
import { ErrorBox, href, Loaded, Page, Status, useAction, useLoad } from "../ui";

interface ProjectDetail {
  id: string;
  name: string;
  evidence_mode: string | null;
  sources: Array<{ id: string; kind: string; ref: string; added_at: string }>;
}
interface Packages {
  packages: Array<{ package_id: string; version: number; producer: string; origin: string; stored_at: string }>;
}
interface Plans {
  plans: Array<{
    plan_id: string;
    in_scope: number;
    created_at: string;
    baseline: { packages: Array<{ package_id: string; package_version: number }> };
  }>;
}

interface Runs {
  runs: Array<{
    run_id: string;
    state: string;
    tester: string;
    label: string;
    scenarios: number;
    progress: { steps_total: number; steps_recorded: number };
    started_at: string;
  }>;
}

const SOURCE_KIND: Record<string, string> = {
  source_root: "Repository",
  environment: "Environment",
  package: "Package",
};

export function ProjectScreen({ projectId }: { projectId: string }) {
  const project = useLoad<ProjectDetail>("project.get", { project_id: projectId }, projectId);
  const packages = useLoad<Packages>("package.list", { project_id: projectId }, projectId);
  const plans = useLoad<Plans>("plan.list", { project_id: projectId }, projectId);
  const runs = useLoad<Runs>("runs.list", { project_id: projectId }, projectId);
  return (
    <Loaded result={project.result} what="the project">
      {(p) => (
        <Page title={p.name} lead={<p>Evidence mode: {p.evidence_mode ?? "no evidence yet"}</p>}>
          <section aria-labelledby="sources">
            <h2 id="sources">Evidence sources</h2>
            <ul>
              {p.sources.map((s) => (
                <li key={s.id}>
                  {SOURCE_KIND[s.kind] ?? s.kind}: <code>{s.ref}</code>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="packages">
            <h2 id="packages">Packages</h2>
            <Loaded result={packages.result} what="packages">
              {(d) =>
                d.packages.length === 0 ? (
                  <p>No package yet.</p>
                ) : (
                  <table>
                    <caption>Stored package versions</caption>
                    <thead>
                      <tr>
                        <th scope="col">Package</th>
                        <th scope="col">Producer</th>
                        <th scope="col">Origin</th>
                        <th scope="col">Stored</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.packages.map((k) => (
                        <tr key={`${k.package_id}@${k.version}`}>
                          <td>
                            <a href={href("project", projectId, "package", k.package_id, String(k.version))}>
                              {k.package_id} version {k.version}
                            </a>
                          </td>
                          <td>{k.producer}</td>
                          <td>{k.origin}</td>
                          <td>{new Date(k.stored_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </Loaded>
          </section>
          <section aria-labelledby="plans">
            <h2 id="plans">Test plans</h2>
            <Loaded result={plans.result} what="test plans">
              {(d) =>
                d.plans.length === 0 ? (
                  <p>No test plan yet. Open a package to check its readiness and create one.</p>
                ) : (
                  <ul>
                    {d.plans.map((plan) => (
                      <li key={plan.plan_id}>
                        <a href={href("plan", plan.plan_id)}>
                          Plan of {plan.baseline.packages[0]?.package_id} version{" "}
                          {plan.baseline.packages[0]?.package_version}, {plan.in_scope} workflow(s) in scope
                        </a>{" "}
                        ({new Date(plan.created_at).toLocaleString()})
                      </li>
                    ))}
                  </ul>
                )
              }
            </Loaded>
          </section>
          <ImportPackResults projectId={projectId} onDone={runs.reload} />
          <GenerateReport projectId={projectId} />
          <section aria-labelledby="runs">
            <h2 id="runs">Manual runs</h2>
            <Loaded result={runs.result} what="manual runs">
              {(d) =>
                d.runs.length === 0 ? (
                  <p>No manual run yet. Start one from a test plan with approved scenarios.</p>
                ) : (
                  <ul>
                    {d.runs.map((r) => (
                      <li key={r.run_id}>
                        <a href={href("run", r.run_id)}>
                          Run of {r.scenarios} scenario(s) by {r.tester}
                        </a>{" "}
                        <Status value={r.state} /> {r.progress.steps_recorded} of {r.progress.steps_total} steps,{" "}
                        {r.label} ({new Date(r.started_at).toLocaleString()})
                      </li>
                    ))}
                  </ul>
                )
              }
            </Loaded>
          </section>
        </Page>
      )}
    </Loaded>
  );
}

/** Imports a filled-in result template of a manual test pack (QAA-FR-112); the service checks it against the pack. */
function ImportPackResults(props: { projectId: string; onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const action = useAction();
  async function upload() {
    const picked = file.current?.files?.[0];
    if (!picked) return;
    let result: unknown;
    try {
      result = JSON.parse(await picked.text());
    } catch {
      result = null;
    }
    const done = await action.run<{ run_id: string }>(
      "packs.import_results",
      { project_id: props.projectId, result: result ?? {} },
      "Manual test pack results imported as tester-reported.",
    );
    if (done) {
      if (file.current) file.current.value = "";
      props.onDone();
    }
  }
  return (
    <section aria-labelledby="pack-results">
      <h2 id="pack-results">Manual test pack results</h2>
      <div className="field">
        <label htmlFor="pack-result-file">Filled-in result-template.json</label>
        <input id="pack-result-file" type="file" accept=".json,application/json" ref={file} />
      </div>
      <button type="button" disabled={action.busy} onClick={() => void upload()}>
        Import results
      </button>
      {action.error ? <ErrorBox error={action.error} /> : null}
    </section>
  );
}

/** Writes the QA report (JSON and Markdown) in the chosen language (QAA-FR-090–093). */
function GenerateReport(props: { projectId: string }) {
  const [language, setLanguage] = useState("en");
  const [done, setDone] = useState<{ path: string; summary: Record<string, number> } | null>(null);
  const action = useAction();
  return (
    <section aria-labelledby="report">
      <h2 id="report">QA report</h2>
      <div className="field">
        <label htmlFor="report-language">Report language</label>
        <select id="report-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="en">English</option>
          <option value="id">Bahasa Indonesia</option>
        </select>
      </div>
      <button
        type="button"
        disabled={action.busy}
        onClick={() =>
          void action
            .run<{
              path: string;
              summary: Record<string, number>;
            }>("reports.generate", { project_id: props.projectId, language }, "QA report written.")
            .then((r) => setDone(r ?? null))
        }
      >
        Generate the QA report
      </button>
      {done ? (
        <>
          <p role="note">
            Written to <code>{done.path}</code> (report.json, report.md).
          </p>
          <table>
            <caption>Scenario counts</caption>
            <tbody>
              {Object.entries(done.summary).map(([k, n]) => (
                <tr key={k}>
                  <th scope="row">{k.replaceAll("_", " ")}</th>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {action.error ? <ErrorBox error={action.error} /> : null}
    </section>
  );
}
