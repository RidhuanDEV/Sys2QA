import cron from "node-cron";
import { db } from "../db";

/** Nightly at 03:00: removes expired password-reset tokens and drafts older than 30 days. */
export function scheduleCleanup(): void {
  cron.schedule("0 3 * * *", async () => {
    await db.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await db.order.deleteMany({ where: { status: "DRAFT", updatedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
  });
}
