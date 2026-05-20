import {
  WorkerExecutorValue,
  WorkJobExecutorValue,
  type WorkerExecutor,
  type WorkJobExecutor,
  type WorkTypeCategory,
} from "./contracts.js";

export interface WorkTypeDefinition {
  workType: string;
  category: WorkTypeCategory;
  requiredCapabilities: string[];
  allowedExecutors: string[];
  outputType: string;
}

export interface ExecutorCapabilityDefinition {
  executor: WorkJobExecutor;
  capabilities: string[];
  canSubmit: string[];
  outputs: string[];
}

export class WorkTypeRegistry {
  private readonly types: ReadonlyMap<string, WorkTypeDefinition>;
  private readonly executors: ReadonlyMap<string, ExecutorCapabilityDefinition>;

  constructor(
    definitions: WorkTypeDefinition[],
    executors: ExecutorCapabilityDefinition[] = [],
  ) {
    this.types = new Map(definitions.map((d) => [d.workType, d]));
    this.executors = new Map(executors.map((e) => [e.executor, e]));
  }

  get(workType: string): WorkTypeDefinition | undefined {
    return this.types.get(workType);
  }

  has(workType: string): boolean {
    return this.types.has(workType);
  }

  findByCategory(category: WorkTypeCategory): WorkTypeDefinition | undefined {
    for (const definition of this.types.values()) {
      if (definition.category === category) return definition;
    }
    return undefined;
  }

  workTypeForCategory(category: WorkTypeCategory): string | undefined {
    return this.findByCategory(category)?.workType;
  }

  isCategory(workType: string, category: WorkTypeCategory): boolean {
    return this.types.get(workType)?.category === category;
  }

  isCodeProducing(workType: string): boolean {
    const category = this.types.get(workType)?.category;
    return category === "implement" || category === "remediate";
  }

  executorCanRun(
    executor: string,
    workType: string,
    requiredCapabilities?: string[],
  ): boolean {
    const work = this.types.get(workType);
    const cap = this.executors.get(executor);
    if (!work || !cap) return false;
    const capabilities = new Set(cap.capabilities);
    const required = requiredCapabilities ?? work.requiredCapabilities;
    return work.allowedExecutors.includes(executor) && required.every((c) => capabilities.has(c));
  }

  getExecutor(executor: string): ExecutorCapabilityDefinition | undefined {
    return this.executors.get(executor);
  }
}

export function createDefaultFlowWorkTypeRegistry(): WorkTypeRegistry {
  return new WorkTypeRegistry(
    [
      {
        workType: "flow.prepare_workspace",
        category: "prepare",
        requiredCapabilities: ["repo.worktree.prepare"],
        allowedExecutors: [WorkJobExecutorValue.LiveAgentThread],
        outputType: "workspace_result",
      },
      {
        workType: "flow.implement",
        category: "implement",
        requiredCapabilities: ["code.edit", "test.run"],
        allowedExecutors: [WorkJobExecutorValue.PiWorker, WorkJobExecutorValue.LiveAgentThread, WorkJobExecutorValue.CodexWorker],
        outputType: "worker_result",
      },
      {
        workType: "flow.remediate",
        category: "remediate",
        requiredCapabilities: ["code.edit", "review.remediate", "test.run"],
        allowedExecutors: [WorkJobExecutorValue.PiWorker, WorkJobExecutorValue.LiveAgentThread, WorkJobExecutorValue.CodexWorker],
        outputType: "worker_result",
      },
      {
        workType: "flow.verify",
        category: "verify",
        requiredCapabilities: ["test.run", "evidence.record"],
        allowedExecutors: [WorkJobExecutorValue.PiWorker, WorkJobExecutorValue.LiveAgentThread],
        outputType: "evidence_result",
      },
    ],
    [
      {
        executor: WorkJobExecutorValue.PiWorker,
        capabilities: ["code.edit", "test.run", "review.remediate"],
        canSubmit: [],
        outputs: ["worker_result", "blocked_result"],
      },
      {
        executor: WorkJobExecutorValue.CodexWorker,
        capabilities: ["code.edit", "test.run", "review.remediate"],
        canSubmit: [],
        outputs: ["worker_result", "blocked_result"],
      },
      {
        executor: WorkJobExecutorValue.LiveAgentThread,
        capabilities: ["repo.worktree.prepare", "code.edit", "test.run", "review.remediate", "evidence.record"],
        canSubmit: [
          "flow.prepare_workspace",
          "flow.implement",
          "flow.remediate",
          "flow.verify",
        ],
        outputs: ["workspace_result", "worker_result", "blocked_result", "evidence_result"],
      },
    ],
  );
}

export function workerExecutorToWorkExecutor(executor: WorkerExecutor | undefined): WorkJobExecutor {
  if (executor === WorkerExecutorValue.Codex) return WorkJobExecutorValue.CodexWorker;
  return executor === WorkerExecutorValue.LiveAgentThread ? WorkJobExecutorValue.LiveAgentThread : WorkJobExecutorValue.PiWorker;
}
