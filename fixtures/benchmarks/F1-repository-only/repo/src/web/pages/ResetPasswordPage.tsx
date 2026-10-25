export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get("token");
  async function request(form: FormData) {
    await fetch("/api/auth/password-reset/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
  }
  async function confirm(form: FormData) {
    await fetch("/api/auth/password-reset/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: form.get("password") }) });
  }
  return token ? (
    <form id="reset-confirm" action={confirm}>
      <input name="password" type="password" minLength={12} required />
      <button type="submit">Set new password</button>
    </form>
  ) : (
    <form id="reset-request" action={request}>
      <input name="email" type="email" required />
      <button type="submit">Send reset link</button>
    </form>
  );
}
