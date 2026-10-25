import { api } from "../api/client";
import { publishOrderPlaced } from "../events/publisher";

export function CartPage() {
  async function checkout(form: FormData) {
    const order = await api<{ id: string }>("/orders", { method: "POST", body: JSON.stringify({ coupon: form.get("coupon") }) });
    await publishOrderPlaced(order.id);
    window.location.assign(`/orders/${order.id}`);
  }
  return (
    <form id="checkout" action={checkout}>
      <input name="coupon" maxLength={20} />
      <button type="submit">Place order</button>
    </form>
  );
}
