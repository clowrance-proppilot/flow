#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const repoRoot = flowRoot;
const host = "127.0.0.1";
const dashboardPort = 8767;
const dashboardUrl = `http://${host}:${dashboardPort}`;
const tmp = await mkdtemp(join(tmpdir(), "flow-dashboard-smoke-"));

const child = spawn(
  process.execPath,
  [join(flowRoot, "bin", "flow-dashboard")],
  {
    cwd: flowRoot,
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

  const payload = await fetchJson(`${dashboardUrl}/api/dashboard`);
  if (typeof payload.snapshot?.ageSeconds !== "number" || typeof payload.snapshot?.stale !== "boolean") {
    throw new Error(`dashboard should report snapshot freshness: ${JSON.stringify(payload.snapshot)}`);
  }
  if (payload.stale !== payload.snapshot.stale) {
    throw new Error(`dashboard stale flag should match snapshot stale flag: ${JSON.stringify(payload)}`);
  }
  await fetchJson(`${dashboardUrl}/api/actions/autoflow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issueRef: "ISSUE-1", issue: payload.issues[0] }),
  });

  console.log("dashboard smoke: ok");
} finally {
  child.kill("SIGTERM");
  await rm(tmp, { recursive: true, force: true });
  await delay(100);
}

if (child.exitCode && child.exitCode !== 0) {
  throw new Error(`dashboard exited early: ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
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

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}`);
  return await response.json();
}

async function fetchText(url) {
  if (url.startsWith("file://")) {
    const { readFile } = await import("node:fs/promises");
    return await readFile(new URL(url), "utf8");
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}`);
  return await response.text();
}
