import { useParams } from "react-router-dom";

export function OrderPage() {
  const { id } = useParams();
  async function decide(approve: boolean) {
    await fetch(`/api/orders/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
  }
  return (
    <section id="order-decision">
      <button onClick={() => decide(true)}>Approve</button>
      <button onClick={() => decide(false)}>Reject</button>
    </section>
  );
}
