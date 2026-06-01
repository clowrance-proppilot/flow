export const durableExecutionBackendValues = [
  "flow-standalone",
  "hatchet",
] as const;

export type DurableExecutionBackend = typeof durableExecutionBackendValues[number];

export type FlowExecutionControlSurface = "cli" | "desktop" | "daemon" | "api";

export type AutoflowSemanticStep =
  | "select_issue"
  | "doctor"
  | "prepare_workspace"
  | "create_worker_handoff"
  | "run_executor"
  | "record_result"
  | "closeout";

export const autoflowSemanticSteps = [
  "select_issue",
  "doctor",
  "prepare_workspace",
  "create_worker_handoff",
  "run_executor",
  "record_result",
  "closeout",
] as const satisfies readonly AutoflowSemanticStep[];

export interface AutoflowExecutionRequest {
  projectId: string;
  issueRef: string;
  repoKeys: readonly string[];
  requestedBy: FlowExecutionControlSurface;
  runId?: string;
  reason?: string;
  durableSession?: DurablePiSessionHandle;
}

export interface AutoflowExecutionHandle {
  backend: DurableExecutionBackend;
  runId: string;
  issueRef: string;
  projectId: string;
  statusUrl?: string;
}

export interface AutoflowExecutionSnapshot extends AutoflowExecutionHandle {
  phase: "queued" | "running" | "needs_input" | "failed" | "succeeded" | "cancelled";
  summary: string;
  updatedAt: string;
}

export interface AutoflowExecutionProvider {
  readonly backend: DurableExecutionBackend;
  enqueueAutoflowRun(request: AutoflowExecutionRequest): Promise<AutoflowExecutionHandle>;
  getAutoflowRun(runId: string): Promise<AutoflowExecutionSnapshot | undefined>;
  cancelAutoflowRun(runId: string): Promise<void>;
}

export const HATCHET_AUTOFLOW_TASK_NAME = "flow.autoflow.run_issue";
export const HATCHET_AUTOFLOW_WORKER_NAME = "flow-autoflow-worker";
export const HATCHET_AUTOFLOW_VERSION = "flow-autoflow-v1";

export interface HatchetAutoflowPayload {
  version: typeof HATCHET_AUTOFLOW_VERSION;
  taskName: typeof HATCHET_AUTOFLOW_TASK_NAME;
  projectId: string;
  issueRef: string;
  repoKeys: string[];
  requestedBy: FlowExecutionControlSurface;
  runId: string;
  reason?: string;
  durableSession?: DurablePiSessionHandle;
  concurrencyKey: string;
  semanticSteps: readonly AutoflowSemanticStep[];
}

export interface DurablePiSessionHandle {
  provider: "pi";
  issueRef: string;
  flowSessionId: string;
  piSessionId: string;
  sessionFile?: string;
  workspacePath?: string;
}

export interface HatchetAutoflowRunResult {
  issueRef: string;
  runId: string;
  status: "succeeded" | "blocked" | "failed";
  summary: string;
  changedFiles: string[];
  testsRun: string[];
  completedAt: string;
}

export function toHatchetAutoflowPayload(request: AutoflowExecutionRequest): HatchetAutoflowPayload {
  const normalized = normalizeAutoflowExecutionRequest(request);
  return {
    version: HATCHET_AUTOFLOW_VERSION,
    taskName: HATCHET_AUTOFLOW_TASK_NAME,
    ...normalized,
    concurrencyKey: hatchetRepoConcurrencyKey(normalized),
    semanticSteps: autoflowSemanticSteps,
  };
}

export function hatchetRepoConcurrencyKey(request: Pick<AutoflowExecutionRequest, "projectId" | "repoKeys">): string {
  const projectId = requiredTrimmed(request.projectId, "projectId");
  const repoKeys = normalizeRepoKeys(request.repoKeys);
  const repoScope = repoKeys.length ? repoKeys.join("+") : "unrouted";
  return `flow:${projectId}:repos:${repoScope}`;
}

function normalizeAutoflowExecutionRequest(request: AutoflowExecutionRequest): Omit<HatchetAutoflowPayload, "version" | "taskName" | "concurrencyKey" | "semanticSteps"> {
  const projectId = requiredTrimmed(request.projectId, "projectId");
  const issueRef = requiredTrimmed(request.issueRef, "issueRef").toUpperCase();
  const repoKeys = normalizeRepoKeys(request.repoKeys);
  const runId = request.runId?.trim() || `${projectId}:${issueRef}`;
  const reason = request.reason?.trim() || undefined;
  return {
    projectId,
    issueRef,
    repoKeys,
    requestedBy: request.requestedBy,
    runId,
    ...(reason ? { reason } : {}),
    ...(request.durableSession ? { durableSession: normalizeDurablePiSessionHandle(request.durableSession) } : {}),
  };
}

function normalizeRepoKeys(repoKeys: readonly string[]): string[] {
  return [...new Set(repoKeys.map((key) => key.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function requiredTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function normalizeDurablePiSessionHandle(handle: DurablePiSessionHandle): DurablePiSessionHandle {
  return {
    provider: "pi",
    issueRef: requiredTrimmed(handle.issueRef, "durableSession.issueRef").toUpperCase(),
    flowSessionId: requiredTrimmed(handle.flowSessionId, "durableSession.flowSessionId"),
    piSessionId: requiredTrimmed(handle.piSessionId, "durableSession.piSessionId"),
    ...(handle.sessionFile?.trim() ? { sessionFile: handle.sessionFile.trim() } : {}),
    ...(handle.workspacePath?.trim() ? { workspacePath: handle.workspacePath.trim() } : {}),
  };
}
