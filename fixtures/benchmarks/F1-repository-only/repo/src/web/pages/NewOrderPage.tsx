export function NewOrderPage() {
  async function submit(form: FormData) {
    await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: Number(form.get("amount")) }) });
  }
  return (
    <form id="new-order" action={submit}>
      <input name="amount" type="number" min={1} max={10000} required />
      <button type="submit">Submit order</button>
    </form>
  );
}
