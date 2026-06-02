import { app, BrowserWindow, session } from "electron";
import { join, resolve, dirname } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { DesktopActionRouter } from "./action-router.js";
import { DesktopProjectRegistry, type DesktopProjectRecord } from "./project-registry.js";
import { DesktopPromptRouter } from "./prompt-router.js";
import { registerProjectRoutes } from "./project-routes.js";
import { message } from "./route-helpers.js";
import type { DesktopProjectSurface, RouteContext } from "./route-types.js";
import { registerStaticRoutes } from "./static-routes.js";
import { registerWorkRoutes } from "./work-routes.js";
import { nextAutoflowReconcileDelay, runEnabledProjectAutoflowReconcile } from "./autoflow-reconcile.js";
import { DesktopSurfaceFactory } from "./surface-factory.js";
import { DesktopAgentSessionAdapterImpl } from "./agent-session-adapter.js";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let dashboardServer: Server | undefined;
let rendererAutoReloadWatcher: FSWatcher | undefined;
let rendererAutoReloadTimer: ReturnType<typeof setTimeout> | undefined;
const localApiToken = randomBytes(32).toString("hex");

// Resolve the flow repo root. In dev this is the repo itself;
// in a packaged build we use cwd or an env override.
function resolveFlowRoot(): string {
  if (process.env.FLOW_ROOT) return process.env.FLOW_ROOT;
  return resolveAppAssetRoot();
}

function resolveAppAssetRoot(): string {
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
  const projectRegistry = new DesktopProjectRegistry({
    dbPath: join(resolveDesktopUserDataPath(), "flow-desktop-state.db"),
  });
  await projectRegistry.addProject(flowRoot);

  const surfaceFactory = new DesktopSurfaceFactory({
    desktopAgentDisabled: process.env.FLOW_DESKTOP_AGENT === "disabled",
  });

  const projectSurface = async (project: DesktopProjectRecord): Promise<DesktopProjectSurface> => {
    return surfaceFactory.getSurface(project);
  };

  const agent = new DesktopAgentSessionAdapterImpl({
    getPiSessionDriver: async () => {
      const project = await projectRegistry.activeProject();
      if (!project) throw new Error("No active Flow project.");
      const surface = await projectSurface(project);
      return surface.piSessionDriver;
    },
    getAutoflowRunner: async () => {
      const project = await projectRegistry.activeProject();
      if (!project) throw new Error("No active Flow project.");
      const surface = await projectSurface(project);
      return surface.autoflowRunner;
    },
  });

  const promptRouter = new DesktopPromptRouter({
    projects: projectRegistry,
    ledgerForProject: async (project) => (await projectSurface(project)).configured.workflowLedger,
    agent,
  });
  const actionRouter = new DesktopActionRouter({
    projects: projectRegistry,
    runtimeForProject: async (project) => (await projectSurface(project)).configured.runtime,
    ledgerForProject: async (project) => (await projectSurface(project)).configured.workflowLedger,
  });
  const assetRoot = resolveAppAssetRoot();
  const desktopFilePath = resolveDesktopFilePath(assetRoot);
  const dashboardFilePath = resolveDashboardFilePath(assetRoot);
  const server = express();
  server.disable("x-powered-by");
  const jsonBody = express.json({ limit: "256kb" });

  // Local trust boundary: require auth token for all API routes
  server.use((req, res, next) => {
    // Health check and static assets are unauthenticated
    if (req.path === "/healthz" || (req.method === "GET" && !req.path.startsWith("/api/"))) {
      next();
      return;
    }
    const token = req.headers["x-flow-token"] ?? req.query._token;
    if (token !== localApiToken) {
      res.status(403).json({ ok: false, error: "Forbidden" });
      return;
    }
    next();
  });

  // Security headers for all responses
  server.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Cache-Control", "no-store");
    next();
  });

  const routeContext: RouteContext = {
    projectRegistry,
    projectSurface,
    invalidateProjectSurface: (projectId) => surfaceFactory.invalidate(projectId),
  };
  registerProjectRoutes(server, routeContext, jsonBody);
  registerWorkRoutes(server, routeContext, { promptRouter, actionRouter }, jsonBody);
  registerStaticRoutes(server, { desktopFilePath, dashboardFilePath });

  let autoflowReconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let autoflowReconcileStopped = false;
  const scheduleAutoflowReconcile = async (): Promise<void> => {
    const summary = await runEnabledProjectAutoflowReconcile(projectRegistry, projectSurface);
    if (autoflowReconcileStopped) return;
    autoflowReconcileTimer = setTimeout(() => {
      void scheduleAutoflowReconcile();
    }, nextAutoflowReconcileDelay(summary));
  };
  void scheduleAutoflowReconcile();

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
    listener.on("close", () => {
      autoflowReconcileStopped = true;
      if (autoflowReconcileTimer) clearTimeout(autoflowReconcileTimer);
    });
    dashboardServer = listener;
  });
}

function createWindow(port: number): BrowserWindow {
  // Set CSP on the default session before creating the window
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; " +
          "font-src 'self'; " +
          "connect-src 'self'; " +
          "base-uri 'none'; " +
          "form-action 'none'; " +
          "frame-ancestors 'none'",
        ],
      },
    });
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#050914",
    show: false,
    title: "Flow",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Pass the local API token via query parameter
  void window.loadURL(`http://127.0.0.1:${port}/?_token=${localApiToken}`);

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

  mainWindow = createWindow(port);
  enableRendererAutoReload(flowRoot);

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
  rendererAutoReloadWatcher?.close();
  rendererAutoReloadWatcher = undefined;
  if (rendererAutoReloadTimer) clearTimeout(rendererAutoReloadTimer);
  rendererAutoReloadTimer = undefined;
  dashboardServer?.close();
});

function resolveDesktopUserDataPath(): string {
  return process.env.FLOW_DESKTOP_USER_DATA || app.getPath("userData");
}

function enableRendererAutoReload(flowRoot: string): void {
  if (!isDev || process.env.FLOW_DESKTOP_AUTO_RELOAD !== "1") return;
  const rendererRoot = join(flowRoot, "dist", "desktop-renderer");
  if (!existsSync(rendererRoot)) return;
  try {
    rendererAutoReloadWatcher?.close();
    rendererAutoReloadWatcher = watch(rendererRoot, { recursive: true }, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (rendererAutoReloadTimer) clearTimeout(rendererAutoReloadTimer);
      rendererAutoReloadTimer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        void mainWindow.webContents.reloadIgnoringCache();
      }, 120);
    });
    console.log(`[flow-desktop] renderer auto reload watching ${rendererRoot}`);
  } catch (error) {
    console.warn(`[flow-desktop] renderer auto reload unavailable: ${message(error)}`);
  }
}

