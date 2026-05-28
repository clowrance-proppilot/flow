#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const flowRoot = join(scriptDir, "..");
const repoRoot = await mkdtemp(join(tmpdir(), "flow-desktop-smoke-"));
const secondRepoRoot = await mkdtemp(join(tmpdir(), "flow-desktop-smoke-second-"));
const userDataRoot = await mkdtemp(join(tmpdir(), "flow-desktop-user-data-"));
let child;
let stdout = "";
let stderr = "";

assertBuiltDesktopFiles();
assertDesktopPackagingConfig();

try {
  await writeFixtureConfig(repoRoot, "desktop-smoke");
  await writeFixtureConfig(secondRepoRoot, "desktop-smoke-second");
  const issue = runFlow(repoRoot, {
    op: "issue",
    mode: "create",
    issueType: "Task",
    summary: "Smoke desktop prompt canvas",
    description: "Desktop smoke fixture.",
    repoKeys: ["main"],
  });
  const secondIssue = runFlow(secondRepoRoot, {
    op: "issue",
    mode: "create",
    issueType: "Task",
    summary: "Smoke second project dashboard",
    description: "Second desktop smoke fixture.",
    repoKeys: ["main"],
  });

  const electron = await import("electron");
  const electronBin = String(electron.default);
  child = spawn(electronBin, [join(flowRoot, "dist", "desktop", "main.js")], {
    cwd: flowRoot,
    env: {
      ...process.env,
      FLOW_ROOT: repoRoot,
      FLOW_DESKTOP_USER_DATA: userDataRoot,
      FLOW_DESKTOP_AGENT: "disabled",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const desktopUrl = await waitForDesktopUrl();
  await waitForServer(desktopUrl, 120);

  const html = await fetchText(`${desktopUrl}/`);
  if (!html.includes("root")) throw new Error("desktop HTML did not include app root");
  if (!html.includes("/assets/")) throw new Error("desktop root should reference desktop renderer assets");
  const assets = await fetchDesktopAssets(desktopUrl, html);
  for (const token of ["Projects", "Work with Flow on this issue", "Workflow actions"]) {
    if (!assets.includes(token)) throw new Error(`desktop renderer asset should include ${token}`);
  }

  const projects = await fetchJson(`${desktopUrl}/api/projects`);
  if (!projects.ok || !projects.activeProjectId || projects.projects?.length !== 1) {
    throw new Error(`desktop projects payload is invalid: ${JSON.stringify(projects)}`);
  }
  const firstProjectId = projects.activeProjectId;

  const contextBefore = await fetchJson(`${desktopUrl}/api/context`);
  if (!contextBefore.ok || contextBefore.project?.root !== repoRoot) {
    throw new Error(`desktop context should use fixture project: ${JSON.stringify(contextBefore)}`);
  }
  if (!Array.isArray(contextBefore.dashboard?.issues) || !contextBefore.dashboard.issues.some((item) => item.ref === issue.ref)) {
    throw new Error(`desktop context should include fixture issue ${issue.ref}: ${JSON.stringify(contextBefore.dashboard)}`);
  }

  const addedProject = await fetchJson(`${desktopUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: secondRepoRoot }),
  });
  if (!addedProject.ok || addedProject.projects?.length !== 2) {
    throw new Error(`desktop should add a second project: ${JSON.stringify(addedProject)}`);
  }
  const secondProjectId = addedProject.projects.find((project) => project.root === secondRepoRoot)?.id;
  if (!secondProjectId) {
    throw new Error(`desktop should return the second project id: ${JSON.stringify(addedProject.projects)}`);
  }
  await fetchJson(`${desktopUrl}/api/projects/${encodeURIComponent(secondProjectId)}/active`, { method: "POST" });
  const secondContext = await fetchJson(`${desktopUrl}/api/context`);
  if (secondContext.project?.root !== secondRepoRoot) {
    throw new Error(`desktop should switch to selected second project: ${JSON.stringify(secondContext.project)}`);
  }
  if (!secondContext.dashboard?.issues?.some((item) => item.ref === secondIssue.ref)) {
    throw new Error(`desktop second project should include its own issue: ${JSON.stringify(secondContext.dashboard)}`);
  }
  await fetchJson(`${desktopUrl}/api/projects/${encodeURIComponent(firstProjectId)}/active`, { method: "POST" });
  const firstContextAgain = await fetchJson(`${desktopUrl}/api/context`);
  if (firstContextAgain.project?.root !== repoRoot) {
    throw new Error(`desktop should switch back to first project: ${JSON.stringify(firstContextAgain.project)}`);
  }

  const routed = await fetchJson(`${desktopUrl}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "Route this smoke prompt.",
      projectId: projects.activeProjectId,
      issueRef: issue.ref,
    }),
  });
  if (!routed.ok || !routed.threadId || !routed.sessionId) {
    throw new Error(`desktop prompt should route to a thread and session: ${JSON.stringify(routed)}`);
  }
  if (!Array.isArray(routed.artifactRefs) || routed.artifactRefs.length === 0) {
    throw new Error(`desktop prompt should return at least one artifact ref: ${JSON.stringify(routed)}`);
  }

  const contextAfter = await fetchJson(`${desktopUrl}/api/context`);
  if (contextAfter.context?.active?.issueRef !== issue.ref) {
    throw new Error(`desktop context should preserve prompt issue context: ${JSON.stringify(contextAfter.context)}`);
  }
  if (!contextAfter.context?.prompts?.some((prompt) => prompt.prompt === "Route this smoke prompt.")) {
    throw new Error(`desktop context should persist prompt record: ${JSON.stringify(contextAfter.context)}`);
  }

  console.log("desktop smoke: ok");
} finally {
  if (child) await stopChild(child);
  await rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(secondRepoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(userDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function assertBuiltDesktopFiles() {
  for (const path of [
    join(flowRoot, "dist", "desktop", "main.js"),
    join(flowRoot, "dist", "desktop", "preload.js"),
    join(flowRoot, "dist", "desktop-renderer", "index.html"),
  ]) {
    if (!existsSync(path)) throw new Error(`missing built desktop file: ${path}`);
  }
}

function assertDesktopPackagingConfig() {
  const config = readFileSync(join(flowRoot, "desktop", "electron-builder.yml"), "utf8");
  if (!config.includes("dist/desktop-renderer/**/*")) {
    throw new Error("desktop package config must include dist/desktop-renderer/**/*");
  }
}

async function writeFixtureConfig(root, projectName) {
  await mkdir(join(root, ".flow"), { recursive: true });
  await writeFile(join(root, ".flow", "config.yaml"), [
    'version: "1"',
    "project:",
    `  name: "${projectName}"`,
    "topology:",
    "  repos:",
    "    main:",
    `      name: "${projectName}"`,
    "issueTracker:",
    '  type: "local"',
    '  prefix: "FLOW"',
    "collaboration:",
    '  type: "none"',
    "sourceControl:",
    '  type: "git"',
    "ledger:",
    '  type: "flow"',
    "",
  ].join("\n"), "utf8");
}

function runFlow(cwd, body) {
  const result = spawnSync(process.execPath, [join(flowRoot, "bin", "flow"), JSON.stringify(body)], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`flow command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.ok === false) throw new Error(`flow command failed: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function waitForDesktopUrl() {
  for (let i = 0; i < 120; i += 1) {
    const match = /\[flow-desktop\] dashboard server on (http:\/\/127\.0\.0\.1:\d+)/.exec(`${stdout}\n${stderr}`);
    if (match) return match[1];
    if (child?.exitCode !== null) {
      throw new Error(`desktop exited before startup\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await delay(250);
  }
  throw new Error(`desktop did not report server URL\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function waitForServer(url, retries) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`desktop server did not become healthy at ${url}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}: ${await response.text()}`);
  return await response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}`);
  return await response.text();
}

async function fetchDesktopAssets(baseUrl, html) {
  const assetPaths = [...html.matchAll(/\b(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((match) => match[1]);
  if (!assetPaths.length) throw new Error("desktop HTML should reference built assets");
  const texts = [];
  for (const assetPath of assetPaths) {
    texts.push(await fetchText(new URL(assetPath, baseUrl).toString()));
  }
  return texts.join("\n");
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  const exited = once(childProcess, "exit").then(() => undefined);
  childProcess.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(5000).then(() => {
      childProcess.kill("SIGKILL");
    }),
  ]);
  await Promise.race([exited, delay(1000)]);
}
