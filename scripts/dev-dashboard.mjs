#!/usr/bin/env node
import { createServer as createViteServer } from "vite";
import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const host = process.env.FLOW_DASHBOARD_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.FLOW_DASHBOARD_PORT ?? 8767);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Invalid FLOW_DASHBOARD_PORT value.");
  process.exit(1);
}

let shuttingDown = false;

// Create Express app for API endpoints
const app = express();
app.disable("x-powered-by");

// Security headers
app.use((_req, res, next) => {
  setMirrorHeaders(res);
  next();
});

// Health check
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, mode: "dev" });
});

// API endpoint - returns mock data in dev mode
app.get("/api/dashboard", async (_req, res) => {
  res.json({
    ok: true,
    snapshot: {
      freshnessLabel: "Dev mode - live data not connected",
    },
    issues: [
      {
        ref: "GH-237",
        title: "Add dev server for dashboard with hot reload",
        workStatus: "Active",
        repositories: ["flow"],
        evidenceStatus: "Present",
        documentationStatus: "Present",
      },
    ],
  });
});

// Create Vite dev server
const vite = await createViteServer({
  root: resolve(root, "src/dashboard"),
  base: "/dashboard/",
  server: {
    middlewareMode: true,
    host,
    port,
  },
  appType: "spa",
});

// Use Vite's middleware in Express
app.use(vite.middlewares);

// Serve dashboard HTML for SPA routes
app.get("/dashboard", async (req, res, next) => {
  try {
    const url = req.originalUrl;
    const template = await vite.transformIndexHtml(url, `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Flow Dashboard (Dev)</title>
          <link
            rel="icon"
            href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='10' fill='%231e3a8a'/%3E%3Cpath d='M15 17h12a6 6 0 0 1 0 12H21' fill='none' stroke='%23fff' stroke-width='4' stroke-linecap='round'/%3E%3Ccircle cx='15' cy='17' r='4' fill='%2360a5fa'/%3E%3Ccircle cx='27' cy='17' r='4' fill='%23fff'/%3E%3Ccircle cx='21' cy='29' r='4' fill='%2360a5fa'/%3E%3C/svg%3E"
          />
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="/main.tsx"></script>
        </body>
      </html>
    `);
    res.status(200).set({ "Content-Type": "text/html" }).end(template);
  } catch (e) {
    vite.ssrFixStacktrace(e);
    next(e);
  }
});

// Root redirect
app.get("/", (_req, res) => {
  res.redirect(301, "/dashboard");
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ ok: false });
});

// Error handler
app.use((error, _req, res, _next) => {
  console.error(`Flow Dashboard dev server error: ${error.message}`);
  res.status(500).json({ ok: false });
});

// Start server
const server = app.listen(port, host, () => {
  console.log(`Flow Dashboard dev server listening on http://${host}:${port}`);
  console.log(`Dashboard: http://${host}:${port}/dashboard`);
  console.log("Hot reload is enabled. Edit files in src/dashboard/ to see changes.");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Flow Dashboard dev port ${host}:${port} is already in use.`);
  } else {
    console.error(`Flow Dashboard dev server failed to start: ${error.message}`);
  }
  process.exit(1);
});

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown(signal));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nFlow Dashboard dev server received ${signal}; shutting down.`);
  
  const timeout = setTimeout(() => {
    console.error("Flow Dashboard dev server shutdown timed out.");
    process.exit(1);
  }, 5000);
  timeout.unref();

  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      console.error(`Flow Dashboard dev server shutdown failed: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  });
}

function setMirrorHeaders(res) {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-DNS-Prefetch-Control", "off");
  res.set("Referrer-Policy", "no-referrer");
}
