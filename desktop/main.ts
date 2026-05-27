import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join, resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import type { Server } from "node:http";
import { DashboardState } from "../src/dashboard-state.js";
import { validateFlowConfig } from "../src/config/config-loader.js";
import { createConfiguredWorkRuntime } from "../src/runtime-factory.js";
import { PiSessionDriver } from "./pi-session-driver.js";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let dashboardServer: Server | undefined;

// Resolve the flow repo root. In dev this is the repo itself;
// in a packaged build we use cwd or an env override.
function resolveFlowRoot(): string {
  if (process.env.FLOW_ROOT) return process.env.FLOW_ROOT;
  // Walk up from this file to find package.json + src/ + bin/
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (
      existsSync(join(cursor, "package.json")) &&
      existsSync(join(cursor, "src")) &&
      existsSync(join(cursor, "bin"))
    ) {
      return cursor;
    }
    cursor = resolve(cursor, "..");
  }
  return process.cwd();
}

function resolveDesktopFilePath(flowRoot: string): string {
  const candidates = [
    join(flowRoot, "dist", "desktop-renderer", "index.html"),
    join(flowRoot, ".tmp", "desktop-renderer", "index.html"),
    join(flowRoot, "dist", "dashboard", "index.html"),
    join(flowRoot, ".tmp", "dashboard", "index.html"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function resolveDashboardFilePath(flowRoot: string): string {
  const candidates = [
    join(flowRoot, "dist", "dashboard", "index.html"),
    join(flowRoot, ".tmp", "dashboard", "index.html"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function startDashboardServer(flowRoot: string): Promise<number> {
  const configValidation = await validateFlowConfig({ projectRoot: flowRoot });
  const configuredRuntime = createConfiguredWorkRuntime({
    projectRoot: flowRoot,
    flowConfig: configValidation.config,
  });
  const dashboardState = new DashboardState({ runtime: configuredRuntime.runtime });
  const piSessionDriver = new PiSessionDriver({
    runtime: configuredRuntime.runtime,
    repoRoot: flowRoot,
    flowSessionId: "desktop",
  });
  const desktopFilePath = resolveDesktopFilePath(flowRoot);
  const dashboardFilePath = resolveDashboardFilePath(flowRoot);
  const desktopAssetsDir = join(dirname(desktopFilePath), "assets");
  const dashboardAssetsDir = join(dirname(dashboardFilePath), "assets");

  const server = express();
  server.disable("x-powered-by");
  server.use(express.json({ limit: "256kb" }));

  // Health
  server.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Dashboard snapshot API — same shape as dashboard-server.ts
  server.get("/api/dashboard", async (_req, res) => {
    try {
      const payload = await dashboardState.payload({ limit: 50 });
      res.json(payload);
    } catch (error) {
      console.error("[flow-desktop] dashboard snapshot failed:", error);
      res.status(503).json({ ok: false });
    }
  });
  server.get("/api/pi/issues", async (_req, res) => {
    try {
      const payload = await dashboardState.payload({ limit: 50 });
      res.json({
        ok: true,
        issues: Array.isArray(payload.issues) ? payload.issues : [],
      });
    } catch (error) {
      console.error("[flow-desktop] pi issue list failed:", error);
      res.status(503).json({ ok: false });
    }
  });
  server.post("/api/pi/issues/:issueRef/session", async (req, res) => {
    try {
      const issueRef = String(req.params.issueRef ?? "").trim();
      if (!issueRef) {
        res.status(400).json({ ok: false, error: "Missing issueRef." });
        return;
      }
      const session = await piSessionDriver.startSession(issueRef);
      res.json({ ok: true, session });
    } catch (error) {
      console.error("[flow-desktop] pi session start failed:", error);
      res.status(503).json({ ok: false, error: message(error) });
    }
  });
  server.get("/api/pi/sessions/:sessionId", async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId." });
        return;
      }
      const session = await piSessionDriver.getSession(sessionId);
      res.json({ ok: true, session });
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });
  server.post("/api/pi/sessions/:sessionId/prompts", async (req, res) => {
    try {
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId." });
        return;
      }
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      const session = await piSessionDriver.postPrompt(sessionId, prompt);
      res.json({ ok: true, session });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });

  // Dashboard HTML
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

  // Desktop and dashboard static assets
  server.use("/assets", express.static(desktopAssetsDir));
  server.use("/dashboard/assets", express.static(dashboardAssetsDir));

  // 404
  server.use((_req, res) => res.status(404).json({ ok: false }));

  // Find a free port
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, "127.0.0.1", () => {
      const addr = listener.address();
      if (typeof addr === "object" && addr) {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server port"));
      }
    });
    listener.on("error", reject);
    dashboardServer = listener;
  });
}

function createWindow(port: number): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#050914",
    show: false,
    title: "Flow",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  void window.loadURL(`http://127.0.0.1:${port}/`);

  if (isDev) {
    window.webContents.openDevTools({ mode: "detach" });
  }

  return window;
}

app.whenReady().then(async () => {
  const flowRoot = resolveFlowRoot();
  console.log(`[flow-desktop] flow root: ${flowRoot}`);

  const port = await startDashboardServer(flowRoot);
  console.log(`[flow-desktop] dashboard server on http://127.0.0.1:${port}`);

  // --- IPC handlers for future thread/session features ---
  ipcMain.handle("flow:ping", () => "flow desktop ready");

  ipcMain.handle("flow:openExternal", async (_event, url: string) => {
    const parsed = new URL(url);
    if (["http:", "https:"].includes(parsed.protocol)) {
      await shell.openExternal(url);
    }
  });

  mainWindow = createWindow(port);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(port);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    dashboardServer?.close();
    app.quit();
  }
});

app.on("before-quit", () => {
  dashboardServer?.close();
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
