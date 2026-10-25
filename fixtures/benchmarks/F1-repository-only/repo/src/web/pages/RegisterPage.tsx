import { useState } from "react";

export function RegisterPage() {
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  async function submit(form: FormData) {
    const res = await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
    if (res.status === 422) setErrors((await res.json()).errors);
  }
  return (
    <form id="register" action={submit}>
      <input name="email" type="email" required />
      <input name="password" type="password" minLength={12} required />
      <input name="nib" inputMode="numeric" pattern="[0-9]{13}" maxLength={13} required />
      <button type="submit">Create account</button>
      {Object.entries(errors).map(([field, messages]) => (
        <p key={field}>{messages.join(", ")}</p>
      ))}
    </form>
  );
}
