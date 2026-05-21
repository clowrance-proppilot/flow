import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  FlowWorkRuntime,
  FlowStore,
  MemoryWorkflowLedger,
  MirroredWorkflowLedger,
  assessIssue,
  extractAutoReviewFeedback,
  nowIso,
  beadUpdateArgsForIssue,
  workItemToBeadsMetadata,
  workJobResultSchema,
  workJobSchema,
  parseWorkEnvelope,
  createDefaultFlowWorkTypeRegistry,
  CodexWorkerSpawner,
  PiWorkerSpawner,
  createDefaultWorkerSpawner,
  createWorkflowLedger,
  bootstrapFlowConfig,
  configToProjectTopology,
  configToWorkTypeRegistry,
  flowConfigSchema,
  loadFlowConfig,
  LocalThreadExecutor,
} from "../src/index.js";
import type { ProjectTopology } from "../src/project-topology.js";
import { parseGitHubIssues, parsePullRequests } from "../src/adapters/github.js";
import { currentUserOpenSprintJql, parseJiraCommentUrl, parseJiraIssue, parseJiraSearch } from "../src/adapters/jira.js";

const legacyHostConfig = flowConfigSchema.parse({
  version: "1",
  project: { name: "Legacy Host Fixture" },
  topology: {
    repos: {
      main: { name: "HostProject", baseBranch: "main" },
      web_app: { name: "web-app", baseBranch: "develop", pathFromRoot: "web-app" },
      mobile_app: { name: "mobile-app", baseBranch: "develop", pathFromRoot: "mobile-app" },
      public_api: { name: "public-api", baseBranch: "develop", pathFromRoot: "public-api" },
      app_api: { name: "app-api", baseBranch: "develop", pathFromRoot: "app-api" },
      core_database: { name: "core-database", baseBranch: "develop", pathFromRoot: "core-database" },
    },
    branchPattern: "{kind}/{issueRef}-{slug}",
    pullRequestUrlPattern: "https://github.com/ExampleOrg/{repoName}/pull/{number}",
    issueInference: [
      { repo: "main", keywords: ["flow", "workflow workRuntime", "worker executor"] },
      { repo: "web_app", keywords: ["web-app", "pwa", "frontend", "react", "vite", "browser ui"] },
      { repo: "mobile_app", keywords: ["mobile-app", "ios", "swift", "xcode", "iphone"] },
      { repo: "public_api", keywords: ["public-api", "public api", "request-export", "endpoint contract", "nx workspace"] },
      { repo: "app_api", keywords: ["app-api", "provider", "agi", "partnercloud", "partner", "celery", "controller data", "controller-data", "pixi", "flask"] },
      { repo: "core_database", keywords: ["core-database", "stored procedure", "sproc", "sql revision", "sql trigger"] },
    ],
  },
  issueTracker: { type: "jira", projectKey: "ISSUE", siteUrl: "https://example.atlassian.net" },
  collaboration: { type: "github", owner: "ExampleOrg" },
});
const legacyHostTopology = configToProjectTopology(legacyHostConfig);

function testWorkRuntime(options: ConstructorParameters<typeof FlowWorkRuntime>[0]): FlowWorkRuntime {
  return new FlowWorkRuntime({
    topology: legacyHostTopology,
    defaultJiraProjectKey: configString(legacyHostConfig.issueTracker, "projectKey"),
    ...options,
  });
}

process.env.FLOW_GITHUB_OWNER = "ExampleOrg";

function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

test("Typed work contracts and registry validate supported jobs", () => {
  const workTypes = createDefaultFlowWorkTypeRegistry();
  const now = nowIso();
  const job = workJobSchema.parse({
    id: "job-1",
    issueRef: "ISSUE-1",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "queued",
    input: { prompt: "fix it" },
    requiredCapabilities: ["code.edit", "test.run"],
    createdAt: now,
    updatedAt: now,
  });
  const result = workJobResultSchema.parse({
    jobId: job.id,
    issueRef: job.issueRef,
    repoKey: job.repoKey,
    workType: job.workType,
    status: "succeeded",
    summary: "Implemented",
    evidence: ["npm test"],
    completedAt: now,
  });

  assert.equal(workTypes.get(job.workType)?.outputType, "worker_result");
  assert.equal(workTypes.executorCanRun("pi_worker", job.workType, job.requiredCapabilities), true);
  assert.equal(workTypes.executorCanRun("pi_worker", "flow.prepare_workspace"), false);
  assert.equal(result.jobId, job.id);
  assert.equal(workTypes.has("flow.unknown"), false);
});

test("Work type definitions include category metadata", () => {
  const workTypes = createDefaultFlowWorkTypeRegistry();
  assert.equal(workTypes.get("flow.prepare_workspace")?.category, "prepare");
  assert.equal(workTypes.get("flow.implement")?.category, "implement");
  assert.equal(workTypes.get("flow.remediate")?.category, "remediate");
  assert.equal(workTypes.get("flow.verify")?.category, "verify");

  assert.equal(workTypes.isCodeProducing("flow.implement"), true);
  assert.equal(workTypes.isCodeProducing("flow.remediate"), true);
  assert.equal(workTypes.isCodeProducing("flow.prepare_workspace"), false);
  assert.equal(workTypes.isCodeProducing("flow.verify"), false);

  assert.equal(workTypes.workTypeForCategory("implement"), "flow.implement");
  assert.equal(workTypes.workTypeForCategory("remediate"), "flow.remediate");
  assert.equal(workTypes.workTypeForCategory("prepare"), "flow.prepare_workspace");
  assert.equal(workTypes.workTypeForCategory("verify"), "flow.verify");
});

test("Flow config schema validates topology and adapter declarations", () => {
  const config = flowConfigSchema.parse({
    version: "1",
    project: { name: "Example" },
    topology: {
      repos: {
        main: { name: "example", baseBranch: "main" },
      },
      issueInference: [{ repo: "main", keywords: ["frontend"] }],
    },
    issueTracker: { type: "github", owner: "example", repo: "example" },
    collaboration: { type: "github", owner: "example" },
  });

  assert.equal(config.project.name, "Example");
  assert.equal(config.issueTracker?.type, "github");
  assert.equal(config.topology.issueInference[0].repo, "main");
  assert.throws(() =>
    flowConfigSchema.parse({
      version: "1",
      project: { name: "Bad" },
      topology: {
        repos: { main: { name: "example" } },
        issueInference: [{ repo: "missing", keywords: ["oops"] }],
      },
    })
  );
});

test("Flow config loader reads YAML and builds topology", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-"));
  await mkdir(join(root, ".flow"), { recursive: true });
  await writeFile(join(root, ".flow", "config.yaml"), [
    'version: "1"',
    "project:",
    '  name: "Example"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '      baseBranch: "main"',
    "    api:",
    '      name: "example-api"',
    '      baseBranch: "develop"',
    '      pathFromRoot: "services/api"',
    '  branchPattern: "{kind}/{issueRef}-{slug}"',
    '  pullRequestUrlPattern: "https://github.com/example/{repoName}/pull/{number}"',
    "  issueInference:",
    "    - repo: api",
    '      keywords: ["api", "backend"]',
    "issueTracker:",
    '  type: "github"',
    '  owner: "example"',
    '  repo: "example"',
    "",
  ].join("\n"));

  const config = await loadFlowConfig({ projectRoot: root });
  assert.ok(config);
  const topology = configToProjectTopology(config);
  assert.equal(topology.repoName("api"), "example-api");
  assert.equal(topology.repoPath(root, "api"), join(root, "services/api"));
  assert.equal(topology.defaultBaseBranch("api"), "develop");
  assert.equal(topology.pullRequestUrl("example-api", 42), "https://github.com/example/example-api/pull/42");
  assert.deepEqual(topology.inferRepoKeysFromIssue({ title: "Fix backend endpoint", labels: [] }), ["api"]);
  assert.equal(topology.branchName({
    ref: "ABC-123",
    title: "ABC-123 Fix backend endpoint",
    repoKeys: ["api"],
    state: "queued",
    metadata: { jiraIssueType: "Bug" },
  }), "bug/abc-123-fix-backend-endpoint");
});

test("Flow config bootstrap creates .flow/config.yaml from folder metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-"));
  const result = await bootstrapFlowConfig({ projectRoot: root });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.path, join(root, ".flow", "config.yaml"));
  assert.equal(result.repoName, result.projectName);

  const config = await loadFlowConfig({ projectRoot: root });
  assert.ok(config);
  assert.equal(config.project.name, result.projectName);
  assert.equal(config.topology.repos.main.name, result.repoName);
  assert.equal(config.topology.repos.main.baseBranch, "main");
  assert.equal(config.sourceControl?.type, "git");
  assert.equal(config.ledger?.type, "flow");

  await assert.rejects(
    () => bootstrapFlowConfig({ projectRoot: root }),
    /Flow config already exists/,
  );
});

test("Flow config builds default and custom work type registries", () => {
  const baseConfig = flowConfigSchema.parse({
    version: "1",
    project: { name: "Example" },
    topology: { repos: { main: { name: "example" } } },
  });
  const defaultRegistry = configToWorkTypeRegistry(baseConfig);
  assert.equal(defaultRegistry.workTypeForCategory("implement"), "flow.implement");
  assert.equal(defaultRegistry.executorCanRun("live_agent_thread", "flow.implement", ["code.edit"]), true);

  const customRegistry = configToWorkTypeRegistry(flowConfigSchema.parse({
    ...baseConfig,
    workTypes: [{
      name: "project.fix",
      category: "implement",
      requiredCapabilities: ["code.edit"],
      allowedExecutors: ["live_agent_thread"],
      outputType: "worker_result",
    }],
    executors: [{
      name: "live_agent_thread",
      capabilities: ["code.edit"],
      outputs: ["worker_result"],
    }],
  }));
  assert.equal(customRegistry.workTypeForCategory("implement"), "project.fix");
  assert.equal(customRegistry.executorCanRun("live_agent_thread", "project.fix", ["code.edit"]), true);
});

test("Local thread executor advertises capabilities and returns a reportable handoff result", async () => {
  const executor = new LocalThreadExecutor();
  assert.equal(executor.executionMode, "local_thread");
  assert.equal(executor.canRun("flow.implement", ["code.edit", "test.run"]), true);
  assert.equal(executor.canRun("flow.implement", ["deploy.prod"]), false);
  const progress: string[] = [];
  const result = await executor.run({
    id: "local-1",
    issueRef: "ISSUE-601",
    repoKey: "app_api",
    executor: "live_agent_thread",
    prompt: "Implement the change.",
    createdAt: nowIso(),
  }, (event) => {
    progress.push(event.summary);
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.executor, "live_agent_thread");
  assert.match(result.nextPickup ?? "", /Implement the change/);
  assert.deepEqual(progress, ["Local thread executor prepared a handoff request."]);
});

test("Work envelopes parse YAML frontmatter and preserve Markdown body", () => {
  const envelope = parseWorkEnvelope(`---
workType: flow.remediate
issueRef: ISSUE-123
repoKey: public_api
executionMode: local_thread
idempotencyKey: ISSUE-123:review
metadata:
  prNumber: 2914
---

Address only the unresolved review blockers.

- Run the smallest relevant verification.
- Return evidence.
`);

  assert.equal(envelope.workType, "flow.remediate");
  assert.equal(envelope.issueRef, "ISSUE-123");
  assert.equal(envelope.executionMode, "local_thread");
  assert.equal(envelope.metadata.prNumber, 2914);
  assert.match(envelope.body, /Address only the unresolved review blockers/);
});

test("Work Runtime submits work envelopes idempotently", async () => {
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root: await mkdtemp(join(tmpdir(), "flow-envelope-")) }), ledger });
  const session = await workRuntime.createSession("session-envelope-idempotency");
  await ledger.writeIssue({
    ref: "ISSUE-124",
    title: "Envelope idempotency",
    repoKeys: ["public_api"],
    state: "ready_to_run",
    metadata: {},
  });

  const envelope = `---
workType: flow.implement
issueRef: ISSUE-124
repoKey: public_api
executionMode: background
idempotencyKey: ISSUE-124:implementation
---

Implement the bounded change.
`;

  const first = await workRuntime.submitWorkEnvelope(session.id, envelope);
  const second = await workRuntime.submitWorkEnvelope(session.id, envelope);
  const jobs = await ledger.listWorkJobs("ISSUE-124");

  assert.equal(first.id, second.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].input.executionMode, "background");
  assert.equal(jobs[0].input.idempotencyKey, "ISSUE-124:implementation");
});

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

test("Readiness treats retryable Worker timeout after success as warning", () => {
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
        summary: "Existing Codex thread evidence is valid",
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
        summary: "Pi Worker timed out or was interrupted before returning a structured result.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Pi Worker timed out or was interrupted before returning a structured result."],
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
    },
    evidenceRecorded: true,
    documentationRecorded: true,
  });

  assert.equal(assessment.readyToAdvance, true);
  assert.equal(assessment.reviewReady, true);
  assert.equal(assessment.findings.some((finding) => finding.severity === "blocker"), false);
  assert.equal(assessment.findings.some((finding) => finding.summary.includes("timed out")), true);
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
        summary: "Pi Worker could not find provider credentials.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Pi Worker could not find provider credentials."],
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
        summary: "Worker workspace path is missing for app_api.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Worker workspace path is missing."],
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
        summary: "Pi Worker could not find provider credentials.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Pi Worker could not find provider credentials."],
        nextPickup: "Configure Pi provider credentials, then rerun the Worker request.",
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
        "JIRA Ticket or Reason for Change",
        "Description",
        "Summary of Changes",
        "Related PRs or Issues",
      ],
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(assessment.findings[0].summary, "Pull request does not follow the repo template.");
  assert.match(assessment.findings[0].detail ?? "", /JIRA Ticket or Reason for Change/);
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

test("Readiness requires auto-review confirmations to be posted to GitHub", () => {
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
  assert.equal(missingPost.findings[0].summary, "Auto review confirmation has not been posted to GitHub.");

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

test("Work Runtime advances by reconciling then requesting confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-test");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-2",
    title: "Build workRuntime",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const result = await workRuntime.advanceIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "spawn_worker");
  assert.equal(result.issue?.ref, "ISSUE-2");
});

test("Work Runtime does not leak findings across selected issues", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-finding-scope");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-OLD",
    title: "Old issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  const blocked = await workRuntime.advanceIssue(session.id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.message, /Repo routing is missing/);

  const selected = await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-NEW",
    title: "New issue",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });
  const summary = await workRuntime.summarizeHandoff(session.id);

  assert.equal(selected.findings.length, 0);
  assert.match(summary, /ISSUE-NEW: New issue/);
  assert.doesNotMatch(summary, /Repo routing is missing/);
  assert.doesNotMatch(summary, /ISSUE-OLD/);
});

test("Work Runtime does not request an unknown-repo Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-missing-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-19",
    title: "Missing route",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const result = await workRuntime.advanceIssue(session.id);

  assert.equal(result.status, "blocked");
  assert.equal(result.message, "Repo routing is missing.");
  assert.equal(result.session.pendingConfirmation, undefined);
});

test("Work Runtime records repo routing and blocks until workspace exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger, projectRoot: root });
  const session = await workRuntime.createSession("session-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Route issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const routed = await workRuntime.routeIssue(session.id, "ISSUE-20", ["app-api", "app_api"]);
  const result = await workRuntime.advanceIssue(session.id);

  assert.deepEqual(routed.repoKeys, ["app_api"]);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "prepare_workspace");
  assert.equal(result.message, "Prepare workspace for ISSUE-20 in app_api.");
});

test("Work Runtime rejects non-component repo keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger, projectRoot: root });
  const session = await workRuntime.createSession("session-route-invalid");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Route issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  await assert.rejects(
    workRuntime.routeIssue(session.id, "ISSUE-20", ["HostProject"]),
    /No valid repo keys provided/,
  );
});

test("Work Runtime prepares workspace before Worker confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
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
  const session = await workRuntime.createSession("session-prepare");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-21",
    title: "Prepare workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-21", { repoKey: "app_api" });
  const result = await workRuntime.advanceIssue(session.id);
  const confirmationId = result.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(
    prepared.metadata["workflow.repos.app_api.worktree_path"],
    "/repo/app-api/.worktrees/feature-issue-21-prepare-workspace",
  );
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.payload.repoKey, "app_api");
  assert.equal(approved.workerRequest?.workspacePath, "/repo/app-api/.worktrees/feature-issue-21-prepare-workspace");
  assert.match(approved.workerRequest?.prompt ?? "", /Prepared workspace: \/repo\/app-api\/.worktrees/);
});

test("Work Runtime inspects queue from workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-5",
    title: "Queue item",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  const queue = await workRuntime.inspectQueue(1);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "ISSUE-5");
});

test("Work Runtime accepts pure issue tracker providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
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
          title: "Provider issue",
          status: "Ready for Dev",
          statusCategory: "new",
          type: "story",
          url: `https://tracker.example/${ref}`,
          labels: ["app-api"],
        };
      },
      async fetchActiveQueue(limit) {
        assert.equal(limit, 10);
        return [
          {
            ref: "ISSUE-900",
            title: "Provider queue issue",
            status: "Ready for Dev",
            statusCategory: "new",
            type: "story",
            url: "https://tracker.example/ISSUE-900",
            labels: ["app-api"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "ISSUE-900");
  assert.equal(queue[0].title, "Provider queue issue");
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
  assert.equal(queue[0].metadata.jiraStatus, "Ready for Dev");
});

test("Work Runtime accepts pure source control providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let preparedInput: unknown;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    sourceControl: {
      async inspectWorkspace(repoPath) {
        return {
          branch: "develop",
          headSha: `inspect:${repoPath}`,
          dirty: false,
          entries: [],
        };
      },
      async prepareWorktree(input: { repoPath: string; worktreePath: string; branch: string; baseRef?: string }) {
        preparedInput = input;
        return {
          branch: input.branch,
          headSha: "provider-sha",
          dirty: false,
          entries: [" M src/provider.ts"],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-provider-source-control");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-901",
    title: "Provider workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-901", { repoKey: "app_api" });

  assert.deepEqual(preparedInput, {
    repoPath: "/repo/app-api",
    worktreePath: "/repo/app-api/.worktrees/feature-issue-901-provider-workspace",
    branch: "feature/issue-901-provider-workspace",
    baseRef: "develop",
  });
  assert.equal(prepared.metadata["workflow.repos.app_api.head_sha"], "provider-sha");
  assert.equal(prepared.metadata["workflow.repos.app_api.dirty"], false);
});

test("Work Runtime bootstraps an existing Jira issue into the workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  const workRuntime = testWorkRuntime({
    store,
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        assert.equal(key, "ISSUE-15725");
        return {
          key,
          summary: "Provider Panorama app-key already-exists response causes start-auth 500",
          issueType: "Bug",
          status: "In Progress",
          statusCategory: "indeterminate",
          labels: ["app-api"],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-bootstrap-jira");

  const issue = await workRuntime.bootstrapJiraIssue(session.id, "ISSUE-15725", {
    repoKeys: ["app_api"],
    branch: "bug/ISSUE-15725-panorama-app-key-idempotent",
    worktreePath: "/repo/app-api/.worktrees/feature-issue-15607-validate-updated-provider-panorama-o",
  });
  const selectedSession = await store.readSession(session.id);
  const stored = await ledger.readIssue("ISSUE-15725");

  assert.equal(issue.ref, "ISSUE-15725");
  assert.equal(issue.state, "selected");
  assert.deepEqual(issue.repoKeys, ["app_api"]);
  assert.equal(selectedSession?.selectedIssueRef, "ISSUE-15725");
  assert.equal(stored?.metadata.jiraStatus, "In Progress");
  assert.equal(
    stored?.metadata["workflow.repos.app_api.branch"],
    "bug/ISSUE-15725-panorama-app-key-idempotent",
  );
  assert.equal(
    stored?.metadata["workflow.repos.app_api.worktree_path"],
    "/repo/app-api/.worktrees/feature-issue-15607-validate-updated-provider-panorama-o",
  );
});

test("Work Runtime creates Jira issues through Flow without generated labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let createdInput: unknown;
  const workRuntime = testWorkRuntime({
    store,
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        assert.equal(key, "ISSUE-15738");
        return {
          key,
          summary: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
          issueType: "Bug",
          status: "Ready for Dev",
          statusCategory: "new",
          labels: [],
        };
      },
      async createIssue(input) {
        createdInput = input;
        return {
          key: "ISSUE-15738",
          summary: input.summary,
          issueType: input.issueType,
          status: "Ready for Dev",
          labels: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-create-jira");

  const issue = await workRuntime.createJiraIssue(session.id, {
    issueType: "Bug",
    summary: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
    description: "Follow-up from ISSUE-15461.",
    repoKeys: ["app_api"],
  });
  const selectedSession = await store.readSession(session.id);

  assert.deepEqual(createdInput, {
    projectKey: "ISSUE",
    issueType: "Bug",
    summary: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
    description: "Follow-up from ISSUE-15461.",
  });
  assert.equal(issue.ref, "ISSUE-15738");
  assert.equal(issue.metadata.jiraIssueType, "Bug");
  assert.deepEqual(issue.metadata.jiraLabels, []);
  assert.deepEqual(issue.repoKeys, ["app_api"]);
  assert.equal(selectedSession?.selectedIssueRef, "ISSUE-15738");
});

test("Work Runtime moves issues into the active Jira sprint through Flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let movedInput: unknown;
  await ledger.writeIssue({
    ref: "ISSUE-15730",
    title: "Prevent prescribed fixes",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  const workRuntime = testWorkRuntime({
    store,
    ledger,
    jira: {
      async viewIssue(key) {
        return { key, summary: key, status: "Ready for Dev", labels: [] };
      },
      async moveIssuesToActiveSprint(input) {
        movedInput = input;
        return {
          issueKeys: input.issueKeys,
          sprintId: 321,
          sprintName: "Sprint 321",
          boardId: 12,
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-move-sprint");

  const result = await workRuntime.moveIssuesToActiveSprint(session.id, ["ISSUE-15730"], { projectKey: "ISSUE" });
  const issue = await ledger.readIssue("ISSUE-15730");

  assert.deepEqual(movedInput, { issueKeys: ["ISSUE-15730"], projectKey: "ISSUE", boardId: undefined, sprintId: undefined });
  assert.deepEqual(result.issueKeys, ["ISSUE-15730"]);
  assert.equal(result.sprintId, 321);
  assert.equal(issue?.metadata.jiraSprintId, 321);
  assert.equal(issue?.metadata.jiraSprintName, "Sprint 321");
});

test("Work Runtime inspects queue from current Jira sprint before ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "ISSUE-15697",
    title: "Stale closed bead",
    repoKeys: ["public_api"],
    state: "running",
    metadata: {
      "workflow.phase": "implementation",
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-15676",
    title: "Existing ledger title",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.phase": "triage",
    },
  });

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues(limit?: number) {
        assert.equal(limit, 10);
        return [
          {
            key: "ISSUE-15676",
            summary: "Current sprint issue",
            status: "Ready for Dev",
            statusCategory: "new",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.deepEqual(queue.map((issue) => issue.ref), ["ISSUE-15676"]);
  assert.equal(queue[0].title, "Current sprint issue");
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
  assert.equal(queue[0].metadata["workflow.phase"], "triage");
  assert.equal(queue[0].metadata.jiraStatus, "Ready for Dev");
  assert.equal(await ledger.readIssue("ISSUE-15697").then((issue) => issue?.state), "running");
  assert.equal(await ledger.readIssue("ISSUE-15676").then((issue) => issue?.title), "Existing ledger title");
});

test("Work Runtime inspects current-user Jira backlog separately from sprint queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "flow"), { recursive: true });
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger: new MemoryWorkflowLedger(),
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira backlog search");
      },
      async searchCurrentUserBacklogIssues(limit) {
        assert.equal(limit, 2);
        return [
          {
            key: "ISSUE-15730",
            summary: "Prevent host-ops autogenerated Jira issues from prescribing fixes",
            issueType: "Story",
            status: "Ready for Dev",
            statusCategory: "new",
            labels: ["flow"],
          },
        ];
      },
    },
  });

  const backlog = await workRuntime.inspectBacklog(2);

  assert.equal(backlog.length, 1);
  assert.equal(backlog[0].ref, "ISSUE-15730");
  assert.deepEqual(backlog[0].repoKeys, ["main"]);
  assert.equal(backlog[0].metadata.jiraStatus, "Ready for Dev");
});

test("Work Runtime excludes done Jira issues defensively", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15697",
            summary: "Closed issue",
            status: "Closed",
            statusCategory: "done",
            resolution: "Done",
            labels: [],
          },
          {
            key: "ISSUE-15676",
            summary: "Current sprint issue",
            status: "In Progress",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.deepEqual(queue.map((issue) => issue.ref), ["ISSUE-15676"]);
  assert.equal(await ledger.readIssue("ISSUE-15676"), undefined);
});

test("Work Runtime lets Jira review state override stale worker phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "ISSUE-15382",
    title: "Stale implementation phase",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      "workflow.phase": "implementation",
      "workflow.workers.pi.app_api.status": "blocked",
      "workflow.workers.pi.app_api.summary": "Old worker blocker",
    },
  });

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15382",
            summary: "Current review issue",
            status: "In Review",
            labels: ["app_api"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);
  const stored = await ledger.readIssue("ISSUE-15382");

  assert.equal(queue[0].state, "awaiting_human");
  assert.equal(stored?.state, "blocked");
  assert.equal(stored ? workItemToBeadsMetadata(stored)["workflow.phase"] : "", "blocked");
  assert.equal(queue[0].metadata.jiraStatus, "In Review");
});

test("Work Runtime replaces invalid stale routed repo keys from Jira labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "ISSUE-15676",
    title: "Stale repo routing",
    repoKeys: ["HostProject"],
    state: "queued",
    metadata: {
      "workflow.repo": "HostProject",
    },
  });

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15676",
            summary: "Current sprint issue",
            status: "In Progress",
            labels: ["app_api"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "ISSUE-15676");
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
});

test("Work Runtime infers app_api routing from Jira summary keywords", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "app-api"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();

  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue() {
        throw new Error("viewIssue should not be needed for Jira queue search");
      },
      async searchCurrentUserOpenSprintIssues() {
        return [
          {
            key: "ISSUE-15676",
            summary: "Provider unable to process files compared to AGI",
            status: "Ready for Dev",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].repoKeys, ["app_api"]);
});

test("Work Runtime approval creates a worker request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-approve");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-3",
    title: "Spawn worker",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });
  const pending = await workRuntime.advanceIssue(session.id);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);

  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "worker_requested");
  assert.equal(approved.workerRequest?.issueRef, "ISSUE-3");
  assert.ok(approved.workerRequest?.workJobId);
  assert.match(approved.workerRequest?.prompt ?? "", /Return only a JSON object/);
  const jobs = await workRuntime.listWorkJobs(session.id, "ISSUE-3");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.implement");
  assert.equal(jobs[0].status, "queued");
  assert.equal(approved.workerRequest?.workJobId, jobs[0].id);
});

test("Work Runtime prepares bug-prefixed branches from agent-selected branch kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const repoPath = join(root, "app-api");
  await mkdir(repoPath, { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  let preparedBranch = "";
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    git: {
      async inspect() {
        return { branch: "bug/issue-15738-geoparquet-provider-etl-fails", headSha: "abc123", dirty: false, entries: [] };
      },
      async prepareWorktree(plan) {
        preparedBranch = plan.branch;
        return { branch: plan.branch, headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const session = await workRuntime.createSession("session-bug-branch");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15738",
    title: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: { jiraIssueType: "Bug", branchKind: "bug" },
  });

  await workRuntime.prepareWorkspace(session.id, "ISSUE-15738", { repoKey: "app_api", baseBranch: "release/2026.6.0" });

  assert.equal(preparedBranch, "bug/issue-15738-geoparquet-provider-etl-fails-on-geoarrow-wkb-parquet-sc");
});

test("Work Runtime blocks generated branches when branch kind is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const repoPath = join(root, "app-api");
  await mkdir(repoPath, { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree() {
        throw new Error("prepareWorktree should not run without branch kind");
      },
    },
  });
  const session = await workRuntime.createSession("session-missing-branch-kind");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15747",
    title: "Provider upload batch completion regression",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {},
  });

  await assert.rejects(
    workRuntime.prepareWorkspace(session.id, "ISSUE-15747", { repoKey: "app_api" }),
    /branch kind is missing/,
  );
});

test("Work Runtime infers generated branch kind from Jira issue type", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let preparedBranch = "";
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        preparedBranch = plan.branch;
        return { branch: plan.branch, headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const session = await workRuntime.createSession("session-infer-branch-kind");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15720",
    title: "Partner PartnerCloud Provider Integration",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: { jiraIssueType: "Story" },
  });

  await workRuntime.prepareWorkspace(session.id, "ISSUE-15720", { repoKey: "app_api" });

  assert.equal(preparedBranch, "feature/issue-15720-partner-partnercloud-provider-integration");
});

test("Work Runtime moves Ready for Dev issue to In Progress after workspace prep", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const transitions: Array<{ key: string; status: string }> = [];
  let jiraStatus = "Ready for Dev";
  let jiraStatusCategory = "new";
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        return {
          key,
          summary: "Partner PartnerCloud Provider Integration",
          status: jiraStatus,
          statusCategory: jiraStatusCategory,
          labels: [],
        };
      },
      async transitionIssueToStatus(key, status) {
        transitions.push({ key, status });
        jiraStatus = status;
        jiraStatusCategory = "indeterminate";
      },
    },
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        return { branch: plan.branch, headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const session = await workRuntime.createSession("session-transition-in-progress");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15720",
    title: "Partner PartnerCloud Provider Integration",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      branchKind: "feature",
      jiraStatus: "Ready for Dev",
      jiraStatusCategory: "new",
    },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-15720", { repoKey: "app_api" });

  assert.deepEqual(transitions, [{ key: "ISSUE-15720", status: "In Progress" }]);
  assert.equal(prepared.metadata.jiraStatus, "In Progress");
  assert.equal(prepared.metadata.jiraStatusCategory, "indeterminate");
});

test("Work Runtime persists worker results through the workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-ledger");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-4",
    title: "Use ledger",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-4",
    issueRef: "ISSUE-4",
    repoKey: "app_api",
    status: "blocked",
    summary: "Need operator input",
    changedFiles: [],
    testsRun: [],
    blockers: ["operator input required"],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("ISSUE-4");
  const runs = await ledger.listWorkerRuns("ISSUE-4");
  const issue = await ledger.readIssue("ISSUE-4");
  assert.equal(results.length, 1);
  assert.equal(runs[0].status, "blocked");
  assert.equal(results[0].summary, "Need operator input");
  assert.equal(issue?.state, "blocked");
});

test("Workflow ledger upserts Worker results by task id", async () => {
  const ledger = new MemoryWorkflowLedger();
  await ledger.recordWorkerResult({
    taskId: "worker-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    status: "blocked",
    summary: "Missing pytest",
    changedFiles: [],
    testsRun: [],
    blockers: ["pytest unavailable"],
    completedAt: nowIso(),
  });

  await ledger.recordWorkerResult({
    taskId: "worker-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Verified",
    changedFiles: [],
    testsRun: ["pixi run pytest"],
    blockers: [],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("ISSUE-10");
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "succeeded");
  assert.equal(results[0].blockers.length, 0);
});

test("Mirrored workflow ledger keeps primary authoritative when mirror fails", async () => {
  const primary = new MemoryWorkflowLedger();
  const mirrored = new MirroredWorkflowLedger(primary, {
    async mirrorIssue() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkerRun() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkerResult() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkJob() {
      throw new Error("mirror unavailable");
    },
    async mirrorWorkJobResult() {
      throw new Error("mirror unavailable");
    },
  });

  const stored = await mirrored.ensureIssue({
    ref: "ISSUE-88",
    title: "Mirror should not gate writes",
    repoKeys: ["main"],
    state: "selected",
    metadata: {},
  });
  const readBack = await primary.readIssue("ISSUE-88");

  assert.equal(stored.ref, "ISSUE-88");
  assert.equal(readBack?.state, "selected");
});

test("Flow workflow ledger persists records to local JSONL by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ledger-"));
  const ledger = createWorkflowLedger({ cwd: root, env: {} as NodeJS.ProcessEnv });
  await ledger.writeIssue({
    ref: "ISSUE-90",
    title: "Native ledger",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  await ledger.recordWorkerResult({
    taskId: "worker-90",
    issueRef: "ISSUE-90",
    repoKey: "main",
    status: "succeeded",
    summary: "done",
    changedFiles: [],
    testsRun: [],
    blockers: [],
    completedAt: nowIso(),
  });

  const reloaded = createWorkflowLedger({ cwd: root, env: {} as NodeJS.ProcessEnv });
  assert.equal((await reloaded.readIssue("ISSUE-90"))?.title, "Native ledger");
  assert.equal((await reloaded.listWorkerResults("ISSUE-90"))[0]?.taskId, "worker-90");
  const projection = JSON.parse(await readFile(join(root, ".flow", "ledger", "issues", "ISSUE-90.json"), "utf8"));
  assert.equal(projection.issue.title, "Native ledger");
  assert.equal(projection.workerRuns[0].taskId, "worker-90");
  assert.equal(projection.workerResults[0].taskId, "worker-90");
});

test("Workflow ledger upserts typed work jobs and results", async () => {
  const ledger = new MemoryWorkflowLedger();
  const now = nowIso();
  await ledger.recordWorkJob({
    id: "job-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "queued",
    input: {},
    requiredCapabilities: ["code.edit"],
    createdAt: now,
    updatedAt: now,
  });
  await ledger.recordWorkJob({
    id: "job-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "running",
    input: {},
    requiredCapabilities: ["code.edit"],
    claimedBy: "pi_worker",
    createdAt: now,
    updatedAt: nowIso(),
  });
  await ledger.recordWorkJobResult({
    jobId: "job-10",
    issueRef: "ISSUE-10",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "succeeded",
    summary: "Done",
    evidence: ["npm test"],
    completedAt: nowIso(),
  });

  const jobs = await ledger.listWorkJobs("ISSUE-10");
  const results = await ledger.listWorkJobResults("ISSUE-10");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].claimedBy, "pi_worker");
  assert.equal(results.length, 1);
  assert.equal(results[0].summary, "Done");
});

test("Work Runtime records Pi Worker spawn blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-worker-blocked");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-7",
    title: "Worker blocker",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  const result = await workRuntime.runWorker(
    session.id,
    {
      id: "worker-7",
      issueRef: "ISSUE-7",
      repoKey: "app_api",
      prompt: "do work",
      workspacePath: "/tmp/app-api-worktree",
      createdAt: nowIso(),
    },
    {
      async run(request) {
        return {
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          status: "blocked",
          summary: "Pi provider is not configured",
          changedFiles: [],
          testsRun: [],
          blockers: ["Pi provider is not configured"],
          completedAt: nowIso(),
        };
      },
    },
  );

  const results = await ledger.listWorkerResults("ISSUE-7");
  const jobs = await ledger.listWorkJobs("ISSUE-7");
  const jobResults = await ledger.listWorkJobResults("ISSUE-7");
  const runs = await workRuntime.observeWorkers(session.id);
  assert.equal(result.status, "blocked");
  assert.equal(result.workJobId, jobs[0].id);
  assert.equal(jobs[0].status, "blocked");
  assert.equal(jobResults[0].jobId, jobs[0].id);
  assert.equal(jobResults[0].workerResult?.taskId, "worker-7");
  assert.equal(runs.map((run) => run.status).join(","), "blocked");
  assert.equal(results[0].blockers[0], "Pi provider is not configured");
  assert.match(results[0].handoffPrompt ?? "", /You are a local-thread executor for Flow issue ISSUE-7/);
  assert.match(results[0].handoffPrompt ?? "", /Work through Flow/);
  assert.match(results[0].handoffPrompt ?? "", /First reconcile\/adopt this executor task/);
  assert.match(results[0].handoffPrompt ?? "", /real blocker or the work is review-ready/);
  assert.match(results[0].handoffPrompt ?? "", /If Flow asks for an adoption payload/);
  assert.doesNotMatch(results[0].handoffPrompt ?? "", /Direct Jira\/GitHub/);
  assert.match(results[0].handoffPrompt ?? "", /app-api-worktree/);
});

test("Work Runtime does not create typed work while a Worker is active for the issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-active-worker-guard");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-71",
    title: "Already running",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });
  await ledger.recordWorkerRun({
    taskId: "worker-active",
    issueRef: "ISSUE-71",
    repoKey: "app_api",
    status: "running",
    workspacePath: "/tmp/app-api-worktree",
    summary: "Worker started.",
    blockers: [],
    startedAt: nowIso(),
    updatedAt: nowIso(),
  });

  const result = await workRuntime.advanceIssue(session.id);
  const jobs = await ledger.listWorkJobs("ISSUE-71");
  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(result.status, "blocked");
  assert.match(result.message, /Worker is already running/);
  assert.equal(jobs.length, 0);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-71")?.workflowState, "running");
});

test("Work Runtime blocked handoff includes paste-ready local-thread executor prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-blocked-handoff-prompt");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-77",
    title: "Needs local intervention",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-77",
    issueRef: "ISSUE-77",
    repoKey: "app_api",
    status: "blocked",
    summary: "Worker needs human context",
    changedFiles: [],
    testsRun: [],
    blockers: ["Need operator to inspect production evidence"],
    nextPickup: "Paste the handoff prompt into a local agent thread.",
    handoffPrompt: "Take over ISSUE-77 from Flow.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Paste-ready local-thread executor prompt/);
  assert.match(advanced.message, /Take over ISSUE-77 from Flow/);
});

test("Work Runtime blocked message suppresses obsolete satisfied PR executor prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-obsolete-pr-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15272",
    title: "Coverage PR",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1344",
      prNumber: 1344,
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm pixi.lock truly does not change.",
      evidenceRecorded: true,
      documentationRecorded: true,
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-15272-test-coverage-ci",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-issue-15272-undraft-pr1406",
    issueRef: "ISSUE-15272",
    repoKey: "app_api",
    status: "blocked",
    summary: "Pi Worker could not find provider credentials.",
    changedFiles: [],
    testsRun: [],
    blockers: ["Pi Worker could not find provider credentials."],
    nextPickup: "Configure credentials, then undraft PR #1406.",
    handoffPrompt: "Convert PR https://github.com/ExampleOrg/app-api/pull/1406 from draft to ready for review.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Auto review requires confirmation/);
  assert.doesNotMatch(advanced.message, /1406/);
  assert.doesNotMatch(advanced.message, /provider credentials/);
  assert.doesNotMatch(advanced.message, /Paste-ready local-thread executor prompt/);
});

test("Work Runtime synthesizes paste-ready handoff for existing blocked workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-legacy-blocked-handoff");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-78",
    title: "Existing blocked worker",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-78",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-78",
    issueRef: "ISSUE-78",
    repoKey: "app_api",
    status: "blocked",
    summary: "Worker stopped before local inspection",
    changedFiles: [],
    testsRun: [],
    blockers: ["Needs local operator context"],
    nextPickup: "Use a local agent thread.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Paste-ready local-thread executor prompt/);
  assert.match(advanced.message, /You are a local-thread executor for Flow issue ISSUE-78/);
  assert.match(advanced.message, /Work through Flow/);
  assert.match(advanced.message, /First reconcile\/adopt this executor task/);
  assert.match(advanced.message, /If Flow asks for an adoption payload/);
  assert.doesNotMatch(advanced.message, /Direct Jira\/GitHub/);
  assert.match(advanced.message, /feature-issue-78/);
  assert.match(advanced.message, /Requested work/);
});

test("Work Runtime records Worker lifecycle before and after execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-worker-lifecycle");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-8",
    title: "Lifecycle",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  let runsDuringWorker = 0;
  await workRuntime.runWorker(
    session.id,
    {
      id: "worker-8",
      issueRef: "ISSUE-8",
      repoKey: "app_api",
      prompt: "do work",
      workspacePath: "/tmp/app-api-worktree",
      createdAt: nowIso(),
    },
    {
      async run() {
        runsDuringWorker = (await ledger.listWorkerRuns("ISSUE-8")).length;
        return {
          taskId: "worker-8",
          issueRef: "ISSUE-8",
          repoKey: "app_api",
          status: "succeeded",
          summary: "Done",
          changedFiles: [],
          testsRun: [],
          blockers: [],
          completedAt: nowIso(),
        };
      },
    },
  );

  const runs = await workRuntime.observeWorkers(session.id);
  assert.equal(runsDuringWorker, 1);
  assert.equal(runs[0].status, "succeeded");
  assert.equal(runs[0].summary, "Done");
  const jobs = await ledger.listWorkJobs("ISSUE-8");
  const jobResults = await ledger.listWorkJobResults("ISSUE-8");
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults[0].workerResult?.taskId, "worker-8");
});

test("Work Runtime records streamed Worker progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-worker-progress");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-9",
    title: "Progress",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.runWorker(
    session.id,
    {
      id: "worker-9",
      issueRef: "ISSUE-9",
      repoKey: "app_api",
      prompt: "do work",
      workspacePath: "/tmp/app-api-worktree",
      createdAt: nowIso(),
    },
    {
      async run(request, onProgress) {
        await onProgress?.({
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          summary: "Tool started: grep",
          updatedAt: nowIso(),
        });
        return {
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          status: "succeeded",
          summary: "Done",
          changedFiles: [],
          testsRun: [],
          blockers: [],
          completedAt: nowIso(),
        };
      },
    },
  );

  const runs = await workRuntime.observeWorkers(session.id);
  assert.equal(runs[0].summary, "Done");
});

test("Work Runtime lets a live agent thread adopt and close a Worker run", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-live-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-30",
    title: "Live worker",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });

  const request = await workRuntime.adoptLiveWorker(
    session.id,
    {
      id: "worker-live-1",
      issueRef: "ISSUE-30",
      repoKey: "main",
      prompt: "Do the live-thread work",
      workspacePath: "/repo/.worktrees/feature-issue-30-live-worker",
      createdAt: nowIso(),
    },
    { adopter: "agent-thread" },
  );
  const adoptedRuns = await workRuntime.observeWorkers(session.id);

  assert.equal(request.executor, "live_agent_thread");
  assert.ok(request.workJobId);
  assert.equal(adoptedRuns[0].executor, "live_agent_thread");
  assert.equal(adoptedRuns[0].status, "running");
  assert.match(adoptedRuns[0].summary ?? "", /agent-thread/);
  const adoptedJobs = await ledger.listWorkJobs("ISSUE-30");
  assert.equal(adoptedJobs.length, 1);
  assert.equal(adoptedJobs[0].claimedBy, "live_agent_thread");
  assert.equal(adoptedJobs[0].status, "running");

  await workRuntime.recordWorkerResult(session.id, {
    taskId: request.id,
    issueRef: request.issueRef,
    repoKey: request.repoKey,
    workJobId: request.workJobId,
    executor: "live_agent_thread",
    status: "succeeded",
    summary: "Live thread completed the Worker assignment.",
    changedFiles: ["src/work-runtime.ts"],
    testsRun: ["npm test"],
    blockers: [],
    completedAt: nowIso(),
  });

  const runs = await workRuntime.observeWorkers(session.id);
  const results = await ledger.listWorkerResults("ISSUE-30");
  const jobs = await ledger.listWorkJobs("ISSUE-30");
  const jobResults = await ledger.listWorkJobResults("ISSUE-30");
  assert.equal(runs[0].status, "succeeded");
  assert.equal(runs[0].executor, "live_agent_thread");
  assert.equal(results[0].executor, "live_agent_thread");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults[0].jobId, request.workJobId);
});

test("Work Runtime adopts the pending Worker request into a live thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-pending-live-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-31",
    title: "Pending live worker",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-31",
    },
  });

  const request = await workRuntime.adoptPendingLiveWorker(session.id, { adopter: "codex-thread" });
  const runs = await workRuntime.observeWorkers(session.id);
  const jobs = await ledger.listWorkJobs("ISSUE-31");

  assert.equal(request.executor, "live_agent_thread");
  assert.equal(request.issueRef, "ISSUE-31");
  assert.equal(request.repoKey, "app_api");
  assert.ok(request.workJobId);
  assert.equal(request.workspacePath, "/repo/app-api/.worktrees/feature-issue-31");
  assert.equal(runs[0].taskId, request.id);
  assert.equal(runs[0].workJobId, request.workJobId);
  assert.equal(runs[0].executor, "live_agent_thread");
  assert.equal(runs[0].status, "running");
  assert.match(runs[0].summary ?? "", /codex-thread/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, request.workJobId);
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].claimedBy, "live_agent_thread");
});

test("Work Runtime infers typed work job when live thread records result without workJobId", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-live-worker-result-infer-job");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-32",
    title: "Live worker result without job id",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-32",
    },
  });

  const request = await workRuntime.adoptPendingLiveWorker(session.id, { adopter: "codex-thread" });
  await workRuntime.recordWorkerResult(session.id, {
    taskId: request.id,
    issueRef: request.issueRef,
    repoKey: request.repoKey,
    executor: "live_agent_thread",
    status: "succeeded",
    summary: "Codex thread completed the Worker assignment.",
    changedFiles: ["worker/tests/services/controller_data/etl/test_provider_parquet.py"],
    testsRun: ["pixi run pytest worker/tests/services/controller_data/etl/test_provider_parquet.py"],
    blockers: [],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("ISSUE-32");
  const jobs = await ledger.listWorkJobs("ISSUE-32");
  const jobResults = await ledger.listWorkJobResults("ISSUE-32");
  assert.equal(results[0].workJobId, request.workJobId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults.length, 1);
  assert.equal(jobResults[0].jobId, request.workJobId);
  assert.equal(jobResults[0].workerResult?.executor, "live_agent_thread");
});

test("Work Runtime records current local thread against a pending Worker request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-codex-worker-result");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-33",
    title: "Codex worker result",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-33",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const requested = await workRuntime.advanceIssue(session.id, confirmationId);
  assert.equal(requested.status, "worker_requested");

  const record = await workRuntime.recordLocalThreadResult(session.id, {
    issueRef: "ISSUE-33",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Codex thread completed the Worker assignment.",
    changedFiles: ["src/work-runtime.ts"],
    testsRun: ["npm test"],
  });

  const results = await ledger.listWorkerResults("ISSUE-33");
  const runs = await ledger.listWorkerRuns("ISSUE-33");
  const jobs = await ledger.listWorkJobs("ISSUE-33");
  const jobResults = await ledger.listWorkJobResults("ISSUE-33");
  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(record.result.taskId, requested.workerRequest?.id);
  assert.equal(record.result.workJobId, requested.workerRequest?.workJobId);
  assert.equal(record.result.executor, "live_agent_thread");
  assert.equal(results[0].executor, "live_agent_thread");
  assert.equal(runs.at(-1)?.status, "succeeded");
  assert.equal(jobs[0].claimedBy, "live_agent_thread");
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults[0].workerResult?.taskId, requested.workerRequest?.id);
  assert.notEqual(advanced.session.pendingConfirmation?.action, "spawn_worker");
});

test("Work Runtime routes and prepares main work in the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "host-root-"));
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger: new MemoryWorkflowLedger(),
    projectRoot,
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        assert.equal(plan.repoPath, projectRoot);
        assert.equal(plan.baseRef, "main");
        assert.match(plan.worktreePath, /\.worktrees\/feature-issue-31-flow-root-work$/);
        return {
          branch: plan.branch,
          headSha: "abcflow",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-flow-route");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-31",
    title: "Flow root work",
    repoKeys: [],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const routed = await workRuntime.routeIssue(session.id, "ISSUE-31", ["main"]);
  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-31", { repoKey: "main" });

  assert.deepEqual(routed.repoKeys, ["main"]);
  assert.equal(prepared.metadata["workflow.repos.main.base_branch"], "main");
  assert.equal(prepared.metadata["workflow.repos.main.worktree_path"], `${projectRoot}/.worktrees/feature-issue-31-flow-root-work`);
});

test("Work Runtime autoflow can approve, run Worker, and stop on Readiness blocker", async () => {
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

  const result = await workRuntime.autoFlowIssue(
    session.id,
    {
      async run(request) {
        return {
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          status: "succeeded",
          summary: "Code changed",
          changedFiles: ["worker/src/example.py"],
          testsRun: ["pytest worker/tests/example.py"],
          blockers: [],
          completedAt: nowIso(),
        };
      },
    },
    { autoApproveWorker: true, runWorker: true },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.workerResults.length, 1);
  assert.equal(result.steps.map((step) => step.status).join(","), "needs_confirmation,worker_requested,blocked");
  assert.match(result.message, /Acceptance evidence is missing/);
  const issue = await ledger.readIssue("ISSUE-16");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
  assert.equal(typeof issue?.metadata["workflow.autoflow.last_attempted_at"], "string");
});

test("Work Runtime autoflow runs background executor alias used by CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow-background-alias");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-18",
    title: "Autoflow alias",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const result = await workRuntime.autoFlowIssue(
    session.id,
    {
      async run(request) {
        return {
          taskId: request.id,
          issueRef: request.issueRef,
          repoKey: request.repoKey,
          status: "succeeded",
          summary: "Code changed",
          changedFiles: ["worker/src/example.py"],
          testsRun: ["pytest worker/tests/example.py"],
          blockers: [],
          completedAt: nowIso(),
        };
      },
    },
    { autoApproveWorker: true, runBackgroundExecutor: true },
  );

  assert.equal(result.workerResults.length, 1);
  assert.equal(result.steps.map((step) => step.status).join(","), "needs_confirmation,worker_requested,blocked");
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

test("Default Worker spawner falls back to Codex when Pi credentials are unavailable", () => {
  const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;

  const spawner = createDefaultWorkerSpawner({
    env,
    flowRoot: "/repo",
    codexAvailable: () => true,
  });

  assert.equal(spawner instanceof CodexWorkerSpawner, true);
});

test("Default Worker spawner honors explicit Pi executor selection", () => {
  const env = { FLOW_WORKER_EXECUTOR: "pi" } as NodeJS.ProcessEnv;

  const spawner = createDefaultWorkerSpawner({
    env,
    flowRoot: "/repo",
    codexAvailable: () => true,
  });

  assert.equal(spawner instanceof PiWorkerSpawner, true);
});

test("Work Runtime autoflow prepares a missing workspace before Worker confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
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

  const result = await workRuntime.autoFlowIssue(session.id, {
    async run() {
      throw new Error("Worker should not run without runWorker");
    },
  });

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.workerResults.length, 0);
  assert.equal(result.steps.map((step) => step.session.pendingConfirmation?.action).join(","), "prepare_workspace,spawn_worker");
  assert.equal(result.issue?.metadata["workflow.repos.app_api.worktree_path"], "/repo/app-api/.worktrees/feature-issue-17-autoflow-prepare");
});

test("Work Runtime autoflow marks draft pull requests ready before reassessing blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let markedReady: { repo: string; number: number } | undefined;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
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
        return this.getPullRequest?.(repo, number);
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

  const result = await workRuntime.autoFlowIssue(session.id, {
    async run() {
      throw new Error("Worker should not run for PR readiness remediation");
    },
  });

  assert.deepEqual(markedReady, { repo: "app-api", number: 20 });
  assert.equal(result.steps.map((step) => step.status).join(","), "blocked,needs_confirmation");
  const issue = await ledger.readIssue("ISSUE-20");
  assert.equal(issue?.metadata["workflow.autoflow.current_action"], "mark_pr_ready_for_review");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
});

test("Work Runtime records evidence and documentation handoff metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-handoff-records");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-12",
    title: "Handoff records",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordEvidence(session.id, {
    issueRef: "ISSUE-12",
    summary: "Focused pytest passed.",
    source: "pixi run pytest",
  });
  await workRuntime.recordDocumentation(session.id, {
    issueRef: "ISSUE-12",
    disposition: "not_needed",
    summary: "Internal processing fix only.",
  });

  const issue = await ledger.readIssue("ISSUE-12");
  assert.equal(issue?.metadata.evidenceRecorded, true);
  assert.equal(issue?.metadata.documentationRecorded, true);
});

test("Work Runtime writes acceptance evidence back to Jira once", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const comments: Array<{ key: string; body: string }> = [];
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    jira: {
      async viewIssue(key) {
        return { key, summary: "Accepted issue", labels: [] };
      },
      async postIssueComment(key, body) {
        comments.push({ key, body });
        return { url: `https://example.atlassian.net/browse/${key}?focusedCommentId=10001`, body };
      },
    },
  });
  const session = await workRuntime.createSession("session-acceptance-writeback");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-18",
    title: "Closeout acceptance",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/18",
      prState: "OPEN",
      evidenceRecorded: true,
      evidenceSummary: "Focused pytest and PR checks passed.",
      evidenceSource: "pixi run pytest worker/tests/test_acceptance.py",
      evidenceCriteria: [
        {
          label: "Regression covered",
          status: "passed",
          evidence: "Focused pytest passed.",
          source: "worker/tests/test_acceptance.py",
        },
      ],
    },
  });

  const issue = await workRuntime.recordAcceptanceWriteback(session.id);
  const repeated = await workRuntime.recordAcceptanceWriteback(session.id);

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.key, "ISSUE-18");
  assert.match(comments[0]?.body ?? "", /Acceptance evidence recorded for PR closeout/);
  assert.match(comments[0]?.body ?? "", /Regression covered: Focused pytest passed/);
  assert.equal(issue.state, "awaiting_review");
  assert.equal(repeated.metadata["workflow.acceptance.jira_written"], true);
  assert.equal(
    repeated.metadata["workflow.acceptance.jira_comment_url"],
    "https://example.atlassian.net/browse/ISSUE-18?focusedCommentId=10001",
  );
});

test("Work Runtime honors disabled issue tracker comment capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let commentAttempts = 0;
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
        return {
          ref,
          title: "Capability issue",
          status: "In Review",
          type: "story",
          url: `https://tracker.example/${ref}`,
          labels: [],
        };
      },
      async postComment() {
        commentAttempts += 1;
        return { body: "should not post" };
      },
    },
  });
  const session = await workRuntime.createSession("session-comment-capability-disabled");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-902",
    title: "Capability writeback",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/902",
      evidenceRecorded: true,
      evidenceSummary: "Verified.",
      evidenceSource: "pytest",
    },
  });

  await assert.rejects(
    workRuntime.recordAcceptanceWriteback(session.id),
    /Jira comment writer is not configured/,
  );
  assert.equal(commentAttempts, 0);
});

test("Work Runtime accepts pure code collaboration providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: {
      capabilities: {
        canMarkReady: true,
        canPostComments: false,
        canMerge: false,
      },
      async findCodeReviews(repo, branchName) {
        assert.equal(repo, "app-api");
        assert.equal(branchName, "feature/issue-903-provider-review");
        return [
          {
            id: 903,
            repo,
            url: "https://github.com/ExampleOrg/app-api/pull/903",
            title: "ISSUE-903 provider review",
            sourceBranch: branchName,
            targetBranch: "develop",
            isDraft: false,
            isMerged: false,
            isClosed: false,
            mergeableState: "clean",
            checksPassing: true,
            state: "OPEN",
            reviewDecision: "REVIEW_REQUIRED",
            templateMissingHeadings: [],
            autoReviewStatus: "passed",
            autoReviewMustFix: false,
            autoReviewNeedsConfirmation: false,
          },
        ];
      },
    },
  });
  await ledger.writeIssue({
    ref: "ISSUE-903",
    title: "Provider review",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.branch": "feature/issue-903-provider-review",
    },
  });
  const session = await workRuntime.createSession("session-provider-collaboration");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-903",
    title: "Provider review",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.branch": "feature/issue-903-provider-review",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id, "ISSUE-903");

  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/903");
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.prChecksPassing, true);
});

test("Work Runtime closeout records evidence, merges approved PR, and verifies Jira automation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const comments: Array<{ key: string; body: string }> = [];
  let merged: { repo: string; number: number; method?: string } | undefined;
  let prMerged = false;
  let jiraReads = 0;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
      async getPullRequest(repo, number) {
        return {
          repo,
          number,
          title: "Closeout PR",
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          headRefName: "feature/ISSUE-19-closeout",
          state: prMerged ? "MERGED" : "OPEN",
          mergedAt: prMerged ? "2026-05-15T15:00:00Z" : undefined,
          mergeCommitSha: prMerged ? "abc123" : undefined,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          checksPassing: true,
          autoReviewStatus: "passed",
          autoReviewMustFix: false,
        };
      },
      async postPullRequestComment() {
        throw new Error("unexpected PR comment");
      },
      async mergePullRequest(repo, number, options) {
        merged = { repo, number, method: options?.method };
        prMerged = true;
        return {
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          mergedAt: "2026-05-15T15:00:00Z",
          mergeCommitSha: "abc123",
        };
      },
    },
    jira: {
      async viewIssue(key) {
        jiraReads += 1;
        return {
          key,
          summary: "Closeout issue",
          status: jiraReads >= 2 ? "Ready for QA" : "In Review",
          statusCategory: jiraReads >= 2 ? "Done" : "In Progress",
          labels: [],
        };
      },
      async postIssueComment(key, body) {
        comments.push({ key, body });
        return { url: `https://example.atlassian.net/browse/${key}?focusedCommentId=20002`, body };
      },
    },
  });
  const session = await workRuntime.createSession("session-closeout-after-approval");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-19",
    title: "Approved closeout",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 19,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/19",
      evidenceRecorded: true,
      evidenceSummary: "Acceptance criteria passed.",
      evidenceSource: "pixi run pytest tests/test_closeout.py",
      documentationRecorded: true,
      documentationDisposition: "not_needed",
      documentationSummary: "No user-facing docs needed.",
    },
  });

  const result = await workRuntime.closeoutAfterApproval(session.id, {
    jiraPollAttempts: 2,
    jiraPollIntervalMs: 0,
  });

  assert.equal(result.status, "merged_jira_verified");
  assert.deepEqual(merged, { repo: "app-api", number: 19, method: "squash" });
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /Acceptance evidence recorded for PR closeout/);
  assert.equal(result.acceptanceCommentUrl, "https://example.atlassian.net/browse/ISSUE-19?focusedCommentId=20002");
  assert.equal(result.jiraStatusBefore, "In Review");
  assert.equal(result.jiraStatusAfter, "Ready for QA");
  const issue = await ledger.readIssue("ISSUE-19");
  assert.equal(issue?.state, "done");
  assert.equal(issue?.metadata["workflow.closeout.status"], "merged_jira_verified");
  assert.equal(issue?.metadata["workflow.closeout.jira_verified"], true);
  assert.equal(issue?.metadata["workflow.closeout.merge_commit_sha"], "abc123");
});

test("Work Runtime records provider escalation as blocked workflow metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-provider-escalation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-16",
    title: "Provider stuck processing",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordProviderEscalation(session.id, {
    issueRef: "ISSUE-16",
    provider: "Provider",
    summary: "Provider uploaded files are stuck, but Jira has no concrete sample IDs.",
    blocker: "Need affected Provider file IDs or batch IDs before HostProject can reproduce or escalate.",
  });

  const issue = await ledger.readIssue("ISSUE-16");
  const escalation = issue?.metadata.externalProviderEscalation as Record<string, unknown> | undefined;
  assert.equal(issue?.state, "blocked");
  assert.equal(escalation?.provider, "Provider");
  assert.equal(escalation?.summary, "Provider uploaded files are stuck, but Jira has no concrete sample IDs.");
  assert.equal(
    escalation?.blocker,
    "Need affected Provider file IDs or batch IDs before HostProject can reproduce or escalate.",
  );
  assert.equal(typeof escalation?.recordedAt, "string");
});

test("Work Runtime issue selection preserves existing workflow metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-select-preserves");
  await ledger.writeIssue({
    ref: "ISSUE-17",
    title: "Existing provider blocker",
    repoKeys: ["app_api"],
    state: "blocked",
    metadata: {
      externalProviderEscalation: {
        provider: "Provider",
        summary: "Waiting on Provider samples.",
        blocker: "Need Provider batch IDs.",
        recordedAt: nowIso(),
      },
    },
  });

  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-17",
    title: "Existing provider blocker",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const issue = await ledger.readIssue("ISSUE-17");
  assert.equal(issue?.state, "selected");
  assert.deepEqual(issue?.repoKeys, ["app_api"]);
  assert.equal(
    (issue?.metadata.externalProviderEscalation as Record<string, unknown> | undefined)?.blocker,
    "Need Provider batch IDs.",
  );
});

test("Work Runtime records pull request metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-14-test",
          headSha: "abc123",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-record");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-14",
    title: "PR metadata",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });

  await workRuntime.recordPullRequest(session.id, {
    issueRef: "ISSUE-14",
    repo: "app-api",
    number: 1401,
    url: "https://github.com/ExampleOrg/app-api/pull/1401",
    isDraft: true,
  });

  const issue = await ledger.readIssue("ISSUE-14");
  assert.equal(issue?.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1401");
  assert.equal(issue?.metadata.prIsDraft, true);
  assert.equal(issue?.metadata["workflow.repos.app_api.head_sha"], "abc123");
  assert.equal(issue?.metadata["workflow.repos.app_api.dirty"], false);
});

test("Work Runtime reconciliation adopts matching pull request into Beads state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-17-test",
          headSha: "def456",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
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
    github: {
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

test("Work Runtime doctor reports visibility, blockers, and next action", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
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
            autoReviewMustFix: true,
            autoReviewMustFixDetail: "Resolve review feedback.",
          },
        ];
      },
    },
  });
  const session = await workRuntime.createSession("session-doctor");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15397",
    title: "Standardize task priority into shared constants module",
    repoKeys: [],
    state: "ready_to_run",
    metadata: {},
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.issue.repoKeys, ["public_api"]);
  assert.equal(result.visibility.repoRouting, true);
  assert.equal(result.visibility.pullRequest, true);
  assert.equal(result.visibility.preparedWorktree, false);
  assert.equal(result.review?.prUrl, "https://github.com/ExampleOrg/public-api/pull/3026");
  assert.equal(result.nextAction.type, "prepare_workspace");
  assert.equal(
    result.findings.some((finding) => finding.summary === "Auto review has must-fix feedback."),
    true,
  );
});

test("Work Runtime reconciliation adopts open issue PR when branch has changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-15607-old",
          headSha: "oldsha",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
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
    git: {
      async inspect() {
        return {
          branch: "feature/issue-15607-test",
          headSha: "abc15607",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
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

test("Work Runtime turns remediable PR review blockers into Worker requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-review-remediation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-72",
    title: "Fix review feedback",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      prUrl: "https://github.com/ExampleOrg/app-api/pull/72",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewMustFix: true,
      prAutoReviewMustFixDetail: "Keep TEMP_PATH type-compatible by assigning Path(temp_path).",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);

  assert.equal(pending.status, "needs_confirmation");
  assert.equal(pending.session.pendingConfirmation?.action, "spawn_worker");
  assert.equal(pending.session.pendingConfirmation?.summary, "Remediate PR review feedback for ISSUE-72 in app_api.");

  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "worker_requested");
  assert.match(approved.workerRequest?.prompt ?? "", /Review remediation target:/);
  assert.match(approved.workerRequest?.prompt ?? "", /Keep TEMP_PATH type-compatible/);
  const jobs = await ledger.listWorkJobs("ISSUE-72");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.remediate");
  assert.equal(approved.workerRequest?.workJobId, jobs[0].id);
});

test("Work Runtime turns failed PR checks into review remediation work", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-review-checks-remediation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-73",
    title: "Fix failed PR checks",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
      prUrl: "https://github.com/ExampleOrg/app-api/pull/73",
      prIsDraft: false,
      prChecksPassing: false,
      prAutoReviewStatus: "failed",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);

  assert.equal(pending.status, "needs_confirmation");
  assert.equal(pending.session.pendingConfirmation?.action, "spawn_worker");
  assert.match(pending.session.pendingConfirmation?.summary ?? "", /Remediate PR review feedback/);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);
  assert.equal(approved.status, "worker_requested");
  assert.match(approved.workerRequest?.prompt ?? "", /Pull request checks are not passing/);
  assert.match(approved.workerRequest?.prompt ?? "", /Auto review checks failed/);
});

test("Work Runtime records review confirmation and posts it to GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let posted: { repo: string; number: number; body: string } | undefined;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
      async postPullRequestComment(repo, number, body) {
        posted = { repo, number, body };
        return {
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}#issuecomment-1`,
          body,
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-review-confirmation");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15676",
    title: "Provider confirmation",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1402,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1402",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm Provider semantics.",
      evidenceRecorded: true,
      documentationRecorded: true,
    },
  });

  const issue = await workRuntime.recordReviewConfirmation(session.id, {
    issueRef: "ISSUE-15676",
    repo: "app-api",
    number: 1402,
    disposition: "accept",
    summary: "Confirmed from Provider docs and focused regression tests.",
    evidence: "Provider PROCESSED status plus batch status sections govern completion.",
    verification: "pixi run pytest worker/tests/services/provider/test_user_upload_batch_status.py",
  });

  assert.equal(posted?.repo, "app-api");
  assert.equal(posted?.number, 1402);
  assert.match(posted?.body ?? "", /Addressing the auto-review confirmation question for ISSUE-15676/);
  assert.match(posted?.body ?? "", /Confirmed from Provider docs and focused regression tests/);
  assert.doesNotMatch(posted?.body ?? "", /Disposition:/);
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationDisposition, "accept");
  assert.equal(
    issue.metadata.prAutoReviewNeedsConfirmationPostedUrl,
    "https://github.com/ExampleOrg/app-api/pull/1402#issuecomment-1",
  );
  assert.equal(
    issue.metadata["workflow.repos.app_api.pr_auto_review_needs_confirmation_disposition"],
    "accept",
  );

  const advanced = await workRuntime.advanceIssue(session.id);
  assert.equal(
    advanced.session.findings.some((finding) => finding.summary === "Auto review requires confirmation."),
    false,
  );
});

test("Work Runtime review confirmation replaces stale top-level PR metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
    },
  });
  const session = await workRuntime.createSession("session-review-confirmation-stale-pr");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15272",
    title: "Coverage confirmation",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 1406,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/1406",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm pixi.lock truly does not change.",
      evidenceRecorded: true,
      documentationRecorded: true,
      "workflow.repos.app_api.pr_number": 1344,
      "workflow.repos.app_api.pr_url": "https://github.com/ExampleOrg/app-api/pull/1344",
    },
  });

  const issue = await workRuntime.recordReviewConfirmation(session.id, {
    issueRef: "ISSUE-15272",
    repo: "app-api",
    number: 1344,
    disposition: "accept",
    summary: "pixi.toml changed only task command text and pixi.lock is unchanged.",
    verification: "pixi lock --check",
    githubCommentUrl: "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-1",
  });

  assert.equal(issue.metadata.prRepo, "app-api");
  assert.equal(issue.metadata.prNumber, 1344);
  assert.equal(issue.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1344");
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationPostedUrl, "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-1");
  assert.equal(
    issue.metadata["workflow.repos.app_api.pr_auto_review_needs_confirmation_posted_url"],
    "https://github.com/ExampleOrg/app-api/pull/1344#issuecomment-1",
  );
});

test("Work Runtime reconciliation refreshes existing PR metadata when draft state changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/issue-18-test",
          headSha: "def789",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
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
    git: {
      async inspect() {
        return {
          branch: "feature/issue-1407-test",
          headSha: "abc1407",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
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
    github: {
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
    git: {
      async inspect() {
        return {
          branch: "feature/ISSUE-15272-test-coverage-ci",
          headSha: "21e22d6e9759a9830564d9fc24e674c50da1b3c9",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
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

test("Work Runtime runWorker blocks cleanly when worker workspace path is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-run-worker-missing-workspace");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-19",
    title: "Missing workspace",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {},
  });

  const result = await workRuntime.runWorker(
    session.id,
    {
      id: "task-1",
      issueRef: "ISSUE-19",
      repoKey: "app_api",
      prompt: "Do work",
      createdAt: nowIso(),
    },
    {
      async run() {
        throw new Error("Worker should not run without workspace path");
      },
    },
  );

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /workspace path is missing/i);
  const runs = await workRuntime.observeWorkers(session.id);
  assert.equal(runs[0].status, "blocked");
});

test("Beads metadata keeps legacy review-ready flag aligned with phase", () => {
  const metadata = workItemToBeadsMetadata({
    ref: "ISSUE-15",
    title: "Review ready",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.app_api.head_sha": "abc123",
    },
  });

  assert.equal(metadata["workflow.phase"], "ready_for_review");
  assert.equal(metadata["workflow.ready_for_review"], true);
  assert.equal(metadata["workflow.repos.app_api.head_sha"], "abc123");
});

test("Beads metadata preserves branch kind and Jira issue type for workspace prep", () => {
  const metadata = workItemToBeadsMetadata({
    ref: "ISSUE-15720",
    title: "Partner PartnerCloud Provider Integration",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      branchKind: "feature",
      jiraIssueType: "Story",
    },
  });

  assert.equal(metadata.branchKind, "feature");
  assert.equal(metadata.jiraIssueType, "Story");
});

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
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
        body: `### JIRA Ticket or Reason for Change

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
      },
    ],
    "app-api",
  );

  assert.equal(prs[0].checksPassing, true);
  assert.equal(prs[0].headRefName, "feature/test");
  assert.equal(prs[0].state, undefined);
  assert.equal(prs[0].mergedAt, undefined);
  assert.equal(prs[0].mergeable, "MERGEABLE");
  assert.equal(prs[0].mergeStateStatus, "CLEAN");
  assert.equal(prs[0].reviewDecision, "REVIEW_REQUIRED");
  assert.equal(prs[0].templateMissingHeadings, undefined);
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
      assignees: [{ login: "codex" }],
    },
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, 12);
  assert.equal(issues[0].labels.join(","), "enhancement,main");
  assert.equal(issues[0].assignees.join(","), "codex");
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
        body: `### JIRA Ticket or Reason for Change

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
  );

  assert.deepEqual(prs[0].templateMissingHeadings, [
    "JIRA Ticket or Reason for Change",
    "Description",
    "Summary of Changes",
    "Related PRs or Issues",
  ]);
});

test("GitHub adapter parses Codex review must-fix sections", () => {
  const feedback = extractAutoReviewFeedback(`<!-- codex-pr-review -->
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

test("GitHub adapter treats empty Codex review sections as no feedback", () => {
  const feedback = extractAutoReviewFeedback(`<!-- codex-pr-review -->
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
