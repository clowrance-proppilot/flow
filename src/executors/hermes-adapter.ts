import type { WorkerTaskRequest, WorkerTaskResult } from "../contracts.js";
import { nowIso, workerTaskResultSchema } from "../contracts.js";
import type { WorkerProgressSink } from "./worker-contracts.js";

export interface HermesAgentExecutorOptions {
  name?: string;
  capabilities?: string[];
}

/**
 * Hermes executor adapter for Flow integration.
 *
 * Hermes picks up Flow issues, executes work via terminal/file tools,
 * and records evidence back through the Flow JSON CLI protocol.
 */
export class HermesAgentExecutor {
  readonly name: string;
  readonly executionMode = "local_thread" as const;
  private readonly capabilities: ReadonlySet<string>;

  constructor(options: HermesAgentExecutorOptions = {}) {
    this.name = options.name ?? "hermes_agent";
    this.capabilities = new Set(options.capabilities ?? [
      "repo.worktree.prepare",
      "code.edit",
      "test.run",
      "review.remediate",
      "evidence.record",
      "terminal.execute",
      "file.read",
      "file.write",
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
      summary: "Hermes agent executor prepared a handoff request.",
      updatedAt: nowIso(),
    });
    return workerTaskResultSchema.parse({
      taskId: request.id,
      issueRef: request.issueRef,
      repoKey: request.repoKey,
      workJobId: request.workJobId,
      executor: "hermes_agent",
      status: "blocked",
      summary: "Hermes agent execution is waiting for the agent to report a result.",
      changedFiles: [],
      testsRun: [],
      blockers: ["Hermes agent must perform the requested work and report the result."],
      nextPickup: request.prompt,
      completedAt: nowIso(),
    });
  }
}
