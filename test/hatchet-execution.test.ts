import assert from "node:assert/strict";
import test from "node:test";

import {
  HATCHET_AUTOFLOW_TASK_NAME,
  HATCHET_AUTOFLOW_WORKER_NAME,
  createHatchetAutoflowTask,
  hatchetStatusToAutoflowPhase,
  HatchetAutoflowExecutionProvider,
  startHatchetAutoflowWorker,
  type HatchetAutoflowPayload,
  type HatchetClientLike,
  type HatchetRunRef,
  type HatchetTaskDeclaration,
  type HatchetTaskOptions,
} from "../src/index.js";

class FakeRunRef implements HatchetRunRef {
  cancelled = false;

  constructor(private readonly id: string) {}

  async getWorkflowRunId(): Promise<string> {
    return this.id;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

class FakeHatchetClient implements HatchetClientLike {
  taskOptions?: HatchetTaskOptions;
  workerOptions?: { name: string; workflows: HatchetTaskDeclaration[]; slots?: number };
  runInput?: HatchetAutoflowPayload;
  runOptions?: unknown;
  cancelledIds: string[] = [];

  readonly runs = {
    get_status: async (_runId: string) => "RUNNING",
    cancel: async (options: { ids: string[] }) => {
      this.cancelledIds.push(...options.ids);
      return {};
    },
  };

  task(options: HatchetTaskOptions): HatchetTaskDeclaration {
    this.taskOptions = options;
    return {
      runNoWait: async (input, options) => {
        this.runInput = input;
        this.runOptions = options;
        return new FakeRunRef(`run-${input.issueRef}`);
      },
    };
  }

  async worker(name: string, options: { workflows: HatchetTaskDeclaration[]; slots?: number }) {
    this.workerOptions = { name, ...options };
    return {
      start: async () => undefined,
    };
  }

  runRef(runId: string): HatchetRunRef {
    return new FakeRunRef(runId);
  }
}

test("createHatchetAutoflowTask declares durable task policy outside Flow semantics", async () => {
  const client = new FakeHatchetClient();
  const task = createHatchetAutoflowTask(client, {
    runAutoflowIssue: async (input) => ({
      issueRef: input.issueRef,
      runId: input.runId,
      status: "succeeded",
      summary: "done",
      changedFiles: [],
      testsRun: [],
      completedAt: "2026-06-01T00:00:00.000Z",
    }),
  });

  assert.ok(task);
  assert.equal(client.taskOptions?.name, HATCHET_AUTOFLOW_TASK_NAME);
  assert.equal(client.taskOptions?.retries, 2);
  assert.equal(client.taskOptions?.concurrency.expression, "input.concurrencyKey");
  assert.equal(client.taskOptions?.concurrency.maxRuns, 1);
  assert.equal(String(client.taskOptions?.fn).includes("selectIssue"), false);
  assert.equal(String(client.taskOptions?.fn).includes("advanceIssue"), false);

  const result = await client.taskOptions?.fn({
    version: "flow-autoflow-v1",
    taskName: HATCHET_AUTOFLOW_TASK_NAME,
    projectId: "flow",
    issueRef: "GH-412",
    repoKeys: ["flow"],
    requestedBy: "daemon",
    runId: "flow:GH-412",
    concurrencyKey: "flow:flow:repos:flow",
    semanticSteps: ["select_issue"],
  });
  assert.equal(result?.issueRef, "GH-412");
});

test("Hatchet provider enqueues Autoflow payloads and returns a run handle", async () => {
  const client = new FakeHatchetClient();
  const task = createHatchetAutoflowTask(client, {
    runAutoflowIssue: async () => {
      throw new Error("not called while enqueueing");
    },
  });
  const provider = new HatchetAutoflowExecutionProvider({
    client,
    task,
    dashboardUrl: "http://hatchet.local/",
  });

  const handle = await provider.enqueueAutoflowRun({
    projectId: "flow",
    issueRef: "gh-412",
    repoKeys: ["flow"],
    requestedBy: "cli",
  });

  assert.equal(handle.backend, "hatchet");
  assert.equal(handle.runId, "run-GH-412");
  assert.equal(handle.statusUrl, "http://hatchet.local/runs/run-GH-412");
  assert.equal(client.runInput?.issueRef, "GH-412");
  assert.deepEqual(client.runInput?.semanticSteps, [
    "select_issue",
    "doctor",
    "prepare_workspace",
    "create_worker_handoff",
    "run_executor",
    "record_result",
    "closeout",
  ]);
  assert.deepEqual(client.runOptions, {
    additionalMetadata: {
      "flow.project_id": "flow",
      "flow.issue_ref": "GH-412",
      "flow.concurrency_key": "flow:flow:repos:flow",
      "flow.version": "flow-autoflow-v1",
    },
  });
});

test("Hatchet worker registration uses the Flow Autoflow worker name and slots", async () => {
  const client = new FakeHatchetClient();

  await startHatchetAutoflowWorker({
    client,
    slots: 3,
    runner: {
      runAutoflowIssue: async (input) => ({
        issueRef: input.issueRef,
        runId: input.runId,
        status: "succeeded",
        summary: "done",
        changedFiles: [],
        testsRun: [],
        completedAt: "2026-06-01T00:00:00.000Z",
      }),
    },
  });

  assert.equal(client.workerOptions?.name, HATCHET_AUTOFLOW_WORKER_NAME);
  assert.equal(client.workerOptions?.slots, 3);
  assert.equal(client.workerOptions?.workflows.length, 1);
});

test("Hatchet run statuses map to Flow execution phases", () => {
  assert.equal(hatchetStatusToAutoflowPhase("QUEUED"), "queued");
  assert.equal(hatchetStatusToAutoflowPhase("RUNNING"), "running");
  assert.equal(hatchetStatusToAutoflowPhase("COMPLETED"), "succeeded");
  assert.equal(hatchetStatusToAutoflowPhase("CANCELLED"), "cancelled");
  assert.equal(hatchetStatusToAutoflowPhase("FAILED"), "failed");
});
