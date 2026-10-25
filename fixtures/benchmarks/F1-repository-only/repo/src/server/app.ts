import express from "express";
import { config } from "./config";
import { scheduleCleanup } from "./jobs/cleanup";
import { registerReportPlugins } from "./plugins";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { ordersRouter } from "./routes/orders";

export const app = express();
app.use(express.json());
app.use(authRouter);
app.use(ordersRouter);
app.use(adminRouter);
registerReportPlugins(app);

if (process.env.NODE_ENV !== "test") {
  scheduleCleanup();
  app.listen(config.port);
}
