import type { DesktopProjectRecord, DesktopProjectRegistry } from "./project-registry.js";

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function requireActiveProject(projectRegistry: DesktopProjectRegistry): Promise<DesktopProjectRecord> {
  const project = await projectRegistry.activeProject();
  if (!project) throw new Error("No active Flow project.");
  return project;
}

export function isPromptTarget(value: unknown): value is "project" | "issue" | "thread" | "session" | "artifact" {
  return value === "project" || value === "issue" || value === "thread" || value === "session" || value === "artifact";
}

export type ProjectIssueSummary = {
  blocked: number;
  needsInput: number;
  inReview: number;
  running: number;
  ready: number;
  queued: number;
  done: number;
  total: number;
};

export function summarizeProjectIssues(issues: unknown): ProjectIssueSummary {
  const summary: ProjectIssueSummary = {
    blocked: 0,
    needsInput: 0,
    inReview: 0,
    running: 0,
    ready: 0,
    queued: 0,
    done: 0,
    total: 0,
  };
  if (!Array.isArray(issues)) return summary;
  for (const issue of issues) {
    const status = issueStatusLabel(issue);
    summary.total += 1;
    if (status === "Blocked") summary.blocked += 1;
    else if (status === "Needs Input") summary.needsInput += 1;
    else if (status === "In Review") summary.inReview += 1;
    else if (status === "Running") summary.running += 1;
    else if (status === "Ready") summary.ready += 1;
    else if (status === "Done") summary.done += 1;
    else summary.queued += 1;
  }
  return summary;
}

function issueStatusLabel(issue: unknown): string {
  if (!issue || typeof issue !== "object") return "Queued";
  const record = issue as { workStatus?: unknown; statusLabel?: unknown };
  const workStatus = typeof record.workStatus === "string" ? record.workStatus.trim() : "";
  if (workStatus) return workStatus;
  const statusLabel = typeof record.statusLabel === "string" ? record.statusLabel.trim() : "";
  if (statusLabel) return statusLabel;
  return "Queued";
}
