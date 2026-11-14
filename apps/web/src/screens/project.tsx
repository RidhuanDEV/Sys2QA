import { href, Loaded, Page, useLoad } from "../ui";

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

const SOURCE_KIND: Record<string, string> = {
  source_root: "Repository",
  environment: "Environment",
  package: "Package",
};

export function ProjectScreen({ projectId }: { projectId: string }) {
  const project = useLoad<ProjectDetail>("project.get", { project_id: projectId }, projectId);
  const packages = useLoad<Packages>("package.list", { project_id: projectId }, projectId);
  const plans = useLoad<Plans>("plan.list", { project_id: projectId }, projectId);
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
        </Page>
      )}
    </Loaded>
  );
}
