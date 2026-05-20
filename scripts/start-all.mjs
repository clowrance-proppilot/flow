#!/usr/bin/env node
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const flowRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dashboardHost = process.env.FLOW_DASHBOARD_HOST ?? "127.0.0.1";
const dashboardPort = process.env.FLOW_DASHBOARD_PORT ?? "8767";
const workRuntimeHost = process.env.FLOW_WORK_RUNTIME_HOST ?? "127.0.0.1";
const workRuntimePort = process.env.FLOW_WORK_RUNTIME_PORT ?? "8771";
const workRuntimeUrl = process.env.FLOW_WORK_RUNTIME_URL ?? `http://${workRuntimeHost}:${workRuntimePort}`;
const dashboardUrl = process.env.FLOW_DASHBOARD_URL ?? `http://${dashboardHost}:${dashboardPort}`;
const children = [];

await cleanListeningPorts([dashboardPort, workRuntimePort]);
buildFrontendAndRuntime();

console.log("Starting Flow services: Work Runtime and Dashboard. Executors launch per issue.");

const workRuntime = startRole("Work Runtime", resolveEntry("work-runtime-server.js"), {
  FLOW_WORK_RUNTIME_URL: workRuntimeUrl,
});
await waitForHealth(`${workRuntimeUrl}/healthz`, "Work Runtime");

const dashboard = startRole("Dashboard", resolveEntry("dashboard-server.js"), {
  FLOW_DASHBOARD_URL: dashboardUrl,
  FLOW_WORK_RUNTIME_URL: workRuntimeUrl,
});
await waitForHealth(`${dashboardUrl}/healthz`, "Dashboard");

openDashboard(`${dashboardUrl}/dashboard`);
console.log(`Flow dashboard: ${dashboardUrl}/dashboard`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopChildren(signal);
  });
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`Flow role exited: pid=${child.pid} code=${code ?? ""} signal=${signal ?? ""}`);
    stopChildren("SIGTERM");
    process.exit(code ?? 1);
  });
}

let shuttingDown = false;

function buildFrontendAndRuntime() {
  console.log("Building Flow runtime and dashboard.");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: flowRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error("Flow build failed.");
    process.exit(result.status ?? 1);
  }
}

function startRole(name, entry, env = {}) {
  console.log(`Starting Flow ${name}.`);
  const child = spawn(process.execPath, [entry], {
    cwd: flowRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push(child);
  return child;
}

function resolveEntry(fileName) {
  const candidates = [
    join(flowRoot, ".tmp", "bin", "src", fileName),
    join(flowRoot, ".tmp", "bin", fileName),
  ];
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (!entry) {
    console.error(`Flow role entry not found after build: ${fileName}`);
    process.exit(1);
  }
  return entry;
}

async function cleanListeningPorts(ports) {
  for (const targetPort of ports) {
    await cleanListeningPort(targetPort);
  }
}

async function waitForHealth(url, name) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await sleep(250);
  }
  console.error(`Flow ${name} did not become healthy at ${url}`);
  stopChildren("SIGTERM");
  process.exit(1);
}

function stopChildren(signal) {
  shuttingDown = true;
  for (const child of [...children].reverse()) {
    if (!child.killed) child.kill(signal);
  }
}

process.on("exit", () => {
  stopChildren("SIGTERM");
});

async function cleanListeningPort(targetPort) {
  const pids = await listeningPids(targetPort);
  const ownPid = String(process.pid);
  const stalePids = [...new Set(pids)].filter((pid) => pid && pid !== ownPid);
  if (!stalePids.length) return;

  console.log(`Cleaning Flow listeners on port ${targetPort}: ${stalePids.join(", ")}`);
  for (const pid of stalePids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }
  await sleep(700);

  for (const pid of stalePids) {
    if (!isRunning(pid)) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // Process may have already exited.
    }
  }
}

function listeningPids(targetPort) {
  return new Promise((resolve) => {
    execFile("lsof", [`-tiTCP:${targetPort}`, "-sTCP:LISTEN"], (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(stdout.split(/\s+/).filter(Boolean));
    });
  });
}

function isRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function openDashboard(url) {
  if (process.env.FLOW_OPEN_DASHBOARD !== "1") return;
  const opener = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
