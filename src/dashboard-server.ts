#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardState } from "./dashboard-state.js";
import { FlowEventStream } from "./event-stream.js";
import { flowRoot, repoRoot } from "./flow-runtime.js";
import { loadFlowConfig } from "./config/config-loader.js";
import type { FlowConfig } from "./config/config-schema.js";

const flowConfig = await loadFlowConfig({ projectRoot: repoRoot });
const host = resolveDashboardHost(flowConfig);
const port = resolveDashboardPort(flowConfig);
const publicUrl = resolveDashboardUrl(flowConfig);
const themeConfig = resolveThemeConfig(flowConfig);
const customCssPath = resolveCustomCssPath(flowConfig);
const customAssetsPath = customCssPath ? dirname(customCssPath) : undefined;
const dashboardFilePath = resolveDashboardFilePath();
const dashboardAssetsPath = join(dirname(dashboardFilePath), "assets");
const serviceStartedAt = new Date();
const debugEnabled = flowConfig?.runtime?.debug === true;
const events = new FlowEventStream("dashboard");

const dashboardState = new DashboardState({
  repoRoot,
  debugLog,
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => {
  res.json(healthPayload());
});

app.get("/api/events", (req, res) => {
  events.subscribe(req, res);
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const payload = await dashboardState.payload({
      limit: 25,
      health: healthPayload(),
    });
    res.json({ ...payload, ui: themeConfig });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/actions/:action", async (req, res) => {
  try {
    events.publish("dashboard.action.started", { action: req.params.action, issueRef: isRecord(req.body) ? req.body.issueRef : undefined });
    const result = await handleAction(req.params.action, isRecord(req.body) ? req.body : {});
    const dashboard = {
      ...(await dashboardState.payload({ limit: 25, health: healthPayload() })),
      ui: themeConfig,
    };
    events.publish("dashboard.action.completed", { action: req.params.action, issueRef: isRecord(req.body) ? req.body.issueRef : undefined });
    res.json({ ok: true, result, dashboard });
  } catch (error) {
    events.publish("dashboard.action.failed", {
      action: req.params.action,
      issueRef: isRecord(req.body) ? req.body.issueRef : undefined,
      error: errorMessage(error).split("\n")[0],
    });
    res.status(400).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/", (_req, res) => res.redirect("/dashboard"));
app.use("/dashboard/assets", express.static(dashboardAssetsPath));
if (customAssetsPath) {
  app.use("/dashboard/custom-assets", express.static(customAssetsPath));
}
app.get("/dashboard/custom.css", (_req, res) => {
  if (!customCssPath) {
    res.type("css").send("");
    return;
  }
  res.type("css").send(readFileSync(customCssPath, "utf8"));
});
app.get("/dashboard", (_req, res) => {
  if (!existsSync(dashboardFilePath)) {
    res.status(404).type("text/plain").send("Dashboard file not found.");
    return;
  }
  res.type("html").send(readFileSync(dashboardFilePath, "utf8"));
});
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error(`Flow Dashboard route failed: ${errorMessage(error)}`);
  res.status(500).json({ ok: false, error: errorMessage(error) });
});

const server = app.listen(port, host, () => {
  console.log(`Flow Dashboard listening on ${publicUrl}`);
  console.log(`Dashboard: ${publicUrl}/dashboard`);
  dashboardState.startRefreshDaemon(25);
  debugLog("startup", {
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    host,
    port,
    publicUrl,
    repoRoot,
    dashboardFilePath,
    dashboardExists: existsSync(dashboardFilePath),
    customCssPath,
    customAssetsPath,
  });
});
server.on("error", (error: NodeJS.ErrnoException) => {
  const message = error.code === "EADDRINUSE"
    ? `Flow Dashboard port ${host}:${port} is already in use.`
    : `Flow Dashboard failed to start: ${errorMessage(error)}`;
  console.error(message);
  process.exit(1);
});
process.once("SIGINT", () => shutdown(server, "SIGINT"));
process.once("SIGTERM", () => shutdown(server, "SIGTERM"));

function healthPayload(): Record<string, unknown> {
  return {
    ok: true,
    role: "dashboard",
    repoRoot,
    pid: process.pid,
    startedAt: serviceStartedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    refreshing: dashboardState.isRefreshing,
  };
}

async function handleAction(action: string, body: Record<string, unknown>): Promise<unknown> {
  if (action === "refresh" || action === "refresh_queue") {
    return dashboardState.payload({ limit: 25, health: healthPayload() });
  }

  const sessionId = typeof body.sessionId === "string" && body.sessionId
    ? body.sessionId
    : await createSession();
  const issueRef = requireString(body.issueRef, "issueRef");

  switch (action) {
    case "refresh_review":
    case "refresh_pr_state":
      return dashboardState.runtimeAction("refreshReviewState", { sessionId, issueRef });
    case "select":
    case "select_issue":
      return selectRuntimeIssue(sessionId, issueRef, body);
    case "prepare_workspace":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return dashboardState.runtimeAction("prepareWorkspace", {
        sessionId,
        issueRef,
        options: { repoKey: typeof body.repoKey === "string" ? body.repoKey : undefined },
      });
    case "advance":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return dashboardState.runtimeAction("advanceIssue", {
        sessionId,
        approveConfirmationId: typeof body.approveConfirmationId === "string" ? body.approveConfirmationId : undefined,
      });
    case "autoflow":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return dashboardState.runtimeAction("autoFlowIssue", {
        sessionId,
        options: isRecord(body.options) ? body.options : {},
      });
    case "summarize_handoff":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return dashboardState.runtimeAction("summarizeHandoff", { sessionId });
    default:
      throw new Error(`Unknown dashboard action: ${action}`);
  }
}

async function selectRuntimeIssue(sessionId: string, issueRef: string, body: Record<string, unknown>): Promise<unknown> {
  const options = isRecord(body.bootstrapOptions) ? body.bootstrapOptions : {};
  try {
    return await dashboardState.runtimeAction("bootstrapIssue", { sessionId, issueRef, options });
  } catch (error) {
    if (isRecord(body.issue)) {
      return dashboardState.runtimeAction("selectIssue", { sessionId, issue: body.issue });
    }
    throw error;
  }
}

async function createSession(): Promise<string> {
  const session = await dashboardState.runtimeAction("createSession", {}) as Record<string, unknown>;
  const id = session.id;
  if (typeof id !== "string" || !id) throw new Error("Work Runtime did not return a session id.");
  return id;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value) return value;
  throw new Error(`${name} is required.`);
}

function shutdown(server: Server, signal: NodeJS.Signals): void {
  console.log(`Flow Dashboard received ${signal}; shutting down.`);
  dashboardState.stopRefreshDaemon();
  const timeout = setTimeout(() => {
    console.error("Flow Dashboard shutdown timed out.");
    process.exit(1);
  }, 5000);
  timeout.unref();
  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      console.error(`Flow Dashboard shutdown failed: ${errorMessage(error)}`);
      process.exit(1);
    }
    process.exit(0);
  });
}

function resolveDashboardFilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(flowRoot, "dist", "dashboard", "index.html"),
    join(here, "..", "..", "dashboard", "index.html"),
    join(flowRoot, ".tmp", "dashboard", "index.html"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function resolveDashboardHost(config: FlowConfig | undefined): string {
  const host = config?.runtime?.dashboard?.host?.trim();
  return host || "127.0.0.1";
}

function resolveDashboardPort(config: FlowConfig | undefined): number {
  const port = config?.runtime?.dashboard?.port ?? 8767;
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Missing required config value: runtime.dashboard.port");
  }
  return port;
}

function resolveDashboardUrl(config: FlowConfig | undefined): string {
  const url = config?.runtime?.dashboard?.url?.trim();
  return url || `http://${host}:${port}`;
}

function resolveCustomCssPath(config: FlowConfig | undefined): string | undefined {
  const configured = config?.runtime?.dashboard?.customCssPath?.trim();
  const candidate = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(repoRoot, configured)
    : join(repoRoot, ".flow", "dashboard.css");
  return existsSync(candidate) ? candidate : undefined;
}

function resolveThemeConfig(config: FlowConfig | undefined): Record<string, unknown> {
  const dashboard = config?.runtime?.dashboard;
  return {
    themes: dashboard?.themes ?? [],
    defaultThemeId: dashboard?.defaultThemeId ?? "",
    defaultMode: dashboard?.defaultMode ?? "",
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  return String(error);
}

function debugLog(event: string, details: Record<string, unknown>): void {
  if (!debugEnabled) return;
  console.error(`[flow-dashboard debug] ${event} ${JSON.stringify(details)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
