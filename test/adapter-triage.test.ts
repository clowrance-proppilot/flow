import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import {
  FlowStore,
  MemoryWorkflowLedger,
  nowIso,
  beadUpdateArgsForIssue,
  ProviderAdapterError,
  classifyProviderCliError,
  extractAutoReviewFeedback,
  triageIssues as triageIssuesEngine,
  configToProjectTopology,
} from "../src/index.js";
import { parsePullRequests, parseGitHubIssues, githubIssueCreateBody, normalizePullRequest } from "../src/adapters/github.js";
import { parseJiraIssue, parseJiraCommentUrl, parseJiraSearch, currentUserOpenSprintJql, currentUserBacklogJql } from "../src/adapters/jira.js";
import type { ProjectTopology } from "../src/project-topology.js";
import { testWorkRuntime, configString, legacyHostConfig, legacyHostTopology, execFileAsync } from "./helpers/test-fixtures.js";

test("Jira adapter parses issue JSON", () => {
  const issue = parseJiraIssue({
    key: "ISSUE-6",
    fields: {
      summary: "Adapter test",
      issuetype: { name: "Bug" },
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      resolution: { name: "Unresolved" },
      assignee: { displayName: "Camden Lowrance" },
      labels: ["app_api"],
      updated: "2026-05-11T12:00:00.000-0400",
    },
  });

  assert.equal(issue.key, "ISSUE-6");
  assert.equal(issue.summary, "Adapter test");
  assert.equal(issue.issueType, "Bug");
  assert.equal(issue.status, "In Progress");
  assert.equal(issue.statusCategory, "indeterminate");
  assert.equal(issue.resolution, "Unresolved");
});

test("Jira adapter parses comment URL JSON", () => {
  assert.equal(
    parseJiraCommentUrl({ comment: { self: "https://example.atlassian.net/rest/api/3/comment/10001" } }),
    "https://example.atlassian.net/rest/api/3/comment/10001",
  );
});

test("Jira adapter parses workitem search JSON", () => {
  const issues = parseJiraSearch({
    values: [
      {
        key: "ISSUE-7",
        fields: {
          summary: "Search result",
          status: { name: "Ready for Dev" },
          labels: ["public_api"],
        },
      },
    ],
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "ISSUE-7");
  assert.equal(issues[0].summary, "Search result");
});

test("Jira adapter queue query includes active dev and review work only", () => {
  assert.equal(
    currentUserOpenSprintJql(configString(legacyHostConfig.issueTracker, "projectKey")),
    "project = ISSUE AND assignee = currentUser() AND sprint in openSprints() AND status in ('Ready for Dev', 'In Progress', 'In Review')",
  );
});

test("Jira adapter backlog query includes default planning statuses", () => {
  assert.equal(
    currentUserBacklogJql(configString(legacyHostConfig.issueTracker, "projectKey")),
    "project = ISSUE AND assignee = currentUser() AND sprint is EMPTY AND status in ('Ready for Dev', 'To Do', 'Selected for Development') ORDER BY updated DESC",
  );
});

test("Beads ledger issue update includes title and description", () => {
  assert.deepEqual(
    beadUpdateArgsForIssue("issue-1", {
      title: "Current Jira title",
      summary: "Current Jira summary",
    }),
    ["update", "issue-1", "--title", "Current Jira title", "--description", "Current Jira summary", "--allow-empty-description"],
  );
});

test("GitHub adapter parses pull request check status", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1,
        title: "PR",
        url: "https://github.com/example/repo/pull/1",
        headRefName: "feature/test",
        baseRefName: "main",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
        body: `### Issue or Reason for Change

ISSUE-1

### Description
- [x] Bug Fix

### Summary of Changes
Changed code.

### Related PRs or Issues
None.`,
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "NEUTRAL" },
        ],
        reviews: [
          { state: "COMMENTED", author: { login: "khwiri" } },
          { state: "COMMENTED", author: { login: "developer-hla" } },
          { state: "APPROVED", author: { login: "approver" } },
        ],
      },
    ],
    "app-api",
    ["Issue or Reason for Change", "Description", "Summary of Changes", "Related PRs or Issues"],
  );

  assert.equal(prs[0].checksPassing, true);
  assert.equal(prs[0].headRefName, "feature/test");
  assert.equal(prs[0].baseRefName, "main");
  assert.equal(normalizePullRequest(prs[0]).targetBranch, "main");
  assert.equal(prs[0].state, undefined);
  assert.equal(prs[0].mergedAt, undefined);
  assert.equal(prs[0].mergeable, "MERGEABLE");
  assert.equal(prs[0].mergeStateStatus, "CLEAN");
  assert.equal(prs[0].reviewDecision, "REVIEW_REQUIRED");
  assert.equal(prs[0].templateMissingHeadings, undefined);
  assert.equal(prs[0].reviewCommentCount, 2);
  assert.deepEqual(prs[0].reviewCommentAuthors, ["khwiri", "developer-hla"]);
});

test("GitHub issue tracker parses issue list JSON", () => {
  const issues = parseGitHubIssues([
    {
      number: 12,
      title: "Dogfood dashboard with GitHub issues",
      url: "https://github.com/example/flow/issues/12",
      state: "OPEN",
      body: "Use Flow to drive Flow.",
      updatedAt: "2026-05-20T12:00:00Z",
      labels: [{ name: "enhancement" }, { name: "main" }],
      assignees: [{ login: "agent" }],
    },
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, 12);
  assert.equal(issues[0].labels.join(","), "enhancement,main");
  assert.equal(issues[0].assignees.join(","), "agent");
});

test("Provider CLI errors are classified for actionable Flow blockers", () => {
  const missingCli = classifyProviderCliError("github", "gh issue list", {
    message: "spawn gh ENOENT",
    code: "ENOENT",
  });
  const auth = classifyProviderCliError("jira", "acli jira workitem search", {
    stderr: "Unauthorized: token expired",
  });
  const rateLimit = classifyProviderCliError("github", "gh pr view", {
    stderr: "API rate limit exceeded",
  });

  assert.ok(missingCli instanceof ProviderAdapterError);
  assert.equal(missingCli.code, "cli_missing");
  assert.equal(auth.code, "auth_missing");
  assert.equal(rateLimit.code, "rate_limited");
});

test("GitHub adapter parses merged pull request lifecycle fields", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1393,
        title: "ISSUE-15594",
        url: "https://github.com/ExampleOrg/app-api/pull/1393",
        headRefName: "feature/issue-15594",
        state: "MERGED",
        mergedAt: "2026-05-11T19:11:01Z",
        isDraft: false,
        body: `### Issue or Reason for Change

ISSUE-15594

### Description
- [x] Bug Fix

### Summary of Changes
Changed code.

### Related PRs or Issues
None.`,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      },
    ],
    "app-api",
    ["Issue or Reason for Change", "Description", "Summary of Changes", "Related PRs or Issues"],
  );

  assert.equal(prs[0].state, "MERGED");
  assert.equal(prs[0].mergedAt, "2026-05-11T19:11:01Z");
});

test("GitHub adapter flags pull requests missing template headings", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1402,
        title: "ISSUE-15676",
        url: "https://github.com/ExampleOrg/app-api/pull/1402",
        headRefName: "feature/issue-15676",
        isDraft: false,
        body: `## Summary
- Harden Provider batch handling.

## Validation
- pytest`,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ],
    "app-api",
    ["Issue or Reason for Change", "Description", "Summary of Changes", "Related PRs or Issues"],
  );

  assert.deepEqual(prs[0].templateMissingHeadings, [
    "Issue or Reason for Change",
    "Description",
    "Summary of Changes",
    "Related PRs or Issues",
  ]);
});

test("GitHub adapter does not enforce a PR template when none is provided", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1403,
        title: "ISSUE-15677",
        url: "https://github.com/ExampleOrg/app-api/pull/1403",
        headRefName: "feature/issue-15677",
        isDraft: false,
        body: "No repository template is configured.",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ],
    "app-api",
  );

  assert.equal(prs[0].templateMissingHeadings, undefined);
});

test("GitHub adapter parses auto review must-fix sections", () => {
  const feedback = extractAutoReviewFeedback(`<!-- flow-pr-review -->
## Summary
- Tests were added.

## Must-fix
- New test files use \`// @ts-nocheck\`, which hides type errors.

## Needs Confirmation
None.

## Suggestions
- Prefer typed mocks.`);

  assert.equal(feedback.mustFix, true);
  assert.match(feedback.mustFixDetail ?? "", /ts-nocheck/);
  assert.equal(feedback.needsConfirmation, false);
});

test("GitHub adapter treats empty auto review sections as no feedback", () => {
  const feedback = extractAutoReviewFeedback(`<!-- flow-pr-review -->
## Summary
No issues found.

## Must-fix
None found.

## Needs Confirmation
None identified.`);

  assert.equal(feedback.mustFix, false);
  assert.equal(feedback.mustFixDetail, undefined);
  assert.equal(feedback.needsConfirmation, false);
  assert.equal(feedback.needsConfirmationDetail, undefined);
});

test("Custom topology overrides repo names, paths, branch names, and PR URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-topo-"));
  await mkdir(join(root, "my-service"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();

  const customTopology: ProjectTopology = {
    validRepoKeys: new Set(["my_service", "my_ui"]),
    isValidRepoKey(repoKey) {
      return this.validRepoKeys.has(repoKey.replace(/-/g, "_"));
    },
    inferRepoKeysFromIssue(issue) {
      const text = `${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
      if (text.includes("frontend")) return ["my_ui"];
      if (text.includes("backend")) return ["my_service"];
      return [];
    },
    branchName(issue) {
      return `work/${issue.ref}`;
    },
    defaultBaseBranch() {
      return "main";
    },
    repoName(repoKey) {
      return repoKey.replace(/_/g, "-");
    },
    repoPath(projectRoot, repoKey) {
      return join(projectRoot, repoKey.replace(/_/g, "-"));
    },
    pullRequestUrl(repo, number) {
      return `https://gitlab.example.com/${repo}/-/merge_requests/${number}`;
    },
  };

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    topology: customTopology,
    projectRoot: root,
    issueTracker: {
      capabilities: {
        canCreateIssues: false,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        return {
          ref,
          title: "Fix backend crash",
          status: "Open",
          type: "bug",
          url: `https://tracker.example/${ref}`,
          labels: ["backend"],
        };
      },
      async fetchActiveQueue() {
        return [
          {
            ref: "PROJ-42",
            title: "Fix backend crash",
            status: "Open",
            type: "bug",
            url: "https://tracker.example/PROJ-42",
            labels: ["backend"],
          },
        ];
      },
    },
  });

  assert.equal(workRuntime.topology, customTopology);

  const queue = await workRuntime.inspectQueue(10);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "PROJ-42");
  assert.deepEqual(queue[0].repoKeys, ["my_service"]);

  assert.equal(customTopology.repoName("my_service"), "my-service");
  assert.equal(customTopology.repoPath(root, "my_service"), join(root, "my-service"));
  assert.equal(customTopology.branchName(queue[0]), "work/PROJ-42");
  assert.equal(customTopology.defaultBaseBranch("my_service"), "main");
  assert.equal(customTopology.pullRequestUrl("my-service", 7), "https://gitlab.example.com/my-service/-/merge_requests/7");

  assert.equal(customTopology.isValidRepoKey("my_service"), true);
  assert.equal(customTopology.isValidRepoKey("unknown_repo"), false);
});

test("Triage engine detects missing sections and duplicate candidates", async () => {
  const issues = [
    {
      ref: "GH-100",
      title: "Fix backend crash",
      description: "## Problem\nServer crashes on startup.\n\n## Scope\nOnly the auth module.\n\n## Acceptance criteria\n- Server starts without errors",
      status: "Open",
      type: "bug",
      url: "https://github.com/example/repo/issues/100",
      labels: ["bug"],
    },
    {
      ref: "GH-101",
      title: "Fix server crash on startup",
      description: "Server crashes when starting up.",
      status: "Open",
      type: "bug",
      url: "https://github.com/example/repo/issues/101",
      labels: [],
    },
    {
      ref: "GH-102",
      title: "WIP",
      description: "",
      status: "Open",
      type: "task",
      url: "https://github.com/example/repo/issues/102",
      labels: [],
    },
  ];

  const result = await triageIssuesEngine({ issues, options: { dryRun: true } });

  assert.equal(result.dryRun, true);
  assert.equal(result.issuesScanned, 3);
  assert.equal(result.issues.length, 3);

  // GH-100 has Problem and Scope but missing other sections
  const gh100 = result.issues.find((i: { ref: string }) => i.ref === "GH-100");
  assert.ok(gh100);
  assert.equal(gh100.missingSections.length > 0, true);
  assert.equal(gh100.missingSections.some((s: { section: string }) => s.section === "Problem"), false);
  assert.equal(gh100.missingSections.some((s: { section: string }) => s.section === "Verification commands"), true);

  // GH-101 is a duplicate candidate for GH-100 (similar title)
  const gh101 = result.issues.find((i: { ref: string }) => i.ref === "GH-101");
  assert.ok(gh101);
  assert.equal(gh101.duplicateCandidates.length > 0, true);
  assert.equal(gh101.duplicateCandidates[0].ref, "GH-100");
  assert.equal(gh101.duplicateCandidates[0].confidence > 0.5, true);

  // GH-102 has vague title and empty body
  const gh102 = result.issues.find((i: { ref: string }) => i.ref === "GH-102");
  assert.ok(gh102);
  assert.equal(gh102.missingSections.length, 8); // All sections missing
  assert.equal(gh102.proposedActions.some((a: { type: string }) => a.type === "add_comment"), true);
});

test("Triage engine proposes priority and lane labels", async () => {
  const issues = [
    {
      ref: "GH-200",
      title: "Security vulnerability in auth",
      description: "## Problem\nCritical security issue.",
      status: "Open",
      type: "bug",
      url: "https://github.com/example/repo/issues/200",
      labels: ["security"],
    },
    {
      ref: "GH-201",
      title: "Update documentation",
      description: "Docs need updating.",
      status: "Open",
      type: "task",
      url: "https://github.com/example/repo/issues/201",
      labels: ["chore"],
    },
  ];

  const result = await triageIssuesEngine({ issues, options: { dryRun: true } });

  const gh200 = result.issues.find((i: { ref: string }) => i.ref === "GH-200");
  assert.ok(gh200);
  assert.equal(gh200.proposedPriority, "priority-p0");
  assert.equal(gh200.proposedLane, undefined);
  assert.equal(gh200.proposedLabels.includes("priority-p0"), true);

  const gh201 = result.issues.find((i: { ref: string }) => i.ref === "GH-201");
  assert.ok(gh201);
  assert.equal(gh201.proposedPriority, "priority-p3");
  assert.equal(gh201.proposedLane, "lane-docs");
});

test("Triage engine proposes close for high-confidence duplicates", async () => {
  const issues = [
    {
      ref: "GH-300",
      title: "Fix login button not working",
      description: "The login button does nothing when clicked.",
      status: "Open",
      type: "bug",
      url: "https://github.com/example/repo/issues/300",
      labels: [],
    },
    {
      ref: "GH-301",
      title: "Fix login button not working",
      description: "The login button does nothing when clicked.",
      status: "Open",
      type: "bug",
      url: "https://github.com/example/repo/issues/301",
      labels: [],
    },
  ];

  const result = await triageIssuesEngine({ issues, options: { dryRun: true } });

  const gh301 = result.issues.find((i: { ref: string }) => i.ref === "GH-301");
  assert.ok(gh301);
  assert.equal(gh301.proposedActions.some((a: { type: string }) => a.type === "close_duplicate"), true);
  assert.equal(gh301.duplicateCandidates[0].ref, "GH-300");
  assert.equal(gh301.duplicateCandidates[0].confidence >= 0.9, true);
});

test("Triage works through Flow CLI with dry-run mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-triage-cli-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });

  const createReviewedIssue = async (summary: string, issueType: string) => {
    const request = { op: "issue", mode: "create", summary, issueType };
    const intake = await callFlow({ ...request, mode: "intake", dryRun: true });
    assert.equal(intake.ok, true);
    const reviewJob = (intake.result as { reviewJob?: { id: string; issueRef: string; repoKey: string; workType: string } }).reviewJob;
    assert.ok(reviewJob);
    await callFlow({
      op: "runtime",
      method: "recordWorkJobResult",
      params: {
        result: {
          jobId: reviewJob.id,
          issueRef: reviewJob.issueRef,
          repoKey: reviewJob.repoKey,
          workType: reviewJob.workType,
          status: "succeeded",
          summary: "Executor approved issue intake.",
          evidence: ["CLI test executor review."],
          completedAt: nowIso(),
        },
      },
    });
    return callFlow(request);
  };

  // Create some issues
  await createReviewedIssue("First issue", "Task");
  await createReviewedIssue("Second issue", "Bug");

  // Run triage in dry-run mode
  const triageResult = await callFlow({
    op: "issue",
    mode: "triage",
    dryRun: true,
    limit: 10,
  });

  assert.equal(triageResult.ok, true);
  const result = triageResult.result as { dryRun: boolean; issuesScanned: number; issues: unknown[] };
  assert.equal(result.dryRun, true);
  assert.equal(result.issuesScanned >= 2, true);
  assert.equal(result.issues.length >= 2, true);

  const accidentalApply = await callFlow({
    op: "issue",
    mode: "triage",
    dryRun: false,
    limit: 10,
  });
  const accidentalApplyResult = accidentalApply.result as { dryRun: boolean };
  assert.equal(accidentalApplyResult.dryRun, true);
});

test("Triage CLI manifest includes triage mode and capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-triage-manifest-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });

  const manifest = await callFlow({ op: "manifest", target: "issue" });
  const result = manifest.result as { modes: string[]; issueTracker: { capabilities: { triage: boolean } } };

  assert.equal(result.modes.includes("triage"), true);
  assert.equal(result.issueTracker.capabilities.triage, true);
});
