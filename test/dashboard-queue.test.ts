import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  FlowStore,
  MemoryWorkflowLedger,
  ReconciliationEngine,
  nowIso,
} from "../src/index.js";
import { testWorkRuntime, legacyHostTopology } from "./helpers/test-fixtures.js";

test("Dashboard queue mirrors provider-neutral issue status without provider URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-queue-"));
  const ledger = new MemoryWorkflowLedger();
  const issueUrl = "https://github.com/example/flow/issues/9";
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-9",
    title: "Mirror generic provider metadata",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      issueStatus: "Open",
      issueStatusCategory: "To Do",
      issueType: "task",
      issueUrl,
      issueLabels: ["app_api"],
      "workflow.external.issue.status": "published",
      "workflow.external.code_review.status": "unpublished",
      branchKind: "feature",
    },
  });

  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(queue[0].ref, "GH-9");
  assert.equal(queue[0].statusLabel, "Open");
  assert.equal(Object.hasOwn(queue[0] as unknown as Record<string, unknown>, "issueUrl"), false);
});

test("Dashboard queue reads ledger state without provider refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-ledger-only-"));
  const ledger = new MemoryWorkflowLedger();
  let issueTrackerCalls = 0;
  let collaborationCalls = 0;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: {
      capabilities: {
        canCreateIssues: false,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        issueTrackerCalls += 1;
        throw new Error(`provider refresh should not run for ${ref}`);
      },
      async fetchActiveQueue() {
        issueTrackerCalls += 1;
        throw new Error("provider queue should not run");
      },
    },
    collaboration: {
      capabilities: {
        canMarkReady: false,
        canPostComments: false,
        canMerge: false,
      },
      async findCodeReviews() {
        collaborationCalls += 1;
        throw new Error("code review refresh should not run");
      },
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-100",
    title: "Ledger dashboard item",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(queue.find((issue) => issue.ref === "ISSUE-100")?.title, "Ledger dashboard item");
  assert.equal(issueTrackerCalls, 0);
  assert.equal(collaborationCalls, 0);
});

test("Dashboard queue reconciles and hides closed issue tracker records", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-closed-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-166-CLOSED",
    title: "Closed stale issue",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      issueStatus: "Closed",
      issueStatusCategory: "Complete",
      issueResolution: "Done",
    },
  });
  await ledger.writeIssue({
    ref: "GH-166-OPEN",
    title: "Open issue",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      issueStatus: "Open",
      issueStatusCategory: "To Do",
    },
  });

  const queue = await workRuntime.inspectDashboardQueue(10);
  const closed = await ledger.readIssue("GH-166-CLOSED");

  assert.equal(queue.some((issue) => issue.ref === "GH-166-CLOSED"), false);
  assert.equal(queue.some((issue) => issue.ref === "GH-166-OPEN"), true);
  assert.equal(closed?.state, "done");
});

test("Dashboard queue reconciles closed issue tracker status without resolution metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-closed-status-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-163-CLOSED",
    title: "Closed GitHub issue",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      issueStatus: "Closed",
      issueStatusCategory: "Complete",
    },
  });

  const queue = await workRuntime.inspectDashboardQueue(10);
  const closed = await ledger.readIssue("GH-163-CLOSED");

  assert.equal(queue.some((issue) => issue.ref === "GH-163-CLOSED"), false);
  assert.equal(closed?.state, "done");
});

test("Dashboard queue reconciles merged pull requests into done state", async () => {
  const ledger = new MemoryWorkflowLedger();
  const reconciliation = new ReconciliationEngine({
    topology: legacyHostTopology,
    ledger,
    sourceControl: {
      async inspect() {
        return {
          branch: "main",
          headSha: "abc123",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const issue = await ledger.writeIssue({
    ref: "GH-163-MERGED",
    title: "Merged GitHub pull request",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      prUrl: "https://github.com/example/flow/pull/163",
      prMergedAt: "2026-05-31T08:00:00Z",
    },
  });

  await reconciliation.reconcile(issue);
  const merged = await ledger.readIssue("GH-163-MERGED");

  assert.equal(merged?.state, "done");
});

test("Dashboard queue omits source-control and provider internals", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-public-contract-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-80",
    title: "Prepared local workspace",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.branch": "feature/issue-80-work",
      "workflow.repos.app_api.head_sha": "abc123",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-80-work",
    },
  });

  const queue = await workRuntime.inspectDashboardQueue(10);
  const issue = queue.find((candidate) => candidate.ref === "ISSUE-80") as Record<string, unknown> | undefined;

  assert.ok(issue);
  assert.equal(Object.hasOwn(issue, "branch"), false);
  assert.equal(Object.hasOwn(issue, "repoKeys"), false);
  assert.deepEqual(issue.repositories, ["app_api"]);
  assert.equal(Object.hasOwn(issue, "headSha"), false);
  assert.equal(Object.hasOwn(issue, "worktreePath"), false);
  assert.equal(Object.hasOwn(issue, "issueUrl"), false);
  assert.equal(Object.hasOwn(issue, "prUrl"), false);
});

test("Dashboard queue derives work status from Flow artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-real-status-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-90",
    title: "Merged dashboard polish",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/20",
      prState: "MERGED",
      prMergedAt: nowIso(),
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-91",
    title: "Blocked worker",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });
  await ledger.writeIssue({
    ref: "ISSUE-92",
    title: "Open review",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/21",
      prState: "OPEN",
      prIsDraft: false,
      prChecksPassing: true,
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-93",
    title: "Successful handoff",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });
  await ledger.recordWorkerResult({
    taskId: "worker-91",
    issueRef: "ISSUE-91",
    repoKey: "app_api",
    status: "blocked",
    summary: "Needs local input",
    changedFiles: [],
    testsRun: [],
    blockers: ["Need local context"],
    completedAt: nowIso(),
  });
  await ledger.recordWorkerResult({
    taskId: "worker-93",
    issueRef: "ISSUE-93",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Implementation complete",
    changedFiles: ["src/dashboard/main.tsx"],
    testsRun: ["npm test"],
    blockers: [],
    completedAt: nowIso(),
  });

  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(queue.find((issue) => issue.ref === "ISSUE-90")?.workStatus, "Done");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-90")?.workStatusDetail ?? "", /#20 is merged/);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-91")?.workStatus, "Blocked");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-91")?.workStatusDetail ?? "", /worker-91 is blocked/);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-92")?.workStatus, "In Review");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-92")?.workStatusDetail ?? "", /#21 is open/);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-93")?.workStatus, "Ready");
  assert.match(queue.find((issue) => issue.ref === "ISSUE-93")?.workStatusDetail ?? "", /worker-93 succeeded/);
});

test("Dashboard queue mirrors the current session selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-dashboard-session-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  const workRuntime = testWorkRuntime({ store, ledger });
  await ledger.writeIssue({
    ref: "ISSUE-1",
    title: "Stale selected issue",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {},
  });
  await ledger.writeIssue({
    ref: "ISSUE-2",
    title: "Current session issue",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {},
  });
  const session = await workRuntime.createSession("session-dashboard-selection");
  await store.writeSession({
    ...session,
    selectedIssueRef: "ISSUE-2",
    selectedRepoKey: "app_api",
  });

  const queueWithoutSession = await workRuntime.inspectDashboardQueue(10);
  const queue = await workRuntime.inspectDashboardQueue(10, session.id);

  assert.equal(queueWithoutSession.find((issue) => issue.ref === "ISSUE-1")?.workStatus, "Queued");
  assert.equal(queueWithoutSession.find((issue) => issue.ref === "ISSUE-2")?.workStatus, "Ready");
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-1")?.workStatus, "Queued");
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-2")?.workStatus, "Active");
});
