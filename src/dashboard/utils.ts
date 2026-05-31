import {
  isExceptionalWorkStatusLabel,
  normalizeRecordStatusLabel,
  normalizeWorkStatusLabel,
} from "../dashboard-labels.js";
import type { DashboardIssue, DashboardIssueStringField, DashboardPayload } from "./types.js";

// ---- Data Normalization ----

export function normalizeDashboardIssue(input: DashboardIssue): DashboardIssue {
  const issue: DashboardIssue = {
    ref: input.ref ? String(input.ref) : "",
    repositories: stringArray(input.repositories),
    blockerLabels: stringArray(input.blockerLabels),
  };
  assignDisplayString(issue, "title", input.title);
  issue.workStatus = normalizeWorkStatus(input.workStatus);
  assignDisplayString(issue, "workStatusDetail", input.workStatusDetail);
  assignDisplayString(issue, "statusLabel", input.statusLabel);
  assignDisplayString(issue, "prStatus", input.prStatus);
  assignDisplayString(issue, "reviewStatus", input.reviewStatus);
  issue.evidenceStatus = normalizeRecordStatus(input.evidenceStatus);
  issue.documentationStatus = normalizeRecordStatus(input.documentationStatus);
  assignDisplayString(issue, "updatedLabel", input.updatedLabel);
  assignDisplayString(issue, "nextPickup", input.nextPickup);
  assignDisplayString(issue, "handoffPrompt", input.handoffPrompt);
  return issue;
}

export function assignDisplayString(issue: DashboardIssue, field: DashboardIssueStringField, value: unknown): void {
  if (typeof value === "string" && value) {
    issue[field] = value;
  }
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function normalizeWorkStatus(value: unknown): string {
  return normalizeWorkStatusLabel(value);
}

export function normalizeRecordStatus(value: unknown): string {
  return normalizeRecordStatusLabel(value);
}

export function workStatusLabel(issue: DashboardIssue): string {
  return normalizeWorkStatus(issue.workStatus);
}

export function recordStatusLabel(status?: string): string {
  return normalizeRecordStatus(status);
}

export function recordStatusClass(status?: string): string {
  return status === "Present"
    ? "text-lime-300"
    : "text-red-300";
}

// ---- Clipboard ----

export async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to the older user-gesture copy path below.
    }
  }
  const target = document.createElement("textarea");
  target.value = value;
  target.setAttribute("readonly", "true");
  target.style.position = "fixed";
  target.style.left = "-9999px";
  target.style.top = "0";
  document.body.append(target);
  target.select();
  try {
    document.execCommand("copy");
    return true;
  } finally {
    target.remove();
  }
}

// ---- Theme / Status Helpers ----

export function workStatusThemeClass(label: string): string {
  if (label === "Blocked") return "status-theme-blocked";
  if (label === "Needs Input") return "status-theme-needs-input";
  if (label === "In Review") return "status-theme-review";
  if (label === "Running") return "status-theme-running";
  if (label === "Done") return "status-theme-done";
  if (label === "Ready") return "status-theme-ready";
  if (label === "Active") return "status-theme-active";
  if (label === "Queued") return "status-theme-queued";
  if (label === "all") return "status-theme-all";
  return "status-theme-unknown";
}

export function matchesQuery(issue: DashboardIssue, query: string): boolean {
  return [
    issue.ref,
    issue.title,
    workStatusLabel(issue),
    ...(Array.isArray(issue.repositories) ? issue.repositories : []),
    ...(Array.isArray(issue.blockerLabels) ? issue.blockerLabels : []),
  ].join(" ").toLowerCase().includes(query);
}

export function statusDotClass(kind: "loading" | "ok" | "error"): string {
  if (kind === "error") return "bg-flow-red";
  if (kind === "loading") return "bg-flow-yellow";
  return "accent-dot";
}

export function formatSnapshotTime(snapshot: DashboardPayload["snapshot"]): string {
  return snapshot?.freshnessLabel || "Snapshot not loaded";
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
