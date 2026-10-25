export function LoginPage() {
  async function submit(form: FormData) {
    await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
  }
  return (
    <form id="login" action={submit}>
      <input name="email" type="email" required />
      <input name="password" type="password" required />
      <a href="/reset-password">Forgot password?</a>
      <button type="submit">Log in</button>
    </form>
  );
}
