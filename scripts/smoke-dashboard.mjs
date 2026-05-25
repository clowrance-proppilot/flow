#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const repoRoot = await mkdtemp(join(tmpdir(), "flow-dashboard-smoke-"));
const host = "127.0.0.1";
const dashboardPort = 18767;
const dashboardUrl = `http://${host}:${dashboardPort}`;

await mkdir(join(repoRoot, ".flow"), { recursive: true });
await writeFile(join(repoRoot, ".flow", "config.yaml"), [
  'version: "1"',
  "project:",
  '  name: "dashboard-smoke"',
  "topology:",
  "  repos:",
  "    main:",
  '      name: "dashboard-smoke"',
  "issueTracker:",
  '  type: "local"',
  '  prefix: "FLOW"',
  "collaboration:",
  '  type: "none"',
  "sourceControl:",
  '  type: "git"',
  "ledger:",
  '  type: "flow"',
  "runtime:",
  "  dashboard:",
  `    host: "${host}"`,
  `    port: ${dashboardPort}`,
  "",
].join("\n"));
let stdout = "";
let stderr = "";
let child;

try {
  runFlow({
    op: "issue",
    mode: "create",
    issueType: "Task",
    summary: "Smoke dashboard action",
    description: "Dashboard smoke fixture.",
    repoKeys: ["main"],
  });

  child = spawn(
    process.execPath,
    [join(flowRoot, "bin", "flow-dashboard")],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

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
  const issueRef = String(payload.issues?.[0]?.ref ?? "");
  if (!issueRef) throw new Error(`dashboard should include the local smoke issue: ${JSON.stringify(payload.issues)}`);
  await fetchJson(`${dashboardUrl}/api/actions/select`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issueRef, issue: payload.issues[0] }),
  });

  console.log("dashboard smoke: ok");
} finally {
  if (child) await stopChild(child);
  await rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (child?.exitCode && child.exitCode !== 0) {
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

function runFlow(body) {
  const result = spawnSync(process.execPath, [join(flowRoot, "bin", "flow"), JSON.stringify(body)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`flow command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.ok === false) throw new Error(`flow command failed: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(5000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
  await Promise.race([exited, delay(1000)]);
}
