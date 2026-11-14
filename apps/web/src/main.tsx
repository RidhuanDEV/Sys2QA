import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { takeToken } from "./api";
import { PackageScreen } from "./screens/package";
import { PlanScreen } from "./screens/plan";
import { ProjectScreen } from "./screens/project";
import { Home, StartWizard } from "./screens/start";
import { Announce } from "./ui";

function useRoute(): string[] {
  const read = () =>
    window.location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .filter(Boolean)
      .map((p) => decodeURIComponent(p));
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function Screen({ route }: { route: string[] }) {
  const [head, a, b, c, d] = route;
  if (head === "start") return <StartWizard />;
  if (head === "project" && a && b === "package" && c && d)
    return <PackageScreen projectId={a} packageId={c} version={Number(d)} />;
  if (head === "project" && a) return <ProjectScreen projectId={a} />;
  if (head === "plan" && a) return <PlanScreen planId={a} />;
  return <Home />;
}

function App({ token }: { token: string | null }) {
  const route = useRoute();
  const [message, setMessage] = useState("");
  const main = useRef<HTMLElement>(null);
  const announce = useCallback((m: string) => setMessage(m), []);
  return (
    <Announce.Provider value={announce}>
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header>
        <nav aria-label="Main">
          <a href="#/" className="brand">
            Sys2QA
          </a>
          <a href="#/">Projects</a>
          <a href="#/start">Start a project</a>
        </nav>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        {token ? (
          <Screen route={route} />
        ) : (
          <>
            <h1>Open Sys2QA from the launcher</h1>
            <p>
              This page needs the session link that <code>sys2qa ui</code> prints. Open that link; it carries a session
              token that only this computer knows.
            </p>
          </>
        )}
      </main>
      <div className="announcer" role="status" aria-live="polite">
        {message}
      </div>
    </Announce.Provider>
  );
}

const token = takeToken();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App token={token} />
  </StrictMode>,
);
