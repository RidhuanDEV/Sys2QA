export type OrderStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "SHIPPED";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED"],
  APPROVED: ["SHIPPED"],
  REJECTED: [],
  SHIPPED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
