import assert from "node:assert/strict";
import test from "node:test";
import { assessIssue, nowIso } from "../src/index.js";

test("Readiness blocks failed worker results", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-1",
      title: "Test issue",
      repoKeys: ["app_api"],
      state: "running",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-1",
        issueRef: "ISSUE-1",
        repoKey: "app_api",
        status: "failed",
        summary: "Tests failed",
        changedFiles: [],
        testsRun: ["pytest"],
        blockers: ["pytest failed"],
        completedAt: nowIso(),
      },
    ],
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), true);
});

test("Readiness blocks successful Worker output until handoff records exist", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-11",
      title: "Needs handoff",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-11",
        issueRef: "ISSUE-11",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(
    assessment.findings.map((finding) => finding.summary).join(","),
    "Acceptance evidence is missing.,Documentation disposition is missing.,Pull request is missing.",
  );
});

test("Readiness lets empty successful Worker output retry execution", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-EMPTY",
      title: "Empty worker result",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {
        work_dir: "/tmp/app-api-worktree",
      },
    },
    workerResults: [
      {
        taskId: "worker-empty",
        issueRef: "ISSUE-EMPTY",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Agent returned without useful output.",
        changedFiles: [],
        testsRun: [],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, false);
  assert.equal(
    assessment.findings.some((finding) => finding.summary === "Acceptance evidence is missing."),
    false,
  );
  assert.equal(
    assessment.findings.some((finding) => finding.summary === "Documentation disposition is missing."),
    false,
  );
  assert.equal(
    assessment.findings.some((finding) => finding.summary === "Pull request is missing."),
    false,
  );
  assert.equal(
    assessment.findings.some((finding) => finding.summary === "Successful worker result has no changed files or tests."),
    true,
  );
});

test("Readiness supports local no-PR workflows when code review is disabled", () => {
  const assessment = assessIssue({
    issue: {
      ref: "LOCAL-11",
      title: "Needs local closeout",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-local-11",
        issueRef: "LOCAL-11",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    codeReviewRequired: false,
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Pull request is missing."), false);
});

test("Readiness treats retryable handoff timeout after success as warning", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-12",
      title: "Retryable timeout after success",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-success",
        issueRef: "ISSUE-12",
        repoKey: "app_api",
        executor: "live_agent_thread",
        status: "succeeded",
        summary: "Existing agent-thread evidence is valid",
        changedFiles: [],
        testsRun: ["pixi run pytest shared/provider/tests/test_panorama_one_click_contract.py"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-timeout",
        issueRef: "ISSUE-12",
        repoKey: "app_api",
        status: "blocked",
        summary: "Agent handoff timed out or was interrupted before returning a structured result.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Agent handoff timed out or was interrupted before returning a structured result."],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/12",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checksPassing: true,
      autoReviewStatus: "passed",
      humanReviewRequired: true,
      reviewDecision: "REVIEW_REQUIRED",
      reviewCommentCount: 2,
      reviewCommentAuthors: ["khwiri", "developer-hla"],
    },
    evidenceRecorded: true,
    documentationRecorded: true,
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), false);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("timed out")), true);
  const approvalFinding = assessment.findings.find((finding) => finding.summary === "Approval review is required.");
  assert.match(approvalFinding?.detail ?? "", /Comment-only reviews do not satisfy approval-required review policy/);
  const commentFinding = assessment.findings.find((finding) => finding.summary === "Review comments are present.");
  assert.match(commentFinding?.detail ?? "", /khwiri, developer-hla/);
});

test("Readiness ignores obsolete undraft executor blockers once PR is ready", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15272",
      title: "Coverage PR",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-issue-15272-implementation",
        issueRef: "ISSUE-15272",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Implemented coverage changes.",
        changedFiles: ["scripts/check_coverage.py"],
        testsRun: ["pixi run coverage-check"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-issue-15272-undraft-pr1406",
        issueRef: "ISSUE-15272",
        repoKey: "app_api",
        status: "blocked",
        summary: "Agent handoff could not find provider credentials.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Agent handoff could not find provider credentials."],
        nextPickup: "Configure credentials, then undraft PR #1406.",
        handoffPrompt: "Convert PR https://github.com/ExampleOrg/app-api/pull/1406 from draft to ready for review.",
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1344",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      checksPassing: true,
      autoReviewStatus: "passed",
    },
    evidenceRecorded: true,
    documentationRecorded: true,
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("provider credentials")), false);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("Pull request is still draft")), false);
});

test("Readiness ignores obsolete missing-workspace blockers once a worktree exists", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15389",
      title: "Evaluate Celery locking",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {
        "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-15389",
      },
    },
    workerResults: [
      {
        taskId: "worker-retry-1",
        issueRef: "ISSUE-15389",
        repoKey: "app_api",
        status: "blocked",
        summary: "Handoff workspace path is missing for app_api.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Handoff workspace path is missing."],
        nextPickup: "Run prepare workspace for the routed repo, then retry advance/autoflow.",
        completedAt: nowIso(),
      },
    ],
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), false);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("workspace path is missing")), false);
});

test("Readiness treats provider-credential executor failures as retryable", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15738",
      title: "Review remediation",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {
        "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-15738",
      },
    },
    workerResults: [
      {
        taskId: "worker-issue-15738-implementation",
        issueRef: "ISSUE-15738",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Implemented GeoParquet compatibility fix.",
        changedFiles: ["worker/src/services/controller_data/etl/provider_parquet.py"],
        testsRun: ["pixi run pytest worker/tests/services/controller_data/etl/test_provider_parquet.py"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-issue-15738-remediate",
        issueRef: "ISSUE-15738",
        repoKey: "app_api",
        status: "blocked",
        summary: "Agent handoff could not find provider credentials.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Agent handoff could not find provider credentials."],
        nextPickup: "Configure provider credentials, then retry the handoff.",
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1411",
      isDraft: false,
      checksPassing: false,
      autoReviewStatus: "failed",
    },
  });

  assert.equal(assessment.findings.some((finding) => finding.summary.includes("provider credentials")), false);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Pull request checks are not passing."), true);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Auto review checks failed."), true);
});

test("Readiness blocks duplicate review remediation when executor changes are unpushed", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15738",
      title: "Review remediation",
      repoKeys: ["app_api"],
      state: "awaiting_human",
      metadata: {
        "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-15738",
        "workflow.repos.app_api.dirty": true,
      },
    },
    workerResults: [
      {
        taskId: "worker-issue-15738-remediate",
        issueRef: "ISSUE-15738",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Fixed import ordering.",
        changedFiles: ["worker/src/services/controller_data/etl/provider_parquet.py"],
        testsRun: ["pre-commit run --files worker/src/services/controller_data/etl/provider_parquet.py"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1411",
      isDraft: false,
      checksPassing: false,
      autoReviewStatus: "failed",
    },
  });

  assert.equal(assessment.findings.some((finding) => finding.summary === "Executor changes are not pushed."), true);
  assert.equal(assessment.readyToAdvance, false);
});

test("Readiness ignores stale review blockers once the pull request is merged", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-1393",
      title: "Merged PR",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-1393",
        issueRef: "ISSUE-1393",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Implemented fix",
        changedFiles: [],
        testsRun: [],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1393",
      state: "MERGED",
      mergedAt: "2026-05-11T19:11:01Z",
      isDraft: false,
      checksPassing: false,
      autoReviewStatus: "failed",
      humanReviewRequired: true,
    },
    evidenceRecorded: true,
    documentationRecorded: true,
  });

  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), false);
});

test("Readiness reports external provider escalation as a blocker", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-15",
      title: "Provider needs samples",
      repoKeys: ["app_api"],
      state: "blocked",
      metadata: {
        externalProviderEscalation: {
          provider: "Provider",
          summary: "Provider may need to investigate the sample files.",
          blocker: "Need affected Provider file IDs or batch IDs.",
          recordedAt: nowIso(),
        },
      },
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(
    assessment.findings.some((finding) => finding.summary === "Blocked on Provider escalation."),
    true,
  );
  const escalationFinding = assessment.findings.find((finding) => finding.summary === "Blocked on Provider escalation.");
  assert.equal(escalationFinding?.detail, "Need affected Provider file IDs or batch IDs.");
});

test("Readiness blocks draft pull requests", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-13",
      title: "Draft PR",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-13",
        issueRef: "ISSUE-13",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1",
      isDraft: true,
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.findings[0].summary, "Pull request is still draft.");
});

test("Readiness blocks pull requests missing the repo template", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-22",
      title: "Missing PR template",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-22",
        issueRef: "ISSUE-22",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      templateMissingHeadings: [
        "Issue or Reason for Change",
        "Description",
        "Summary of Changes",
        "Related PRs or Issues",
      ],
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings[0].summary, "Pull request does not follow the repo template.");
  assert.match(assessment.findings[0].detail ?? "", /Issue or Reason for Change/);
});

test("Readiness blocks conflicted pull requests", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-16",
      title: "Conflicted PR",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-16",
        issueRef: "ISSUE-16",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1",
      isDraft: false,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      checksPassing: true,
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings[0].summary, "Pull request has merge conflicts.");
});

test("Readiness blocks auto-review must-fix feedback", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-21",
      title: "Must fix PR",
      repoKeys: ["public_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-21",
        issueRef: "ISSUE-21",
        repoKey: "public_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["packages/example.ts"],
        testsRun: ["pnpm test"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/public-api/pull/2971",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewMustFix: true,
      autoReviewMustFixDetail: "New test files use // @ts-nocheck.",
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings[0].summary, "Auto review has must-fix feedback.");
  assert.equal(assessment.findings[0].detail, "New test files use // @ts-nocheck.");
});

test("Readiness ignores empty auto-review must-fix text from stale metadata", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-22",
      title: "Empty must-fix metadata",
      repoKeys: ["app_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-22",
        issueRef: "ISSUE-22",
        repoKey: "app_api",
        status: "succeeded",
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1405",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewMustFix: true,
      autoReviewMustFixDetail: "None found.",
    },
  });

  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.summary === "Auto review has must-fix feedback."), false);
});

test("Readiness requires auto-review confirmations to be posted to the code review", () => {
  const base = {
    issue: {
      ref: "ISSUE-23",
      title: "Needs confirmation",
      repoKeys: ["app_api"],
      state: "ready_to_run" as const,
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-23",
        issueRef: "ISSUE-23",
        repoKey: "app_api",
        status: "succeeded" as const,
        summary: "Changed code",
        changedFiles: ["worker/src/example.py"],
        testsRun: ["pytest"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    evidenceRecorded: true,
    documentationRecorded: true,
  };

  const missingPost = assessIssue({
    ...base,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewNeedsConfirmation: true,
      autoReviewNeedsConfirmationDetail: "Confirm Provider semantics.",
      autoReviewNeedsConfirmationDisposition: "accept",
    },
  });

  assert.equal(missingPost.reviewReady, false);
  assert.equal(missingPost.findings[0].summary, "Auto review confirmation has not been posted to the code review.");

  const posted = assessIssue({
    ...base,
    review: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewNeedsConfirmation: true,
      autoReviewNeedsConfirmationDetail: "Confirm Provider semantics.",
      autoReviewNeedsConfirmationDisposition: "accept",
      autoReviewNeedsConfirmationPostedUrl: "https://github.com/ExampleOrg/app-api/pull/1402#issuecomment-1",
    },
  });

  assert.equal(posted.reviewReady, true);
  assert.equal(
    posted.findings.some((finding) => finding.summary === "Auto review requires confirmation."),
    false,
  );
});

test("Readiness blocks worker spawn when repo routing is missing", () => {
  const assessment = assessIssue({
    issue: {
      ref: "ISSUE-18",
      title: "Missing route",
      repoKeys: [],
      state: "queued",
      metadata: {},
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.findings[0].summary, "Repo routing is missing.");
});
