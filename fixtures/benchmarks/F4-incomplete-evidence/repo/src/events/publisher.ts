import { api } from "../api/client";

/** Publishes an order event; it is consumed by the fulfillment service in another repository. */
export function publishOrderPlaced(orderId: string): Promise<void> {
  return api("/events", { method: "POST", body: JSON.stringify({ topic: "orders.placed", orderId }) });
}
