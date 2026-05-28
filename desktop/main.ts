import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join, resolve, dirname } from "node:path";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import type { Server } from "node:http";
import { DashboardState } from "../src/dashboard-state.js";
import { validateFlowConfig } from "../src/config/config-loader.js";
import { createConfiguredWorkRuntime } from "../src/runtime-factory.js";
import { DesktopActionRouter, isDesktopAction } from "./action-router.js";
import { PiSessionDriver } from "./pi-session-driver.js";
import { DesktopProjectRegistry, type DesktopProjectRecord } from "./project-registry.js";
import { DesktopPromptRouter, type DesktopAgentSessionAdapter } from "./prompt-router.js";

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let dashboardServer: Server | undefined;
let rendererAutoReloadWatcher: FSWatcher | undefined;
let rendererAutoReloadTimer: ReturnType<typeof setTimeout> | undefined;

interface DesktopProjectSurface {
  project: DesktopProjectRecord;
  configured: ReturnType<typeof createConfiguredWorkRuntime>;
  dashboardState: DashboardState;
  piSessionDriver: PiSessionDriver;
}

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
    const surface: DesktopProjectSurface = {
      project,
      configured,
      dashboardState: new DashboardState({ runtime: configured.runtime }),
      piSessionDriver: new PiSessionDriver({
        runtime: configured.runtime,
        repoRoot: project.root,
        flowSessionId: `desktop-${project.id}`,
        agent: process.env.FLOW_DESKTOP_AGENT === "disabled" ? false : undefined,
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
      let session = input.sessionId
        ? await surface.piSessionDriver.getSession(input.sessionId).catch(() => undefined)
        : undefined;
      session ??= await surface.piSessionDriver.openOrCreateIssueSession(input.issueRef);
      const updated = await surface.piSessionDriver.sendUserMessage(session.id, { text: input.prompt });
      const summary = latestAssistantText(updated) || `Prompt queued for ${updated.issueRef}.`;
      return {
        session: {
          id: updated.id,
          provider: "pi",
          workspacePath: updated.workspacePath,
          status: updated.status,
          summary,
        },
        artifacts: [artifactFromPiSession(updated, summary)],
        summary,
        error: updated.error,
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
  const desktopAssetsDir = join(dirname(desktopFilePath), "assets");
  const dashboardAssetsDir = join(dirname(dashboardFilePath), "assets");

  const server = express();
  server.disable("x-powered-by");
  const jsonBody = express.json({ limit: "256kb" });

  // Health
  server.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Dashboard snapshot API — same shape as dashboard-server.ts
  server.get("/api/dashboard", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const payload = await surface.dashboardState.payload({ limit: 50 });
      res.json(payload);
    } catch (error) {
      console.error("[flow-desktop] dashboard snapshot failed:", error);
      res.status(503).json({ ok: false });
    }
  });
  server.get("/api/projects", async (_req, res) => {
    const active = await projectRegistry.activeProject();
    const projects = await projectRegistry.listProjects();
    const projectsWithSummary = await Promise.all(projects.map(async (project) => {
      try {
        const surface = await projectSurface(project);
        const payload = await surface.dashboardState.payload({ limit: 50 });
        const summary = summarizeProjectIssues(payload.issues);
        return {
          ...project,
          attentionCount: summary.blocked + summary.needsInput,
          statusCounts: summary,
        };
      } catch {
        return {
          ...project,
          attentionCount: 0,
          statusCounts: summarizeProjectIssues(undefined),
        };
      }
    }));
    res.json({
      ok: true,
      activeProjectId: active?.id,
      projects: projectsWithSummary,
    });
  });
  server.post("/api/projects", jsonBody, async (req, res) => {
    try {
      const root = typeof req.body?.root === "string" ? req.body.root : "";
      if (!root.trim()) {
        res.status(400).json({ ok: false, error: "Missing project root." });
        return;
      }
      const project = await projectRegistry.addProject(root);
      projectSurfaces.delete(project.id);
      res.json({ ok: true, project, projects: await projectRegistry.listProjects() });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });
  server.post("/api/projects/:projectId/active", async (req, res) => {
    try {
      const project = await projectRegistry.setActiveProject(String(req.params.projectId ?? ""));
      res.json({ ok: true, project });
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });
  server.get("/api/context", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const dashboard = await surface.dashboardState.payload({ limit: 50 });
      const context = surface.configured.workflowLedger.readContext
        ? await surface.configured.workflowLedger.readContext({ projectId: project.id })
        : undefined;
      res.json({ ok: true, project, dashboard, context });
    } catch (error) {
      res.status(503).json({ ok: false, error: message(error) });
    }
  });
  server.post("/api/prompt", jsonBody, async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      const result = await promptRouter.submit({
        prompt,
        projectId: typeof req.body?.projectId === "string" ? req.body.projectId : undefined,
        issueRef: typeof req.body?.issueRef === "string" ? req.body.issueRef : undefined,
        threadId: typeof req.body?.threadId === "string" ? req.body.threadId : undefined,
        sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
        target: isPromptTarget(req.body?.target) ? req.body.target : undefined,
        artifactRefs: Array.isArray(req.body?.artifactRefs) ? req.body.artifactRefs.map(String).filter(Boolean) : undefined,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });
  server.post("/api/issues/:issueRef/session", async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const session = await surface.piSessionDriver.openOrCreateIssueSession(String(req.params.issueRef ?? ""));
      res.json({ ok: true, session });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });
  server.get("/api/sessions/:sessionId/events", async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const sessionId = String(req.params.sessionId ?? "");
      await surface.piSessionDriver.getSession(sessionId);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, sessionId })}\n\n`);
      const unsubscribe = surface.piSessionDriver.subscribe(sessionId, (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      req.on("close", unsubscribe);
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });
  server.post("/api/actions/:action", jsonBody, async (req, res) => {
    try {
      const action = String(req.params.action ?? "");
      if (!isDesktopAction(action)) {
        res.status(404).json({ ok: false, error: "Unknown desktop action." });
        return;
      }
      const result = await actionRouter.invoke({
        action,
        projectId: typeof req.body?.projectId === "string" ? req.body.projectId : undefined,
        issueRef: typeof req.body?.issueRef === "string" ? req.body.issueRef : undefined,
        payload: typeof req.body?.payload === "object" && req.body.payload !== null ? req.body.payload : {},
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error) });
    }
  });
  server.get("/api/pi/issues", async (_req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const payload = await surface.dashboardState.payload({ limit: 50 });
      res.json({
        ok: true,
        project,
        issues: Array.isArray(payload.issues) ? payload.issues : [],
      });
    } catch (error) {
      console.error("[flow-desktop] pi issue list failed:", error);
      res.status(503).json({ ok: false });
    }
  });
  server.post("/api/pi/issues/:issueRef/session", async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const issueRef = String(req.params.issueRef ?? "").trim();
      if (!issueRef) {
        res.status(400).json({ ok: false, error: "Missing issueRef." });
        return;
      }
      const session = await surface.piSessionDriver.startSession(issueRef);
      res.json({ ok: true, session });
    } catch (error) {
      console.error("[flow-desktop] pi session start failed:", error);
      res.status(503).json({ ok: false, error: message(error) });
    }
  });
  server.get("/api/pi/sessions/:sessionId", async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId." });
        return;
      }
      const session = await surface.piSessionDriver.getSession(sessionId);
      res.json({ ok: true, session });
    } catch (error) {
      res.status(404).json({ ok: false, error: message(error) });
    }
  });
  server.post("/api/pi/sessions/:sessionId/prompts", jsonBody, async (req, res) => {
    try {
      const project = await requireActiveProject(projectRegistry);
      const surface = await projectSurface(project);
      const sessionId = String(req.params.sessionId ?? "").trim();
      if (!sessionId) {
        res.status(400).json({ ok: false, error: "Missing sessionId." });
        return;
      }
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      const session = await surface.piSessionDriver.postPrompt(sessionId, prompt);
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requireActiveProject(projectRegistry: DesktopProjectRegistry): Promise<DesktopProjectRecord> {
  const project = await projectRegistry.activeProject();
  if (!project) throw new Error("No active Flow project.");
  return project;
}

function isPromptTarget(value: unknown): value is "project" | "issue" | "thread" | "session" | "artifact" {
  return value === "project" || value === "issue" || value === "thread" || value === "session" || value === "artifact";
}

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

function latestAssistantText(session: { timeline: Array<{ role: string; content: string }> }): string {
  return [...session.timeline].reverse().find((item) => item.role === "assistant")?.content.trim() ?? "";
}

type ProjectIssueSummary = {
  blocked: number;
  needsInput: number;
  inReview: number;
  running: number;
  ready: number;
  queued: number;
  done: number;
  total: number;
};

function summarizeProjectIssues(issues: unknown): ProjectIssueSummary {
  const summary: ProjectIssueSummary = {
    blocked: 0,
    needsInput: 0,
    inReview: 0,
    running: 0,
    ready: 0,
    queued: 0,
    done: 0,
    total: 0,
  };
  if (!Array.isArray(issues)) return summary;
  for (const issue of issues) {
    const status = issueStatusLabel(issue);
    summary.total += 1;
    if (status === "Blocked") summary.blocked += 1;
    else if (status === "Needs Input") summary.needsInput += 1;
    else if (status === "In Review") summary.inReview += 1;
    else if (status === "Running") summary.running += 1;
    else if (status === "Ready") summary.ready += 1;
    else if (status === "Done") summary.done += 1;
    else summary.queued += 1;
  }
  return summary;
}

function issueStatusLabel(issue: unknown): string {
  if (!issue || typeof issue !== "object") return "Queued";
  const record = issue as { workStatus?: unknown; statusLabel?: unknown };
  const workStatus = typeof record.workStatus === "string" ? record.workStatus.trim() : "";
  if (workStatus) return workStatus;
  const statusLabel = typeof record.statusLabel === "string" ? record.statusLabel.trim() : "";
  if (statusLabel) return statusLabel;
  return "Queued";
}

function artifactFromPiSession(
  session: { id: string; issueRef: string; status: string; sessionFile?: string; error?: string },
  summary: string,
) {
  return {
    id: `artifact-${session.id}`,
    artifactType: session.status === "failed" ? "test_output" as const : "other" as const,
    title: `Pi session ${session.issueRef}`,
    path: session.sessionFile,
    summary: session.error ? `Pi error: ${session.error}` : summary,
  };
}
