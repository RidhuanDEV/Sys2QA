import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { db } from "../db";
import { sendEmail } from "../email";
import { loginSchema, registrationSchema } from "../validation";

export const authRouter = Router();

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

authRouter.post("/api/auth/register", async (req, res) => {
  const parsed = registrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  const user = await db.user.create({ data: { email: parsed.data.email, passwordHash: hash(parsed.data.password), nib: parsed.data.nib } });
  await sendEmail(user.email, "welcome", {});
  return res.status(201).json({ id: user.id });
});

authRouter.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ errors: parsed.error.flatten().fieldErrors });
  const user = await db.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || user.passwordHash !== hash(parsed.data.password)) return res.status(401).json({ error: "invalid credentials" });
  return res.json({ session: { userId: user.id, role: user.role } });
});

authRouter.post("/api/auth/password-reset/request", async (req, res) => {
  const user = await db.user.findUnique({ where: { email: String(req.body?.email ?? "") } });
  // Same answer whether or not the account exists.
  if (user) {
    const token = randomBytes(24).toString("hex");
    await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
    await sendEmail(user.email, "password-reset", { token });
  }
  return res.status(202).json({ status: "if the account exists, an email was sent" });
});

authRouter.post("/api/auth/password-reset/confirm", async (req, res) => {
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash: hash(String(req.body?.token ?? "")) } });
  if (!record || record.expiresAt.getTime() < Date.now()) return res.status(400).json({ error: "invalid or expired token" });
  const password = registrationSchema.shape.password.safeParse(req.body?.password);
  if (!password.success) return res.status(422).json({ errors: { password: ["too short"] } });
  await db.user.update({ where: { id: record.userId }, data: { passwordHash: hash(password.data) } });
  await db.passwordResetToken.deleteMany({ where: { userId: record.userId } });
  return res.status(204).end();
});
