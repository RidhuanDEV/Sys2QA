// Legacy CSV export from the 2021 portal. Not mounted anywhere since the v1.2 rewrite.
import { Router } from "express";

export const legacyExportRouter = Router();

legacyExportRouter.get("/api/legacy/export.csv", (_req, res) => {
  res.type("text/csv").send("id,email\n");
});
