import { join } from "node:path";
import { GitAdapter } from "./adapters/git.js";
import { AutoflowService, type AutoflowAgentSessionDriver, type AutoflowCodeReviewCreator, type AutoflowServiceStatus } from "./autoflow-service.js";
import type { WorkItem } from "./contracts.js";
import { flowUserStateRoot } from "./flow-layout.js";
import { createKyselyFlowState, createSqliteSqlStateConfig } from "./sql-state.js";
import type { FlowWorkRuntime } from "./work-runtime.js";

export const AUTOFLOW_ENABLED_STATE_KEY = "autoflow.enabled";
export const AUTOFLOW_STATUS_STATE_KEY = "autoflow.status";

export interface AutoflowRunnerState {
  getProjectState<T = unknown>(projectId: string, key: string): Promise<T | undefined>;
  setProjectState(projectId: string, key: string, value: unknown): Promise<void>;
}

export function createDefaultAutoflowRunnerState(projectRoot: string): AutoflowRunnerState {
  const root = flowUserStateRoot(projectRoot);
  return createKyselyFlowState({
    root,
    dialectConfig: createSqliteSqlStateConfig({ path: join(root, "flow-state.db") }),
  });
}

export interface StandaloneAutoflowRunnerOptions {
  projectId: string;
  runtime: FlowWorkRuntime;
  state: AutoflowRunnerState;
  agentSessionDriver: AutoflowAgentSessionDriver;
  codeReviewCreator?: AutoflowCodeReviewCreator;
  maxConcurrency?: number;
  postPromptTimeoutMs?: number;
  recoveryPollAttempts?: number;
  recoveryPollIntervalMs?: number;
}

export class StandaloneAutoflowRunner {
  private readonly projectId: string;
  private readonly state: AutoflowRunnerState;
  private readonly runtime: FlowWorkRuntime;
  private readonly service: AutoflowService;
  private enabled = true;
  private loaded = false;

  constructor(options: StandaloneAutoflowRunnerOptions) {
    this.projectId = options.projectId;
    this.state = options.state;
    this.runtime = options.runtime;
    const git = new GitAdapter();
    this.service = new AutoflowService({
      projectId: options.projectId,
      runtime: options.runtime,
      agentSessionDriver: options.agentSessionDriver,
      codeReviewCreator: options.codeReviewCreator,
      maxConcurrency: options.maxConcurrency,
      postPromptTimeoutMs: options.postPromptTimeoutMs,
      recoveryPollAttempts: options.recoveryPollAttempts,
      recoveryPollIntervalMs: options.recoveryPollIntervalMs,
      autoReconcileOnSlotAvailable: false,
      onStatusChange: async (status) => {
        await this.persistStatus(status);
      },
      enabled: () => this.enabled,
      gitInspect: async (path) => {
        const status = await git.inspect(path);
        return { dirty: status.dirty, entries: status.entries };
      },
    });
  }

  async status(): Promise<AutoflowServiceStatus> {
    await this.load();
    const status = this.service.getStatus();
    if (!status.enabled || status.activeCount > 0 || Object.keys(status.issues).length > 0) {
      return await this.reconcileTerminalPersistedStatus(normalizeAutoflowStatus(status));
    }
    return await this.readPersistedStatus() ?? status;
  }

  async setEnabled(enabled: boolean): Promise<AutoflowServiceStatus> {
    await this.state.setProjectState(this.projectId, AUTOFLOW_ENABLED_STATE_KEY, enabled);
    this.enabled = enabled;
    this.loaded = true;
    return await this.persistStatus(this.service.getStatus());
  }

  async tick(options: { issueRefs?: string[]; wait?: boolean } = {}): Promise<AutoflowServiceStatus> {
    await this.load();
    const status = await this.service.reconcile({ issueRefs: options.issueRefs });
    await this.persistStatus(status);
    if (!options.wait) return status;
    return this.persistStatus(await this.service.waitForIdle());
  }

  async sendUserMessage(input: { issueRef: string; sessionId?: string; text: string }) {
    await this.load();
    return this.service.sendUserMessage(input);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const configured = await this.state.getProjectState<boolean>(this.projectId, AUTOFLOW_ENABLED_STATE_KEY);
    this.enabled = configured !== false;
    this.loaded = true;
  }

  private async persistStatus(status: AutoflowServiceStatus): Promise<AutoflowServiceStatus> {
    const normalized = normalizeAutoflowStatus(status);
    await this.state.setProjectState(this.projectId, AUTOFLOW_STATUS_STATE_KEY, normalized);
    return normalized;
  }

  private async readPersistedStatus(): Promise<AutoflowServiceStatus | undefined> {
    const status = await this.state.getProjectState<AutoflowServiceStatus>(this.projectId, AUTOFLOW_STATUS_STATE_KEY);
    return isAutoflowServiceStatus(status)
      ? await this.reconcileTerminalPersistedStatus(normalizeAutoflowStatus(status))
      : undefined;
  }

  private async reconcileTerminalPersistedStatus(status: AutoflowServiceStatus): Promise<AutoflowServiceStatus> {
    const inspectIssue = typeof this.runtime.inspectIssue === "function"
      ? this.runtime.inspectIssue.bind(this.runtime)
      : undefined;
    if (!inspectIssue) return status;

    const issues = { ...status.issues };
    let changed = false;
    for (const [ref, issueStatus] of Object.entries(issues)) {
      const issue = await inspectIssue(ref).catch(() => undefined);
      if (!issue || !isTerminalWorkflowIssue(issue)) continue;
      delete issues[ref];
      changed = true;
    }

    const normalized = normalizeAutoflowStatus({ ...status, issues });
    if (changed) await this.state.setProjectState(this.projectId, AUTOFLOW_STATUS_STATE_KEY, normalized);
    return normalized;
  }
}

function normalizeAutoflowStatus(status: AutoflowServiceStatus): AutoflowServiceStatus {
  const issues = Object.fromEntries(
    Object.entries(status.issues).map(([ref, issue]) => [ref, { ...issue }]),
  );
  const activeCount = Object.values(issues).filter((issue) => isActiveAutoflowPhase(issue.phase)).length;
  const blockedCount = Object.values(issues).filter((issue) => issue.phase === "needs_input").length;
  return {
    ...status,
    activeCount: status.enabled ? activeCount : 0,
    issues,
    summary: status.enabled ? autoflowStatusSummary(activeCount, blockedCount) : "Autoflow is paused.",
  };
}

function autoflowStatusSummary(activeCount: number, blockedCount: number): string {
  if (activeCount === 0 && blockedCount === 0) return "Autoflow idle.";
  if (activeCount === 0) return `${blockedCount} issue${blockedCount === 1 ? "" : "s"} need${blockedCount === 1 ? "s" : ""} input.`;
  let summary = `Working ${activeCount} issue${activeCount === 1 ? "" : "s"}.`;
  if (blockedCount > 0) summary += ` ${blockedCount} need${blockedCount === 1 ? "s" : ""} input.`;
  return summary;
}

function isActiveAutoflowPhase(phase: string): boolean {
  return phase === "starting" || phase === "running" || phase === "recovering";
}

function isTerminalWorkflowIssue(issue: WorkItem): boolean {
  if (issue.state === "done") return true;
  const metadata = issue.metadata ?? {};
  return metadata["workflow.closeout.merged"] === true ||
    metadata.issueStatus === "Closed" ||
    metadata.jiraStatus === "Closed" ||
    metadata.issueStatusCategory === "Complete" ||
    metadata.jiraStatusCategory === "Complete";
}

function isAutoflowServiceStatus(value: unknown): value is AutoflowServiceStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<AutoflowServiceStatus>;
  return typeof status.enabled === "boolean" &&
    typeof status.maxConcurrency === "number" &&
    typeof status.activeCount === "number" &&
    Boolean(status.issues) &&
    typeof status.issues === "object" &&
    typeof status.summary === "string" &&
    typeof status.updatedAt === "string";
}
