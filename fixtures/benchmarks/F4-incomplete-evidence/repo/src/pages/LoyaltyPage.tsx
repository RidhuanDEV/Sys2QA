import { api } from "../api/client";

export function LoyaltyPage() {
  async function join() {
    await api("/loyalty/members", { method: "POST" });
  }
  return <button onClick={join}>Join the loyalty program</button>;
}
