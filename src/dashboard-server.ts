#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardState } from "./dashboard-state.js";
import { flowRoot, repoRoot } from "./flow-runtime.js";
import { loadFlowConfig } from "./config/config-loader.js";
import type { FlowConfig } from "./config/config-schema.js";

const flowConfig = await loadFlowConfig({ projectRoot: repoRoot });
const host = resolveDashboardHost(flowConfig);
const port = resolveDashboardPort(flowConfig);
const publicUrl = resolveDashboardUrl(flowConfig);
const dashboardFilePath = resolveDashboardFilePath();
const dashboardAssetsPath = join(dirname(dashboardFilePath), "assets");
const debugEnabled = flowConfig?.runtime?.debug === true;

const dashboardState = new DashboardState({
  repoRoot,
  debugLog,
});

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  setMirrorHeaders(res);
  next();
});
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  res.status(404).json({ ok: false });
});

app.get("/healthz", (_req, res) => {
  res.json(healthPayload());
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    const payload = await dashboardState.payload({
      limit: 25,
    });
    res.json(payload);
  } catch (error) {
    console.error(`Flow Dashboard snapshot failed: ${errorMessage(error)}`);
    res.status(503).json({ ok: false });
  }
});

app.get("/", (_req, res) => sendDashboardHtml(res));
app.use("/dashboard/assets", express.static(dashboardAssetsPath, { setHeaders: setNoStore }));
app.get("/dashboard", (_req, res) => sendDashboardHtml(res));
app.use((_req, res) => {
  res.status(404).json({ ok: false });
});
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  console.error(`Flow Dashboard route failed: ${errorMessage(error)}`);
  res.status(500).json({ ok: false });
});

const server = app.listen(port, host, () => {
  console.log(`Flow Dashboard listening on ${publicUrl}`);
  console.log(`Dashboard: ${publicUrl}/dashboard`);
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

function sendDashboardHtml(res: Response): void {
  if (!existsSync(dashboardFilePath)) {
    res.status(404).json({ ok: false });
    return;
  }
  res.type("html").send(readFileSync(dashboardFilePath, "utf8"));
}

function healthPayload(): Record<string, unknown> {
  return {
    ok: true,
  };
}

function setNoStore(res: Response): void {
  setMirrorHeaders(res);
}

function setMirrorHeaders(res: Response): void {
  res.set("Cache-Control", "no-store");
  res.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "img-src 'self' data:",
      "manifest-src 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "worker-src 'none'",
    ].join("; "),
  );
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Resource-Policy", "same-origin");
  res.set("Origin-Agent-Cluster", "?1");
  res.set("Referrer-Policy", "no-referrer");
  res.set(
    "Permissions-Policy",
    [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "serial=()",
      "hid=()",
      "bluetooth=()",
      "clipboard-read=()",
      "clipboard-write=(self)",
      "display-capture=()",
      "fullscreen=()",
      "web-share=()",
    ].join(", "),
  );
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-DNS-Prefetch-Control", "off");
  res.set("X-Frame-Options", "DENY");
}

function shutdown(server: Server, signal: NodeJS.Signals): void {
  console.log(`Flow Dashboard received ${signal}; shutting down.`);
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  return String(error);
}

function debugLog(event: string, details: Record<string, unknown>): void {
  if (!debugEnabled) return;
  console.error(`[flow-dashboard debug] ${event} ${JSON.stringify(details)}`);
}
