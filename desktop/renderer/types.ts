export type StatusKind = "loading" | "ok" | "error";
export type WorkStatusFilter = "active" | "all" | string;

export type ProjectStatusCounts = {
  blocked: number;
  needsInput: number;
  inReview: number;
  running: number;
  ready: number;
  queued: number;
  done: number;
  total: number;
};

export type { DesktopAction } from "../action-types";

export type ProjectRecord = {
  id: string;
  name: string;
  root: string;
  valid: boolean;
  icon?: string;
  error?: string;
  autoflowEnabled?: boolean;
  attentionCount?: number;
  statusCounts?: ProjectStatusCounts;
};

export type DashboardIssue = {
  ref: string;
  title?: string;
  workStatus?: string;
  workStatusDetail?: string;
  statusLabel?: string;
  blockerLabels?: string[];
  repositories?: string[];
  prStatus?: string;
  reviewStatus?: string;
  evidenceStatus?: string;
  documentationStatus?: string;
  updatedLabel?: string;
  nextPickup?: string;
  handoffPrompt?: string;
};

export type CreatedIssue = {
  ref: string;
  title?: string;
};

export type DashboardPayload = {
  snapshot?: {
    freshnessLabel?: string;
  };
  issues?: DashboardIssue[];
};

export type ContextProjection = {
  active?: {
    projectId?: string;
    issueRef?: string;
    threadId?: string;
    sessionId?: string;
    artifactId?: string;
  };
  prompts?: Array<{
    id: string;
    prompt: string;
    issueRef?: string;
    threadId?: string;
    sessionId?: string;
    artifactRefs?: string[];
    summary?: string;
    updatedAt: string;
  }>;
  artifacts?: Array<{
    id: string;
    artifactType: string;
    title: string;
    uri?: string;
    path?: string;
    summary?: string;
    updatedAt?: string;
  }>;
  desktop?: {
    refreshIntervalMs?: number;
    dashboardRefreshIntervalMs?: number;
    autoflowStatusRefreshIntervalMs?: number;
  };
};

export type IssueType = "Bug" | "Task" | "Story";

export const ISSUE_TYPES: IssueType[] = ["Bug", "Task", "Story"];

export type ConversationItem = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
};

export type { PiSessionSnapshot, PiSessionStatus, PiTimelineItem } from "../../src/pi-session-driver";
export type { SessionDriverEvent as PiSessionEvent } from "../../src/session-driver";

export type PendingConfirmationState = {
  id: string;
  summary: string;
};

export type PiActivityState = {
  phase: "idle" | "starting" | "thinking" | "tool" | "responding" | "done" | "failed";
  label: string;
  detail?: string;
  toolName?: string;
  updatedAt?: string;
};

export type AutoflowRunnerIssueStatus = {
  phase: "paused" | "idle" | "starting" | "running" | "needs_input" | "failed";
  sessionId?: string;
  workspacePath?: string;
  summary?: string;
  reason?: string;
  updatedAt: string;
};

export type AutoflowRunnerStatus = {
  enabled: boolean;
  maxConcurrency: number;
  activeCount: number;
  issues: Record<string, AutoflowRunnerIssueStatus>;
  summary: string;
  updatedAt: string;
};
