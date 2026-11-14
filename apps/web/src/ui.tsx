import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { call, type Result, type ServiceError } from "./api";

/** Polite announcements for screen readers (NFR-009): results of actions, not only visual changes. */
export const Announce = createContext<(message: string) => void>(() => undefined);
export const useAnnounce = () => useContext(Announce);

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;

/** Loads one read operation; reloads when the key changes or on demand. */
export function useLoad<T>(operation: string, input: Record<string, unknown>, key: string) {
  const [result, setResult] = useState<Result<T> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setResult(null);
    void call<T>(operation, input).then((r) => live && setResult(r));
    return () => {
      live = false;
    };
    // `key` stands for the input, which callers rebuild on every render.
  }, [operation, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { result, reload };
}

/** Runs a write operation, announces the outcome and keeps the error for display. */
export function useAction() {
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServiceError | null>(null);
  const run = useCallback(
    async <T,>(operation: string, input: Record<string, unknown>, done?: string): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      announce("Working…");
      const r = await call<T>(operation, input);
      setBusy(false);
      if (!r.ok) {
        setError(r.error);
        announce(`Failed: ${r.error.message}`);
        return undefined;
      }
      if (done) announce(done);
      return r.data;
    },
    [announce],
  );
  return { run, busy, error, clearError: () => setError(null) };
}

/** A page: its heading takes focus when the page opens, so keyboard and screen-reader users land on it. */
export function Page(props: { title: string; children: ReactNode; lead?: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    document.title = `${props.title} · Sys2QA`;
  }, [props.title]);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        {props.title}
      </h1>
      {props.lead}
      {props.children}
    </>
  );
}

export function ErrorBox({ error }: { error: ServiceError }) {
  return (
    <div className="error" role="alert">
      <p>
        <strong>Error {error.code}:</strong> {error.message}
      </p>
      <p>Next: {error.remediation}</p>
    </div>
  );
}

/** Shows loading, an error, or the loaded data. */
export function Loaded<T>(props: { result: Result<T> | null; children: (data: T) => ReactNode; what: string }) {
  if (!props.result)
    return (
      <p className="muted" aria-busy="true">
        Loading {props.what}…
      </p>
    );
  if (!props.result.ok) return <ErrorBox error={props.result.error} />;
  return <>{props.children(props.result.data)}</>;
}

const TONE: Record<string, string> = {
  ready: "good",
  approved: "good",
  current: "good",
  source_verified: "good",
  reconstructed: "good",
  available: "good",
  active: "good",
  confirmed: "good",
  review_only: "warn",
  pending_review: "warn",
  potentially_stale: "warn",
  partial: "warn",
  partially_reconstructed: "warn",
  needs_clarification: "warn",
  inferred: "warn",
  draft: "neutral",
  limited: "warn",
  blocked: "bad",
  stale: "bad",
  rejected: "bad",
  contradicted: "bad",
  unavailable: "neutral",
  unresolved: "bad",
};
const MARK: Record<string, string> = { good: "✓", warn: "!", bad: "✕", neutral: "•" };

/** A status always carries its words and a symbol; color only repeats them (NFR-009). */
export function Status({ value, label }: { value: string | null | undefined; label?: string }) {
  const v = value ?? "unknown";
  const tone = TONE[v] ?? "neutral";
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden="true">{MARK[tone]} </span>
      {label ? `${label}: ` : ""}
      {v.replaceAll("_", " ")}
    </span>
  );
}

/** The evidence profile and what it cannot establish, shown wherever a package is summarized (SYS-004). */
export function EvidenceProfile({ profile }: { profile: Record<string, unknown> | null | undefined }) {
  if (!profile) return <p>This package states no evidence profile.</p>;
  const cannot = (profile.cannot_establish as string[] | undefined) ?? [];
  return (
    <section aria-labelledby="evidence-profile">
      <h2 id="evidence-profile">Evidence profile</h2>
      <ul className="inline">
        {(["source_analysis", "runtime_observation", "documentation_import", "revision_correspondence"] as const).map(
          (k) => (
            <li key={k}>
              <Status value={String(profile[k] ?? "unknown")} label={k.replaceAll("_", " ")} />
            </li>
          ),
        )}
      </ul>
      <h3>What this evidence cannot establish</h3>
      {cannot.length === 0 ? (
        <p>Nothing is listed.</p>
      ) : (
        <ul>
          {cannot.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>
        {props.label}
        {props.required ? " (required)" : ""}
      </label>
      {props.hint ? (
        <p className="hint" id={`${props.id}-hint`}>
          {props.hint}
        </p>
      ) : null}
      <input
        id={props.id}
        type={props.type ?? "text"}
        value={props.value}
        required={props.required}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}
