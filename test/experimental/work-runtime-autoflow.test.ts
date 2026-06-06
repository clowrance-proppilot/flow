import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { FlowStore, MemoryWorkflowLedger, nowIso } from "../../src/index.js";
import { testWorkRuntime } from "../helpers/test-fixtures.js";

test("Work Runtime autoflow stops at execution handoff confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-16",
    title: "Autoflow",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const result = await workRuntime.autoFlowIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.workerResults.length, 0);
  assert.equal(result.steps.map((step) => step.status).join(","), "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "request_execution");
  assert.equal(result.handoffRequest, undefined);
  const issue = await ledger.readIssue("ISSUE-16");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
  assert.equal(typeof issue?.metadata["workflow.autoflow.last_attempted_at"], "string");
});

test("Work Runtime autoflow auto-approves execution handoff when requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-autoflow-execution-approve-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow-execution-approve");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-APPROVE",
    title: "Autoflow approve execution",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const result = await workRuntime.autoFlowIssue(session.id, { autoApproveExecution: true });

  assert.equal(result.status, "execution_handoff");
  assert.ok(result.handoffRequest);
  assert.equal(result.handoffRequest?.issueRef, "ISSUE-APPROVE");
});

test("Work Runtime autoflow retries after empty successful Worker output", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-empty-success-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow-empty-success");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-EMPTY",
    title: "Empty successful worker result",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });
  await ledger.recordWorkerResult({
    taskId: "worker-empty",
    issueRef: "ISSUE-EMPTY",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Agent returned without useful output.",
    changedFiles: [],
    testsRun: [],
    blockers: [],
    completedAt: nowIso(),
  });

  const result = await workRuntime.autoFlowIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "request_execution");
  assert.equal(
    result.steps[0]?.session.findings.some((finding) => finding.summary === "Acceptance evidence is missing."),
    false,
  );
  assert.equal(
    result.steps[0]?.session.findings.some((finding) => finding.summary === "Successful worker result has no changed files or tests."),
    true,
  );
});

test("Work Runtime resets Autoflow attempt state through Flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow-reset");
  await ledger.writeIssue({
    ref: "ISSUE-17",
    title: "Autoflow reset",
    repoKeys: ["main"],
    state: "blocked",
    metadata: {
      "workflow.autoflow.attempts": 3,
      "workflow.autoflow.last_attempted_at": "2026-05-15T20:00:00.000Z",
      "workflow.autoflow.current_action": "mark_pr_ready_for_review",
      "workflow.autoflow.current_action_started_at": "2026-05-15T20:00:00.000Z",
    },
  });

  const [reset] = await workRuntime.resetAutoflowState(session.id, ["ISSUE-17"]);

  assert.equal(reset.ref, "ISSUE-17");
  assert.equal(reset.metadata["workflow.autoflow.attempts"], 0);
  assert.equal(reset.metadata["workflow.autoflow.last_attempted_at"], "");
  assert.equal(reset.metadata["workflow.autoflow.current_action"], "");
  assert.equal(reset.metadata["workflow.autoflow.current_action_started_at"], "");
});

test("Work Runtime autoflow prepares a missing workspace before execution handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    sourceControl: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan: any) {
        assert.equal(plan.repoPath, "/repo/app-api");
        assert.equal(plan.baseRef, "develop");
        return {
          branch: plan.branch,
          headSha: "abc123",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-autoflow-prepare");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-17",
    title: "Autoflow prepare",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const result = await workRuntime.autoFlowIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.workerResults.length, 0);
  assert.equal(result.steps.map((step) => step.session.pendingConfirmation?.action).join(","), "prepare_workspace,request_execution");
  assert.equal(result.issue?.metadata["workflow.repos.app_api.worktree_path"], "/repo/app-api/.worktrees/feature-issue-17-autoflow-prepare");
});

test("Work Runtime live adoption prepares existing PR branch when workspace is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const preparedPlans: any[] = [];
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    sourceControl: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan: any) {
        preparedPlans.push(plan);
        assert.equal(plan.repoPath, "/repo/app-api");
        assert.equal(plan.branch, "feature/gh-245-existing-pr");
        assert.equal(plan.baseRef, "develop");
        return {
          branch: plan.branch,
          headSha: "abc123",
          dirty: false,
          entries: [],
          worktreePath: plan.worktreePath,
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-autoflow-existing-pr-workspace");
  await workRuntime.selectIssue(session.id, {
    ref: "GH-245",
    title: "Existing PR conflict",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 380,
      prUrl: "https://github.com/camden-lowrance/app-api/pull/380",
      prHeadRefName: "feature/gh-245-existing-pr",
      prState: "OPEN",
      prMergeable: "CONFLICTING",
      prMergeStateStatus: "DIRTY",
      "workflow.repos.app_api.pr_repo": "app-api",
      "workflow.repos.app_api.pr_number": 380,
      "workflow.repos.app_api.pr_url": "https://github.com/camden-lowrance/app-api/pull/380",
      "workflow.repos.app_api.pr_head_ref_name": "feature/gh-245-existing-pr",
      "workflow.repos.app_api.pr_state": "OPEN",
      "workflow.repos.app_api.pr_mergeable": "CONFLICTING",
      "workflow.repos.app_api.pr_merge_state_status": "DIRTY",
    },
  });

  const autoflow = await workRuntime.autoFlowIssue(session.id);
  assert.equal(autoflow.status, "needs_confirmation");
  assert.equal(autoflow.session.pendingConfirmation?.action, "request_execution");

  const handoff = await workRuntime.adoptPendingLiveWorker(session.id, {
    adopter: "Flow Autoflow",
  });

  assert.equal(preparedPlans.length, 1);
  assert.equal(handoff.workspacePath, "/repo/app-api/.worktrees/feature-gh-245-existing-pr");
  const issue = await ledger.readIssue("GH-245");
  assert.equal(issue?.metadata["workflow.repos.app_api.branch"], "feature/gh-245-existing-pr");
  assert.equal(issue?.metadata["workflow.repos.app_api.worktree_path"], "/repo/app-api/.worktrees/feature-gh-245-existing-pr");
});

test("Work Runtime autoflow marks draft pull requests ready before reassessing blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let markedReady: { repo: string; number: number } | undefined;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: {
      async findPullRequests() {
        return [];
      },
      async getPullRequest(repo, number) {
        return {
          repo,
          number,
          title: "Draft PR",
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          headRefName: "feature/ISSUE-20-draft",
          state: "OPEN",
          isDraft: markedReady ? false : true,
          checksPassing: true,
          autoReviewStatus: "passed",
        };
      },
      async markPullRequestReadyForReview(repo, number) {
        markedReady = { repo, number };
        return (this as any).getPullRequest?.(repo, number);
      },
    },
  });
  const session = await workRuntime.createSession("session-autoflow-pr-ready");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Draft PR",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      prRepo: "app-api",
      prNumber: 20,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/20",
      prIsDraft: true,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      "workflow.repos.app_api.pr_repo": "app-api",
      "workflow.repos.app_api.pr_number": 20,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/20",
      "workflow.repos.app_api.pr_is_draft": true,
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-20-draft",
    },
  });

  const result = await workRuntime.autoFlowIssue(session.id);

  assert.deepEqual(markedReady, { repo: "app-api", number: 20 });
  assert.equal(result.steps.map((step) => step.status).join(","), "blocked,needs_confirmation");
  const issue = await ledger.readIssue("ISSUE-20");
  assert.equal(issue?.metadata["workflow.autoflow.current_action"], "mark_pr_ready_for_review");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
});
