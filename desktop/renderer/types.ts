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

export type ConversationItem = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
};

export type PiTimelineItem = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolName?: string;
};

export type PiSessionSnapshot = {
  id: string;
  issueRef: string;
  status: "active" | "running" | "paused" | "done" | "failed";
  timeline: PiTimelineItem[];
};

export type PiSessionEvent = {
  type: "assistantDelta" | "toolStarted" | "toolUpdated" | "toolFinished" | "runFailed" | "runCompleted" | "sessionUpdated";
  timestamp: string;
  text?: string;
  toolName?: string;
  callId?: string;
  success?: boolean;
  error?: { message?: string };
  snapshot?: { status?: "idle" | "running" | "failed" };
};

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

export type PiAgentOrchestratorIssueStatus = {
  phase: "queued" | "starting" | "running" | "blocked" | "needs_input" | "failed" | "done";
  sessionId?: string;
  workspacePath?: string;
  summary?: string;
  reason?: string;
  updatedAt: string;
};

export type PiAgentOrchestratorStatus = {
  enabled: boolean;
  maxConcurrency: number;
  activeCount: number;
  issues: Record<string, PiAgentOrchestratorIssueStatus>;
  summary: string;
  updatedAt: string;
};
