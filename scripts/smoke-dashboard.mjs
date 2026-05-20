#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const repoRoot = flowRoot;
const host = "127.0.0.1";
const dashboardPort = 8877;
const dashboardUrl = `http://${host}:${dashboardPort}`;
const tmp = await mkdtemp(join(tmpdir(), "flow-dashboard-smoke-"));
const callsPath = join(tmp, "calls.jsonl");
const mockFlowBin = join(tmp, "flow");
await writeFile(mockFlowBin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const method = process.argv[3] ?? "";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method }) + "\\n");
if (method === "inspectDashboardQueue") {
  console.log(JSON.stringify([{
    ref: "ISSUE-1",
    title: "Dashboard smoke",
    repoKeys: ["main"],
    workflowState: "queued",
    issueStatus: "Open",
    issueUrl: "https://github.com/example/flow/issues/1",
    metadata: {},
  }]));
} else {
  console.log(JSON.stringify({ id: "session-dashboard-smoke" }));
}
`);
await chmod(mockFlowBin, 0o755);

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
      FLOW_BIN: mockFlowBin,
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
  if (initialPayload.snapshot?.source !== "flow_cli") {
    throw new Error(`dashboard should wait for initial Flow CLI refresh: ${JSON.stringify(initialPayload)}`);
  }

  const payload = initialPayload;
  if (payload.issues?.[0]?.ref !== "ISSUE-1") {
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
    body: JSON.stringify({ issueRef: "ISSUE-1", issue: payload.issues[0] }),
  });
  const runtimeMethods = (await fetchText(`file://${callsPath}`).catch(async () => "")).trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).method);
  if (!runtimeMethods.includes("bootstrapIssue") || !runtimeMethods.includes("autoFlowIssue")) {
    throw new Error(`dashboard autoflow should bootstrap the issue before invoking autoflow: ${JSON.stringify(runtimeMethods)}`);
  }

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
