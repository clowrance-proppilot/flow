import type { WorkerTaskRequest, WorkerTaskResult } from "../contracts.js";
import { nowIso, workerTaskResultSchema } from "../contracts.js";
import type { WorkerProgressSink } from "./worker-contracts.js";

export type ExecutorExecutionMode = "local_thread" | "background";

export interface ExecutorAdapter {
  readonly name: string;
  readonly executionMode: ExecutorExecutionMode;
  canRun(workType: string, requiredCapabilities: string[]): boolean;
  run(request: WorkerTaskRequest, onProgress?: WorkerProgressSink): Promise<WorkerTaskResult>;
}

export interface LocalThreadExecutorOptions {
  name?: string;
  capabilities?: string[];
}

export class LocalThreadExecutor implements ExecutorAdapter {
  readonly name: string;
  readonly executionMode = "local_thread" as const;
  private readonly capabilities: ReadonlySet<string>;

  constructor(options: LocalThreadExecutorOptions = {}) {
    this.name = options.name ?? "local_agent_thread";
    this.capabilities = new Set(options.capabilities ?? [
      "repo.worktree.prepare",
      "code.edit",
      "test.run",
      "review.remediate",
      "evidence.record",
      "issue.intake",
    ]);
  }

  canRun(_workType: string, requiredCapabilities: string[]): boolean {
    return requiredCapabilities.every((capability) => this.capabilities.has(capability));
  }

  async run(request: WorkerTaskRequest, onProgress?: WorkerProgressSink): Promise<WorkerTaskResult> {
    await onProgress?.({
      taskId: request.id,
      issueRef: request.issueRef,
      repoKey: request.repoKey,
      summary: "Local thread executor prepared a handoff request.",
      updatedAt: nowIso(),
    });
    return workerTaskResultSchema.parse({
      taskId: request.id,
      issueRef: request.issueRef,
      repoKey: request.repoKey,
      workJobId: request.workJobId,
      executor: "live_agent_thread",
      status: "blocked",
      summary: "Local thread execution is waiting for the current agent thread to report a result.",
      changedFiles: [],
      testsRun: [],
      blockers: ["Current agent thread must perform the requested work and report the result."],
      nextPickup: request.prompt,
      completedAt: nowIso(),
    });
  }
}
