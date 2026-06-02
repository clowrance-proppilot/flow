import type { DashboardIssue, PiSessionSnapshot, ProjectRecord, ContextProjection } from "./types";

const statusMetadata = [
  { label: "Blocked", rank: 0, themeClass: "status-theme-blocked", stateClass: "blocked", exceptional: true, active: true },
  { label: "Needs Input", rank: 1, themeClass: "status-theme-needs-input", stateClass: "needs-input", exceptional: true, active: true },
  { label: "In Review", rank: 2, workflowRank: 3, themeClass: "status-theme-review", stateClass: "in-review", exceptional: false, active: true },
  { label: "Running", rank: 3, workflowRank: 2, themeClass: "status-theme-running", stateClass: "running", exceptional: false, active: true },
  { label: "Ready", rank: 4, workflowRank: 1, themeClass: "status-theme-ready", stateClass: "ready", exceptional: false, active: true },
  { label: "Queued", rank: 5, workflowRank: 0, themeClass: "status-theme-queued", stateClass: "queued", exceptional: false, active: true },
  { label: "Done", rank: 6, workflowRank: 4, themeClass: "status-theme-done", stateClass: "done", exceptional: false, active: false },
] as const;

const statusMetadataByLabel = new Map<string, typeof statusMetadata[number]>(
  statusMetadata.map((status) => [status.label, status]),
);

export const workflowSteps = statusMetadata
  .filter((status) => status.workflowRank !== undefined)
  .sort((left, right) => (left.workflowRank ?? 0) - (right.workflowRank ?? 0))
  .map((status) => status.label);

function statusMeta(label: string): typeof statusMetadata[number] | undefined {
  return statusMetadataByLabel.get(label);
}

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
  return `issue-state ${statusMeta(label)?.stateClass ?? "queued"}`;
}

export function statusFilterThemeClass(label: string): string {
  if (label === "Active" || label === "Attention") return "status-theme-active";
  if (label === "All") return "status-theme-all";
  return statusMeta(label)?.themeClass ?? "status-theme-unknown";
}

export function isExceptionalStatus(status: string): boolean {
  return Boolean(statusMeta(status)?.exceptional);
}

export function isActiveWorkStatus(status: string): boolean {
  return statusMeta(status)?.active ?? true;
}

export function isManualActionIssue(issue: DashboardIssue): boolean {
  return isExceptionalStatus(workStatusLabel(issue));
}

export function statusRank(status: string): number {
  return statusMeta(status)?.rank ?? 7;
}

export function issueAttentionRank(issue: DashboardIssue): number {
  const status = workStatusLabel(issue);
  const missingEvidence = issue.evidenceStatus !== "Present";
  const missingDocs = issue.documentationStatus !== "Present";
  return statusRank(status) * 10
    + (missingEvidence ? 0 : 2)
    + (missingDocs ? 0 : 1);
}

export function autoflowPhaseLabel(phase?: string): string {
  switch (phase) {
    case "running": return "Autoflow working";
    case "recovering": return "Autoflow recovering";
    case "starting": return "Autoflow starting";
    case "needs_input": return "Intervention needed";
    case "failed": return "Autoflow failed";
    case "paused": return "Autoflow paused";
    case "idle": return "Autoflow idle";
    default: return "";
  }
}

export function autoflowPhaseThemeClass(phase?: string): string {
  switch (phase) {
    case "running":
    case "recovering":
    case "starting": return "autoflow-phase-active";
    case "needs_input": return "autoflow-phase-intervention";
    case "failed": return "autoflow-phase-failed";
    case "idle": return "autoflow-phase-idle";
    default: return "";
  }
}
