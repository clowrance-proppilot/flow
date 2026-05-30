import assert from "node:assert/strict";
import test from "node:test";

import {
  ReconciliationEngine,
  collectPullRequestSnapshots,
  selectPullRequestForGate,
  repoFromPullRequestUrl,
  inferredRepoKeys,
  findPullRequestForIssue,
  pullRequestMetadata,
  globalPullRequestMetadata,
  pullRequestStatusSnapshot,
  isPullRequestConflicted,
} from "../src/reconciliation.js";
import type {
  ReconciliationDeps,
  PullRequestsByRepo,
  PullRequestMetadataSnapshot,
} from "../src/reconciliation.js";
import type { PullRequestStatus } from "../src/adapters/github.js";
import type { ProjectTopology } from "../src/project-topology.js";
import type { SourceControlForReconciliation, CollaborationForReconciliation } from "../src/reconciliation.js";
import { MemoryWorkflowLedger } from "../src/ledger.js";
import type { WorkItem, WorkerRunRecord } from "../src/contracts.js";
import { nowIso } from "../src/contracts.js";

// --- Test fixtures ---

function makeTopology(repoKeys: Record<string, string> = {}): ProjectTopology {
  const keys = new Set(Object.keys(repoKeys));
  return {
    validRepoKeys: keys,
    isValidRepoKey: (key: string) => keys.has(key),
    inferRepoKeysFromIssue: () => [],
    branchName: (issue: WorkItem) => `feature/${issue.ref.toLowerCase()}-test`,
    defaultBaseBranch: () => "main",
    repoName: (key: string) => repoKeys[key] ?? key,
    repoPath: (root: string, key: string) => `${root}/${repoKeys[key] ?? key}`,
    pullRequestUrl: (repo: string, number: number) => `https://github.com/ExampleOrg/${repo}/pull/${number}`,
  };
}

function makePullRequest(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    repo: "test-repo",
    number: 42,
    title: "Test PR",
    url: "https://github.com/ExampleOrg/test-repo/pull/42",
    headRefName: "feature/issue-42-test",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    checksPassing: true,
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ref: "ISSUE-1",
    title: "Test issue",
    repoKeys: ["test_repo"],
    state: "ready_to_run",
    metadata: {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ReconciliationDeps> = {}): ReconciliationDeps {
  return {
    topology: makeTopology({ test_repo: "test-repo" }),
    sourceControl: { inspect: async () => ({ branch: "main", headSha: "abc123", dirty: false, entries: [] }) },
    ledger: new MemoryWorkflowLedger(),
    ...overrides,
  };
}

// --- repoFromPullRequestUrl ---

test("repoFromPullRequestUrl extracts repo name from GitHub PR URL", () => {
  assert.equal(repoFromPullRequestUrl("https://github.com/ExampleOrg/my-repo/pull/17"), "my-repo");
});

test("repoFromPullRequestUrl returns undefined for non-GitHub URLs", () => {
  assert.equal(repoFromPullRequestUrl("https://gitlab.com/org/repo/pull/1"), undefined);
});

test("repoFromPullRequestUrl returns undefined for malformed URL", () => {
  assert.equal(repoFromPullRequestUrl("not-a-url"), undefined);
});

// --- inferredRepoKeys ---

test("inferredRepoKeys extracts repo keys from metadata prefixes", () => {
  const metadata = {
    "workflow.repos.app_api.worktree_path": "/tmp/app-api",
    "workflow.repos.public_api.branch": "develop",
  };
  const keys = inferredRepoKeys(metadata);
  assert.ok(keys.includes("app_api"));
  assert.ok(keys.includes("public_api"));
});

test("inferredRepoKeys extracts repo key from workflow.repo metadata", () => {
  const metadata = { "workflow.repo": "my_repo" };
  const keys = inferredRepoKeys(metadata);
  assert.ok(keys.includes("my_repo"));
});

test("inferredRepoKeys extracts repo key from prUrl via repoKeyFromRepoName callback", () => {
  const metadata = { prUrl: "https://github.com/ExampleOrg/special-repo/pull/99" };
  const keys = inferredRepoKeys(metadata, (name) => (name === "special-repo" ? "special_repo" : undefined));
  assert.ok(keys.includes("special_repo"));
});

test("inferredRepoKeys returns empty array for empty metadata", () => {
  assert.deepEqual(inferredRepoKeys({}), []);
});

// --- findPullRequestForIssue ---

test("findPullRequestForIssue prefers branch match over title match", () => {
  const prs: PullRequestStatus[] = [
    makePullRequest({ number: 1, headRefName: "other/branch", title: "ISSUE-1 title" }),
    makePullRequest({ number: 2, headRefName: "feature/issue-1-fix", title: "Unrelated" }),
  ];
  const found = findPullRequestForIssue(prs, "ISSUE-1", "feature/issue-1-fix");
  assert.equal(found?.number, 2);
});

test("findPullRequestForIssue falls back to title match", () => {
  const prs: PullRequestStatus[] = [
    makePullRequest({ number: 5, headRefName: "random-branch", title: "feat(ISSUE-10): something" }),
    makePullRequest({ number: 6, headRefName: "other-branch", title: "Unrelated" }),
  ];
  const found = findPullRequestForIssue(prs, "ISSUE-10", "no-match");
  assert.equal(found?.number, 5);
});

test("findPullRequestForIssue returns undefined when no match", () => {
  const prs: PullRequestStatus[] = [
    makePullRequest({ number: 1, headRefName: "other", title: "Unrelated" }),
  ];
  assert.equal(findPullRequestForIssue(prs, "ISSUE-99", "no-match"), undefined);
});

test("findPullRequestForIssue matches case-insensitively", () => {
  const prs: PullRequestStatus[] = [
    makePullRequest({ number: 3, headRefName: "feature/issue-3-test", title: "lowercase" }),
  ];
  const found = findPullRequestForIssue(prs, "issue-3", "other");
  assert.equal(found?.number, 3);
});

// --- isPullRequestConflicted ---

test("isPullRequestConflicted detects CONFLICTING mergeable", () => {
  assert.equal(isPullRequestConflicted({ mergeable: "CONFLICTING" }), true);
});

test("isPullRequestConflicted detects DIRTY mergeStateStatus", () => {
  assert.equal(isPullRequestConflicted({ mergeStateStatus: "DIRTY" }), true);
});

test("isPullRequestConflicted returns false for clean PR", () => {
  assert.equal(isPullRequestConflicted({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }), false);
});

test("isPullRequestConflicted handles undefined fields", () => {
  assert.equal(isPullRequestConflicted({}), false);
});

// --- collectPullRequestSnapshots ---

test("collectPullRequestSnapshots collects repo-prefixed PR metadata", () => {
  const metadata = {
    "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/10",
    "workflow.repos.app_api.pr_number": 10,
    "workflow.repos.app_api.pr_repo": "app-api",
    "workflow.repos.app_api.pr_head_ref_name": "feature/issue-10-test",
    "workflow.repos.app_api.pr_is_draft": false,
    "workflow.repos.app_api.pr_checks_passing": true,
  };
  const snapshots = collectPullRequestSnapshots(metadata, ["app_api"], (k) => k);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].source, "repo");
  assert.equal(snapshots[0].repoKey, "app_api");
  assert.equal(snapshots[0].url, "https://github.com/ExampleOrg/app-api/pull/10");
  assert.equal(snapshots[0].number, 10);
});

test("collectPullRequestSnapshots includes global prUrl when not duplicated by repo snapshot", () => {
  const metadata = {
    prUrl: "https://github.com/ExampleOrg/other-repo/pull/55",
    prNumber: 55,
    prRepo: "other-repo",
    prIsDraft: true,
  };
  const snapshots = collectPullRequestSnapshots(metadata, [], () => "other-repo");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].source, "global");
  assert.equal(snapshots[0].url, "https://github.com/ExampleOrg/other-repo/pull/55");
  assert.equal(snapshots[0].number, 55);
  assert.equal(snapshots[0].isDraft, true);
});

test("collectPullRequestSnapshots deduplicates global when repo snapshot has same URL", () => {
  const metadata = {
    prUrl: "https://github.com/ExampleOrg/app-api/pull/10",
    "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/10",
    "workflow.repos.app_api.pr_number": 10,
    "workflow.repos.app_api.pr_repo": "app-api",
  };
  const snapshots = collectPullRequestSnapshots(metadata, ["app_api"], () => "app-api");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].source, "repo");
});

// --- selectPullRequestForGate ---

test("selectPullRequestForGate picks repo snapshot over global", () => {
  const snapshots: PullRequestMetadataSnapshot[] = [
    { source: "global", url: "https://github.com/org/repo/pull/1" },
    { source: "repo", repoKey: "test_repo", url: "https://github.com/org/repo/pull/2", expectedBranch: "main", headRefName: "main" },
  ];
  const selected = selectPullRequestForGate(snapshots);
  assert.equal(selected?.source, "repo");
});

test("selectPullRequestForGate prefers branch-matched snapshot", () => {
  const snapshots: PullRequestMetadataSnapshot[] = [
    { source: "repo", repoKey: "a", url: "https://github.com/org/a/pull/1", expectedBranch: "main", headRefName: "other" },
    { source: "repo", repoKey: "b", url: "https://github.com/org/b/pull/2", expectedBranch: "develop", headRefName: "develop" },
  ];
  const selected = selectPullRequestForGate(snapshots);
  assert.equal(selected?.repoKey, "b");
});

test("selectPullRequestForGate scores blockers higher", () => {
  const snapshots: PullRequestMetadataSnapshot[] = [
    { source: "repo", repoKey: "a", url: "https://github.com/org/a/pull/1", expectedBranch: "main", headRefName: "main" },
    { source: "repo", repoKey: "b", url: "https://github.com/org/b/pull/2", expectedBranch: "main", headRefName: "main", isDraft: true },
  ];
  const selected = selectPullRequestForGate(snapshots);
  assert.equal(selected?.repoKey, "b");
});

test("selectPullRequestForGate returns undefined for empty input", () => {
  assert.equal(selectPullRequestForGate([]), undefined);
});

// --- pullRequestMetadata ---

test("pullRequestMetadata produces both global and repo-prefixed keys", () => {
  const pr = makePullRequest({ number: 99, repo: "my-repo", headRefName: "feature/fix" });
  const metadata = pullRequestMetadata("my_repo", pr);
  assert.equal(metadata.prUrl, pr.url);
  assert.equal(metadata.prNumber, 99);
  assert.equal(metadata["workflow.repos.my_repo.pr_url"], pr.url);
  assert.equal(metadata["workflow.repos.my_repo.pr_number"], 99);
  assert.equal(metadata["workflow.repos.my_repo.pr_head_ref_name"], "feature/fix");
});

test("pullRequestMetadata sets humanReviewRequired when reviewDecision is REVIEW_REQUIRED", () => {
  const pr = makePullRequest({ reviewDecision: "REVIEW_REQUIRED" });
  const metadata = pullRequestMetadata("test_repo", pr);
  assert.equal(metadata.humanReviewRequired, true);
});

test("pullRequestMetadata sets humanReviewRequired to false for APPROVED", () => {
  const pr = makePullRequest({ reviewDecision: "APPROVED" });
  const metadata = pullRequestMetadata("test_repo", pr);
  assert.equal(metadata.humanReviewRequired, false);
});

// --- globalPullRequestMetadata ---

test("globalPullRequestMetadata sets prRecordedAt to nowIso when not provided", () => {
  const snapshot: PullRequestMetadataSnapshot = {
    source: "global",
    url: "https://github.com/org/repo/pull/1",
  };
  const metadata = globalPullRequestMetadata(snapshot);
  assert.ok(typeof metadata.prRecordedAt === "string");
  assert.ok(metadata.prRecordedAt.length > 0);
});

test("globalPullRequestMetadata preserves provided recordedAt", () => {
  const recorded = "2025-01-01T00:00:00.000Z";
  const snapshot: PullRequestMetadataSnapshot = {
    source: "global",
    url: "https://github.com/org/repo/pull/1",
    recordedAt: recorded,
  };
  const metadata = globalPullRequestMetadata(snapshot);
  assert.equal(metadata.prRecordedAt, recorded);
});

// --- pullRequestStatusSnapshot ---

test("pullRequestStatusSnapshot creates snapshot from PullRequestStatus", () => {
  const pr = makePullRequest({ number: 7, repo: "the-repo", headRefName: "feature/issue-7" });
  const snapshot = pullRequestStatusSnapshot(pr, "repo", "the_repo");
  assert.equal(snapshot.source, "repo");
  assert.equal(snapshot.repoKey, "the_repo");
  assert.equal(snapshot.repo, "the-repo");
  assert.equal(snapshot.number, 7);
  assert.equal(snapshot.headRefName, "feature/issue-7");
});

// --- ReconciliationEngine.reconcile ---

test("ReconciliationEngine.reconcile populates PR metadata when PR found", async () => {
  const deps = makeDeps({
    collaboration: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "test-repo");
        return [makePullRequest({ repo, headRefName: headRefName ?? "feature/issue-1-test" })];
      },
    },
    sourceControl: {
      async inspect() {
        return { branch: "feature/issue-1-test", headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    metadata: { "workflow.repos.test_repo.worktree_path": "/tmp/test-repo" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });

  assert.equal(result.metadata.prUrl, "https://github.com/ExampleOrg/test-repo/pull/42");
  assert.equal(result.metadata.prNumber, 42);
  assert.equal(result.metadata.prIsDraft, false);
  assert.equal(result.metadata.prMergeable, "MERGEABLE");
  assert.equal(result.metadata["workflow.repos.test_repo.pr_url"], "https://github.com/ExampleOrg/test-repo/pull/42");
  assert.equal(result.metadata["workflow.repos.test_repo.head_sha"], "abc123");
});

test("ReconciliationEngine.reconcile discovers repo keys from PRs when issue is unrouted", async () => {
  const topology = makeTopology({ public_api: "public-api", app_api: "app-api" });
  const deps = makeDeps({
    topology,
    collaboration: {
      async findPullRequests(repo) {
        if (repo !== "public-api") return [];
        return [makePullRequest({ repo, number: 300, title: "ISSUE-100 fix", url: "https://github.com/ExampleOrg/public-api/pull/300", headRefName: "feature/issue-100" })];
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({ ref: "ISSUE-100", repoKeys: [], metadata: {} });

  const result = await engine.reconcile(issue, undefined, { persist: false });

  assert.ok(result.repoKeys.includes("public_api"));
  assert.equal(result.metadata.prUrl, "https://github.com/ExampleOrg/public-api/pull/300");
  assert.equal(result.metadata.prNumber, 300);
});

test("ReconciliationEngine.reconcile uses preloaded pullRequestsByRepo when available", async () => {
  let findPullRequestsCalled = false;
  const deps = makeDeps({
    collaboration: {
      async findPullRequests() {
        findPullRequestsCalled = true;
        return [];
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({ repoKeys: ["test_repo"], metadata: {} });
  const preloaded: PullRequestsByRepo = new Map([
    ["test-repo", [makePullRequest({ repo: "test-repo", title: "ISSUE-1 fix" })]],
  ]);

  const result = await engine.reconcile(issue, preloaded, { persist: false });

  assert.equal(findPullRequestsCalled, false);
  assert.equal(result.metadata.prUrl, "https://github.com/ExampleOrg/test-repo/pull/42");
  assert.equal(result.metadata.prNumber, 42);
});

test("ReconciliationEngine.reconcile handles missing collaboration gracefully", async () => {
  const deps = makeDeps({ collaboration: undefined });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({ repoKeys: ["test_repo"], metadata: {} });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.ref, "ISSUE-1");
});

test("ReconciliationEngine.reconcile persists to ledger when persist=true", async () => {
  const ledger = new MemoryWorkflowLedger();
  const deps = makeDeps({
    ledger,
    collaboration: {
      async findPullRequests(repo, headRefName) {
        return [makePullRequest({ repo, headRefName: headRefName ?? "feature/issue-1-test", title: "ISSUE-1 fix" })];
      },
    },
    sourceControl: {
      async inspect() {
        return { branch: "feature/issue-1-test", headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    metadata: { "workflow.repos.test_repo.worktree_path": "/tmp/test-repo" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: true });
  const persisted = await ledger.readIssue("ISSUE-1");
  assert.ok(persisted);
  assert.equal(persisted.metadata.prUrl, "https://github.com/ExampleOrg/test-repo/pull/42");
  assert.deepEqual(persisted.metadata, result.metadata);
});

test("ReconciliationEngine.reconcile updates repoKeys from inferred when issue has no explicit keys", async () => {
  const topology = makeTopology({ my_repo: "my-repo" });
  const deps = makeDeps({
    topology,
    collaboration: {
      async findPullRequests(repo) {
        if (repo !== "my-repo") return [];
        return [makePullRequest({ repo, number: 50, title: "ISSUE-5 feat", headRefName: "feature/issue-5" })];
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({ ref: "ISSUE-5", repoKeys: [], metadata: {} });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.deepEqual(result.repoKeys, ["my_repo"]);
});

// --- ReconciliationEngine.reconcileSafely ---

test("ReconciliationEngine.reconcileSafely returns original issue on error", async () => {
  const deps = makeDeps({
    collaboration: {
      async findPullRequests() {
        throw new Error("Network failure");
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({ repoKeys: ["test_repo"], metadata: {} });

  const result = await engine.reconcileSafely(issue, undefined, { persist: false });
  assert.deepEqual(result, issue);
});

test("ReconciliationEngine.reconcileSafely delegates to reconcile on success", async () => {
  const deps = makeDeps({
    collaboration: {
      async findPullRequests(repo, headRefName) {
        return [makePullRequest({ repo, headRefName: headRefName ?? "feature/issue-1-test", title: "ISSUE-1 fix" })];
      },
    },
    sourceControl: {
      async inspect() {
        return { branch: "feature/issue-1-test", headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    metadata: { "workflow.repos.test_repo.worktree_path": "/tmp/test-repo" },
  });

  const result = await engine.reconcileSafely(issue, undefined, { persist: false });
  assert.equal(result.metadata.prUrl, "https://github.com/ExampleOrg/test-repo/pull/42");
});

// --- ReconciliationEngine.reconcileStaleWorkerRuns ---

test("ReconciliationEngine.reconcileStaleWorkerRuns expires stale running workers", async () => {
  const ledger = new MemoryWorkflowLedger();
  const twentyOneMinutesAgo = new Date(Date.now() - 21 * 60 * 1000).toISOString();
  await ledger.recordWorkerRun({
    issueRef: "ISSUE-1",
    taskId: "task-1",
    repoKey: "test_repo",
    status: "running",
    summary: "Working...",
    blockers: [],
    updatedAt: twentyOneMinutesAgo,
  });
  const deps = makeDeps({ ledger });
  const engine = new ReconciliationEngine(deps);

  await engine.reconcileStaleWorkerRuns("ISSUE-1");

  const runs = await ledger.listWorkerRuns("ISSUE-1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.match(runs[0].summary ?? "", /expired/i);
  assert.ok(runs[0].blockers?.some((b) => b.includes("stale")));
});

test("ReconciliationEngine.reconcileStaleWorkerRuns skips recently updated workers", async () => {
  const ledger = new MemoryWorkflowLedger();
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await ledger.recordWorkerRun({
    issueRef: "ISSUE-1",
    taskId: "task-2",
    repoKey: "test_repo",
    status: "running",
    summary: "Working...",
    blockers: [],
    updatedAt: twoMinutesAgo,
  });
  const deps = makeDeps({ ledger });
  const engine = new ReconciliationEngine(deps);

  await engine.reconcileStaleWorkerRuns("ISSUE-1");

  const runs = await ledger.listWorkerRuns("ISSUE-1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "running");
});

test("ReconciliationEngine.reconcileStaleWorkerRuns skips completed workers", async () => {
  const ledger = new MemoryWorkflowLedger();
  const twentyOneMinutesAgo = new Date(Date.now() - 21 * 60 * 1000).toISOString();
  await ledger.recordWorkerRun({
    issueRef: "ISSUE-1",
    taskId: "task-3",
    repoKey: "test_repo",
    status: "succeeded",
    summary: "Done",
    blockers: [],
    updatedAt: twentyOneMinutesAgo,
  });
  const deps = makeDeps({ ledger });
  const engine = new ReconciliationEngine(deps);

  await engine.reconcileStaleWorkerRuns("ISSUE-1");

  const runs = await ledger.listWorkerRuns("ISSUE-1");
  assert.equal(runs[0].status, "succeeded");
});

test("ReconciliationEngine.reconcileStaleWorkerRuns expires stale queued workers", async () => {
  const ledger = new MemoryWorkflowLedger();
  const twentyOneMinutesAgo = new Date(Date.now() - 21 * 60 * 1000).toISOString();
  await ledger.recordWorkerRun({
    issueRef: "ISSUE-1",
    taskId: "task-4",
    repoKey: "test_repo",
    status: "queued",
    summary: "Waiting...",
    blockers: [],
    updatedAt: twentyOneMinutesAgo,
  });
  const deps = makeDeps({ ledger });
  const engine = new ReconciliationEngine(deps);

  await engine.reconcileStaleWorkerRuns("ISSUE-1");

  const runs = await ledger.listWorkerRuns("ISSUE-1");
  assert.equal(runs[0].status, "failed");
});

// --- ReconciliationEngine.preloadPullRequests ---

test("ReconciliationEngine.preloadPullRequests fetches PRs for all repos in issues", async () => {
  const reposQueried: string[] = [];
  const deps = makeDeps({
    topology: makeTopology({ app_api: "app-api", web_app: "web-app" }),
    collaboration: {
      async findPullRequests(repo) {
        reposQueried.push(repo);
        return [makePullRequest({ repo })];
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issues = [
    makeWorkItem({ repoKeys: ["app_api"], metadata: {} }),
    makeWorkItem({ repoKeys: ["web_app"], metadata: {} }),
  ];

  const result = await engine.preloadPullRequests(issues);

  assert.ok(result);
  assert.equal(result.size, 2);
  assert.ok(reposQueried.includes("app-api"));
  assert.ok(reposQueried.includes("web-app"));
  assert.equal(result.get("app-api")?.length, 1);
});

test("ReconciliationEngine.preloadPullRequests returns undefined when no collaboration", async () => {
  const deps = makeDeps({ collaboration: undefined });
  const engine = new ReconciliationEngine(deps);
  const issues = [makeWorkItem({ repoKeys: ["test_repo"], metadata: {} })];

  const result = await engine.preloadPullRequests(issues);
  assert.equal(result, undefined);
});

test("ReconciliationEngine.preloadPullRequests returns undefined when no repos found", async () => {
  const deps = makeDeps({
    topology: makeTopology({}),
    collaboration: {
      async findPullRequests() { return []; },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issues = [makeWorkItem({ repoKeys: [], metadata: {} })];

  const result = await engine.preloadPullRequests(issues);
  assert.equal(result, undefined);
});

test("ReconciliationEngine.preloadPullRequests handles fetch errors gracefully", async () => {
  const deps = makeDeps({
    topology: makeTopology({ test_repo: "test-repo" }),
    collaboration: {
      async findPullRequests() { throw new Error("API error"); },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issues = [makeWorkItem({ repoKeys: ["test_repo"], metadata: {} })];

  const result = await engine.preloadPullRequests(issues);
  assert.ok(result);
  assert.deepEqual(result.get("test-repo"), []);
});

// --- ReconciliationEngine: state derivation ---

test("ReconciliationEngine.reconcile sets state to done when PR is merged", async () => {
  const deps = makeDeps({
    collaboration: {
      async findPullRequests(repo, headRefName) {
        return [makePullRequest({ repo, headRefName: headRefName ?? "feature/issue-1-test", title: "ISSUE-1 fix", state: "MERGED", mergedAt: "2025-01-01T00:00:00Z" })];
      },
    },
    sourceControl: {
      async inspect() {
        return { branch: "feature/issue-1-test", headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    state: "ready_to_run",
    metadata: { "workflow.repos.test_repo.worktree_path": "/tmp/test-repo" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.state, "done");
});

test("ReconciliationEngine.reconcile sets state to blocked when PR is draft", async () => {
  const deps = makeDeps({
    collaboration: {
      async findPullRequests(repo, headRefName) {
        return [makePullRequest({ repo, headRefName: headRefName ?? "feature/issue-1-test", title: "ISSUE-1 fix", isDraft: true })];
      },
    },
    sourceControl: {
      async inspect() {
        return { branch: "feature/issue-1-test", headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    state: "ready_to_run",
    metadata: { "workflow.repos.test_repo.worktree_path": "/tmp/test-repo" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.state, "blocked");
});

test("ReconciliationEngine.reconcile sets state to awaiting_human when review required", async () => {
  const deps = makeDeps({
    collaboration: {
      async findPullRequests(repo, headRefName) {
        return [makePullRequest({ repo, headRefName: headRefName ?? "feature/issue-1-test", title: "ISSUE-1 fix", reviewDecision: "REVIEW_REQUIRED" })];
      },
    },
    sourceControl: {
      async inspect() {
        return { branch: "feature/issue-1-test", headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    state: "ready_to_run",
    metadata: { "workflow.repos.test_repo.worktree_path": "/tmp/test-repo" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.state, "awaiting_human");
});

test("ReconciliationEngine.reconcile sets state to done when jira status category is done", async () => {
  const deps = makeDeps({ collaboration: undefined });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    state: "ready_to_run",
    metadata: { jiraStatusCategory: "done" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.state, "done");
});

test("ReconciliationEngine.reconcile sets state to done when jira status is closed", async () => {
  const deps = makeDeps({ collaboration: undefined });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    state: "ready_to_run",
    metadata: { jiraStatus: "closed" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.state, "done");
});

// --- ReconciliationEngine: reconcileRecordedPullRequest ---

test("ReconciliationEngine.reconcile refreshes stale recorded PR metadata from collaboration", async () => {
  const deps = makeDeps({
    collaboration: {
      async findPullRequests(repo, headRefName) {
        return [makePullRequest({ repo, headRefName: headRefName ?? "feature/issue-1-test", title: "ISSUE-1 fix", isDraft: false, mergeStateStatus: "CLEAN" })];
      },
      async getPullRequest(repo, number) {
        return makePullRequest({ repo, number, isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" });
      },
    },
    sourceControl: {
      async inspect() {
        return { branch: "feature/issue-1-test", headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    metadata: {
      "workflow.repos.test_repo.worktree_path": "/tmp/test",
      "workflow.repos.test_repo.pr_url": "https://github.com/ExampleOrg/test-repo/pull/42",
      "workflow.repos.test_repo.pr_number": 42,
      "workflow.repos.test_repo.pr_is_draft": true,
      "workflow.repos.test_repo.pr_merge_state_status": "BLOCKED",
    },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.metadata["workflow.repos.test_repo.pr_merge_state_status"], "CLEAN");
  assert.equal(result.metadata["workflow.repos.test_repo.pr_is_draft"], false);
});

// --- ReconciliationEngine: debug events ---

test("ReconciliationEngine.reconcileStaleWorkerRuns emits debug event on stale expiry", async () => {
  const debugEvents: Array<{ event: string; details: Record<string, unknown> }> = [];
  const ledger = new MemoryWorkflowLedger();
  const twentyOneMinutesAgo = new Date(Date.now() - 21 * 60 * 1000).toISOString();
  await ledger.recordWorkerRun({
    issueRef: "ISSUE-1",
    taskId: "task-debug",
    repoKey: "test_repo",
    status: "running",
    summary: "Working...",
    blockers: [],
    updatedAt: twentyOneMinutesAgo,
  });
  const deps = makeDeps({
    ledger,
    debug: (event, details) => debugEvents.push({ event, details }),
  });
  const engine = new ReconciliationEngine(deps);

  await engine.reconcileStaleWorkerRuns("ISSUE-1");

  assert.equal(debugEvents.length, 1);
  assert.equal(debugEvents[0].event, "worker.stale_expired");
  assert.equal(debugEvents[0].details.taskId, "task-debug");
  assert.equal(debugEvents[0].details.issueRef, "ISSUE-1");
});

// --- ReconciliationEngine: edge cases ---

test("ReconciliationEngine.reconcile handles sourceControl.inspect throwing gracefully", async () => {
  const deps = makeDeps({
    sourceControl: {
      async inspect() { throw new Error("git error"); },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({
    repoKeys: ["test_repo"],
    metadata: { "workflow.repos.test_repo.worktree_path": "/tmp/test" },
  });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.ref, "ISSUE-1");
});

test("ReconciliationEngine.reconcile normalizes hyphenated repo keys", async () => {
  const topology = makeTopology({ my_repo: "my-repo" });
  const deps = makeDeps({ topology });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({ repoKeys: ["my-repo"], metadata: {} });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.ok(result.repoKeys.some((k) => k === "my_repo" || k === "my-repo"));
});

test("ReconciliationEngine.reconcile merges metadata from multiple repos", async () => {
  const topology = makeTopology({ frontend: "web-app", backend: "api-server" });
  const deps = makeDeps({
    topology,
    collaboration: {
      async findPullRequests(repo, headRefName) {
        if (repo === "web-app") return [makePullRequest({ repo, number: 10, headRefName: headRefName ?? "feature/issue-1-test" })];
        if (repo === "api-server") return [makePullRequest({ repo, number: 20, headRefName: headRefName ?? "feature/issue-1-test" })];
        return [];
      },
    },
  });
  const engine = new ReconciliationEngine(deps);
  const issue = makeWorkItem({ repoKeys: ["frontend", "backend"], metadata: {} });

  const result = await engine.reconcile(issue, undefined, { persist: false });
  assert.equal(result.metadata["workflow.repos.frontend.pr_number"], 10);
  assert.equal(result.metadata["workflow.repos.backend.pr_number"], 20);
});
