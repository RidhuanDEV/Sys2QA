import { useState, type FormEvent } from "react";
import { ErrorBox, Field, href, Loaded, Page, useAction, useLoad } from "../ui";

interface Project {
  id: string;
  name: string;
  evidence_mode: string | null;
  created_at: string;
}

export function Home() {
  const { result } = useLoad<Project[]>("project.list", {}, "projects");
  return (
    <Page title="Projects">
      <p>
        <a className="button" href="#/start">
          Start a project
        </a>
      </p>
      <Loaded result={result} what="projects">
        {(projects) =>
          projects.length === 0 ? (
            <p>No project yet. Start one from what you have: a repository, a URL, both, or a package.</p>
          ) : (
            <table>
              <caption>Your projects</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Evidence mode</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={href("project", p.id)}>{p.name}</a>
                    </td>
                    <td>{p.evidence_mode ?? "no evidence yet"}</td>
                    <td>{new Date(p.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Loaded>
    </Page>
  );
}

type Mode = "A" | "B" | "C" | "D";
const MODES: Array<{ mode: Mode; label: string; detail: string }> = [
  { mode: "A", label: "A repository on this computer", detail: "Sys2QA reads the source code; nothing is executed." },
  {
    mode: "B",
    label: "The URL of a running environment",
    detail: "The environment and its scope are recorded; runtime discovery runs on it once available.",
  },
  { mode: "C", label: "Both a repository and a URL", detail: "Source analysis now; the environment is recorded too." },
  {
    mode: "D",
    label: "A Sys2QA package (folder or ZIP)",
    detail: "An existing package is imported as the system model; nothing is re-analyzed.",
  },
];

/**
 * The start wizard (PRD W1, SYS-001/SYS-002): it asks what the developer has, never what the system is. Every step is
 * one application-service call; the scope of each declaration is shown before it is recorded.
 */
export function StartWizard() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState<"mode" | "inputs" | "declare">("mode");
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [url, setUrl] = useState("");
  const [packagePath, setPackagePath] = useState("");
  const [classification, setClassification] = useState("staging");
  const [declaredBy, setDeclaredBy] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const action = useAction();
  const needsRepo = mode === "A" || mode === "C";
  const needsUrl = mode === "B" || mode === "C";
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {
    host = "";
  }

  const say = (line: string) => setProgress((p) => [...p, line]);

  async function finish(event: FormEvent) {
    event.preventDefault();
    setProgress([]);
    const { run } = action;
    let projectId: string;
    let sourceRootId: string | undefined;
    if (needsRepo) {
      const started = await run<{ project: { id: string }; source: { id: string } }>("saa.start", { name, root });
      if (!started) return;
      projectId = started.project.id;
      sourceRootId = started.source.id;
      say("Project created and repository registered.");
    } else {
      const created = await run<{ id: string }>("project.create", { name });
      if (!created) return;
      projectId = created.id;
      say("Project created.");
    }
    if (mode === "D") {
      const imported = await run<{ package: { package_id: string; version: number } }>(
        "package.import",
        { project_id: projectId, path: packagePath },
        "Package imported.",
      );
      if (!imported) return;
      window.location.hash = href(
        "project",
        projectId,
        "package",
        imported.package.package_id,
        String(imported.package.version),
      );
      return;
    }
    if (needsUrl) {
      const env = await run<{ id: string }>("project.add_source", {
        project_id: projectId,
        kind: "environment",
        ref: url,
      });
      if (!env) return;
      if (!(await run("project.declare", { source_id: env.id, declared_by: declaredBy, operation_level: "L2" })))
        return;
      const configured = await run("project.configure_environment", {
        source_id: env.id,
        base_url: url,
        classification,
        allowed_hosts: [host],
      });
      if (!configured) return;
      say(`Environment recorded with scope ${host}.`);
    }
    if (sourceRootId) {
      if (!(await run("project.declare", { source_id: sourceRootId, declared_by: declaredBy, operation_level: "L1" })))
        return;
      say("Declaration recorded. Analyzing the repository…");
      const analyzed = await run<{ run_id: string }>("saa.analyze", { source_id: sourceRootId });
      if (!analyzed) return;
      const exported = await run<{ package_id: string; version: number }>(
        "saa.export",
        { run_id: analyzed.run_id },
        "Analysis finished and package stored.",
      );
      if (!exported) return;
      window.location.hash = href("project", projectId, "package", exported.package_id, String(exported.version));
      return;
    }
    window.location.hash = href("project", projectId);
  }

  return (
    <Page title="Start a project" lead={<p>What do you have? Sys2QA never asks how the system works.</p>}>
      {step === "mode" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (mode) setStep("inputs");
          }}
        >
          <fieldset>
            <legend>Starting point</legend>
            {MODES.map((m) => (
              <div className="choice" key={m.mode}>
                <input
                  type="radio"
                  id={`mode-${m.mode}`}
                  name="mode"
                  value={m.mode}
                  checked={mode === m.mode}
                  onChange={() => setMode(m.mode)}
                  aria-describedby={`mode-${m.mode}-detail`}
                />
                <label htmlFor={`mode-${m.mode}`}>
                  Mode {m.mode}: {m.label}
                </label>
                <p className="hint" id={`mode-${m.mode}-detail`}>
                  {m.detail}
                </p>
              </div>
            ))}
          </fieldset>
          <button type="submit" disabled={!mode}>
            Continue
          </button>
        </form>
      ) : step === "inputs" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "D") void finish(e);
            else setStep("declare");
          }}
        >
          <h2>Mode {mode}: what you have</h2>
          <Field id="project-name" label="Project name" value={name} onChange={setName} required />
          {needsRepo ? (
            <Field
              id="repository-path"
              label="Repository path"
              hint="An absolute path on this computer, for example /home/me/code/shop."
              value={root}
              onChange={setRoot}
              required
            />
          ) : null}
          {needsUrl ? (
            <>
              <Field id="environment-url" label="Environment URL" type="url" value={url} onChange={setUrl} required />
              <div className="field">
                <label htmlFor="classification">Kind of environment</label>
                <select id="classification" value={classification} onChange={(e) => setClassification(e.target.value)}>
                  <option value="development">Development</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production (read-only observation only)</option>
                </select>
              </div>
            </>
          ) : null}
          {mode === "D" ? (
            <Field
              id="package-path"
              label="Package path"
              hint="An absolute path to a package folder or ZIP archive."
              value={packagePath}
              onChange={setPackagePath}
              required
            />
          ) : null}
          {action.error ? <ErrorBox error={action.error} /> : null}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setStep("mode")}>
              Back
            </button>
            <button type="submit" disabled={action.busy}>
              {mode === "D" ? "Import package" : "Continue"}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={(e) => void finish(e)}>
          <h2>Authorization declaration</h2>
          <p>Sys2QA records who authorizes what, before it reads or observes anything (SEC-005).</p>
          <ul className="scope">
            {needsRepo ? (
              <li>
                <strong>Read-only static analysis</strong> of <code>{root}</code>: files are read; no process from the
                repository is started and nothing is written into it.
              </li>
            ) : null}
            {needsUrl ? (
              <li>
                <strong>Observation</strong> of <code>{url}</code> ({classification}), limited to the host{" "}
                <code>{host || "(invalid URL)"}</code>. No state-changing test is allowed by this declaration.
              </li>
            ) : null}
          </ul>
          <Field id="declared-by" label="Your name" value={declaredBy} onChange={setDeclaredBy} required />
          <div className="choice">
            <input
              type="checkbox"
              id="authorized"
              checked={authorized}
              onChange={(e) => setAuthorized(e.target.checked)}
              required
            />
            <label htmlFor="authorized">I am authorized to let Sys2QA do what is listed above.</label>
          </div>
          {action.error ? <ErrorBox error={action.error} /> : null}
          {progress.length > 0 ? (
            <ol className="progress" aria-label="Progress">
              {progress.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
          ) : null}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setStep("inputs")} disabled={action.busy}>
              Back
            </button>
            <button type="submit" disabled={action.busy || !authorized}>
              {action.busy ? "Working…" : needsRepo ? "Declare and analyze" : "Declare"}
            </button>
          </div>
        </form>
      )}
    </Page>
  );
}
