import { GitAdapter } from "./adapters/git.js";
import { AutoflowService, type AutoflowAgentSessionDriver, type AutoflowCodeReviewCreator, type AutoflowServiceStatus } from "./autoflow-service.js";
import type { FlowWorkRuntime } from "./work-runtime.js";

export const AUTOFLOW_ENABLED_STATE_KEY = "autoflow.enabled";

export interface AutoflowRunnerState {
  getProjectState<T = unknown>(projectId: string, key: string): Promise<T | undefined>;
  setProjectState(projectId: string, key: string, value: unknown): Promise<void>;
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
      enabled: () => this.enabled,
      gitInspect: async (path) => {
        const status = await git.inspect(path);
        return { dirty: status.dirty, entries: status.entries };
      },
    });
  }

  async status(): Promise<AutoflowServiceStatus> {
    await this.load();
    return this.service.getStatus();
  }

  async setEnabled(enabled: boolean): Promise<AutoflowServiceStatus> {
    await this.state.setProjectState(this.projectId, AUTOFLOW_ENABLED_STATE_KEY, enabled);
    this.enabled = enabled;
    this.loaded = true;
    return this.service.getStatus();
  }

  async tick(options: { issueRefs?: string[]; wait?: boolean } = {}): Promise<AutoflowServiceStatus> {
    await this.load();
    const status = await this.service.reconcile({ issueRefs: options.issueRefs });
    if (!options.wait) return status;
    return this.service.waitForIdle();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const configured = await this.state.getProjectState<boolean>(this.projectId, AUTOFLOW_ENABLED_STATE_KEY);
    this.enabled = configured !== false;
    this.loaded = true;
  }
}
