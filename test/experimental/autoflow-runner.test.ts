import assert from "node:assert/strict";
import test from "node:test";

import {
  AutoflowService,
  StandaloneAutoflowRunner,
  type AutoflowAgentSessionDriver,
  type AutoflowAgentSessionSnapshot,
} from "../../src/experimental/index.js";
import {
  HATCHET_AUTOFLOW_TASK_NAME,
  HATCHET_AUTOFLOW_VERSION,
} from "../../src/execution-plane.js";
import {
  nowIso,
} from "../../src/index.js";

class MemoryRunnerState {
  private readonly values = new Map<string, unknown>();

  async getProjectState<T = unknown>(projectId: string, key: string): Promise<T | undefined> {
    return this.values.get(`${projectId}:${key}`) as T | undefined;
  }

  async setProjectState(projectId: string, key: string, value: unknown): Promise<void> {
    this.values.set(`${projectId}:${key}`, value);
  }
}

test("StandaloneAutoflowRunner stores enablement and pauses ticks when disabled", async () => {
  const state = new MemoryRunnerState();
  let queueReads = 0;
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state,
    runtime: {
      inspectQueue: async () => {
        queueReads += 1;
        return [];
      },
    } as never,
    agentSessionDriver: fakeAgentDriver(),
  });

  assert.equal((await runner.status()).enabled, true);
  assert.equal((await runner.setEnabled(false)).enabled, false);
  assert.equal(await state.getProjectState("flow", "autoflow.enabled"), false);
  assert.equal((await runner.tick({ wait: true })).enabled, false);
  assert.equal(queueReads, 0);
});

test("StandaloneAutoflowRunner can run a queued issue without Desktop", async () => {
  const calls: string[] = [];
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state: new MemoryRunnerState(),
    runtime: {
      inspectQueue: async () => [{
        ref: "GH-315",
        title: "Add standalone Autoflow runner",
        repoKeys: ["flow"],
        state: "queued",
        metadata: {},
      }],
      summarizeHandoff: async () => "handoff",
      createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
      selectIssue: async () => undefined,
      diagnoseIssue: async () => ({
        issueRef: "GH-315",
        status: "ok",
        issue: { ref: "GH-315", title: "Add standalone Autoflow runner", state: "selected", repoKeys: ["flow"] },
        visibility: {
          ledger: true,
          issueTracker: true,
          repoRouting: true,
          preparedWorktree: true,
          codeReview: false,
          codeReviewRequired: false,
        },
        findings: [],
        nextAction: { type: "advance", summary: "Run Autoflow." },
      }),
      autoFlowIssue: async () => ({
        status: "execution_handoff",
        message: "Ready for executor.",
        steps: [],
        workerResults: [],
        session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
      }),
      adoptPendingLiveWorker: async () => ({
        id: "task-1",
        issueRef: "GH-315",
        repoKey: "flow",
        workJobId: "job-1",
        prompt: "Implement GH-315.",
        workspacePath: "/tmp/flow-gh-315",
      }),
      recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => {
        calls.push(`record:${result.issueRef}:${result.status}`);
        return result;
      },
      recordEvidence: async () => undefined,
      recordDocumentation: async () => undefined,
      recordPullRequest: async () => undefined,
      advanceIssue: async () => ({
        status: "awaiting_review",
        message: "Ready for review.",
        issue: { ref: "GH-315", title: "Add standalone Autoflow runner", repoKeys: ["flow"], state: "awaiting_review", metadata: {} },
      }),
    } as never,
    agentSessionDriver: fakeAgentDriver(),
  });

  const status = await runner.tick({ wait: true });

  assert.equal(status.enabled, true);
  assert.equal(status.issues["GH-315"]?.phase, "idle");
  assert.equal(status.issues["GH-315"]?.summary, "Ready for review.");
  assert.deepEqual(calls, ["record:GH-315:succeeded"]);
});

test("AutoflowService runs Hatchet payloads through Flow internals and durable Pi handles", async () => {
  const sessions: string[] = [];
  const agentSession = fakeAgentDriverSession();
  const service = new AutoflowService({
    projectId: "flow",
    runtime: {
      summarizeHandoff: async () => {
        throw new Error("missing session");
      },
      createSession: async (id: string) => {
        sessions.push(`create:${id}`);
        return { id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() };
      },
      selectIssue: async (sessionId: string) => {
        sessions.push(`select:${sessionId}`);
      },
      diagnoseIssue: async () => ({
        issueRef: "GH-416",
        status: "ok",
        issue: { ref: "GH-416", title: "Durable Pi session", state: "selected", repoKeys: ["flow"] },
        visibility: {
          ledger: true,
          issueTracker: true,
          repoRouting: true,
          preparedWorktree: true,
          codeReview: false,
          codeReviewRequired: false,
        },
        findings: [],
        nextAction: { type: "advance", summary: "Run Autoflow." },
      }),
      autoFlowIssue: async () => ({
        status: "execution_handoff",
        message: "Ready for executor.",
        steps: [],
        workerResults: [],
        session: { id: "flow-session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
      }),
      adoptPendingLiveWorker: async () => ({
        id: "task-1",
        issueRef: "GH-416",
        repoKey: "flow",
        workJobId: "job-1",
        prompt: "Implement GH-416.",
        workspacePath: "/tmp/flow-gh-416",
      }),
      recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => result,
      recordEvidence: async () => undefined,
      recordDocumentation: async () => undefined,
      recordPullRequest: async () => undefined,
      advanceIssue: async () => ({
        status: "awaiting_review",
        message: "Ready for review.",
        issue: { ref: "GH-416", title: "Durable Pi session", repoKeys: ["flow"], state: "awaiting_review", metadata: {} },
      }),
    } as never,
    autoReconcileOnSlotAvailable: false,
    agentSessionDriver: {
      async getSession(sessionId: string) {
        sessions.push(`pi:${sessionId}`);
        return { ...agentSession, id: sessionId };
      },
      async openOrCreateIssueSession(issueRef: string) {
        sessions.push(`open:${issueRef}`);
        return agentSession;
      },
      async sendUserMessage() {
        return agentSession;
      },
      async postPrompt(sessionId: string) {
        sessions.push(`prompt:${sessionId}`);
        return { ...agentSession, id: sessionId };
      },
    },
  });

  const result = await service.runExecutionPlanePayload({
    version: HATCHET_AUTOFLOW_VERSION,
    taskName: HATCHET_AUTOFLOW_TASK_NAME,
    projectId: "flow",
    issueRef: "GH-416",
    repoKeys: ["flow"],
    requestedBy: "daemon",
    runId: "hatchet-run-416",
    concurrencyKey: "flow:flow:repos:flow",
    semanticSteps: ["select_issue", "doctor", "prepare_workspace", "create_worker_handoff", "run_executor", "record_result", "closeout"],
    durableSession: {
      provider: "pi",
      issueRef: "GH-416",
      flowSessionId: "flow-gh-416",
      sessionId: "pi-gh-416",
    },
  });

  assert.equal(result.runId, "hatchet-run-416");
  assert.equal(result.status, "succeeded");
  assert.ok(sessions.includes("create:flow-gh-416"));
  assert.ok(sessions.includes("select:flow-gh-416"));
  assert.ok(sessions.includes("pi:pi-gh-416"));
  assert.ok(sessions.includes("prompt:pi-gh-416"));
  assert.equal(sessions.includes("open:GH-416"), false);
});

test("StandaloneAutoflowRunner can target one issue without broad queue pickup", async () => {
  let queueReads = 0;
  const inspected: string[] = [];
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state: new MemoryRunnerState(),
    runtime: {
      inspectQueue: async () => {
        queueReads += 1;
        return [];
      },
      inspectIssue: async (ref: string) => {
        inspected.push(ref);
        return {
          ref,
          title: "Targeted issue",
          repoKeys: ["flow"],
          state: "blocked",
          metadata: {},
        };
      },
    } as never,
    agentSessionDriver: fakeAgentDriver(),
  });

  const status = await runner.tick({ issueRefs: ["GH-999"], wait: true });

  assert.equal(status.summary, "Autoflow idle.");
  assert.deepEqual(inspected, ["GH-999"]);
  assert.equal(queueReads, 0);
});

test("StandaloneAutoflowRunner times out stuck agent prompts and frees the slot", async () => {
  let recordedResult: { issueRef: string; status: string; workJobId?: string; blockers?: string[] } | undefined;
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state: new MemoryRunnerState(),
    runtime: {
      inspectQueue: async () => [{
        ref: "GH-278",
        title: "Add timeout to Pi agent postPrompt",
        repoKeys: ["flow"],
        state: "queued",
        metadata: {},
      }],
      summarizeHandoff: async () => "handoff",
      createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
      selectIssue: async () => undefined,
      diagnoseIssue: async () => ({
        issueRef: "GH-278",
        status: "ok",
        issue: { ref: "GH-278", title: "Add timeout to Pi agent postPrompt", state: "selected", repoKeys: ["flow"] },
        visibility: {
          ledger: true,
          issueTracker: true,
          repoRouting: true,
          preparedWorktree: true,
          codeReview: false,
          codeReviewRequired: false,
        },
        findings: [],
        nextAction: { type: "advance", summary: "Run Autoflow." },
      }),
      autoFlowIssue: async () => ({
        status: "execution_handoff",
        message: "Ready for executor.",
        steps: [],
        workerResults: [],
        session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
      }),
      adoptPendingLiveWorker: async () => ({
        id: "task-278",
        issueRef: "GH-278",
        repoKey: "flow",
        workJobId: "job-278",
        prompt: "Implement GH-278.",
        workspacePath: "/tmp/flow-gh-278",
      }),
      recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string; workJobId?: string; blockers?: string[] }) => {
        recordedResult = result;
        return result;
      },
      recordEvidence: async () => undefined,
      recordDocumentation: async () => undefined,
      recordPullRequest: async () => undefined,
      advanceIssue: async () => ({
        status: "awaiting_review",
        message: "Ready for review.",
      }),
    } as never,
    agentSessionDriver: {
      ...fakeAgentDriver(),
      async postPrompt() {
        return new Promise(() => undefined);
      },
      async getSession() {
        return {
          id: "agent-gh-278",
          workspacePath: "/tmp/flow-gh-278",
          status: "running",
          timeline: [],
        };
      },
    },
    postPromptTimeoutMs: 20,
    recoveryPollAttempts: 1,
    recoveryPollIntervalMs: 10,
  });

  const status = await runner.tick({ wait: true });

  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-278"]?.phase, "failed");
  assert.match(status.issues["GH-278"]?.summary ?? "", /did not complete work within recovery window/);
  assert.equal(recordedResult?.issueRef, "GH-278");
  assert.equal(recordedResult?.workJobId, "job-278");
  assert.equal(recordedResult?.status, "failed");
  assert.match(recordedResult?.blockers?.join("\n") ?? "", /did not complete work within recovery window/);
});

test("StandaloneAutoflowRunner recovers from postPrompt timeout when workspace becomes clean", async () => {
  let recordedResult: { issueRef: string; status: string; workJobId?: string; blockers?: string[] } | undefined;
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state: new MemoryRunnerState(),
    runtime: {
      inspectQueue: async () => [{
        ref: "GH-190",
        title: "Recover from postPrompt timeout",
        repoKeys: ["flow"],
        state: "queued",
        metadata: {},
      }],
      summarizeHandoff: async () => "handoff",
      createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
      selectIssue: async () => undefined,
      diagnoseIssue: async () => ({
        issueRef: "GH-190",
        status: "ok",
        issue: { ref: "GH-190", title: "Recover from postPrompt timeout", state: "selected", repoKeys: ["flow"] },
        visibility: {
          ledger: true,
          issueTracker: true,
          repoRouting: true,
          preparedWorktree: true,
          codeReview: false,
          codeReviewRequired: false,
        },
        findings: [],
        nextAction: { type: "advance", summary: "Run Autoflow." },
      }),
      autoFlowIssue: async () => ({
        status: "execution_handoff",
        message: "Ready for executor.",
        steps: [],
        workerResults: [],
        session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
      }),
      adoptPendingLiveWorker: async () => ({
        id: "task-190",
        issueRef: "GH-190",
        repoKey: "flow",
        workJobId: "job-190",
        prompt: "Implement GH-190.",
        workspacePath: "/tmp/flow-gh-190",
      }),
      recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string; workJobId?: string; blockers?: string[] }) => {
        recordedResult = result;
        return result;
      },
      recordEvidence: async () => undefined,
      recordDocumentation: async () => undefined,
      recordPullRequest: async () => undefined,
      advanceIssue: async () => ({
        status: "awaiting_review",
        message: "Ready for review.",
      }),
    } as never,
    agentSessionDriver: {
      ...fakeAgentDriver(),
      async postPrompt() {
        return new Promise(() => undefined);
      },
      async getSession() {
        return {
          id: "agent-gh-190",
          workspacePath: "/tmp/flow-gh-190",
          status: "done",
          summary: "Implemented GH-190.",
          timeline: [{
            id: "assistant-1",
            role: "assistant",
            content: "Implemented GH-190 and committed changes.",
            createdAt: nowIso(),
          }],
        };
      },
    },
    postPromptTimeoutMs: 20,
    recoveryPollAttempts: 2,
    recoveryPollIntervalMs: 10,
  });

  const status = await runner.tick({ wait: true });

  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-190"]?.phase, "idle");
  assert.match(status.issues["GH-190"]?.summary ?? "", /Ready for review/);
  assert.equal(recordedResult?.issueRef, "GH-190");
  assert.equal(recordedResult?.status, "succeeded");
});

test("StandaloneAutoflowRunner fails after recovery timeout when agent never completes", async () => {
  let recordedResult: { issueRef: string; status: string; workJobId?: string; blockers?: string[] } | undefined;
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state: new MemoryRunnerState(),
    runtime: {
      inspectQueue: async () => [{
        ref: "GH-188",
        title: "Fail after recovery timeout",
        repoKeys: ["flow"],
        state: "queued",
        metadata: {},
      }],
      summarizeHandoff: async () => "handoff",
      createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
      selectIssue: async () => undefined,
      diagnoseIssue: async () => ({
        issueRef: "GH-188",
        status: "ok",
        issue: { ref: "GH-188", title: "Fail after recovery timeout", state: "selected", repoKeys: ["flow"] },
        visibility: {
          ledger: true,
          issueTracker: true,
          repoRouting: true,
          preparedWorktree: true,
          codeReview: false,
          codeReviewRequired: false,
        },
        findings: [],
        nextAction: { type: "advance", summary: "Run Autoflow." },
      }),
      autoFlowIssue: async () => ({
        status: "execution_handoff",
        message: "Ready for executor.",
        steps: [],
        workerResults: [],
        session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
      }),
      adoptPendingLiveWorker: async () => ({
        id: "task-188",
        issueRef: "GH-188",
        repoKey: "flow",
        workJobId: "job-188",
        prompt: "Implement GH-188.",
        workspacePath: "/tmp/flow-gh-188",
      }),
      recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string; workJobId?: string; blockers?: string[] }) => {
        recordedResult = result;
        return result;
      },
      recordEvidence: async () => undefined,
      recordDocumentation: async () => undefined,
      recordPullRequest: async () => undefined,
      advanceIssue: async () => ({
        status: "awaiting_review",
        message: "Ready for review.",
      }),
    } as never,
    agentSessionDriver: {
      ...fakeAgentDriver(),
      async postPrompt() {
        return new Promise(() => undefined);
      },
      async getSession() {
        return {
          id: "agent-gh-188",
          workspacePath: "/tmp/flow-gh-188",
          status: "running",
          timeline: [],
        };
      },
    },
    postPromptTimeoutMs: 20,
    recoveryPollAttempts: 2,
    recoveryPollIntervalMs: 10,
  });

  const status = await runner.tick({ wait: true });

  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-188"]?.phase, "failed");
  assert.match(status.issues["GH-188"]?.summary ?? "", /did not complete work within recovery window/);
  assert.equal(recordedResult?.issueRef, "GH-188");
  assert.equal(recordedResult?.status, "failed");
  assert.match(recordedResult?.blockers?.join("\n") ?? "", /did not complete work within recovery window/);
});

test("StandaloneAutoflowRunner persists running status for separate status readers", async () => {
  const state = new MemoryRunnerState();
  let resolvePrompt: ((value: AutoflowAgentSessionSnapshot) => void) | undefined;
  let recordedResult: { issueRef: string; status: string } | undefined;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-379",
      title: "Fix standalone Autoflow timeout and running-status drift",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-379",
      status: "ok",
      issue: { ref: "GH-379", title: "Fix standalone Autoflow timeout and running-status drift", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: false,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-379",
      issueRef: "GH-379",
      repoKey: "flow",
      workJobId: "job-379",
      prompt: "Implement GH-379.",
      workspacePath: "/tmp/flow-gh-379",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => {
      recordedResult = result;
      return result;
    },
    recordEvidence: async () => undefined,
    recordDocumentation: async () => undefined,
    recordPullRequest: async () => undefined,
    advanceIssue: async () => ({
      status: "awaiting_review",
      message: "Ready for review.",
    }),
  };
  const agentSessionDriver = {
    ...fakeAgentDriver(),
    async openOrCreateIssueSession() {
      return { ...fakeAgentDriverSession(), id: "agent-gh-379", status: "active" };
    },
    async postPrompt() {
      return new Promise<AutoflowAgentSessionSnapshot>((resolve) => {
        resolvePrompt = resolve;
      });
    },
  };
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state,
    runtime: runtime as never,
    agentSessionDriver,
  });
  const statusReader = new StandaloneAutoflowRunner({
    projectId: "flow",
    state,
    runtime: runtime as never,
    agentSessionDriver: fakeAgentDriver(),
  });

  const started = await runner.tick();
  let persisted = await statusReader.status();
  for (let index = 0; index < 20 && persisted.issues["GH-379"]?.phase !== "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    persisted = await statusReader.status();
  }

  assert.equal(started.activeCount, 1);
  assert.equal(persisted.activeCount, 1);
  assert.equal(persisted.issues["GH-379"]?.phase, "running");
  assert.match(persisted.summary, /Working 1 issue/);

  resolvePrompt?.({
    ...fakeAgentDriverSession(),
    id: "agent-gh-379",
    workspacePath: "/tmp/flow-gh-379",
    status: "done",
    summary: "Implemented GH-379.",
  });
  const completed = await runner.tick({ wait: true });

  assert.equal(completed.activeCount, 0);
  assert.equal(recordedResult?.issueRef, "GH-379");
  assert.equal(recordedResult?.status, "succeeded");
});

test("StandaloneAutoflowRunner persists idle status after non-wait run completes", async () => {
  const state = new MemoryRunnerState();
  let resolvePrompt: ((value: AutoflowAgentSessionSnapshot) => void) | undefined;
  let recordedResult: { issueRef: string; status: string } | undefined;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-391",
      title: "Fix stale Autoflow activeCount after non-wait CLI run completes",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-391",
      status: "ok",
      issue: { ref: "GH-391", title: "Fix stale Autoflow activeCount after non-wait CLI run completes", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: false,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-391",
      issueRef: "GH-391",
      repoKey: "flow",
      workJobId: "job-391",
      prompt: "Implement GH-391.",
      workspacePath: "/tmp/flow-gh-391",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => {
      recordedResult = result;
      return result;
    },
    recordEvidence: async () => undefined,
    recordDocumentation: async () => undefined,
    recordPullRequest: async () => undefined,
    advanceIssue: async () => ({
      status: "awaiting_review",
      message: "Ready for review.",
    }),
  };
  const agentSessionDriver = {
    ...fakeAgentDriver(),
    async openOrCreateIssueSession() {
      return { ...fakeAgentDriverSession(), id: "agent-gh-391", status: "active" };
    },
    async postPrompt() {
      return new Promise<AutoflowAgentSessionSnapshot>((resolve) => {
        resolvePrompt = resolve;
      });
    },
  };
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state,
    runtime: runtime as never,
    agentSessionDriver,
  });
  const statusReader = new StandaloneAutoflowRunner({
    projectId: "flow",
    state,
    runtime: runtime as never,
    agentSessionDriver: fakeAgentDriver(),
  });

  assert.equal((await runner.tick()).activeCount, 1);
  let persisted = await statusReader.status();
  for (let index = 0; index < 50 && persisted.issues["GH-391"]?.phase !== "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    persisted = await statusReader.status();
  }
  assert.ok(resolvePrompt);
  assert.equal(persisted.issues["GH-391"]?.phase, "running");
  resolvePrompt?.({
    ...fakeAgentDriverSession(),
    id: "agent-gh-391",
    workspacePath: "/tmp/flow-gh-391",
    status: "done",
    summary: "Implemented GH-391.",
  });

  persisted = await statusReader.status();
  for (let index = 0; index < 50 && persisted.issues["GH-391"]?.phase !== "idle"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    persisted = await statusReader.status();
  }

  assert.equal(persisted.activeCount, 0);
  assert.equal(persisted.issues["GH-391"]?.phase, "idle");
  assert.equal(persisted.summary, "Autoflow idle.");
  assert.equal(recordedResult?.issueRef, "GH-391");
  assert.equal(recordedResult?.status, "succeeded");
});

test("StandaloneAutoflowRunner normalizes stale persisted activeCount", async () => {
  const state = new MemoryRunnerState();
  await state.setProjectState("flow", "autoflow.status", {
    enabled: true,
    maxConcurrency: 5,
    activeCount: 1,
    issues: {
      "GH-217": {
        phase: "idle",
        summary: "Ready for review.",
        updatedAt: nowIso(),
      },
    },
    summary: "Working 1 issue.",
    updatedAt: nowIso(),
  });
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state,
    runtime: {
      inspectQueue: async () => [],
    } as never,
    agentSessionDriver: fakeAgentDriver(),
  });

  const status = await runner.status();

  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-217"]?.phase, "idle");
  assert.equal(status.summary, "Autoflow idle.");
});

test("StandaloneAutoflowRunner drops persisted statuses for terminal workflow issues", async () => {
  const state = new MemoryRunnerState();
  await state.setProjectState("flow", "autoflow.status", {
    enabled: true,
    maxConcurrency: 5,
    activeCount: 1,
    issues: {
      "GH-239": {
        phase: "needs_input",
        summary: "Hand off PR review remediation for GH-239 in flow.",
        updatedAt: nowIso(),
      },
      "GH-240": {
        phase: "running",
        summary: "Autoflow working GH-240.",
        updatedAt: nowIso(),
      },
    },
    summary: "Working 1 issue. 1 needs input.",
    updatedAt: nowIso(),
  });
  const runner = new StandaloneAutoflowRunner({
    projectId: "flow",
    state,
    runtime: {
      inspectQueue: async () => [],
      inspectIssue: async (ref: string) => ({
        ref,
        title: ref,
        repoKeys: ["flow"],
        state: "done",
        metadata: {
          issueStatus: "Closed",
          issueStatusCategory: "Complete",
          "workflow.closeout.merged": true,
        },
      }),
    } as never,
    agentSessionDriver: fakeAgentDriver(),
  });

  const status = await runner.status();

  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-239"], undefined);
  assert.equal(status.issues["GH-240"], undefined);
  assert.equal(status.summary, "Autoflow idle.");
});

test("AutoflowService does not immediately re-pick failed issues after slot cleanup", async () => {
  let prompts = 0;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-391",
      title: "Fix stale Autoflow activeCount after non-wait CLI run completes",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-391",
      status: "ok",
      issue: { ref: "GH-391", title: "Fix stale Autoflow activeCount after non-wait CLI run completes", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: false,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-391",
      issueRef: "GH-391",
      repoKey: "flow",
      workJobId: "job-391",
      prompt: "Implement GH-391.",
      workspacePath: "/tmp/flow-gh-391",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => result,
  };
  const service = new AutoflowService({
    projectId: "flow",
    runtime: runtime as never,
    agentSessionDriver: {
      ...fakeAgentDriver(),
      async postPrompt() {
        prompts += 1;
        return {
          ...fakeAgentDriverSession(),
          id: "agent-gh-391",
          status: "failed",
          error: "Executor failed.",
          summary: "Executor failed.",
        };
      },
    },
  });

  assert.equal((await service.reconcile()).activeCount, 1);
  const status = await service.waitForIdle();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-391"]?.phase, "failed");
  assert.equal(prompts, 1);
});

test("AutoflowService can target awaiting-review remediation without broad pickup", async () => {
  let starts = 0;
  const issue = {
    ref: "GH-241",
    title: "Desktop: add retry/backoff on failed refresh",
    repoKeys: ["flow"],
    state: "awaiting_review",
    metadata: {},
  };
  const runtime = {
    inspectQueue: async () => [issue],
    inspectIssue: async () => issue,
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-241",
      status: "ok",
      issue,
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: true,
        codeReviewRequired: true,
      },
      findings: [{
        id: "finding-gh-241-conflict",
        severity: "blocker",
        summary: "Pull request has merge conflicts.",
        issueRef: "GH-241",
        source: "readiness",
        createdAt: nowIso(),
      }],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => {
      starts += 1;
      return {
        status: "execution_handoff",
        message: "Ready for remediation executor.",
        steps: [],
        workerResults: [],
        session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
      };
    },
    adoptPendingLiveWorker: async () => ({
      id: "task-241",
      issueRef: "GH-241",
      repoKey: "flow",
      workJobId: "job-241",
      prompt: "Resolve GH-241 merge conflicts.",
      workspacePath: "/tmp/flow-gh-241",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => result,
    recordEvidence: async () => undefined,
    recordDocumentation: async () => undefined,
    recordPullRequest: async () => undefined,
    advanceIssue: async () => ({
      status: "awaiting_review",
      message: "Ready for review.",
    }),
  };
  const service = new AutoflowService({
    projectId: "flow",
    runtime: runtime as never,
    agentSessionDriver: fakeAgentDriver(),
    autoReconcileOnSlotAvailable: false,
  });

  assert.equal((await service.reconcile()).activeCount, 0);
  assert.equal(starts, 0);

  assert.equal((await service.reconcile({ issueRefs: ["GH-241"] })).activeCount, 1);
  const status = await service.waitForIdle();

  assert.equal(starts, 1);
  assert.equal(status.issues["GH-241"]?.phase, "idle");
});

test("AutoflowService sends one commit follow-up when the workspace stays dirty", async () => {
  const messages: string[] = [];
  let gitInspections = 0;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-280",
      title: "Add follow-up prompt flow for commit verification",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-280",
      status: "ok",
      issue: { ref: "GH-280", title: "Add follow-up prompt flow for commit verification", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: false,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-280",
      issueRef: "GH-280",
      repoKey: "flow",
      workJobId: "job-280",
      prompt: "Implement GH-280.",
      workspacePath: "/tmp/flow-gh-280",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string; blockers: string[] }) => {
      assert.equal(result.issueRef, "GH-280");
      assert.equal(result.status, "succeeded");
      assert.deepEqual(result.blockers, []);
      return result;
    },
    recordEvidence: async () => undefined,
    recordDocumentation: async () => undefined,
    recordPullRequest: async () => undefined,
    advanceIssue: async () => ({
      status: "awaiting_review",
      message: "Ready for review.",
    }),
  };
  const service = new AutoflowService({
    projectId: "flow",
    runtime: runtime as never,
    agentSessionDriver: {
      async getSession() {
        return committedSession();
      },
      async openOrCreateIssueSession() {
        return dirtySession();
      },
      async postPrompt() {
        return dirtySession();
      },
      async sendUserMessage(_sessionId: string, input: { text: string }) {
        messages.push(input.text);
        return committedSession();
      },
    },
    gitInspect: async (path: string) => {
      gitInspections += 1;
      assert.equal(path, "/tmp/flow-gh-280");
      return { dirty: true, entries: ["M src/autoflow-service.ts"] };
    },
    autoReconcileOnSlotAvailable: false,
  });

  const started = await service.reconcile();
  assert.equal(started.activeCount, 1);
  const status = await service.waitForIdle();

  assert.equal(status.issues["GH-280"]?.phase, "idle");
  assert.equal(gitInspections, 1);
  assert.deepEqual(messages, ["You have uncommitted changes. Commit them with a descriptive message and push to the branch."]);
});

test("AutoflowService polls pending pull request checks through closeout", async () => {
  let advances = 0;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-396",
      title: "Autoflow should poll pending PR checks through closeout",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-396",
      status: "ok",
      issue: { ref: "GH-396", title: "Autoflow should poll pending PR checks through closeout", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: false,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-396",
      issueRef: "GH-396",
      repoKey: "flow",
      workJobId: "job-396",
      prompt: "Implement GH-396.",
      workspacePath: "/tmp/flow-gh-396",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => result,
    recordEvidence: async () => undefined,
    recordDocumentation: async () => undefined,
    recordPullRequest: async () => undefined,
    advanceIssue: async () => {
      advances += 1;
      if (advances === 1) {
        return {
          status: "blocked",
          message: "Pull request checks are still running.",
        };
      }
      return {
        status: "awaiting_review",
        message: "GH-396 closeout completed with status merged_jira_verified.",
      };
    },
  };
  const service = new AutoflowService({
    projectId: "flow",
    runtime: runtime as never,
    agentSessionDriver: fakeAgentDriver(),
    autoReconcileOnSlotAvailable: false,
    pendingCheckPollAttempts: 2,
    pendingCheckPollIntervalMs: 1,
  });

  assert.equal((await service.reconcile()).activeCount, 1);
  const status = await service.waitForIdle();

  assert.equal(advances, 2);
  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-396"]?.phase, "idle");
  assert.equal(status.issues["GH-396"]?.summary, "GH-396 closeout completed with status merged_jira_verified.");
});

test("AutoflowService skips pull request creation when head already equals base", async () => {
  let evidenceRecorded = 0;
  let documentationRecorded = 0;
  let pullRequestsCreated = 0;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-428",
      title: "Skip main-to-main pull requests",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-428",
      status: "ok",
      issue: { ref: "GH-428", title: "Skip main-to-main pull requests", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: true,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-428",
      issueRef: "GH-428",
      repoKey: "flow",
      workJobId: "job-428",
      prompt: "Implement GH-428.",
      workspacePath: "/tmp/flow-gh-428",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { issueRef: string; status: string }) => result,
    recordEvidence: async () => { evidenceRecorded += 1; },
    recordDocumentation: async () => { documentationRecorded += 1; },
    recordPullRequest: async () => {
      throw new Error("recordPullRequest should not be called when branch equals base.");
    },
    inspectIssue: async () => ({
      ref: "GH-428",
      title: "Skip main-to-main pull requests",
      repoKeys: ["flow"],
      state: "running",
      metadata: {
        "workflow.repos.flow.branch": "main",
        "workflow.repos.flow.base_branch": "main",
      },
    }),
    advanceIssue: async () => ({
      status: "awaiting_review",
      message: "Ready for review.",
    }),
  };
  const service = new AutoflowService({
    projectId: "flow",
    runtime: runtime as never,
    agentSessionDriver: fakeAgentDriver(),
    codeReviewCreator: {
      async createPullRequest() {
        pullRequestsCreated += 1;
        throw new Error("createPullRequest should not be called when branch equals base.");
      },
    },
    autoReconcileOnSlotAvailable: false,
  });

  assert.equal((await service.reconcile()).activeCount, 1);
  const status = await service.waitForIdle();

  assert.equal(status.issues["GH-428"]?.phase, "idle");
  assert.equal(evidenceRecorded, 1);
  assert.equal(documentationRecorded, 1);
  assert.equal(pullRequestsCreated, 0);
});

test("AutoflowService uses provider-neutral fallback summary when agent has no assistant text", async () => {
  let capturedSummary: string | undefined;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-426",
      title: "Claude SDK executor smoke",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-426",
      status: "ok",
      issue: { ref: "GH-426", title: "Claude SDK executor smoke", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: false,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-426",
      issueRef: "GH-426",
      repoKey: "flow",
      workJobId: "job-426",
      prompt: "Implement GH-426.",
      workspacePath: "/tmp/flow-gh-426",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { summary: string }) => {
      capturedSummary = result.summary;
      return result;
    },
    recordEvidence: async () => undefined,
    recordDocumentation: async () => undefined,
    recordPullRequest: async () => undefined,
    advanceIssue: async () => ({
      status: "awaiting_review",
      message: "Ready for review.",
    }),
  };
  // Session with no assistant messages and no error — forces the fallback path
  const emptyTimelineSession: AutoflowAgentSessionSnapshot = {
    id: "agent-gh-426",
    workspacePath: "/tmp/flow-gh-426",
    status: "done",
    summary: undefined,
    timeline: [],
  };
  const service = new AutoflowService({
    projectId: "flow",
    runtime: runtime as never,
    agentSessionDriver: {
      async getSession() { return emptyTimelineSession; },
      async openOrCreateIssueSession() { return emptyTimelineSession; },
      async sendUserMessage() { return emptyTimelineSession; },
      async postPrompt() { return emptyTimelineSession; },
    },
    autoReconcileOnSlotAvailable: false,
  });

  assert.equal((await service.reconcile()).activeCount, 1);
  await service.waitForIdle();

  assert.ok(capturedSummary, "expected recordLocalThreadResult to be called");
  assert.ok(!capturedSummary!.toLowerCase().includes("pi"), `fallback summary must not mention Pi: "${capturedSummary}"`);
  assert.match(capturedSummary!, /agent session completed GH-426/i);
});

test("AutoflowService records clean agent summary before assistant timeline text", async () => {
  let capturedSummary: string | undefined;
  const runtime = {
    inspectQueue: async () => [{
      ref: "GH-427",
      title: "Persist clean Claude summary",
      repoKeys: ["flow"],
      state: "queued",
      metadata: {},
    }],
    summarizeHandoff: async () => "handoff",
    createSession: async (id: string) => ({ id, findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() }),
    selectIssue: async () => undefined,
    diagnoseIssue: async () => ({
      issueRef: "GH-427",
      status: "ok",
      issue: { ref: "GH-427", title: "Persist clean Claude summary", state: "selected", repoKeys: ["flow"] },
      visibility: {
        ledger: true,
        issueTracker: true,
        repoRouting: true,
        preparedWorktree: true,
        codeReview: false,
        codeReviewRequired: false,
      },
      findings: [],
      nextAction: { type: "advance", summary: "Run Autoflow." },
    }),
    autoFlowIssue: async () => ({
      status: "execution_handoff",
      message: "Ready for executor.",
      steps: [],
      workerResults: [],
      session: { id: "session", findings: [], workerResults: [], createdAt: nowIso(), updatedAt: nowIso() },
    }),
    adoptPendingLiveWorker: async () => ({
      id: "task-427",
      issueRef: "GH-427",
      repoKey: "flow",
      workJobId: "job-427",
      prompt: "Implement GH-427.",
      workspacePath: "/tmp/flow-gh-427",
    }),
    recordLocalThreadResult: async (_sessionId: string, result: { summary: string }) => {
      capturedSummary = result.summary;
      return result;
    },
    recordEvidence: async () => undefined,
    recordDocumentation: async () => undefined,
    recordPullRequest: async () => undefined,
    advanceIssue: async () => ({
      status: "awaiting_review",
      message: "Ready for review.",
    }),
  };
  const cleanSummarySession: AutoflowAgentSessionSnapshot = {
    id: "agent-gh-427",
    workspacePath: "/tmp/flow-gh-427",
    status: "done",
    summary: "Clean Claude SDK result summary.",
    timeline: [{
      id: "assistant-noisy",
      role: "assistant",
      content: "[tool:Bash] noisy progress output",
      createdAt: nowIso(),
    }],
  };
  const service = new AutoflowService({
    projectId: "flow",
    runtime: runtime as never,
    agentSessionDriver: {
      async getSession() { return cleanSummarySession; },
      async openOrCreateIssueSession() { return cleanSummarySession; },
      async sendUserMessage() { return cleanSummarySession; },
      async postPrompt() { return cleanSummarySession; },
    },
    autoReconcileOnSlotAvailable: false,
  });

  assert.equal((await service.reconcile()).activeCount, 1);
  await service.waitForIdle();

  assert.equal(capturedSummary, "Clean Claude SDK result summary.");
});

function fakeAgentDriver(): AutoflowAgentSessionDriver {
  const session = fakeAgentDriverSession();
  return {
    async getSession() {
      return session;
    },
    async openOrCreateIssueSession() {
      return session;
    },
    async sendUserMessage() {
      return session;
    },
    async postPrompt() {
      return session;
    },
  };
}

function fakeAgentDriverSession(): AutoflowAgentSessionSnapshot {
  return {
    id: "agent-gh-315",
    workspacePath: "/tmp/flow-gh-315",
    status: "done",
    summary: "Implemented GH-315.",
    timeline: [{
      id: "assistant-1",
      role: "assistant",
      content: "Implemented GH-315 and committed changes.",
      createdAt: nowIso(),
    }],
  };
}

function dirtySession(): AutoflowAgentSessionSnapshot {
  return {
    id: "agent-gh-280",
    workspacePath: "/tmp/flow-gh-280",
    status: "done",
    timeline: [{
      id: "tool-edit",
      role: "tool",
      toolName: "apply_patch",
      content: "edited",
      diff: { path: "src/autoflow-service.ts" },
      createdAt: nowIso(),
    }],
  };
}

function committedSession(): AutoflowAgentSessionSnapshot {
  return {
    id: "agent-gh-280",
    workspacePath: "/tmp/flow-gh-280",
    status: "done",
    summary: "Committed and pushed GH-280.",
    timeline: [
      {
        id: "tool-edit",
        role: "tool",
        toolName: "apply_patch",
        content: "edited",
        diff: { path: "src/autoflow-service.ts" },
        createdAt: nowIso(),
      },
      {
        id: "assistant-commit",
        role: "assistant",
        content: "Committed and pushed GH-280.",
        createdAt: nowIso(),
      },
    ],
  };
}
