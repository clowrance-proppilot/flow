#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardState, callWorkRuntime } from "./dashboard-state.js";
import { FlowEventStream } from "./event-stream.js";
import { flowRoot, loadFlowEnv, repoRoot } from "./flow-runtime.js";
import { loadFlowConfig } from "./config/config-loader.js";
import type { FlowConfig } from "./config/config-schema.js";

loadFlowEnv();

const flowConfig = await loadFlowConfig({ projectRoot: repoRoot });
const host = resolveDashboardHost(flowConfig);
const port = resolveDashboardPort(flowConfig);
const publicUrl = resolveDashboardUrl(flowConfig);
const workRuntimeUrl = resolveWorkRuntimeUrl(flowConfig);
const dashboardFilePath = resolveDashboardFilePath();
const dashboardAssetsPath = join(dirname(dashboardFilePath), "assets");
const serviceStartedAt = new Date();
const debugEnabled = process.env.FLOW_DASHBOARD_DEBUG === "1";
const events = new FlowEventStream("dashboard");

const dashboardState = new DashboardState({
  workRuntimeUrl,
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
    res.json(await dashboardState.payload({
      limit: 25,
      health: healthPayload(),
    }));
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/actions/:action", async (req, res) => {
  try {
    events.publish("dashboard.action.started", { action: req.params.action, issueRef: isRecord(req.body) ? req.body.issueRef : undefined });
    const result = await handleAction(req.params.action, isRecord(req.body) ? req.body : {});
    const dashboard = await dashboardState.payload({ limit: 25, health: healthPayload() });
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
    workRuntimeUrl,
    repoRoot,
    dashboardFilePath,
    dashboardExists: existsSync(dashboardFilePath),
  });
  proxyWorkRuntimeEvents();
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
    workRuntimeUrl,
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
      return callWorkRuntime(workRuntimeUrl, "refreshReviewState", { sessionId, issueRef });
    case "select":
    case "select_issue":
      return selectRuntimeIssue(sessionId, issueRef, body);
    case "prepare_workspace":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return callWorkRuntime(workRuntimeUrl, "prepareWorkspace", {
        sessionId,
        issueRef,
        options: { repoKey: typeof body.repoKey === "string" ? body.repoKey : undefined },
      });
    case "advance":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return callWorkRuntime(workRuntimeUrl, "advanceIssue", {
        sessionId,
        approveConfirmationId: typeof body.approveConfirmationId === "string" ? body.approveConfirmationId : undefined,
      });
    case "autoflow":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return callWorkRuntime(workRuntimeUrl, "autoFlowIssue", {
        sessionId,
        options: isRecord(body.options) ? body.options : {},
      });
    case "summarize_handoff":
      await selectRuntimeIssue(sessionId, issueRef, body);
      return callWorkRuntime(workRuntimeUrl, "summarizeHandoff", { sessionId });
    default:
      throw new Error(`Unknown dashboard action: ${action}`);
  }
}

async function selectRuntimeIssue(sessionId: string, issueRef: string, body: Record<string, unknown>): Promise<unknown> {
  const options = isRecord(body.bootstrapOptions) ? body.bootstrapOptions : {};
  try {
    return await callWorkRuntime(workRuntimeUrl, "bootstrapIssue", { sessionId, issueRef, options });
  } catch (error) {
    if (isRecord(body.issue)) {
      return callWorkRuntime(workRuntimeUrl, "selectIssue", { sessionId, issue: body.issue });
    }
    throw error;
  }
}

async function createSession(): Promise<string> {
  const session = await callWorkRuntime(workRuntimeUrl, "createSession", {}) as Record<string, unknown>;
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
    join(here, "..", "..", "dashboard", "index.html"),
    join(flowRoot, ".tmp", "dashboard", "index.html"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`FLOW_DASHBOARD_PORT must be an integer from 1 to 65535; got ${value}.`);
  }
  return parsed;
}

function resolveDashboardHost(config: FlowConfig | undefined): string {
  const host = config?.runtime?.dashboard?.host?.trim();
  if (!host) throw new Error("Missing required config value: runtime.dashboard.host");
  return host;
}

function resolveDashboardPort(config: FlowConfig | undefined): number {
  const port = config?.runtime?.dashboard?.port;
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Missing required config value: runtime.dashboard.port");
  }
  return port;
}

function resolveDashboardUrl(config: FlowConfig | undefined): string {
  const url = config?.runtime?.dashboard?.url?.trim();
  if (!url) throw new Error("Missing required config value: runtime.dashboard.url");
  return url;
}

function resolveWorkRuntimeUrl(config: FlowConfig | undefined): string {
  const url = config?.runtime?.workRuntime?.url?.trim();
  if (!url) throw new Error("Missing required config value: runtime.workRuntime.url");
  return url;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  return String(error);
}

function debugLog(event: string, details: Record<string, unknown>): void {
  if (!debugEnabled) return;
  console.error(`[flow-dashboard debug] ${event} ${JSON.stringify(details)}`);
}

function proxyWorkRuntimeEvents(): void {
  void (async () => {
    while (true) {
      try {
        const response = await fetch(`${workRuntimeUrl.replace(/\/+$/, "")}/v1/events`);
        if (!response.ok || !response.body) throw new Error(`Work Runtime event stream failed with HTTP ${response.status}.`);
        debugLog("events.connected", { workRuntimeUrl });
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            forwardSseBlock(block);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        debugLog("events.disconnected", { error: errorMessage(error).split("\n")[0] });
        await delay(1500);
      }
    }
  })();
}

function forwardSseBlock(block: string): void {
  const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return;
  const parsed = JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
  events.publish("work_runtime.event", parsed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
