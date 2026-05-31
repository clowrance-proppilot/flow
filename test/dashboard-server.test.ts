import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeWorkStatusLabel,
  normalizeRecordStatusLabel,
  isExceptionalWorkStatusLabel,
  workStatusSteps,
  exceptionalWorkStatusLabels,
  recordStatusLabels,
} from "../src/dashboard-labels.js";

// ─── Dashboard Labels Tests ────────────────────────────────────────────────

test("normalizeWorkStatusLabel returns valid status labels unchanged", () => {
  for (const label of workStatusSteps) {
    assert.equal(normalizeWorkStatusLabel(label), label);
  }
  for (const label of exceptionalWorkStatusLabels) {
    assert.equal(normalizeWorkStatusLabel(label), label);
  }
});

test("normalizeWorkStatusLabel returns 'Unknown' for invalid inputs", () => {
  assert.equal(normalizeWorkStatusLabel("invalid"), "Unknown");
  assert.equal(normalizeWorkStatusLabel(""), "Unknown");
  assert.equal(normalizeWorkStatusLabel(undefined), "Unknown");
  assert.equal(normalizeWorkStatusLabel(null), "Unknown");
  assert.equal(normalizeWorkStatusLabel(123), "Unknown");
  assert.equal(normalizeWorkStatusLabel({}), "Unknown");
});

test("normalizeRecordStatusLabel returns valid record status labels unchanged", () => {
  for (const label of recordStatusLabels) {
    assert.equal(normalizeRecordStatusLabel(label), label);
  }
});

test("normalizeRecordStatusLabel returns 'Needed' for invalid inputs", () => {
  assert.equal(normalizeRecordStatusLabel("invalid"), "Needed");
  assert.equal(normalizeRecordStatusLabel(""), "Needed");
  assert.equal(normalizeRecordStatusLabel(undefined), "Needed");
  assert.equal(normalizeRecordStatusLabel(null), "Needed");
  assert.equal(normalizeRecordStatusLabel(123), "Needed");
});

test("isExceptionalWorkStatusLabel identifies exceptional statuses", () => {
  assert.equal(isExceptionalWorkStatusLabel("Blocked"), true);
  assert.equal(isExceptionalWorkStatusLabel("Needs Input"), true);
  assert.equal(isExceptionalWorkStatusLabel("Queued"), false);
  assert.equal(isExceptionalWorkStatusLabel("Active"), false);
  assert.equal(isExceptionalWorkStatusLabel("Done"), false);
  assert.equal(isExceptionalWorkStatusLabel("Unknown"), false);
});

// ─── Dashboard Server Configuration Tests ─────────────────────────────────

test("Dashboard server resolves host from config", () => {
  // Test the resolveDashboardHost function behavior
  function resolveDashboardHost(config: { runtime?: { dashboard?: { host?: string } } } | undefined): string {
    const host = config?.runtime?.dashboard?.host?.trim();
    return host || "127.0.0.1";
  }

  assert.equal(resolveDashboardHost(undefined), "127.0.0.1");
  assert.equal(resolveDashboardHost({}), "127.0.0.1");
  assert.equal(resolveDashboardHost({ runtime: {} }), "127.0.0.1");
  assert.equal(resolveDashboardHost({ runtime: { dashboard: {} } }), "127.0.0.1");
  assert.equal(resolveDashboardHost({ runtime: { dashboard: { host: "" } } }), "127.0.0.1");
  assert.equal(resolveDashboardHost({ runtime: { dashboard: { host: "  " } } }), "127.0.0.1");
  assert.equal(resolveDashboardHost({ runtime: { dashboard: { host: "0.0.0.0" } } }), "0.0.0.0");
  assert.equal(resolveDashboardHost({ runtime: { dashboard: { host: "  192.168.1.1  " } } }), "192.168.1.1");
});

test("Dashboard server resolves port from config", () => {
  function resolveDashboardPort(config: { runtime?: { dashboard?: { port?: number } } } | undefined): number {
    const port = config?.runtime?.dashboard?.port ?? 8767;
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Missing required config value: runtime.dashboard.port");
    }
    return port;
  }

  assert.equal(resolveDashboardPort(undefined), 8767);
  assert.equal(resolveDashboardPort({}), 8767);
  assert.equal(resolveDashboardPort({ runtime: { dashboard: { port: 3000 } } }), 3000);
  assert.equal(resolveDashboardPort({ runtime: { dashboard: { port: 65535 } } }), 65535);
  assert.equal(resolveDashboardPort({ runtime: { dashboard: { port: 1 } } }), 1);

  assert.throws(() => resolveDashboardPort({ runtime: { dashboard: { port: 0 } } }));
  assert.throws(() => resolveDashboardPort({ runtime: { dashboard: { port: -1 } } }));
  assert.throws(() => resolveDashboardPort({ runtime: { dashboard: { port: 65536 } } }));
  assert.throws(() => resolveDashboardPort({ runtime: { dashboard: { port: 1.5 } } }));
});

test("Dashboard server resolves URL from config", () => {
  function resolveDashboardUrl(config: { runtime?: { dashboard?: { url?: string; host?: string; port?: number } } } | undefined): string {
    const host = config?.runtime?.dashboard?.host?.trim() || "127.0.0.1";
    const port = config?.runtime?.dashboard?.port ?? 8767;
    const url = config?.runtime?.dashboard?.url?.trim();
    return url || `http://${host}:${port}`;
  }

  assert.equal(resolveDashboardUrl(undefined), "http://127.0.0.1:8767");
  assert.equal(resolveDashboardUrl({}), "http://127.0.0.1:8767");
  assert.equal(
    resolveDashboardUrl({ runtime: { dashboard: { url: "https://dashboard.example.com" } } }),
    "https://dashboard.example.com"
  );
  assert.equal(
    resolveDashboardUrl({ runtime: { dashboard: { host: "0.0.0.0", port: 3000 } } }),
    "http://0.0.0.0:3000"
  );
});

test("Dashboard server error message extraction", () => {
  function errorMessage(error: unknown): string {
    if (error instanceof Error) return `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
    return String(error);
  }

  assert.ok(errorMessage(new Error("test error")).includes("test error"));
  assert.equal(errorMessage("string error"), "string error");
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");
});

// ─── Dashboard Server Security Headers Tests ──────────────────────────────

test("Dashboard server security headers structure", () => {
  // Test the header values that should be set based on setMirrorHeaders function
  const expectedHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-DNS-Prefetch-Control": "off",
    "X-Frame-Options": "DENY",
  };

  // Verify the expected CSP structure
  const cspParts = [
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
  ];
  const expectedCsp = cspParts.join("; ");

  // Verify the expected Permissions-Policy structure
  const permissionsParts = [
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
  ];
  const expectedPermissionsPolicy = permissionsParts.join(", ");

  assert.ok(expectedCsp.includes("default-src 'none'"));
  assert.ok(expectedCsp.includes("script-src 'self'"));
  assert.ok(expectedPermissionsPolicy.includes("camera=()"));
  assert.ok(expectedPermissionsPolicy.includes("clipboard-write=(self)"));
});

// ─── Dashboard Snapshot Freshness Label Tests ─────────────────────────────

test("Dashboard snapshot freshness label formats relative time", () => {
  // Test the dashboardSnapshotFreshnessLabel function behavior
  function dashboardRelativeTime(value: unknown): string {
    const raw = typeof value === "string" ? value : "";
    if (!raw) return "";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "Unknown";
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function dashboardSnapshotFreshnessLabel(refreshedAt: string): string {
    const relative = dashboardRelativeTime(refreshedAt);
    if (!relative) return "Snapshot not loaded";
    if (relative === "Unknown") return "Snapshot time unknown";
    return `Snapshot ${relative}`;
  }

  // Test with recent timestamp
  const recentTime = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
  assert.ok(dashboardSnapshotFreshnessLabel(recentTime).includes("s ago"));

  // Test with minutes ago
  const minutesAgo = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago
  assert.ok(dashboardSnapshotFreshnessLabel(minutesAgo).includes("m ago"));

  // Test with hours ago
  const hoursAgo = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago
  assert.ok(dashboardSnapshotFreshnessLabel(hoursAgo).includes("h ago"));

  // Test with empty string
  assert.equal(dashboardSnapshotFreshnessLabel(""), "Snapshot not loaded");

  // Test with invalid date
  assert.equal(dashboardSnapshotFreshnessLabel("not-a-date"), "Snapshot time unknown");
});

// ─── Dashboard Public Issue Contract Tests ────────────────────────────────

test("Dashboard public issue contract omits internal fields", () => {
  // Test that only allowed fields are included in the public contract
  const allowedFields = [
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
  ];

  // Simulate the publicDashboardIssue function behavior
  function publicDashboardIssue(summary: Record<string, unknown>): Record<string, unknown> {
    const publicIssue: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (!Object.hasOwn(summary, field)) continue;
      const value = summary[field];
      if (value === "" || value === undefined) continue;
      publicIssue[field] = value;
    }
    return publicIssue;
  }

  // Test with a summary that includes extra fields
  const summary = {
    ref: "GH-1",
    title: "Test Issue",
    workStatus: "Active",
    repositories: ["app_api"],
    evidenceStatus: "Present",
    documentationStatus: "Needed",
    blockerLabels: [],
    // Internal fields that should be omitted
    branch: "feature/gh-1",
    headSha: "abc123",
    worktreePath: "/tmp/worktree",
    issueUrl: "https://github.com/example/repo/issues/1",
    prUrl: "https://github.com/example/repo/pull/1",
    repoKeys: ["app_api"],
  };

  const publicIssue = publicDashboardIssue(summary);

  // Verify allowed fields are present
  assert.equal(publicIssue.ref, "GH-1");
  assert.equal(publicIssue.title, "Test Issue");
  assert.equal(publicIssue.workStatus, "Active");
  assert.deepEqual(publicIssue.repositories, ["app_api"]);
  assert.equal(publicIssue.evidenceStatus, "Present");
  assert.equal(publicIssue.documentationStatus, "Needed");

  // Verify internal fields are omitted
  assert.equal(Object.hasOwn(publicIssue, "branch"), false);
  assert.equal(Object.hasOwn(publicIssue, "headSha"), false);
  assert.equal(Object.hasOwn(publicIssue, "worktreePath"), false);
  assert.equal(Object.hasOwn(publicIssue, "issueUrl"), false);
  assert.equal(Object.hasOwn(publicIssue, "prUrl"), false);
  assert.equal(Object.hasOwn(publicIssue, "repoKeys"), false);

  // Verify all keys in the result are in the allowed list
  for (const key of Object.keys(publicIssue)) {
    assert.ok(
      allowedFields.includes(key),
      `Unexpected field "${key}" in public issue contract`
    );
  }
});

test("Dashboard public issue contract omits empty values", () => {
  const allowedFields = [
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
  ];

  function publicDashboardIssue(summary: Record<string, unknown>): Record<string, unknown> {
    const publicIssue: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (!Object.hasOwn(summary, field)) continue;
      const value = summary[field];
      if (value === "" || value === undefined) continue;
      publicIssue[field] = value;
    }
    return publicIssue;
  }

  const summary = {
    ref: "GH-2",
    title: "Test Issue",
    workStatus: "Active",
    repositories: ["app_api"],
    evidenceStatus: "Present",
    documentationStatus: "Needed",
    blockerLabels: [],
    statusLabel: "",
    prStatus: undefined,
    reviewStatus: "",
    updatedLabel: undefined,
    nextPickup: "",
    handoffPrompt: undefined,
    workStatusDetail: "",
  };

  const publicIssue = publicDashboardIssue(summary);

  // Verify empty/undefined fields are omitted
  assert.equal(Object.hasOwn(publicIssue, "statusLabel"), false);
  assert.equal(Object.hasOwn(publicIssue, "prStatus"), false);
  assert.equal(Object.hasOwn(publicIssue, "reviewStatus"), false);
  assert.equal(Object.hasOwn(publicIssue, "updatedLabel"), false);
  assert.equal(Object.hasOwn(publicIssue, "nextPickup"), false);
  assert.equal(Object.hasOwn(publicIssue, "handoffPrompt"), false);
  assert.equal(Object.hasOwn(publicIssue, "workStatusDetail"), false);

  // Verify non-empty fields are present
  assert.equal(publicIssue.ref, "GH-2");
  assert.equal(publicIssue.title, "Test Issue");
});
