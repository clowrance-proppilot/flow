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
const allowedWorkStatuses = new Set(["Queued", "Active", "Ready", "Running", "Blocked", "In Review", "Needs Input", "Done", "Unknown"]);
const allowedIssueKeys = new Set([
  "blockerLabels",
  "documentationStatus",
  "evidenceStatus",
  "handoffPrompt",
  "nextPickup",
  "prStatus",
  "ref",
  "repositories",
  "reviewStatus",
  "statusLabel",
  "title",
  "updatedLabel",
  "workStatus",
  "workStatusDetail",
]);
const requiredMirrorControlTokens = [
  'data-mirror-control',
  'copy-handoff-prompt',
  'issue-focus',
  'refresh-snapshot',
  'search-filter',
  'status-filter',
];
const forbiddenServedAssetTokens = [
  "/api/actions",
  "/api/events",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "document.cookie",
  "sendBeacon",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "BroadcastChannel",
  "SharedWorker",
  "serviceWorker",
  "Notification",
  "navigator.clipboard.read",
  "navigator.clipboard.readText",
  "window.open",
  "location.assign",
  "location.replace",
  "history.pushState",
  "history.replaceState",
  "download=",
  "data-theme",
  "themed-scroll",
  'target="_blank"',
  "target='_blank'",
  "Open Issue",
  "Open PR",
  "Run Flow",
  "Autoflow",
  "Prepare Workspace",
  "Reload dashboard",
  "workflowState",
  "ready_to_run",
  "awaiting_review",
  "awaiting_human",
  "issueUrl",
  "prUrl",
  "repoKeys",
  "worktreePath",
  "headSha",
  "prIsDraft",
  "prChecksPassing",
  "prReviewDecision",
  "humanReviewRequired",
  "evidenceRecorded",
  "documentationRecorded",
];

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
  const createdIssue = runFlow({
    op: "issue",
    mode: "create",
    issueType: "Task",
    summary: "Smoke dashboard mirror",
    description: "Dashboard smoke fixture.",
    repoKeys: ["main"],
  });
  if (createdIssue.state !== "selected") {
    throw new Error(`dashboard smoke fixture should start from selected internal state: ${JSON.stringify(createdIssue)}`);
  }

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
  await assertMirrorHeaders(`${dashboardUrl}/healthz`);
  assertHealthPayloadShape(await fetchJson(`${dashboardUrl}/healthz`));
  await assertMirrorHeaders(`${dashboardUrl}/`);
  await assertMirrorHeaders(`${dashboardUrl}/dashboard`);
  await assertMirrorHeaders(`${dashboardUrl}/api/dashboard`);
  const html = await fetchText(`${dashboardUrl}/dashboard`);
  if (!html.includes("root")) throw new Error("dashboard HTML did not render app root");
  assertServedDashboardHtml(html);
  const rootHtml = await fetchText(`${dashboardUrl}/`);
  if (rootHtml !== html) throw new Error("dashboard root should serve the same mirror shell as /dashboard");
  const queryHtml = await fetchText(`${dashboardUrl}/dashboard?mode=advance&issueRef=FLOW-999`);
  if (queryHtml !== html) throw new Error("dashboard shell query input should not change the mirror shell");
  await assertServedDashboardAssets(html);

  const payload = await fetchJson(`${dashboardUrl}/api/dashboard`);
  assertDashboardPayloadShape(payload);
  const runtimeQueue = runFlow({ op: "runtime", method: "inspectDashboardQueue", params: { limit: 10 } });
  const runtimeQueueForSession = runFlow({ op: "runtime", method: "inspectDashboardQueue", params: { limit: 10, sessionId: "cli" } });
  assertRuntimeDashboardQueueShape(runtimeQueue);
  assertRuntimeDashboardQueueShape(runtimeQueueForSession);
  const dashboardFingerprintBeforeBlockedRequests = dashboardIssuesFingerprint(payload.issues);
  const runtimeFingerprintBeforeBlockedRequests = dashboardIssuesFingerprint(runtimeQueue);
  assertSelectedIssueUsesQueueState(payload.issues, createdIssue.ref, "dashboard API");
  assertSelectedIssueUsesQueueState(runtimeQueue, createdIssue.ref, "runtime dashboard queue");
  assertSelectedIssueMirrorsAsActive(runtimeQueueForSession, createdIssue.ref, "runtime dashboard queue with session");
  assertNoRawWorkflowStates(payload, "dashboard API");
  assertNoRawWorkflowStates(runtimeQueue, "runtime dashboard queue");
  const statusKeys = ["degraded", "degradedError", "refreshing", "stale"].filter((key) => Object.hasOwn(payload, key));
  if (statusKeys.length) {
    throw new Error(`dashboard API should not expose runtime status wrapper fields: ${statusKeys.join(", ")}`);
  }
  const snapshotKeys = ["source", "stale", "refreshedAt", "ageSeconds"].filter((key) => Object.hasOwn(payload.snapshot ?? {}, key));
  if (snapshotKeys.length) {
    throw new Error(`dashboard snapshot should expose display freshness only: ${snapshotKeys.join(", ")}`);
  }
  if (Object.hasOwn(payload, "ui")) {
    throw new Error(`dashboard API should not expose UI config: ${JSON.stringify(payload.ui)}`);
  }
  if (Object.hasOwn(payload, "health")) {
    throw new Error(`dashboard API should not expose host health details: ${JSON.stringify(payload.health)}`);
  }
  const issueRef = String(payload.issues?.[0]?.ref ?? "");
  if (!issueRef) throw new Error(`dashboard should include the local smoke issue: ${JSON.stringify(payload.issues)}`);
  const queryPayload = await fetchJson(`${dashboardUrl}/api/dashboard?limit=999&issueRef=${encodeURIComponent(issueRef)}&mode=advance`);
  if (queryPayload.issues?.length !== payload.issues?.length) {
    throw new Error(`dashboard query input should not shape mirrored issue count: ${JSON.stringify(queryPayload)}`);
  }
  assertDashboardPayloadShape(queryPayload);
  assertSelectedIssueUsesQueueState(queryPayload.issues, createdIssue.ref, "dashboard API with query input");
  assertMirrorStateUnchanged(dashboardFingerprintBeforeBlockedRequests, queryPayload.issues, "dashboard API with query input");
  assertNoRawWorkflowStates(queryPayload, "dashboard API with query input");
  for (const issue of payload.issues ?? []) {
    const orchestrationKeys = Object.keys(issue).filter((key) => key.toLowerCase().includes("autoflow"));
    if (orchestrationKeys.length) {
      throw new Error(`dashboard issue should not expose orchestration fields: ${orchestrationKeys.join(", ")}`);
    }
    if (Object.hasOwn(issue, "worktreePath")) {
      throw new Error(`dashboard issue should not expose local worktree paths: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "headSha")) {
      throw new Error(`dashboard issue should not expose raw commit heads: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "branch")) {
      throw new Error(`dashboard issue should not expose source-control branch details: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "repoKeys")) {
      throw new Error(`dashboard issue should expose repository labels instead of raw repoKeys fields: ${JSON.stringify(issue)}`);
    }
    if (!Array.isArray(issue.repositories)) {
      throw new Error(`dashboard issue should expose repository labels: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "issueStatus")) {
      throw new Error(`dashboard issue should expose display status labels instead of raw issueStatus fields: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "statusLabel") && typeof issue.statusLabel !== "string") {
      throw new Error(`dashboard issue should expose display statusLabel: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "updatedAt")) {
      throw new Error(`dashboard issue should expose display update labels instead of raw per-issue timestamps: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "updatedLabel") && typeof issue.updatedLabel !== "string") {
      throw new Error(`dashboard issue should expose display updatedLabel: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "issueUrl") || Object.hasOwn(issue, "prUrl")) {
      throw new Error(`dashboard issue should expose link presence labels instead of external URLs: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "issueLinkStatus") || Object.hasOwn(issue, "prLinkStatus")) {
      throw new Error(`dashboard issue should not expose non-actionable link presence fields: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "workflowState")) {
      throw new Error(`dashboard issue should expose workStatus labels instead of raw workflowState: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "blockers")) {
      throw new Error(`dashboard issue should expose blockerLabels instead of raw blocker fields: ${JSON.stringify(issue)}`);
    }
    if (!Array.isArray(issue.blockerLabels)) {
      throw new Error(`dashboard issue should expose blocker display labels: ${JSON.stringify(issue)}`);
    }
    if (typeof issue.workStatus !== "string" || !allowedWorkStatuses.has(issue.workStatus)) {
      throw new Error(`dashboard issue should expose display workStatus labels: ${JSON.stringify(issue)}`);
    }
    if (Object.hasOwn(issue, "evidenceRecorded") || Object.hasOwn(issue, "documentationRecorded")) {
      throw new Error(`dashboard issue should expose record status labels instead of raw booleans: ${JSON.stringify(issue)}`);
    }
    for (const key of ["prIsDraft", "prChecksPassing", "prReviewDecision", "humanReviewRequired"]) {
      if (Object.hasOwn(issue, key)) {
        throw new Error(`dashboard issue should expose PR and review labels instead of raw provider PR fields: ${JSON.stringify(issue)}`);
      }
    }
    for (const key of ["evidenceStatus", "documentationStatus"]) {
      if (issue[key] !== "Present" && issue[key] !== "Needed") {
        throw new Error(`dashboard issue should expose display ${key}: ${JSON.stringify(issue)}`);
      }
    }
    for (const key of ["prStatus", "reviewStatus"]) {
      if (Object.hasOwn(issue, key) && typeof issue[key] !== "string") {
        throw new Error(`dashboard issue should expose display ${key}: ${JSON.stringify(issue)}`);
      }
    }
    for (const blocker of issue.blockerLabels ?? []) {
      if (/worktree/i.test(String(blocker)) || /pull request is missing/i.test(String(blocker))) {
        throw new Error(`dashboard blockers should use display wording: ${JSON.stringify(issue.blockerLabels)}`);
      }
    }
    const emptyStringKeys = Object.entries(issue).filter(([, value]) => value === "").map(([key]) => key);
    if (emptyStringKeys.length) {
      throw new Error(`dashboard issue should omit absent mirror fields: ${emptyStringKeys.join(", ")}`);
    }
  }
  await assertNotAvailable(`${dashboardUrl}/dashboard/custom.css`);
  await assertNotAvailable(`${dashboardUrl}/dashboard/custom-assets/probe.css`);
  await assertNotAvailable(`${dashboardUrl}/dashboard/assets/missing.js`);
  await assertNotAvailable(`${dashboardUrl}/favicon.ico`);
  await assertNotAvailable(`${dashboardUrl}/api/events`);
  await assertMutationMethodsNotAvailable(`${dashboardUrl}/api/dashboard`, { issueRef });
  await assertMutationMethodsNotAvailable(`${dashboardUrl}/api/actions/select`, { issueRef, issue: payload.issues[0] });
  const payloadAfterBlockedRequests = await fetchJson(`${dashboardUrl}/api/dashboard`);
  assertDashboardPayloadShape(payloadAfterBlockedRequests);
  assertSelectedIssueUsesQueueState(payloadAfterBlockedRequests.issues, createdIssue.ref, "dashboard API after blocked requests");
  assertMirrorStateUnchanged(dashboardFingerprintBeforeBlockedRequests, payloadAfterBlockedRequests.issues, "dashboard API after blocked requests");
  const runtimeQueueAfterBlockedRequests = runFlow({ op: "runtime", method: "inspectDashboardQueue", params: { limit: 10 } });
  assertRuntimeDashboardQueueShape(runtimeQueueAfterBlockedRequests);
  assertSelectedIssueUsesQueueState(runtimeQueueAfterBlockedRequests, createdIssue.ref, "runtime dashboard queue after blocked requests");
  assertMirrorStateUnchanged(runtimeFingerprintBeforeBlockedRequests, runtimeQueueAfterBlockedRequests, "runtime dashboard queue after blocked requests");

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

async function assertNotAvailable(url, init) {
  const response = await fetch(url, init);
  assertResponseMirrorHeaders(response, url);
  if (response.ok) throw new Error(`dashboard should not expose ${url}`);
  await assertUnavailablePayloadShape(response, url);
}

async function assertMirrorHeaders(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`request failed ${response.status} ${response.statusText}`);
  assertResponseMirrorHeaders(response, url);
}

function assertResponseMirrorHeaders(response, url) {
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!/\bno-store\b/i.test(cacheControl)) {
    throw new Error(`dashboard mirror responses should disable caching for ${url}: ${cacheControl || "<missing>"}`);
  }
  const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'none'",
  ]) {
    if (!contentSecurityPolicy.includes(directive)) {
      throw new Error(`dashboard mirror responses should include CSP directive ${directive} for ${url}: ${contentSecurityPolicy || "<missing>"}`);
    }
  }
  if (/\bunsafe-inline\b|\bunsafe-eval\b/i.test(contentSecurityPolicy)) {
    throw new Error(`dashboard mirror responses should not allow inline or eval code for ${url}: ${contentSecurityPolicy}`);
  }
  if (response.headers.get("cross-origin-opener-policy") !== "same-origin") {
    throw new Error(`dashboard mirror responses should isolate opener context for ${url}`);
  }
  if (response.headers.get("cross-origin-resource-policy") !== "same-origin") {
    throw new Error(`dashboard mirror responses should restrict cross-origin resource use for ${url}`);
  }
  if (response.headers.get("origin-agent-cluster") !== "?1") {
    throw new Error(`dashboard mirror responses should request origin agent clustering for ${url}`);
  }
  if (response.headers.get("referrer-policy") !== "no-referrer") {
    throw new Error(`dashboard mirror responses should disable referrers for ${url}`);
  }
  const permissionsPolicy = response.headers.get("permissions-policy") ?? "";
  for (const directive of [
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
  ]) {
    if (!permissionsPolicy.includes(directive)) {
      throw new Error(`dashboard mirror responses should include Permissions-Policy directive ${directive} for ${url}: ${permissionsPolicy || "<missing>"}`);
    }
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error(`dashboard mirror responses should disable content sniffing for ${url}`);
  }
  if (response.headers.get("x-dns-prefetch-control") !== "off") {
    throw new Error(`dashboard mirror responses should disable DNS prefetch for ${url}`);
  }
  if (response.headers.get("x-frame-options") !== "DENY") {
    throw new Error(`dashboard mirror responses should deny framing for ${url}`);
  }
}

async function assertMutationMethodsNotAvailable(url, body) {
  for (const method of ["OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
    await assertNotAvailable(url, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "DELETE" ? undefined : JSON.stringify(body),
    });
  }
}

async function assertUnavailablePayloadShape(response, url) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`unavailable dashboard route should return JSON for ${url}: ${text.slice(0, 200)}`);
  }
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "ok" || payload.ok !== false) {
    throw new Error(`unavailable dashboard route should expose only ok:false for ${url}: ${JSON.stringify(payload)}`);
  }
}

function assertDashboardPayloadShape(payload) {
  if (typeof payload.snapshot?.freshnessLabel !== "string") {
    throw new Error(`dashboard should report display snapshot freshness: ${JSON.stringify(payload.snapshot)}`);
  }
  const topLevelKeys = Object.keys(payload).sort().join(",");
  if (topLevelKeys !== "issues,ok,snapshot") {
    throw new Error(`dashboard payload should only expose ok, snapshot, and issues: ${topLevelKeys}`);
  }
  const snapshotKeys = Object.keys(payload.snapshot ?? {}).sort().join(",");
  if (snapshotKeys !== "freshnessLabel") {
    throw new Error(`dashboard snapshot should only expose freshnessLabel: ${snapshotKeys}`);
  }
  if (!Array.isArray(payload.issues)) {
    throw new Error(`dashboard payload should expose issues array: ${JSON.stringify(payload)}`);
  }
  for (const issue of payload.issues) {
    const unexpected = Object.keys(issue).filter((key) => !allowedIssueKeys.has(key));
    if (unexpected.length) {
      throw new Error(`dashboard issue exposed unexpected fields: ${unexpected.join(", ")} in ${JSON.stringify(issue)}`);
    }
  }
}

function assertHealthPayloadShape(payload) {
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "ok" || payload.ok !== true) {
    throw new Error(`dashboard health should expose only ok:true: ${JSON.stringify(payload)}`);
  }
}

function assertRuntimeDashboardQueueShape(queue) {
  if (!Array.isArray(queue)) {
    throw new Error(`dashboard runtime queue should be an array: ${JSON.stringify(queue)}`);
  }
  for (const issue of queue) {
    const unexpected = Object.keys(issue).filter((key) => !allowedIssueKeys.has(key));
    if (unexpected.length) {
      throw new Error(`dashboard runtime queue exposed unexpected fields: ${unexpected.join(", ")} in ${JSON.stringify(issue)}`);
    }
    if (typeof issue.workStatus !== "string" || !allowedWorkStatuses.has(issue.workStatus)) {
      throw new Error(`dashboard runtime queue should expose display workStatus labels: ${JSON.stringify(issue)}`);
    }
    if (!Array.isArray(issue.repositories) || !Array.isArray(issue.blockerLabels)) {
      throw new Error(`dashboard runtime queue should expose display arrays: ${JSON.stringify(issue)}`);
    }
  }
}

function assertSelectedIssueMirrorsAsActive(issues, ref, source) {
  const issue = issues.find((candidate) => candidate.ref === ref);
  if (!issue) throw new Error(`${source} should include selected smoke issue ${ref}: ${JSON.stringify(issues)}`);
  if (issue.workStatus !== "Active") {
    throw new Error(`${source} should mirror explicit session selection as Active: ${JSON.stringify(issue)}`);
  }
}

function assertSelectedIssueUsesQueueState(issues, ref, source) {
  const issue = issues.find((candidate) => candidate.ref === ref);
  if (!issue) throw new Error(`${source} should include selected smoke issue ${ref}: ${JSON.stringify(issues)}`);
  if (issue.workStatus !== "Queued") {
    throw new Error(`${source} should not mirror selected internal state without an explicit session: ${JSON.stringify(issue)}`);
  }
}

function assertNoRawWorkflowStates(value, source) {
  const serialized = JSON.stringify(value);
  for (const rawState of ["selected", "ready_to_run", "awaiting_review", "awaiting_human"]) {
    if (serialized.includes(`"${rawState}"`)) {
      throw new Error(`${source} should not expose raw workflow state ${rawState}: ${serialized}`);
    }
  }
}

function assertMirrorStateUnchanged(before, issues, source) {
  const after = dashboardIssuesFingerprint(issues);
  if (after !== before) {
    throw new Error(`${source} changed after blocked dashboard requests:\nbefore ${before}\nafter ${after}`);
  }
}

function dashboardIssuesFingerprint(issues) {
  return JSON.stringify(
    [...issues]
      .map((issue) => ({
        blockerLabels: sortedStringArray(issue.blockerLabels),
        documentationStatus: issue.documentationStatus,
        evidenceStatus: issue.evidenceStatus,
        prStatus: issue.prStatus,
        ref: issue.ref,
        repositories: sortedStringArray(issue.repositories),
        reviewStatus: issue.reviewStatus,
        statusLabel: issue.statusLabel,
        title: issue.title,
        workStatus: issue.workStatus,
        workStatusDetail: issue.workStatusDetail,
      }))
      .sort((left, right) => String(left.ref).localeCompare(String(right.ref))),
  );
}

function sortedStringArray(value) {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function assertServedDashboardHtml(html) {
  const forbiddenTokens = forbiddenServedAssetTokens.filter((token) => html.includes(token));
  if (forbiddenTokens.length) {
    throw new Error(`dashboard HTML exposes forbidden mirror tokens: ${forbiddenTokens.join(", ")}`);
  }
  const forbiddenPatterns = [
    [/<a\b/i, "anchor"],
    [/<button\b/i, "button"],
    [/<form\b/i, "form"],
    [/\bon[a-z]+\s*=/i, "inline event handler"],
    [/\btarget\s*=\s*["']_blank["']/i, "new-window target"],
    [/\bdownload\s*=/i, "download"],
  ];
  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(html)) {
      throw new Error(`dashboard HTML shell should not expose ${label} controls`);
    }
  }
}

async function assertServedDashboardAssets(html) {
  const assetPaths = [
    ...[...html.matchAll(/\b(?:src|href)="([^"]*\/dashboard\/assets\/[^"]+)"/g)].map((match) => match[1]),
  ];
  if (!assetPaths.length) throw new Error("dashboard HTML should reference built dashboard assets");
  let servedAssetText = "";
  for (const assetPath of assetPaths) {
    const assetUrl = new URL(assetPath, dashboardUrl).toString();
    await assertMirrorHeaders(assetUrl);
    const text = await fetchText(assetUrl);
    servedAssetText += `\n${text}`;
    const forbidden = forbiddenServedAssetTokens.filter((token) => text.includes(token));
    if (forbidden.length) {
      throw new Error(`dashboard asset ${assetPath} exposes forbidden mirror tokens: ${forbidden.join(", ")}`);
    }
  }
  assertServedMirrorControlMarkers(servedAssetText);
}

function assertServedMirrorControlMarkers(assetText) {
  const missing = requiredMirrorControlTokens.filter((token) => !assetText.includes(token));
  if (missing.length) {
    throw new Error(`dashboard assets should mark local view controls as mirror controls: ${missing.join(", ")}`);
  }
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
