import type { DashboardIssue, PiSessionSnapshot, ProjectRecord, ContextProjection } from "./types";

export const workflowSteps = ["Queued", "Ready", "Running", "In Review", "Done"] as const;

export function sessionStatusForUi(status?: PiSessionSnapshot["status"]): "idle" | "running" | "failed" {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "idle";
}

export function contextLine(
  project: ProjectRecord | undefined,
  issue: DashboardIssue | undefined,
  _context: ContextProjection,
  _selectedSessionId?: string,
): string {
  const parts = [
    project?.name,
    issue?.ref,
  ].filter(Boolean);
  return parts.join(" / ") || "No active context";
}

export function workStatusLabel(issue: DashboardIssue): string {
  return (issue.workStatus || issue.statusLabel || "Queued").trim() || "Queued";
}

export function issueDetail(issue: DashboardIssue): string {
  const primary = issue.blockerLabels?.[0]
    || issue.reviewStatus
    || issue.evidenceStatus
    || issue.documentationStatus
    || issue.updatedLabel
    || issue.repositories?.[0]
    || "";
  return primary === workStatusLabel(issue) ? "" : primary;
}

export function recordStatusLabel(status?: string): string {
  return status === "Present" ? "Present" : "Needed";
}

export function recordStatusClass(status?: string): string {
  return status === "Present" ? "record-present" : "record-needed";
}

export function statusThemeClass(label: string): string {
  if (label === "Blocked") return "issue-state blocked";
  if (label === "Needs Input") return "issue-state needs-input";
  if (label === "In Review") return "issue-state in-review";
  if (label === "Running") return "issue-state running";
  if (label === "Done") return "issue-state done";
  if (label === "Ready") return "issue-state ready";
  return "issue-state queued";
}

export function statusFilterThemeClass(label: string): string {
  if (label === "Blocked") return "status-theme-blocked";
  if (label === "Needs Input") return "status-theme-needs-input";
  if (label === "In Review") return "status-theme-review";
  if (label === "Running") return "status-theme-running";
  if (label === "Done") return "status-theme-done";
  if (label === "Ready") return "status-theme-ready";
  if (label === "Queued") return "status-theme-queued";
  if (label === "All") return "status-theme-all";
  return "status-theme-unknown";
}

export function isExceptionalStatus(status: string): boolean {
  return status === "Blocked" || status === "Needs Input";
}

export function isActiveWorkStatus(status: string): boolean {
  return status !== "Done";
}

export function isManualActionIssue(issue: DashboardIssue): boolean {
  return isExceptionalStatus(workStatusLabel(issue));
}

export function statusRank(status: string): number {
  if (status === "Blocked") return 0;
  if (status === "Needs Input") return 1;
  if (status === "In Review") return 2;
  if (status === "Running") return 3;
  if (status === "Ready") return 4;
  if (status === "Queued") return 5;
  if (status === "Done") return 6;
  return 7;
}

export function issueAttentionRank(issue: DashboardIssue): number {
  const status = workStatusLabel(issue);
  const missingEvidence = issue.evidenceStatus !== "Present";
  const missingDocs = issue.documentationStatus !== "Present";
  return statusRank(status) * 10
    + (missingEvidence ? 0 : 2)
    + (missingDocs ? 0 : 1);
}
