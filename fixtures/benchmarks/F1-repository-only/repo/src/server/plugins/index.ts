import type { Express } from "express";
import { config } from "../config";

// Report routes are registered from configuration at start-up; their paths are not visible statically.
export function registerReportPlugins(app: Express): void {
  for (const name of config.reportPlugins) {
    app.get(`/api/reports/${name}`, async (_req, res) => {
      const plugin = (await import(`./reports/${name}`)) as { run(): Promise<unknown> };
      res.json(await plugin.run());
    });
  }
}
