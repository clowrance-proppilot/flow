import {
  HATCHET_AUTOFLOW_TASK_NAME,
  HATCHET_AUTOFLOW_VERSION,
  HATCHET_AUTOFLOW_WORKER_NAME,
  type AutoflowExecutionHandle,
  type AutoflowExecutionProvider,
  type AutoflowExecutionRequest,
  type AutoflowExecutionSnapshot,
  type HatchetAutoflowPayload,
  type HatchetAutoflowRunResult,
  toHatchetAutoflowPayload,
} from "./execution-plane.js";
import { nowIso } from "./contracts.js";

export const HATCHET_GROUP_ROUND_ROBIN = 3;

export interface HatchetSdkModule {
  default?: { init?(): HatchetClientLike; Hatchet?: { init(): HatchetClientLike } };
  Hatchet?: { init(): HatchetClientLike };
}

export interface HatchetRunRef {
  getWorkflowRunId(): Promise<string>;
  cancel?(): Promise<void>;
}

export interface HatchetTaskDeclaration {
  runNoWait(input: HatchetAutoflowPayload, options?: HatchetRunOptions): Promise<HatchetRunRef>;
}

export interface HatchetWorkerHandle {
  start(): Promise<void>;
  stop?(): Promise<void>;
  waitUntilReady?(timeoutMs?: number): Promise<void>;
}

export interface HatchetClientLike {
  task(options: HatchetTaskOptions): HatchetTaskDeclaration;
  worker(name: string, options: { workflows: HatchetTaskDeclaration[]; slots?: number }): Promise<HatchetWorkerHandle>;
  runRef(runId: string): HatchetRunRef;
  runs?: {
    get_status(runId: string): Promise<string>;
    cancel(options: { ids: string[] }): Promise<unknown>;
  };
}

export interface HatchetTaskOptions {
  name: typeof HATCHET_AUTOFLOW_TASK_NAME;
  retries: number;
  executionTimeout: string;
  scheduleTimeout: string;
  concurrency: {
    expression: "input.concurrencyKey";
    maxRuns: 1;
    limitStrategy: typeof HATCHET_GROUP_ROUND_ROBIN;
  };
  fn(input: HatchetAutoflowPayload): Promise<HatchetAutoflowRunResult>;
}

export interface HatchetRunOptions {
  additionalMetadata?: Record<string, string>;
}

export interface HatchetAutoflowTaskRunner {
  runAutoflowIssue(input: HatchetAutoflowPayload): Promise<HatchetAutoflowRunResult>;
}

export interface HatchetAutoflowProviderOptions {
  client: HatchetClientLike;
  task: HatchetTaskDeclaration;
  dashboardUrl?: string;
}

export interface HatchetAutoflowWorkerOptions {
  client: HatchetClientLike;
  runner: HatchetAutoflowTaskRunner;
  workerName?: string;
  slots?: number;
}

export async function createHatchetClient(): Promise<HatchetClientLike> {
  const packageName = "@hatchet-dev/typescript-sdk";
  const mod = await import(packageName) as unknown as HatchetSdkModule;
  const factory = mod.default?.init ? mod.default : mod.Hatchet ?? mod.default?.Hatchet;
  if (!factory?.init) throw new Error("Hatchet SDK did not expose an init() client factory.");
  return factory.init();
}

export function createHatchetAutoflowTask(client: HatchetClientLike, runner: HatchetAutoflowTaskRunner): HatchetTaskDeclaration {
  return client.task({
    name: HATCHET_AUTOFLOW_TASK_NAME,
    retries: 2,
    executionTimeout: "2h",
    scheduleTimeout: "24h",
    concurrency: {
      expression: "input.concurrencyKey",
      maxRuns: 1,
      limitStrategy: HATCHET_GROUP_ROUND_ROBIN,
    },
    fn: async (input) => runner.runAutoflowIssue(input),
  });
}

export async function startHatchetAutoflowWorker(options: HatchetAutoflowWorkerOptions): Promise<HatchetWorkerHandle> {
  const task = createHatchetAutoflowTask(options.client, options.runner);
  const worker = await options.client.worker(options.workerName ?? HATCHET_AUTOFLOW_WORKER_NAME, {
    workflows: [task],
    slots: options.slots ?? 1,
  });
  void worker.start();
  await worker.waitUntilReady?.();
  return worker;
}

export class HatchetAutoflowExecutionProvider implements AutoflowExecutionProvider {
  readonly backend = "hatchet" as const;
  private readonly client: HatchetClientLike;
  private readonly task: HatchetTaskDeclaration;
  private readonly dashboardUrl?: string;

  constructor(options: HatchetAutoflowProviderOptions) {
    this.client = options.client;
    this.task = options.task;
    this.dashboardUrl = options.dashboardUrl?.replace(/\/$/, "");
  }

  async enqueueAutoflowRun(request: AutoflowExecutionRequest): Promise<AutoflowExecutionHandle> {
    const payload = toHatchetAutoflowPayload(request);
    const run = await this.task.runNoWait(payload, {
      additionalMetadata: {
        "flow.project_id": payload.projectId,
        "flow.issue_ref": payload.issueRef,
        "flow.concurrency_key": payload.concurrencyKey,
        "flow.version": HATCHET_AUTOFLOW_VERSION,
      },
    });
    const runId = await run.getWorkflowRunId();
    return {
      backend: this.backend,
      runId,
      issueRef: payload.issueRef,
      projectId: payload.projectId,
      statusUrl: this.statusUrl(runId),
    };
  }

  async getAutoflowRun(runId: string): Promise<AutoflowExecutionSnapshot | undefined> {
    if (!this.client.runs) return undefined;
    const status = await this.client.runs.get_status(runId);
    return {
      backend: this.backend,
      runId,
      issueRef: "",
      projectId: "",
      statusUrl: this.statusUrl(runId),
      phase: hatchetStatusToAutoflowPhase(status),
      summary: `Hatchet run ${runId} is ${status.toLowerCase()}.`,
      updatedAt: nowIso(),
    };
  }

  async cancelAutoflowRun(runId: string): Promise<void> {
    if (this.client.runs) {
      await this.client.runs.cancel({ ids: [runId] });
      return;
    }
    await this.client.runRef(runId).cancel?.();
  }

  private statusUrl(runId: string): string | undefined {
    return this.dashboardUrl ? `${this.dashboardUrl}/runs/${runId}` : undefined;
  }
}

export function hatchetStatusToAutoflowPhase(status: string): AutoflowExecutionSnapshot["phase"] {
  switch (status.toUpperCase()) {
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "succeeded";
    case "CANCELLED":
      return "cancelled";
    case "FAILED":
      return "failed";
    default:
      return "running";
  }
}
