import { Router } from "express";
import { requireRole } from "../auth";
import { db } from "../db";

export const adminRouter = Router();

adminRouter.get("/api/admin/users", requireRole("ADMIN"), async (_req, res) => {
  res.json(await db.user.findMany({ select: { id: true, email: true, role: true } }));
});
