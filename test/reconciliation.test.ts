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

test("Work Runtime reconciliation adopts matching pull request into Beads state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect() {
        return {
          branch: "feature/issue-17-test",
          headSha: "def456",
          dirty: false,
          entries: [],
        };
      },
    },
    collaboration: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        assert.equal(headRefName, "feature/issue-17-test");
        return [
          {
            repo,
            number: 17,
            title: "ISSUE-17",
            url: "https://github.com/ExampleOrg/app-api/pull/17",
            headRefName,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: true,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-reconcile");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-17",
    title: "PR reconcile",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/17");
  assert.equal(issue.metadata.prNumber, 17);
  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(issue.metadata.prMergeable, "MERGEABLE");
  assert.equal(issue.metadata.prMergeStateStatus, "CLEAN");
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata["workflow.repos.app_api.head_sha"], "def456");
});

test("Work Runtime reconciliation discovers routing from an unrouted matching pull request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: {
      async findPullRequests(repo) {
        if (repo !== "public-api") return [];
        return [
          {
            repo,
            number: 3026,
            title: "feat(ISSUE-15397): use shared flower task priorities",
            url: "https://github.com/ExampleOrg/public-api/pull/3026",
            headRefName: "feature/issue-15397-standardize-task-priority-constants",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: true,
            autoReviewStatus: "passed",
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-discovers-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15397",
    title: "Standardize task priority into shared constants module",
    repoKeys: [],
    state: "ready_to_run",
    metadata: {},
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.deepEqual(issue.repoKeys, ["public_api"]);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/public-api/pull/3026");
  assert.equal(issue.metadata.prNumber, 3026);
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata["workflow.repos.public_api.pr_url"], "https://github.com/ExampleOrg/public-api/pull/3026");
});

test("Work Runtime reconciliation adopts open issue PR when branch has changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect() {
        return {
          branch: "feature/issue-15607-old",
          headSha: "oldsha",
          dirty: false,
          entries: [],
        };
      },
    },
    collaboration: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        if (headRefName) {
          assert.equal(headRefName, "feature/issue-15607-old");
          return [];
        }
        return [
          {
            repo,
            number: 1404,
            title: "ISSUE-15607 fix Panorama app key environment endpoint",
            url: "https://github.com/ExampleOrg/app-api/pull/1404",
            headRefName: "bug/ISSUE-15607-panorama-app-key-env",
            state: "OPEN",
            isDraft: true,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: false,
            autoReviewStatus: "failed",
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-issue-key-fallback");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15607",
    title: "PR branch changed",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      jiraStatus: "In Review",
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1385",
      "workflow.repos.app_api.pr_number": 1385,
      "workflow.repos.app_api.pr_repo": "app-api",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1404");
  assert.equal(issue.metadata.prNumber, 1404);
  assert.equal(issue.metadata.prIsDraft, true);
  assert.equal(issue.state, "blocked");
  assert.equal(issue.metadata["workflow.repos.app_api.pr_url"], "https://github.com/ExampleOrg/app-api/pull/1404");
  assert.equal(issue.metadata["workflow.repos.app_api.branch"], "feature/issue-15607-old");
});

test("Work Runtime reconciliation selects blocking pull request across routed repos", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect() {
        return {
          branch: "feature/issue-15607-test",
          headSha: "abc15607",
          dirty: false,
          entries: [],
        };
      },
    },
    collaboration: {
      async findPullRequests(repo, headRefName) {
        assert.equal(headRefName, "feature/issue-15607-test");
        if (repo === "public-api") {
          return [
            {
              repo,
              number: 2971,
              title: "ISSUE-15607",
              url: "https://github.com/ExampleOrg/public-api/pull/2971",
              headRefName,
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "BLOCKED",
              checksPassing: true,
              autoReviewStatus: "passed",
              autoReviewMustFix: true,
              autoReviewMustFixDetail: "New test files use // @ts-nocheck.",
            },
          ];
        }
        return [
          {
            repo,
            number: repo === "app-api" ? 1385 : 3178,
            title: "ISSUE-15607",
            url: `https://github.com/ExampleOrg/${repo}/pull/${repo === "app-api" ? 1385 : 3178}`,
            headRefName,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            checksPassing: true,
            autoReviewStatus: "passed",
            autoReviewMustFix: false,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-aggregate");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15607",
    title: "Cross-repo PR aggregate",
    repoKeys: ["app_api", "public_api", "web_app"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      "workflow.repos.public_api.worktree_path": "/tmp/public-api-worktree",
      "workflow.repos.web_app.worktree_path": "/tmp/web-app-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prRepo, "public-api");
  assert.equal(issue.metadata.prNumber, 2971);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/public-api/pull/2971");
  assert.equal(issue.metadata.prAutoReviewMustFix, true);
  assert.equal(issue.metadata.prAutoReviewMustFixDetail, "New test files use // @ts-nocheck.");
  assert.equal(issue.metadata["workflow.repos.web_app.pr_url"], "https://github.com/ExampleOrg/web-app/pull/3178");
});

test("Work Runtime reconciliation refreshes existing PR metadata when draft state changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect() {
        return {
          branch: "feature/issue-18-test",
          headSha: "def789",
          dirty: false,
          entries: [],
        };
      },
    },
    collaboration: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        assert.equal(headRefName, "feature/issue-18-test");
        return [
          {
            repo,
            number: 18,
            title: "ISSUE-18",
            url: "https://github.com/ExampleOrg/app-api/pull/18",
            headRefName,
            isDraft: false,
            mergeable: "CONFLICTING",
            mergeStateStatus: "DIRTY",
            checksPassing: true,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-refresh");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-18",
    title: "PR refresh",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/18",
      prIsDraft: true,
      prChecksPassing: false,
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(issue.metadata.prMergeable, "CONFLICTING");
  assert.equal(issue.metadata.prMergeStateStatus, "DIRTY");
  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata.prNumber, 18);
});

test("Work Runtime reconciliation completes active undraft worker when GitHub shows PR ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect() {
        return {
          branch: "feature/issue-1407-test",
          headSha: "abc1407",
          dirty: false,
          entries: [],
        };
      },
    },
    collaboration: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        assert.equal(headRefName, "feature/issue-1407-test");
        return [
          {
            repo,
            number: 1407,
            title: "ISSUE-15615",
            url: "https://github.com/ExampleOrg/app-api/pull/1407",
            headRefName,
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            checksPassing: true,
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-undraft-refresh");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15615",
    title: "Tank mix override",
    repoKeys: ["app_api"],
    state: "running",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1407",
      prIsDraft: true,
      "workflow.repos.app_api.branch": "feature/issue-1407-test",
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });
  await ledger.recordWorkerRun({
    taskId: "worker-issue-15615-undraft-pr1407",
    issueRef: "ISSUE-15615",
    repoKey: "app_api",
    status: "running",
    summary: "Undraft PR #1407.",
    blockers: [],
    updatedAt: nowIso(),
  });

  const issue = await workRuntime.reconcileIssue(session.id);
  const runs = await ledger.listWorkerRuns("ISSUE-15615");

  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(runs.at(-1)?.status, "succeeded");
  assert.match(runs.at(-1)?.summary ?? "", /no longer draft/);
});

test("Work Runtime reconciliation refreshes stale recorded PR merge fields from GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: {
      async findPullRequests() {
        throw new Error("Recorded PR refresh should use getPullRequest");
      },
      async getPullRequest(repo, number) {
        assert.equal(repo, "app-api");
        assert.equal(number, 1402);
        return {
          repo,
          number,
          title: "ISSUE-15676",
          url: "https://github.com/ExampleOrg/app-api/pull/1402",
          headRefName: "feature/issue-15676-provider-unable-to-process-files-com",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          reviewDecision: "REVIEW_REQUIRED",
          checksPassing: true,
          autoReviewStatus: "pending",
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-stale-recorded");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15676",
    title: "Stale recorded PR",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1402,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      prMergeable: "",
      prMergeStateStatus: "",
      prReviewDecision: "",
      "workflow.repos.app_api.pr_repo": "app-api",
      "workflow.repos.app_api.pr_number": 1402,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1402",
    },
  });

  const issue = await workRuntime.refreshReviewState(session.id, "ISSUE-15676");

  assert.equal(issue.metadata.prMergeable, "MERGEABLE");
  assert.equal(issue.metadata.prMergeStateStatus, "BLOCKED");
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata.prAutoReviewStatus, "pending");
});

test("Work Runtime reconciliation lets repo PR snapshot override stale global snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-pr-stale-global");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Stale aggregate PR",
    repoKeys: ["public_api"],
    state: "ready_to_run",
    metadata: {
      prRepo: "public-api",
      prNumber: 20,
      prUrl: "https://github.com/ExampleOrg/public-api/pull/20",
      prChecksPassing: false,
      prMergeStateStatus: "BLOCKED",
      "workflow.repos.public_api.pr_repo": "public-api",
      "workflow.repos.public_api.pr_number": 20,
      "workflow.repos.public_api.pr_url": "https://github.com/ExampleOrg/public-api/pull/20",
      "workflow.repos.public_api.pr_checks_passing": true,
      "workflow.repos.public_api.pr_mergeable": "MERGEABLE",
      "workflow.repos.public_api.pr_merge_state_status": "CLEAN",
      "workflow.repos.public_api.pr_review_decision": "APPROVED",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata.prMergeStateStatus, "CLEAN");
  assert.equal(issue.metadata.prReviewDecision, "APPROVED");
});

test("Work Runtime reconciliation keeps branch-matched PR authoritative over stale global PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect() {
        return {
          branch: "feature/ISSUE-15272-test-coverage-ci",
          headSha: "21e22d6e9759a9830564d9fc24e674c50da1b3c9",
          dirty: false,
          entries: [],
        };
      },
    },
    collaboration: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "app-api");
        if (headRefName === "feature/ISSUE-15272-test-coverage-ci") {
          return [{
            repo,
            number: 1344,
            title: "feat(ISSUE-15272): add local coverage delta tooling",
            url: "https://github.com/ExampleOrg/app-api/pull/1344",
            headRefName,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BEHIND",
            reviewDecision: "REVIEW_REQUIRED",
            checksPassing: true,
            autoReviewStatus: "passed",
            autoReviewMustFix: false,
            autoReviewNeedsConfirmation: true,
          }];
        }
        return [];
      },
      async getPullRequest(repo, number) {
        assert.equal(repo, "app-api");
        if (number === 1406) {
          return {
            repo,
            number,
            title: "Unrelated stale PR",
            url: "https://github.com/ExampleOrg/app-api/pull/1406",
            headRefName: "bug/ISSUE-15725-panorama-app-key-idempotent",
            state: "MERGED",
            mergedAt: "2026-05-13T10:00:00Z",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            checksPassing: true,
            autoReviewStatus: "passed",
          };
        }
        throw new Error(`Unexpected PR lookup ${number}`);
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-stale-global-current-branch");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15272",
    title: "Coverage PR",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1406,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1406",
      prState: "MERGED",
      prMergedAt: "2026-05-13T10:00:00Z",
      "workflow.repos.app_api.branch": "feature/ISSUE-15272-test-coverage-ci",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-15272-test-coverage-ci",
      "workflow.repos.app_api.pr_repo": "app-api",
      "workflow.repos.app_api.pr_number": 1344,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1344",
      "workflow.repos.app_api.pr_auto_review_needs_confirmation_disposition": "accept",
      "workflow.repos.app_api.pr_auto_review_needs_confirmation_posted_url": "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-4461307698",
    },
  });

  const issue = await workRuntime.refreshReviewState(session.id, "ISSUE-15272");

  assert.equal(issue.metadata.prNumber, 1344);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1344");
  assert.equal(issue.metadata.prState, "OPEN");
  assert.equal(issue.metadata.prMergedAt, undefined);
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationDisposition, "accept");
  assert.equal(
    issue.metadata.prAutoReviewNeedsConfirmationPostedUrl,
    "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-4461307698",
  );
});
