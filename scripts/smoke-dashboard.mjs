#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const repoRoot = flowRoot;
const host = "127.0.0.1";
const dashboardPort = 8877;
const workRuntimePort = 8878;
const dashboardUrl = `http://${host}:${dashboardPort}`;
const workRuntimeUrl = `http://${host}:${workRuntimePort}`;
let inspectRequests = 0;
const runtimeMethods = [];

const workRuntime = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.url === "/v1/work-runtime" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const payload = JSON.parse(body || "{}");
    runtimeMethods.push(payload.method);
    if (payload.method !== "inspectQueue" && payload.method !== "inspectDashboardQueue") {
      json(res, 200, { ok: true, result: { id: "session-dashboard-smoke" } });
      return;
    }
    inspectRequests += 1;
    if (inspectRequests === 1) {
      await delay(1500);
    }
    json(res, 200, {
      ok: true,
      result: [
        {
          ref: "FSB-1",
          title: "Dashboard smoke",
          repoKeys: ["fs_flow"],
          state: "queued",
          workflowState: "queued",
          lane: "needs_flow",
          substate: "needs flow",
          substateTooltip: "Smoke fixture substate.",
          nextAction: "Advance",
          flowActionable: true,
          metadata: {},
        },
      ],
    });
    return;
  }
  json(res, 404, { ok: false, error: "not found" });
});

await listen(workRuntime, workRuntimePort, host);

const child = spawn(
  process.execPath,
  [join(flowRoot, "bin", "flow-dashboard")],
  {
    cwd: flowRoot,
    env: {
      ...process.env,
      FLOW_PROJECT_ROOT: repoRoot,
      FLOW_DASHBOARD_HOST: host,
      FLOW_DASHBOARD_PORT: String(dashboardPort),
      FLOW_DASHBOARD_URL: dashboardUrl,
      FLOW_WORK_RUNTIME_URL: workRuntimeUrl,
      FLOW_DASHBOARD_LIVE_REFRESH_TIMEOUT_MS: "5000",
      FLOW_DASHBOARD_REQUEST_TIMEOUT_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  await waitForServer(dashboardUrl, 120);
  const html = await fetchText(`${dashboardUrl}/dashboard`);
  if (!html.includes("root")) throw new Error("dashboard HTML did not render app root");

  const initialPayload = await fetchJson(`${dashboardUrl}/api/dashboard`);
  if (initialPayload.snapshot?.source !== "work_runtime") {
    throw new Error(`dashboard should wait for initial Work Runtime refresh: ${JSON.stringify(initialPayload)}`);
  }

  const payload = initialPayload;
  if (payload.issues?.[0]?.ref !== "FSB-1") {
    throw new Error(`unexpected dashboard issue payload: ${JSON.stringify(payload.issues)}`);
  }
  if (typeof payload.snapshot?.ageSeconds !== "number" || typeof payload.snapshot?.stale !== "boolean") {
    throw new Error(`dashboard should report snapshot freshness: ${JSON.stringify(payload.snapshot)}`);
  }
  if (payload.stale !== payload.snapshot.stale) {
    throw new Error(`dashboard stale flag should match snapshot stale flag: ${JSON.stringify(payload)}`);
  }
  await fetchJson(`${dashboardUrl}/api/actions/autoflow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issueRef: "FSB-1", issue: payload.issues[0] }),
  });
  if (!runtimeMethods.includes("bootstrapJiraIssue") || !runtimeMethods.includes("autoFlowIssue")) {
    throw new Error(`dashboard autoflow should bootstrap the issue before invoking autoflow: ${JSON.stringify(runtimeMethods)}`);
  }

  console.log("dashboard smoke: ok");
} finally {
  child.kill("SIGTERM");
  workRuntime.close();
  await delay(100);
}

if (child.exitCode && child.exitCode !== 0) {
  throw new Error(`dashboard exited early: ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

function listen(server, port, hostname) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function waitForServer(url, retries) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`server did not become healthy at ${url}`);
}

async function waitForDashboardSource(url, source, retries) {
  let last;
  for (let i = 0; i < retries; i += 1) {
    try {
      last = await fetchJson(url);
      if (last.snapshot?.source === source) return last;
    } catch {}
    await delay(250);
  }
  throw new Error(`dashboard did not reach source ${source}; last=${JSON.stringify(last)}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}`);
  return await response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}`);
  return await response.text();
}
