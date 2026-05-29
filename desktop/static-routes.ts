import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import express, { type Express } from "express";

export function registerStaticRoutes(
  server: Express,
  paths: { desktopFilePath: string; dashboardFilePath: string },
): void {
  const { desktopFilePath, dashboardFilePath } = paths;
  const desktopAssetsDir = join(dirname(desktopFilePath), "assets");
  const dashboardAssetsDir = join(dirname(dashboardFilePath), "assets");

  server.get("/", (_req, res) => {
    if (!existsSync(desktopFilePath)) {
      res.status(404).send("Desktop UI not built. Run: npm run build:desktop");
      return;
    }
    res.type("html").send(readFileSync(desktopFilePath, "utf8"));
  });

  server.get("/dashboard", (_req, res) => {
    if (!existsSync(dashboardFilePath)) {
      res.status(404).send("Dashboard UI not built.");
      return;
    }
    res.type("html").send(readFileSync(dashboardFilePath, "utf8"));
  });

  server.use("/assets", express.static(desktopAssetsDir));
  server.use("/dashboard/assets", express.static(dashboardAssetsDir));
  server.use((_req, res) => res.status(404).json({ ok: false }));
}
