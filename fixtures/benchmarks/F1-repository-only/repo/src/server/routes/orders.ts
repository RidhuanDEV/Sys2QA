import { Router } from "express";
import { requireRole, requireSession, type Session } from "../auth";
import { db } from "../db";
import { sendEmail } from "../email";
import { canTransition, type OrderStatus } from "../orders/state";
import { orderSchema } from "../validation";

export const ordersRouter = Router();

ordersRouter.post("/api/orders", requireSession, async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  const session = (req as typeof req & { session: Session }).session;
  const order = await db.order.create({ data: { customerId: session.userId, amount: parsed.data.amount, status: "SUBMITTED" } });
  return res.status(201).json({ id: order.id, status: "SUBMITTED" });
});

ordersRouter.get("/api/orders/:id", requireSession, async (req, res) => {
  const order = await db.order.findUnique({ where: { id: req.params.id } });
  return order ? res.json(order) : res.status(404).json({ error: "not found" });
});

ordersRouter.post("/api/orders/:id/decision", requireRole("ADMIN"), async (req, res) => {
  const order = await db.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "not found" });
  const next: OrderStatus = req.body?.approve === true ? "APPROVED" : "REJECTED";
  if (!canTransition(order.status as OrderStatus, next)) return res.status(409).json({ error: `cannot move from ${order.status} to ${next}` });
  const session = (req as typeof req & { session: Session }).session;
  await db.order.update({ where: { id: order.id }, data: { status: next, approvedBy: session.userId } });
  if (next === "APPROVED") await sendEmail(order.customerId, "order-approved", { orderId: order.id });
  return res.json({ id: order.id, status: next });
});
