import assert from "node:assert/strict";
import test from "node:test";

import {
  AutoflowService,
  StandaloneAutoflowRunner,
  nowIso,
  type AutoflowAgentSessionDriver,
  type AutoflowAgentSessionSnapshot,
} from "../src/index.js";

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
      recordLocalThreadResult: async () => undefined,
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
    },
    postPromptTimeoutMs: 20,
  });

  const status = await runner.tick({ wait: true });

  assert.equal(status.activeCount, 0);
  assert.equal(status.issues["GH-278"]?.phase, "failed");
  assert.match(status.issues["GH-278"]?.summary ?? "", /timed out/);
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

function fakeAgentDriver(): AutoflowAgentSessionDriver {
  const session: AutoflowAgentSessionSnapshot = {
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
