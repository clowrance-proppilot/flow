import { join } from "node:path";
import { GitAdapter } from "./adapters/git.js";
import { AutoflowService, type AutoflowAgentSessionDriver, type AutoflowCodeReviewCreator, type AutoflowServiceStatus } from "./autoflow-service.js";
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
}

export class StandaloneAutoflowRunner {
  private readonly projectId: string;
  private readonly state: AutoflowRunnerState;
  private readonly service: AutoflowService;
  private enabled = true;
  private loaded = false;

  constructor(options: StandaloneAutoflowRunnerOptions) {
    this.projectId = options.projectId;
    this.state = options.state;
    const git = new GitAdapter();
    this.service = new AutoflowService({
      projectId: options.projectId,
      runtime: options.runtime,
      agentSessionDriver: options.agentSessionDriver,
      codeReviewCreator: options.codeReviewCreator,
      maxConcurrency: options.maxConcurrency,
      postPromptTimeoutMs: options.postPromptTimeoutMs,
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
    if (!status.enabled || status.activeCount > 0 || Object.keys(status.issues).length > 0) return status;
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
    await this.state.setProjectState(this.projectId, AUTOFLOW_STATUS_STATE_KEY, status);
    return status;
  }

  private async readPersistedStatus(): Promise<AutoflowServiceStatus | undefined> {
    const status = await this.state.getProjectState<AutoflowServiceStatus>(this.projectId, AUTOFLOW_STATUS_STATE_KEY);
    return isAutoflowServiceStatus(status) ? status : undefined;
  }
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
