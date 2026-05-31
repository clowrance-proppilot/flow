import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import express, { type Express, type NextFunction, type Response } from "express";

export function registerStaticRoutes(
  server: Express,
  paths: { desktopFilePath: string; dashboardFilePath: string },
): void {
  const { desktopFilePath, dashboardFilePath } = paths;
  const desktopAssetsDir = join(dirname(desktopFilePath), "assets");
  const dashboardAssetsDir = join(dirname(dashboardFilePath), "assets");

  server.get("/", async (_req, res, next) => {
    await sendHtmlFile(res, next, desktopFilePath, "Desktop UI not built. Run: npm run build:desktop");
  });

  server.get("/dashboard", async (_req, res, next) => {
    await sendHtmlFile(res, next, dashboardFilePath, "Dashboard UI not built.");
  });

  server.use("/assets", express.static(desktopAssetsDir));
  server.use("/dashboard/assets", express.static(dashboardAssetsDir));
  server.use((_req, res) => res.status(404).json({ ok: false }));
}

async function sendHtmlFile(res: Response, next: NextFunction, path: string, missingMessage: string): Promise<void> {
  try {
    res.type("html").send(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) {
      res.status(404).send(missingMessage);
      return;
    }
    next(error);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
