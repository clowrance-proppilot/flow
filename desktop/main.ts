import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join, resolve, dirname } from "node:path";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import type { Server } from "node:http";
import { DashboardState } from "../src/dashboard-state.js";
import { validateFlowConfig } from "../src/config/config-loader.js";
import { createConfiguredWorkRuntime } from "../src/runtime-factory.js";
import { GitAdapter } from "../src/adapters/git.js";
import { DesktopActionRouter } from "./action-router.js";
import { PiAgentOrchestrator } from "./pi-agent-orchestrator.js";
import { PiSessionDriver } from "./pi-session-driver.js";
import { DesktopProjectRegistry, type DesktopProjectRecord } from "./project-registry.js";
import { DesktopPromptRouter, type DesktopAgentSessionAdapter } from "./prompt-router.js";
import { registerProjectRoutes } from "./project-routes.js";
import { message } from "./route-helpers.js";
import type { DesktopProjectSurface, RouteContext } from "./route-types.js";
import { registerStaticRoutes } from "./static-routes.js";
import { registerWorkRoutes } from "./work-routes.js";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let dashboardServer: Server | undefined;
let rendererAutoReloadWatcher: FSWatcher | undefined;
let rendererAutoReloadTimer: ReturnType<typeof setTimeout> | undefined;

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
    statePath: join(resolveDesktopUserDataPath(), "projects.json"),
  });
  await projectRegistry.addProject(flowRoot);
  const projectSurfaces = new Map<string, DesktopProjectSurface>();
  const projectSurface = async (project: DesktopProjectRecord): Promise<DesktopProjectSurface> => {
    const cached = projectSurfaces.get(project.id);
    if (cached && cached.project.root === project.root) return cached;
    const configValidation = await validateFlowConfig({ projectRoot: project.root });
    const configured = createConfiguredWorkRuntime({
      projectRoot: project.root,
      flowConfig: configValidation.config,
    });
    const dashboardState = new DashboardState({ runtime: configured.runtime });
    const piSessionDriver = new PiSessionDriver({
      runtime: configured.runtime,
      repoRoot: project.root,
      flowSessionId: `desktop-${project.id}`,
      agent: process.env.FLOW_DESKTOP_AGENT === "disabled" ? false : undefined,
    });
    const git = new GitAdapter();
    const surface: DesktopProjectSurface = {
      project,
      configured,
      dashboardState,
      piSessionDriver,
      piAgentOrchestrator: new PiAgentOrchestrator({
        projectId: project.id,
        runtime: configured.runtime,
        piSessionDriver,
        enabled: () => project.autoflowEnabled !== false,
        gitInspect: async (path: string) => {
          const status = await git.inspect(path);
          return { dirty: status.dirty, entries: status.entries };
        },
      }),
    };
    projectSurfaces.set(project.id, surface);
    return surface;
  };

  const agent: DesktopAgentSessionAdapter = {
    async sendPrompt(input) {
      if (!input.issueRef) {
        return { summary: "Prompt recorded for project context." };
      }
      const surface = await projectSurface(input.project);
      const session = input.sessionId
        ? await surface.piSessionDriver.getSession(input.sessionId).catch(() => undefined)
        : undefined;
      void surface.piAgentOrchestrator.sendUserMessage({
        issueRef: input.issueRef,
        sessionId: session?.id,
        text: input.prompt,
      }).catch((error) => {
        console.error("[flow-desktop] pi prompt failed:", error);
      });
      const target = session ?? await surface.piSessionDriver.openOrCreateIssueSession(input.issueRef);
      const summary = `Prompt sent to ${target.issueRef}.`;
      return {
        session: {
          id: target.id,
          provider: "pi",
          workspacePath: target.workspacePath,
          status: "active",
          summary,
        },
        summary,
      };
    },
  };

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

  const routeContext: RouteContext = {
    projectRegistry,
    projectSurface,
    invalidateProjectSurface: (projectId) => projectSurfaces.delete(projectId),
  };
  registerProjectRoutes(server, routeContext, jsonBody);
  registerWorkRoutes(server, routeContext, { promptRouter, actionRouter }, jsonBody);
  registerStaticRoutes(server, { desktopFilePath, dashboardFilePath });

  const autoflowInterval = setInterval(() => {
    void runEnabledProjectAutoflowReconcile(projectRegistry, projectSurface);
  }, 30000);
  void runEnabledProjectAutoflowReconcile(projectRegistry, projectSurface);

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
    listener.on("close", () => clearInterval(autoflowInterval));
    dashboardServer = listener;
  });
}

export async function runEnabledProjectAutoflowReconcile(
  projectRegistry: DesktopProjectRegistry,
  projectSurface: (project: DesktopProjectRecord) => Promise<DesktopProjectSurface>,
): Promise<void> {
  const projects = await projectRegistry.listProjects();
  await Promise.all(projects.filter((project) => project.valid && project.autoflowEnabled !== false).map(async (project) => {
    const surface = await projectSurface(project);
    await surface.piAgentOrchestrator.reconcile();
  }));
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

