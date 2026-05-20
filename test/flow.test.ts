import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  configToProjectTopology,
  configToWorkTypeRegistry,
  canCompleteWork,
  canResolveBlocker,
  flowConfigSchema,
  flowEventSchema,
  JsonlFlowEventLedger,
  loadFlowConfig,
  LocalThreadExecutor,
  MemoryFlowEventLedger,
  projectWorkSubject,
  sortFlowEvents,
} from "../src/index.js";
import type { ProjectTopology } from "../src/project-topology.js";
import { parsePullRequests } from "../src/adapters/github.js";
import { currentUserOpenSprintJql, parseJiraCommentUrl, parseJiraIssue, parseJiraSearch } from "../src/adapters/jira.js";

test("Typed work contracts and registry validate supported jobs", () => {
  const workTypes = createDefaultFlowWorkTypeRegistry();
  const now = nowIso();
  const job = workJobSchema.parse({
    id: "job-1",
    issueRef: "FSB-1",
    repoKey: "fs_python",
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
    issueTracker: { type: "github" },
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
  await writeFile(join(root, "flow.config.yaml"), [
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

test("Flow Core memory event ledger appends, queries, and deduplicates events", async () => {
  const ledger = new MemoryFlowEventLedger();
  const actor = { type: "agent" as const, id: "codex" };
  const subject = { type: "issue", ref: "FSB-1" };
  const first = await ledger.append({
    primitive: "issue",
    subject,
    actor,
    input: { title: "Test" },
    idempotencyKey: "issue:FSB-1",
  });
  const duplicate = await ledger.append({
    primitive: "issue",
    subject,
    actor,
    input: { title: "Test again" },
    idempotencyKey: "issue:FSB-1",
  });
  await ledger.append({
    primitive: "claim",
    subject,
    actor,
    correlationId: "advance-1",
  });

  assert.equal(duplicate.id, first.id);
  assert.equal((await ledger.readSubject(subject)).length, 2);
  assert.equal((await ledger.query({ primitive: "claim" })).length, 1);
  assert.equal((await ledger.query({ actorId: "codex" })).length, 2);
});

test("Flow Core JSONL event ledger persists and reloads events", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-events-"));
  const path = join(root, "events.jsonl");
  const ledger = new JsonlFlowEventLedger(path);
  const subject = { type: "issue", ref: "FSB-2" };
  await ledger.append({
    primitive: "record",
    subject,
    actor: { type: "system", id: "test" },
    result: { summary: "Recorded" },
    idempotencyKey: "record:FSB-2",
  });
  await ledger.append({
    primitive: "record",
    subject,
    actor: { type: "system", id: "test" },
    result: { summary: "Duplicate ignored" },
    idempotencyKey: "record:FSB-2",
  });

  const reloaded = new JsonlFlowEventLedger(path);
  const events = await reloaded.readSubject(subject);
  assert.equal(events.length, 1);
  assert.equal(events[0].primitive, "record");
  assert.throws(() => flowEventSchema.parse({ ...events[0], primitive: "unknown" }));
});

test("Flow Core projection helpers sort events deterministically", () => {
  const events = [
    flowEventSchema.parse({
      id: "b",
      primitive: "record",
      subject: { type: "issue", ref: "FSB-3" },
      actor: { type: "system", id: "test" },
      timestamp: "2026-01-01T00:00:02.000Z",
      links: [],
    }),
    flowEventSchema.parse({
      id: "a",
      primitive: "issue",
      subject: { type: "issue", ref: "FSB-3" },
      actor: { type: "system", id: "test" },
      timestamp: "2026-01-01T00:00:01.000Z",
      links: [],
    }),
  ];
  assert.deepEqual(sortFlowEvents(events).map((event) => event.id), ["a", "b"]);
});

test("Flow Core projects work subject state from primitive events", () => {
  const subject = { type: "issue" as const, ref: "FSB-501" };
  const actor = { type: "agent" as const, id: "codex" };
  const events = [
    flowEventSchema.parse({
      id: "issue",
      primitive: "issue",
      subject,
      actor,
      timestamp: "2026-01-01T00:00:00.000Z",
      links: [],
    }),
    flowEventSchema.parse({
      id: "claim",
      primitive: "claim",
      subject,
      actor,
      timestamp: "2026-01-01T00:00:01.000Z",
      links: [],
    }),
    flowEventSchema.parse({
      id: "ask",
      primitive: "ask",
      subject,
      actor,
      timestamp: "2026-01-01T00:00:02.000Z",
      input: { summary: "Need guidance" },
      links: [],
    }),
  ];
  const blocked = projectWorkSubject(events);
  assert.equal(blocked.state, "blocked");
  assert.equal(canResolveBlocker(blocked, "ask").accepted, true);

  const resolved = projectWorkSubject([
    ...events,
    flowEventSchema.parse({
      id: "decide",
      primitive: "decide",
      subject,
      actor: { type: "human", id: "camden" },
      timestamp: "2026-01-01T00:00:03.000Z",
      input: { askEventId: "ask", decision: "approved" },
      links: [],
    }),
    flowEventSchema.parse({
      id: "pr",
      primitive: "link",
      subject,
      actor,
      timestamp: "2026-01-01T00:00:04.000Z",
      links: [{ type: "pull_request", target: { type: "pull_request", ref: "https://github.com/example/repo/pull/1" } }],
    }),
  ]);
  assert.equal(resolved.state, "review_ready");
  assert.equal(resolved.blockers[0].resolvedByEventId, "decide");
  assert.equal(canCompleteWork({ projection: resolved, codeProducing: true, readinessPassed: true }).accepted, true);
  assert.deepEqual(canCompleteWork({ projection: blocked, codeProducing: true, readinessPassed: true }).blockers, [
    "Unresolved blockers remain.",
    "Code-producing work requires a linked pull request.",
  ]);
});

test("Local thread executor advertises capabilities and returns a reportable handoff result", async () => {
  const executor = new LocalThreadExecutor();
  assert.equal(executor.executionMode, "local_thread");
  assert.equal(executor.canRun("flow.implement", ["code.edit", "test.run"]), true);
  assert.equal(executor.canRun("flow.implement", ["deploy.prod"]), false);
  const progress: string[] = [];
  const result = await executor.run({
    id: "local-1",
    issueRef: "FSB-601",
    repoKey: "fs_python",
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
issueRef: FSB-123
repoKey: fs_public_api
executionMode: local_thread
idempotencyKey: FSB-123:review
metadata:
  prNumber: 2914
---

Address only the unresolved review blockers.

- Run the smallest relevant verification.
- Return evidence.
`);

  assert.equal(envelope.workType, "flow.remediate");
  assert.equal(envelope.issueRef, "FSB-123");
  assert.equal(envelope.executionMode, "local_thread");
  assert.equal(envelope.metadata.prNumber, 2914);
  assert.match(envelope.body, /Address only the unresolved review blockers/);
});

test("Work Runtime submits work envelopes idempotently", async () => {
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root: await mkdtemp(join(tmpdir(), "flow-envelope-")) }), ledger });
  const session = await workRuntime.createSession("session-envelope-idempotency");
  await ledger.writeIssue({
    ref: "FSB-124",
    title: "Envelope idempotency",
    repoKeys: ["fs_public_api"],
    state: "ready_to_run",
    metadata: {},
  });

  const envelope = `---
workType: flow.implement
issueRef: FSB-124
repoKey: fs_public_api
executionMode: background
idempotencyKey: FSB-124:implementation
---

Implement the bounded change.
`;

  const first = await workRuntime.submitWorkEnvelope(session.id, envelope);
  const second = await workRuntime.submitWorkEnvelope(session.id, envelope);
  const jobs = await ledger.listWorkJobs("FSB-124");

  assert.equal(first.id, second.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].input.executionMode, "background");
  assert.equal(jobs[0].input.idempotencyKey, "FSB-124:implementation");
});

test("Readiness blocks failed worker results", () => {
  const assessment = assessIssue({
    issue: {
      ref: "FSB-1",
      title: "Test issue",
      repoKeys: ["fs_python"],
      state: "running",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-1",
        issueRef: "FSB-1",
        repoKey: "fs_python",
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
      ref: "FSB-11",
      title: "Needs handoff",
      repoKeys: ["fs_python"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-11",
        issueRef: "FSB-11",
        repoKey: "fs_python",
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
      ref: "FSB-12",
      title: "Retryable timeout after success",
      repoKeys: ["fs_python"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-success",
        issueRef: "FSB-12",
        repoKey: "fs_python",
        executor: "live_agent_thread",
        status: "succeeded",
        summary: "Existing Codex thread evidence is valid",
        changedFiles: [],
        testsRun: ["pixi run pytest shared/leaf/tests/test_panorama_one_click_contract.py"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-timeout",
        issueRef: "FSB-12",
        repoKey: "fs_python",
        status: "blocked",
        summary: "Pi Worker timed out or was interrupted before returning a structured result.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Pi Worker timed out or was interrupted before returning a structured result."],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/12",
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
      ref: "FSB-15272",
      title: "Coverage PR",
      repoKeys: ["fs_python"],
      state: "blocked",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-fsb-15272-implementation",
        issueRef: "FSB-15272",
        repoKey: "fs_python",
        status: "succeeded",
        summary: "Implemented coverage changes.",
        changedFiles: ["scripts/check_coverage.py"],
        testsRun: ["pixi run coverage-check"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-fsb-15272-undraft-pr1406",
        issueRef: "FSB-15272",
        repoKey: "fs_python",
        status: "blocked",
        summary: "Pi Worker could not find provider credentials.",
        changedFiles: [],
        testsRun: [],
        blockers: ["Pi Worker could not find provider credentials."],
        nextPickup: "Configure credentials, then undraft PR #1406.",
        handoffPrompt: "Convert PR https://github.com/BecksDevTeam/fs-python/pull/1406 from draft to ready for review.",
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1344",
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
      ref: "FSB-15389",
      title: "Evaluate Celery locking",
      repoKeys: ["fs_python"],
      state: "ready_to_run",
      metadata: {
        "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-fsb-15389",
      },
    },
    workerResults: [
      {
        taskId: "worker-retry-1",
        issueRef: "FSB-15389",
        repoKey: "fs_python",
        status: "blocked",
        summary: "Worker workspace path is missing for fs_python.",
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
      ref: "FSB-15738",
      title: "Review remediation",
      repoKeys: ["fs_python"],
      state: "blocked",
      metadata: {
        "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-fsb-15738",
      },
    },
    workerResults: [
      {
        taskId: "worker-fsb-15738-implementation",
        issueRef: "FSB-15738",
        repoKey: "fs_python",
        status: "succeeded",
        summary: "Implemented GeoParquet compatibility fix.",
        changedFiles: ["worker/src/services/controller_data/etl/leaf_parquet.py"],
        testsRun: ["pixi run pytest worker/tests/services/controller_data/etl/test_leaf_parquet.py"],
        blockers: [],
        completedAt: nowIso(),
      },
      {
        taskId: "worker-fsb-15738-remediate",
        issueRef: "FSB-15738",
        repoKey: "fs_python",
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
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1411",
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
      ref: "FSB-15738",
      title: "Review remediation",
      repoKeys: ["fs_python"],
      state: "human_review",
      metadata: {
        "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-fsb-15738",
        "workflow.repos.fs_python.dirty": true,
      },
    },
    workerResults: [
      {
        taskId: "worker-fsb-15738-remediate",
        issueRef: "FSB-15738",
        repoKey: "fs_python",
        status: "succeeded",
        summary: "Fixed import ordering.",
        changedFiles: ["worker/src/services/controller_data/etl/leaf_parquet.py"],
        testsRun: ["pre-commit run --files worker/src/services/controller_data/etl/leaf_parquet.py"],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1411",
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
      ref: "FSB-1393",
      title: "Merged PR",
      repoKeys: ["fs_python"],
      state: "blocked",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-1393",
        issueRef: "FSB-1393",
        repoKey: "fs_python",
        status: "succeeded",
        summary: "Implemented fix",
        changedFiles: [],
        testsRun: [],
        blockers: [],
        completedAt: nowIso(),
      },
    ],
    review: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1393",
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
      ref: "FSB-15",
      title: "Leaf needs samples",
      repoKeys: ["fs_python"],
      state: "blocked",
      metadata: {
        externalProviderEscalation: {
          provider: "Leaf",
          summary: "Leaf may need to investigate the sample files.",
          blocker: "Need affected Leaf file IDs or batch IDs.",
          recordedAt: nowIso(),
        },
      },
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.reviewReady, false);
  assert.equal(
    assessment.findings.some((finding) => finding.summary === "Blocked on Leaf escalation."),
    true,
  );
  const escalationFinding = assessment.findings.find((finding) => finding.summary === "Blocked on Leaf escalation.");
  assert.equal(escalationFinding?.detail, "Need affected Leaf file IDs or batch IDs.");
});

test("Readiness blocks draft pull requests", () => {
  const assessment = assessIssue({
    issue: {
      ref: "FSB-13",
      title: "Draft PR",
      repoKeys: ["fs_python"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-13",
        issueRef: "FSB-13",
        repoKey: "fs_python",
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
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1",
      isDraft: true,
    },
  });

  assert.equal(assessment.readyToAdvance, false);
  assert.equal(assessment.findings[0].summary, "Pull request is still draft.");
});

test("Readiness blocks pull requests missing the repo template", () => {
  const assessment = assessIssue({
    issue: {
      ref: "FSB-22",
      title: "Missing PR template",
      repoKeys: ["fs_python"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-22",
        issueRef: "FSB-22",
        repoKey: "fs_python",
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
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1402",
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
      ref: "FSB-16",
      title: "Conflicted PR",
      repoKeys: ["fs_python"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-16",
        issueRef: "FSB-16",
        repoKey: "fs_python",
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
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1",
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
      ref: "FSB-21",
      title: "Must fix PR",
      repoKeys: ["fs_public_api"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-21",
        issueRef: "FSB-21",
        repoKey: "fs_public_api",
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
      prUrl: "https://github.com/BecksDevTeam/fs-public-api/pull/2971",
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
      ref: "FSB-22",
      title: "Empty must-fix metadata",
      repoKeys: ["fs_python"],
      state: "ready_to_run",
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-22",
        issueRef: "FSB-22",
        repoKey: "fs_python",
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
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1405",
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
      ref: "FSB-23",
      title: "Needs confirmation",
      repoKeys: ["fs_python"],
      state: "ready_to_run" as const,
      metadata: {},
    },
    workerResults: [
      {
        taskId: "worker-23",
        issueRef: "FSB-23",
        repoKey: "fs_python",
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
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewNeedsConfirmation: true,
      autoReviewNeedsConfirmationDetail: "Confirm Leaf semantics.",
      autoReviewNeedsConfirmationDisposition: "accept",
    },
  });

  assert.equal(missingPost.reviewReady, false);
  assert.equal(missingPost.findings[0].summary, "Auto review confirmation has not been posted to GitHub.");

  const posted = assessIssue({
    ...base,
    review: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1402",
      isDraft: false,
      checksPassing: true,
      autoReviewStatus: "passed",
      autoReviewNeedsConfirmation: true,
      autoReviewNeedsConfirmationDetail: "Confirm Leaf semantics.",
      autoReviewNeedsConfirmationDisposition: "accept",
      autoReviewNeedsConfirmationPostedUrl: "https://github.com/BecksDevTeam/fs-python/pull/1402#issuecomment-1",
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
      ref: "FSB-18",
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
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-test");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-2",
    title: "Build workRuntime",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/fs-python-worktree",
    },
  });

  const result = await workRuntime.advanceIssue(session.id);

  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "spawn_worker");
  assert.equal(result.issue?.ref, "FSB-2");
});

test("Work Runtime does not leak findings across selected issues", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-finding-scope");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-OLD",
    title: "Old issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  const blocked = await workRuntime.advanceIssue(session.id);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.message, /Repo routing is missing/);

  const selected = await workRuntime.selectIssue(session.id, {
    ref: "FSB-NEW",
    title: "New issue",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/fs-python-worktree",
    },
  });
  const summary = await workRuntime.summarizeHandoff(session.id);

  assert.equal(selected.findings.length, 0);
  assert.match(summary, /FSB-NEW: New issue/);
  assert.doesNotMatch(summary, /Repo routing is missing/);
  assert.doesNotMatch(summary, /FSB-OLD/);
});

test("Work Runtime does not request an unknown-repo Worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-missing-route");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-19",
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
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger, projectRoot: root });
  const session = await workRuntime.createSession("session-route");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-20",
    title: "Route issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const routed = await workRuntime.routeIssue(session.id, "FSB-20", ["fs-python", "fs_python"]);
  const result = await workRuntime.advanceIssue(session.id);

  assert.deepEqual(routed.repoKeys, ["fs_python"]);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.action, "prepare_workspace");
  assert.equal(result.message, "Prepare workspace for FSB-20 in fs_python.");
});

test("Work Runtime rejects non-component repo keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger, projectRoot: root });
  const session = await workRuntime.createSession("session-route-invalid");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-20",
    title: "Route issue",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  await assert.rejects(
    workRuntime.routeIssue(session.id, "FSB-20", ["FARMserver"]),
    /No valid repo keys provided/,
  );
});

test("Work Runtime prepares workspace before Worker confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        assert.equal(plan.repoPath, "/repo/fs-python");
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
    ref: "FSB-21",
    title: "Prepare workspace",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "FSB-21", { repoKey: "fs_python" });
  const result = await workRuntime.advanceIssue(session.id);
  const confirmationId = result.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(
    prepared.metadata["workflow.repos.fs_python.worktree_path"],
    "/repo/fs-python/.worktrees/feature-fsb-21-prepare-workspace",
  );
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.session.pendingConfirmation?.payload.repoKey, "fs_python");
  assert.equal(approved.workerRequest?.workspacePath, "/repo/fs-python/.worktrees/feature-fsb-21-prepare-workspace");
  assert.match(approved.workerRequest?.prompt ?? "", /Prepared workspace: \/repo\/fs-python\/.worktrees/);
});

test("Work Runtime inspects queue from workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "FSB-5",
    title: "Queue item",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  const queue = await workRuntime.inspectQueue(1);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "FSB-5");
});

test("Work Runtime accepts pure issue tracker providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
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
          labels: ["fs-python"],
        };
      },
      async fetchActiveQueue(limit) {
        assert.equal(limit, 10);
        return [
          {
            ref: "FSB-900",
            title: "Provider queue issue",
            status: "Ready for Dev",
            statusCategory: "new",
            type: "story",
            url: "https://tracker.example/FSB-900",
            labels: ["fs-python"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "FSB-900");
  assert.equal(queue[0].title, "Provider queue issue");
  assert.deepEqual(queue[0].repoKeys, ["fs_python"]);
  assert.equal(queue[0].metadata.jiraStatus, "Ready for Dev");
});

test("Work Runtime accepts pure source control providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let preparedInput: unknown;
  const workRuntime = new FlowWorkRuntime({
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
    ref: "FSB-901",
    title: "Provider workspace",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "FSB-901", { repoKey: "fs_python" });

  assert.deepEqual(preparedInput, {
    repoPath: "/repo/fs-python",
    worktreePath: "/repo/fs-python/.worktrees/feature-fsb-901-provider-workspace",
    branch: "feature/fsb-901-provider-workspace",
    baseRef: "develop",
  });
  assert.equal(prepared.metadata["workflow.repos.fs_python.head_sha"], "provider-sha");
  assert.equal(prepared.metadata["workflow.repos.fs_python.dirty"], false);
});

test("Work Runtime bootstraps an existing Jira issue into the workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  const workRuntime = new FlowWorkRuntime({
    store,
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        assert.equal(key, "FSB-15725");
        return {
          key,
          summary: "Leaf Panorama app-key already-exists response causes start-auth 500",
          issueType: "Bug",
          status: "In Progress",
          statusCategory: "indeterminate",
          labels: ["fs-python"],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-bootstrap-jira");

  const issue = await workRuntime.bootstrapJiraIssue(session.id, "FSB-15725", {
    repoKeys: ["fs_python"],
    branch: "bug/FSB-15725-panorama-app-key-idempotent",
    worktreePath: "/repo/fs-python/.worktrees/feature-fsb-15607-validate-updated-leaf-panorama-o",
  });
  const selectedSession = await store.readSession(session.id);
  const stored = await ledger.readIssue("FSB-15725");

  assert.equal(issue.ref, "FSB-15725");
  assert.equal(issue.state, "selected");
  assert.deepEqual(issue.repoKeys, ["fs_python"]);
  assert.equal(selectedSession?.selectedIssueRef, "FSB-15725");
  assert.equal(stored?.metadata.jiraStatus, "In Progress");
  assert.equal(
    stored?.metadata["workflow.repos.fs_python.branch"],
    "bug/FSB-15725-panorama-app-key-idempotent",
  );
  assert.equal(
    stored?.metadata["workflow.repos.fs_python.worktree_path"],
    "/repo/fs-python/.worktrees/feature-fsb-15607-validate-updated-leaf-panorama-o",
  );
});

test("Work Runtime creates Jira issues through Flow without generated labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let createdInput: unknown;
  const workRuntime = new FlowWorkRuntime({
    store,
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        assert.equal(key, "FSB-15738");
        return {
          key,
          summary: "GeoParquet Leaf ETL fails on GeoArrow WKB parquet schema",
          issueType: "Bug",
          status: "Ready for Dev",
          statusCategory: "new",
          labels: [],
        };
      },
      async createIssue(input) {
        createdInput = input;
        return {
          key: "FSB-15738",
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
    summary: "GeoParquet Leaf ETL fails on GeoArrow WKB parquet schema",
    description: "Follow-up from FSB-15461.",
    repoKeys: ["fs_python"],
  });
  const selectedSession = await store.readSession(session.id);

  assert.deepEqual(createdInput, {
    projectKey: "FSB",
    issueType: "Bug",
    summary: "GeoParquet Leaf ETL fails on GeoArrow WKB parquet schema",
    description: "Follow-up from FSB-15461.",
  });
  assert.equal(issue.ref, "FSB-15738");
  assert.equal(issue.metadata.jiraIssueType, "Bug");
  assert.deepEqual(issue.metadata.jiraLabels, []);
  assert.deepEqual(issue.repoKeys, ["fs_python"]);
  assert.equal(selectedSession?.selectedIssueRef, "FSB-15738");
});

test("Work Runtime moves issues into the active Jira sprint through Flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let movedInput: unknown;
  await ledger.writeIssue({
    ref: "FSB-15730",
    title: "Prevent prescribed fixes",
    repoKeys: ["fs_flow"],
    state: "queued",
    metadata: {},
  });
  const workRuntime = new FlowWorkRuntime({
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

  const result = await workRuntime.moveIssuesToActiveSprint(session.id, ["FSB-15730"], { projectKey: "FSB" });
  const issue = await ledger.readIssue("FSB-15730");

  assert.deepEqual(movedInput, { issueKeys: ["FSB-15730"], projectKey: "FSB", boardId: undefined, sprintId: undefined });
  assert.deepEqual(result.issueKeys, ["FSB-15730"]);
  assert.equal(result.sprintId, 321);
  assert.equal(issue?.metadata.jiraSprintId, 321);
  assert.equal(issue?.metadata.jiraSprintName, "Sprint 321");
});

test("Work Runtime inspects queue from current Jira sprint before ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "FSB-15697",
    title: "Stale closed bead",
    repoKeys: ["fs_public_api"],
    state: "running",
    metadata: {
      "workflow.phase": "implementation",
    },
  });
  await ledger.writeIssue({
    ref: "FSB-15676",
    title: "Existing ledger title",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      "workflow.phase": "triage",
    },
  });

  const workRuntime = new FlowWorkRuntime({
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
            key: "FSB-15676",
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

  assert.deepEqual(queue.map((issue) => issue.ref), ["FSB-15676"]);
  assert.equal(queue[0].title, "Current sprint issue");
  assert.deepEqual(queue[0].repoKeys, ["fs_python"]);
  assert.equal(queue[0].metadata["workflow.phase"], "triage");
  assert.equal(queue[0].metadata.jiraStatus, "Ready for Dev");
  assert.equal(await ledger.readIssue("FSB-15697").then((issue) => issue?.state), "running");
  assert.equal(await ledger.readIssue("FSB-15676").then((issue) => issue?.title), "Existing ledger title");
});

test("Work Runtime inspects current-user Jira backlog separately from sprint queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "flow"), { recursive: true });
  const workRuntime = new FlowWorkRuntime({
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
            key: "FSB-15730",
            summary: "Prevent fs-ops autogenerated Jira issues from prescribing fixes",
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
  assert.equal(backlog[0].ref, "FSB-15730");
  assert.deepEqual(backlog[0].repoKeys, ["fs_flow"]);
  assert.equal(backlog[0].metadata.jiraStatus, "Ready for Dev");
});

test("Work Runtime excludes done Jira issues defensively", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
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
            key: "FSB-15697",
            summary: "Closed issue",
            status: "Closed",
            statusCategory: "done",
            resolution: "Done",
            labels: [],
          },
          {
            key: "FSB-15676",
            summary: "Current sprint issue",
            status: "In Progress",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.deepEqual(queue.map((issue) => issue.ref), ["FSB-15676"]);
  assert.equal(await ledger.readIssue("FSB-15676"), undefined);
});

test("Work Runtime lets Jira review state override stale worker phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "FSB-15382",
    title: "Stale implementation phase",
    repoKeys: ["fs_python"],
    state: "blocked",
    metadata: {
      "workflow.phase": "implementation",
      "workflow.workers.pi.fs_python.status": "blocked",
      "workflow.workers.pi.fs_python.summary": "Old worker blocker",
    },
  });

  const workRuntime = new FlowWorkRuntime({
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
            key: "FSB-15382",
            summary: "Current review issue",
            status: "In Review",
            labels: ["fs_python"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);
  const stored = await ledger.readIssue("FSB-15382");

  assert.equal(queue[0].state, "human_review");
  assert.equal(stored?.state, "blocked");
  assert.equal(stored ? workItemToBeadsMetadata(stored)["workflow.phase"] : "", "blocked");
  assert.equal(queue[0].metadata.jiraStatus, "In Review");
});

test("Work Runtime replaces invalid stale routed repo keys from Jira labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "FSB-15676",
    title: "Stale repo routing",
    repoKeys: ["FARMserver"],
    state: "queued",
    metadata: {
      "workflow.repo": "FARMserver",
    },
  });

  const workRuntime = new FlowWorkRuntime({
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
            key: "FSB-15676",
            summary: "Current sprint issue",
            status: "In Progress",
            labels: ["fs_python"],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].ref, "FSB-15676");
  assert.deepEqual(queue[0].repoKeys, ["fs_python"]);
});

test("Work Runtime infers fs_python routing from Jira summary keywords", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  await mkdir(join(root, "fs-python"), { recursive: true });
  const ledger = new MemoryWorkflowLedger();

  const workRuntime = new FlowWorkRuntime({
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
            key: "FSB-15676",
            summary: "Leaf unable to process files compared to AGI",
            status: "Ready for Dev",
            labels: [],
          },
        ];
      },
    },
  });

  const queue = await workRuntime.inspectQueue(10);

  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0].repoKeys, ["fs_python"]);
});

test("Work Runtime approval creates a worker request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-approve");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-3",
    title: "Spawn worker",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/fs-python-worktree",
    },
  });
  const pending = await workRuntime.advanceIssue(session.id);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);

  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "worker_requested");
  assert.equal(approved.workerRequest?.issueRef, "FSB-3");
  assert.ok(approved.workerRequest?.workJobId);
  assert.match(approved.workerRequest?.prompt ?? "", /Return only a JSON object/);
  const jobs = await workRuntime.listWorkJobs(session.id, "FSB-3");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.implement");
  assert.equal(jobs[0].status, "queued");
  assert.equal(approved.workerRequest?.workJobId, jobs[0].id);
});

test("Work Runtime prepares bug-prefixed branches from agent-selected branch kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const repoPath = join(root, "fs-python");
  await mkdir(repoPath, { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  let preparedBranch = "";
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    git: {
      async inspect() {
        return { branch: "bug/fsb-15738-geoparquet-leaf-etl-fails", headSha: "abc123", dirty: false, entries: [] };
      },
      async prepareWorktree(plan) {
        preparedBranch = plan.branch;
        return { branch: plan.branch, headSha: "abc123", dirty: false, entries: [] };
      },
    },
  });
  const session = await workRuntime.createSession("session-bug-branch");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-15738",
    title: "GeoParquet Leaf ETL fails on GeoArrow WKB parquet schema",
    repoKeys: ["fs_python"],
    state: "selected",
    metadata: { jiraIssueType: "Bug", branchKind: "bug" },
  });

  await workRuntime.prepareWorkspace(session.id, "FSB-15738", { repoKey: "fs_python", baseBranch: "release/2026.6.0" });

  assert.equal(preparedBranch, "bug/fsb-15738-geoparquet-leaf-etl-fails-on-geoarrow-wkb-parquet-schema");
});

test("Work Runtime blocks generated branches when branch kind is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const repoPath = join(root, "fs-python");
  await mkdir(repoPath, { recursive: true });
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
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
    ref: "FSB-15747",
    title: "Leaf upload batch completion regression",
    repoKeys: ["fs_python"],
    state: "selected",
    metadata: {},
  });

  await assert.rejects(
    workRuntime.prepareWorkspace(session.id, "FSB-15747", { repoKey: "fs_python" }),
    /branch kind is missing/,
  );
});

test("Work Runtime infers generated branch kind from Jira issue type", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let preparedBranch = "";
  const workRuntime = new FlowWorkRuntime({
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
    ref: "FSB-15720",
    title: "AgLeader AgFiniti Leaf Integration",
    repoKeys: ["fs_python"],
    state: "selected",
    metadata: { jiraIssueType: "Story" },
  });

  await workRuntime.prepareWorkspace(session.id, "FSB-15720", { repoKey: "fs_python" });

  assert.equal(preparedBranch, "feature/fsb-15720-agleader-agfiniti-leaf-integration");
});

test("Work Runtime moves Ready for Dev issue to In Progress after workspace prep", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const transitions: Array<{ key: string; status: string }> = [];
  let jiraStatus = "Ready for Dev";
  let jiraStatusCategory = "new";
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    jira: {
      async viewIssue(key) {
        return {
          key,
          summary: "AgLeader AgFiniti Leaf Integration",
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
    ref: "FSB-15720",
    title: "AgLeader AgFiniti Leaf Integration",
    repoKeys: ["fs_python"],
    state: "selected",
    metadata: {
      branchKind: "feature",
      jiraStatus: "Ready for Dev",
      jiraStatusCategory: "new",
    },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "FSB-15720", { repoKey: "fs_python" });

  assert.deepEqual(transitions, [{ key: "FSB-15720", status: "In Progress" }]);
  assert.equal(prepared.metadata.jiraStatus, "In Progress");
  assert.equal(prepared.metadata.jiraStatusCategory, "indeterminate");
});

test("Work Runtime persists worker results through the workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-ledger");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-4",
    title: "Use ledger",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-4",
    issueRef: "FSB-4",
    repoKey: "fs_python",
    status: "blocked",
    summary: "Need operator input",
    changedFiles: [],
    testsRun: [],
    blockers: ["operator input required"],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("FSB-4");
  const runs = await ledger.listWorkerRuns("FSB-4");
  const issue = await ledger.readIssue("FSB-4");
  assert.equal(results.length, 1);
  assert.equal(runs[0].status, "blocked");
  assert.equal(results[0].summary, "Need operator input");
  assert.equal(issue?.state, "blocked");
});

test("Workflow ledger upserts Worker results by task id", async () => {
  const ledger = new MemoryWorkflowLedger();
  await ledger.recordWorkerResult({
    taskId: "worker-10",
    issueRef: "FSB-10",
    repoKey: "fs_python",
    status: "blocked",
    summary: "Missing pytest",
    changedFiles: [],
    testsRun: [],
    blockers: ["pytest unavailable"],
    completedAt: nowIso(),
  });

  await ledger.recordWorkerResult({
    taskId: "worker-10",
    issueRef: "FSB-10",
    repoKey: "fs_python",
    status: "succeeded",
    summary: "Verified",
    changedFiles: [],
    testsRun: ["pixi run pytest"],
    blockers: [],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("FSB-10");
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
    ref: "FSB-88",
    title: "Mirror should not gate writes",
    repoKeys: ["fs_flow"],
    state: "selected",
    metadata: {},
  });
  const readBack = await primary.readIssue("FSB-88");

  assert.equal(stored.ref, "FSB-88");
  assert.equal(readBack?.state, "selected");
});

test("Flow workflow ledger persists records to local JSONL by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ledger-"));
  const ledger = createWorkflowLedger({ cwd: root, env: {} as NodeJS.ProcessEnv });
  await ledger.writeIssue({
    ref: "FSB-90",
    title: "Native ledger",
    repoKeys: ["fs_flow"],
    state: "queued",
    metadata: {},
  });
  await ledger.recordWorkerResult({
    taskId: "worker-90",
    issueRef: "FSB-90",
    repoKey: "fs_flow",
    status: "succeeded",
    summary: "done",
    changedFiles: [],
    testsRun: [],
    blockers: [],
    completedAt: nowIso(),
  });

  const reloaded = createWorkflowLedger({ cwd: root, env: {} as NodeJS.ProcessEnv });
  assert.equal((await reloaded.readIssue("FSB-90"))?.title, "Native ledger");
  assert.equal((await reloaded.listWorkerResults("FSB-90"))[0]?.taskId, "worker-90");
});

test("Workflow ledger upserts typed work jobs and results", async () => {
  const ledger = new MemoryWorkflowLedger();
  const now = nowIso();
  await ledger.recordWorkJob({
    id: "job-10",
    issueRef: "FSB-10",
    repoKey: "fs_python",
    workType: "flow.implement",
    status: "queued",
    input: {},
    requiredCapabilities: ["code.edit"],
    createdAt: now,
    updatedAt: now,
  });
  await ledger.recordWorkJob({
    id: "job-10",
    issueRef: "FSB-10",
    repoKey: "fs_python",
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
    issueRef: "FSB-10",
    repoKey: "fs_python",
    workType: "flow.implement",
    status: "succeeded",
    summary: "Done",
    evidence: ["npm test"],
    completedAt: nowIso(),
  });

  const jobs = await ledger.listWorkJobs("FSB-10");
  const results = await ledger.listWorkJobResults("FSB-10");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].claimedBy, "pi_worker");
  assert.equal(results.length, 1);
  assert.equal(results[0].summary, "Done");
});

test("Work Runtime records Pi Worker spawn blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-worker-blocked");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-7",
    title: "Worker blocker",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  const result = await workRuntime.runWorker(
    session.id,
    {
      id: "worker-7",
      issueRef: "FSB-7",
      repoKey: "fs_python",
      prompt: "do work",
      workspacePath: "/tmp/fs-python-worktree",
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

  const results = await ledger.listWorkerResults("FSB-7");
  const jobs = await ledger.listWorkJobs("FSB-7");
  const jobResults = await ledger.listWorkJobResults("FSB-7");
  const runs = await workRuntime.observeWorkers(session.id);
  assert.equal(result.status, "blocked");
  assert.equal(result.workJobId, jobs[0].id);
  assert.equal(jobs[0].status, "blocked");
  assert.equal(jobResults[0].jobId, jobs[0].id);
  assert.equal(jobResults[0].workerResult?.taskId, "worker-7");
  assert.equal(runs.map((run) => run.status).join(","), "blocked");
  assert.equal(results[0].blockers[0], "Pi provider is not configured");
  assert.match(results[0].handoffPrompt ?? "", /You are a local-thread executor for FARMserver Jira issue FSB-7/);
  assert.match(results[0].handoffPrompt ?? "", /Work through Flow/);
  assert.match(results[0].handoffPrompt ?? "", /First reconcile\/adopt this executor task/);
  assert.match(results[0].handoffPrompt ?? "", /real blocker or the work is review-ready/);
  assert.match(results[0].handoffPrompt ?? "", /If Flow asks for an adoption payload/);
  assert.doesNotMatch(results[0].handoffPrompt ?? "", /Direct Jira\/GitHub/);
  assert.match(results[0].handoffPrompt ?? "", /fs-python-worktree/);
});

test("Work Runtime does not create typed work while a Worker is active for the issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-active-worker-guard");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-71",
    title: "Already running",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
    },
  });
  await ledger.recordWorkerRun({
    taskId: "worker-active",
    issueRef: "FSB-71",
    repoKey: "fs_python",
    status: "running",
    workspacePath: "/tmp/fs-python-worktree",
    summary: "Worker started.",
    blockers: [],
    startedAt: nowIso(),
    updatedAt: nowIso(),
  });

  const result = await workRuntime.advanceIssue(session.id);
  const jobs = await ledger.listWorkJobs("FSB-71");
  const queue = await workRuntime.inspectDashboardQueue(10);

  assert.equal(result.status, "blocked");
  assert.match(result.message, /Worker is already running/);
  assert.equal(jobs.length, 0);
  assert.equal(queue.find((issue) => issue.ref === "FSB-71")?.workflowState, "running");
});

test("Work Runtime blocked handoff includes paste-ready local-thread executor prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-blocked-handoff-prompt");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-77",
    title: "Needs local intervention",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/fs-python-worktree",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-77",
    issueRef: "FSB-77",
    repoKey: "fs_python",
    status: "blocked",
    summary: "Worker needs human context",
    changedFiles: [],
    testsRun: [],
    blockers: ["Need operator to inspect production evidence"],
    nextPickup: "Paste the handoff prompt into a local agent thread.",
    handoffPrompt: "Take over FSB-77 from Flow.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Paste-ready local-thread executor prompt/);
  assert.match(advanced.message, /Take over FSB-77 from Flow/);
});

test("Work Runtime blocked message suppresses obsolete satisfied PR executor prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-obsolete-pr-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-15272",
    title: "Coverage PR",
    repoKeys: ["fs_python"],
    state: "blocked",
    metadata: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1344",
      prNumber: 1344,
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm pixi.lock truly does not change.",
      evidenceRecorded: true,
      documentationRecorded: true,
      "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-FSB-15272-test-coverage-ci",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-fsb-15272-undraft-pr1406",
    issueRef: "FSB-15272",
    repoKey: "fs_python",
    status: "blocked",
    summary: "Pi Worker could not find provider credentials.",
    changedFiles: [],
    testsRun: [],
    blockers: ["Pi Worker could not find provider credentials."],
    nextPickup: "Configure credentials, then undraft PR #1406.",
    handoffPrompt: "Convert PR https://github.com/BecksDevTeam/fs-python/pull/1406 from draft to ready for review.",
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
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-legacy-blocked-handoff");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-78",
    title: "Existing blocked worker",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-fsb-78",
    },
  });

  await workRuntime.recordWorkerResult(session.id, {
    taskId: "worker-78",
    issueRef: "FSB-78",
    repoKey: "fs_python",
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
  assert.match(advanced.message, /You are a local-thread executor for FARMserver Jira issue FSB-78/);
  assert.match(advanced.message, /Work through Flow/);
  assert.match(advanced.message, /First reconcile\/adopt this executor task/);
  assert.match(advanced.message, /If Flow asks for an adoption payload/);
  assert.doesNotMatch(advanced.message, /Direct Jira\/GitHub/);
  assert.match(advanced.message, /feature-fsb-78/);
  assert.match(advanced.message, /Requested work/);
});

test("Work Runtime records Worker lifecycle before and after execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-worker-lifecycle");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-8",
    title: "Lifecycle",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  let runsDuringWorker = 0;
  await workRuntime.runWorker(
    session.id,
    {
      id: "worker-8",
      issueRef: "FSB-8",
      repoKey: "fs_python",
      prompt: "do work",
      workspacePath: "/tmp/fs-python-worktree",
      createdAt: nowIso(),
    },
    {
      async run() {
        runsDuringWorker = (await ledger.listWorkerRuns("FSB-8")).length;
        return {
          taskId: "worker-8",
          issueRef: "FSB-8",
          repoKey: "fs_python",
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
  const jobs = await ledger.listWorkJobs("FSB-8");
  const jobResults = await ledger.listWorkJobResults("FSB-8");
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults[0].workerResult?.taskId, "worker-8");
});

test("Work Runtime records streamed Worker progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-worker-progress");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-9",
    title: "Progress",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.runWorker(
    session.id,
    {
      id: "worker-9",
      issueRef: "FSB-9",
      repoKey: "fs_python",
      prompt: "do work",
      workspacePath: "/tmp/fs-python-worktree",
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
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-live-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-30",
    title: "Live worker",
    repoKeys: ["fs_flow"],
    state: "queued",
    metadata: {},
  });

  const request = await workRuntime.adoptLiveWorker(
    session.id,
    {
      id: "worker-live-1",
      issueRef: "FSB-30",
      repoKey: "fs_flow",
      prompt: "Do the live-thread work",
      workspacePath: "/repo/.worktrees/feature-fsb-30-live-worker",
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
  const adoptedJobs = await ledger.listWorkJobs("FSB-30");
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
  const results = await ledger.listWorkerResults("FSB-30");
  const jobs = await ledger.listWorkJobs("FSB-30");
  const jobResults = await ledger.listWorkJobResults("FSB-30");
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
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-pending-live-worker");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-31",
    title: "Pending live worker",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-fsb-31",
    },
  });

  const request = await workRuntime.adoptPendingLiveWorker(session.id, { adopter: "codex-thread" });
  const runs = await workRuntime.observeWorkers(session.id);
  const jobs = await ledger.listWorkJobs("FSB-31");

  assert.equal(request.executor, "live_agent_thread");
  assert.equal(request.issueRef, "FSB-31");
  assert.equal(request.repoKey, "fs_python");
  assert.ok(request.workJobId);
  assert.equal(request.workspacePath, "/repo/fs-python/.worktrees/feature-fsb-31");
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
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-live-worker-result-infer-job");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-32",
    title: "Live worker result without job id",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-fsb-32",
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
    changedFiles: ["worker/tests/services/controller_data/etl/test_leaf_parquet.py"],
    testsRun: ["pixi run pytest worker/tests/services/controller_data/etl/test_leaf_parquet.py"],
    blockers: [],
    completedAt: nowIso(),
  });

  const results = await ledger.listWorkerResults("FSB-32");
  const jobs = await ledger.listWorkJobs("FSB-32");
  const jobResults = await ledger.listWorkJobResults("FSB-32");
  assert.equal(results[0].workJobId, request.workJobId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults.length, 1);
  assert.equal(jobResults[0].jobId, request.workJobId);
  assert.equal(jobResults[0].workerResult?.executor, "live_agent_thread");
});

test("Work Runtime routes and prepares fs_flow work in the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "farmserver-root-"));
  const workRuntime = new FlowWorkRuntime({
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
        assert.match(plan.worktreePath, /\.worktrees\/feature-fsb-31-flow-root-work$/);
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
    ref: "FSB-31",
    title: "Flow root work",
    repoKeys: [],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const routed = await workRuntime.routeIssue(session.id, "FSB-31", ["fs_flow"]);
  const prepared = await workRuntime.prepareWorkspace(session.id, "FSB-31", { repoKey: "fs_flow" });

  assert.deepEqual(routed.repoKeys, ["fs_flow"]);
  assert.equal(prepared.metadata["workflow.repos.fs_flow.base_branch"], "main");
  assert.equal(prepared.metadata["workflow.repos.fs_flow.worktree_path"], `${projectRoot}/.worktrees/feature-fsb-31-flow-root-work`);
});

test("Work Runtime autoflow can approve, run Worker, and stop on Readiness blocker", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-16",
    title: "Autoflow",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/fs-python-worktree",
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
  const issue = await ledger.readIssue("FSB-16");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
  assert.equal(typeof issue?.metadata["workflow.autoflow.last_attempted_at"], "string");
});

test("Work Runtime autoflow runs background executor alias used by CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow-background-alias");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-18",
    title: "Autoflow alias",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/fs-python-worktree",
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
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-autoflow-reset");
  await ledger.writeIssue({
    ref: "FSB-17",
    title: "Autoflow reset",
    repoKeys: ["fs_flow"],
    state: "blocked",
    metadata: {
      "workflow.autoflow.attempts": 3,
      "workflow.autoflow.last_attempted_at": "2026-05-15T20:00:00.000Z",
      "workflow.autoflow.current_action": "mark_pr_ready_for_review",
      "workflow.autoflow.current_action_started_at": "2026-05-15T20:00:00.000Z",
    },
  });

  const [reset] = await workRuntime.resetAutoflowState(session.id, ["FSB-17"]);

  assert.equal(reset.ref, "FSB-17");
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
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    git: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan) {
        assert.equal(plan.repoPath, "/repo/fs-python");
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
    ref: "FSB-17",
    title: "Autoflow prepare",
    repoKeys: ["fs_python"],
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
  assert.equal(result.issue?.metadata["workflow.repos.fs_python.worktree_path"], "/repo/fs-python/.worktrees/feature-fsb-17-autoflow-prepare");
});

test("Work Runtime autoflow marks draft pull requests ready before reassessing blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let markedReady: { repo: string; number: number } | undefined;
  const workRuntime = new FlowWorkRuntime({
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
          url: `https://github.com/BecksDevTeam/${repo}/pull/${number}`,
          headRefName: "feature/FSB-20-draft",
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
    ref: "FSB-20",
    title: "Draft PR",
    repoKeys: ["fs_python"],
    state: "blocked",
    metadata: {
      prRepo: "fs-python",
      prNumber: 20,
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/20",
      prIsDraft: true,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      "workflow.repos.fs_python.pr_repo": "fs-python",
      "workflow.repos.fs_python.pr_number": 20,
      "workflow.repos.fs_python.pr_url": "https://github.com/BecksDevTeam/fs-python/pull/20",
      "workflow.repos.fs_python.pr_is_draft": true,
      "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-fsb-20-draft",
    },
  });

  const result = await workRuntime.autoFlowIssue(session.id, {
    async run() {
      throw new Error("Worker should not run for PR readiness remediation");
    },
  });

  assert.deepEqual(markedReady, { repo: "fs-python", number: 20 });
  assert.equal(result.steps.map((step) => step.status).join(","), "blocked,needs_confirmation");
  const issue = await ledger.readIssue("FSB-20");
  assert.equal(issue?.metadata["workflow.autoflow.current_action"], "mark_pr_ready_for_review");
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
});

test("Work Runtime records evidence and documentation handoff metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-handoff-records");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-12",
    title: "Handoff records",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordEvidence(session.id, {
    issueRef: "FSB-12",
    summary: "Focused pytest passed.",
    source: "pixi run pytest",
  });
  await workRuntime.recordDocumentation(session.id, {
    issueRef: "FSB-12",
    disposition: "not_needed",
    summary: "Internal processing fix only.",
  });

  const issue = await ledger.readIssue("FSB-12");
  assert.equal(issue?.metadata.evidenceRecorded, true);
  assert.equal(issue?.metadata.documentationRecorded, true);
});

test("Work Runtime writes acceptance evidence back to Jira once", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const comments: Array<{ key: string; body: string }> = [];
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    jira: {
      async viewIssue(key) {
        return { key, summary: "Accepted issue", labels: [] };
      },
      async postIssueComment(key, body) {
        comments.push({ key, body });
        return { url: `https://beckshybrids.atlassian.net/browse/${key}?focusedCommentId=10001`, body };
      },
    },
  });
  const session = await workRuntime.createSession("session-acceptance-writeback");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-18",
    title: "Closeout acceptance",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/18",
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
  assert.equal(comments[0]?.key, "FSB-18");
  assert.match(comments[0]?.body ?? "", /Acceptance evidence recorded for PR closeout/);
  assert.match(comments[0]?.body ?? "", /Regression covered: Focused pytest passed/);
  assert.equal(issue.state, "review_ready");
  assert.equal(repeated.metadata["workflow.acceptance.jira_written"], true);
  assert.equal(
    repeated.metadata["workflow.acceptance.jira_comment_url"],
    "https://beckshybrids.atlassian.net/browse/FSB-18?focusedCommentId=10001",
  );
});

test("Work Runtime honors disabled issue tracker comment capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let commentAttempts = 0;
  const workRuntime = new FlowWorkRuntime({
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
    ref: "FSB-902",
    title: "Capability writeback",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/902",
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
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: {
      capabilities: {
        canMarkReady: true,
        canPostComments: false,
        canMerge: false,
      },
      async findCodeReviews(repo, branchName) {
        assert.equal(repo, "fs-python");
        assert.equal(branchName, "feature/fsb-903-provider-review");
        return [
          {
            id: 903,
            repo,
            url: "https://github.com/BecksDevTeam/fs-python/pull/903",
            title: "FSB-903 provider review",
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
    ref: "FSB-903",
    title: "Provider review",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      "workflow.repos.fs_python.branch": "feature/fsb-903-provider-review",
    },
  });
  const session = await workRuntime.createSession("session-provider-collaboration");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-903",
    title: "Provider review",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      "workflow.repos.fs_python.branch": "feature/fsb-903-provider-review",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id, "FSB-903");

  assert.equal(issue.metadata.prUrl, "https://github.com/BecksDevTeam/fs-python/pull/903");
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
  const workRuntime = new FlowWorkRuntime({
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
          url: `https://github.com/BecksDevTeam/${repo}/pull/${number}`,
          headRefName: "feature/FSB-19-closeout",
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
          url: `https://github.com/BecksDevTeam/${repo}/pull/${number}`,
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
        return { url: `https://beckshybrids.atlassian.net/browse/${key}?focusedCommentId=20002`, body };
      },
    },
  });
  const session = await workRuntime.createSession("session-closeout-after-approval");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-19",
    title: "Approved closeout",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      prRepo: "fs-python",
      prNumber: 19,
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/19",
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
  assert.deepEqual(merged, { repo: "fs-python", number: 19, method: "squash" });
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /Acceptance evidence recorded for PR closeout/);
  assert.equal(result.acceptanceCommentUrl, "https://beckshybrids.atlassian.net/browse/FSB-19?focusedCommentId=20002");
  assert.equal(result.jiraStatusBefore, "In Review");
  assert.equal(result.jiraStatusAfter, "Ready for QA");
  const issue = await ledger.readIssue("FSB-19");
  assert.equal(issue?.state, "done");
  assert.equal(issue?.metadata["workflow.closeout.status"], "merged_jira_verified");
  assert.equal(issue?.metadata["workflow.closeout.jira_verified"], true);
  assert.equal(issue?.metadata["workflow.closeout.merge_commit_sha"], "abc123");
});

test("Work Runtime records provider escalation as blocked workflow metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-provider-escalation");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-16",
    title: "Leaf stuck processing",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  await workRuntime.recordProviderEscalation(session.id, {
    issueRef: "FSB-16",
    provider: "Leaf",
    summary: "Leaf uploaded files are stuck, but Jira has no concrete sample IDs.",
    blocker: "Need affected Leaf file IDs or batch IDs before FARMserver can reproduce or escalate.",
  });

  const issue = await ledger.readIssue("FSB-16");
  const escalation = issue?.metadata.externalProviderEscalation as Record<string, unknown> | undefined;
  assert.equal(issue?.state, "blocked");
  assert.equal(escalation?.provider, "Leaf");
  assert.equal(escalation?.summary, "Leaf uploaded files are stuck, but Jira has no concrete sample IDs.");
  assert.equal(
    escalation?.blocker,
    "Need affected Leaf file IDs or batch IDs before FARMserver can reproduce or escalate.",
  );
  assert.equal(typeof escalation?.recordedAt, "string");
});

test("Work Runtime issue selection preserves existing workflow metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-select-preserves");
  await ledger.writeIssue({
    ref: "FSB-17",
    title: "Existing provider blocker",
    repoKeys: ["fs_python"],
    state: "blocked",
    metadata: {
      externalProviderEscalation: {
        provider: "Leaf",
        summary: "Waiting on Leaf samples.",
        blocker: "Need Leaf batch IDs.",
        recordedAt: nowIso(),
      },
    },
  });

  await workRuntime.selectIssue(session.id, {
    ref: "FSB-17",
    title: "Existing provider blocker",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const issue = await ledger.readIssue("FSB-17");
  assert.equal(issue?.state, "selected");
  assert.deepEqual(issue?.repoKeys, ["fs_python"]);
  assert.equal(
    (issue?.metadata.externalProviderEscalation as Record<string, unknown> | undefined)?.blocker,
    "Need Leaf batch IDs.",
  );
});

test("Work Runtime mirrors selected issues into Flow events when configured", async () => {
  const flowEvents = new MemoryFlowEventLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root: await mkdtemp(join(tmpdir(), "flow-events-")) }),
    ledger: new MemoryWorkflowLedger(),
    flowEvents: { record: async (event) => { await flowEvents.append(event); } },
  });
  const session = await workRuntime.createSession("event-session");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-401",
    title: "Mirror into Flow events",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  const events = await flowEvents.readSubject({ type: "issue", ref: "FSB-401" });
  assert.equal(events.length, 1);
  assert.equal(events[0].primitive, "claim");
  assert.equal(events[0].actor.id, "event-session");
});

test("Work Runtime treats Flow event mirroring as best-effort during migration", async () => {
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root: await mkdtemp(join(tmpdir(), "flow-events-fail-")) }),
    ledger: new MemoryWorkflowLedger(),
    flowEvents: { record: async () => { throw new Error("event store unavailable"); } },
  });
  const session = await workRuntime.createSession("event-failure-session");
  const selected = await workRuntime.selectIssue(session.id, {
    ref: "FSB-402",
    title: "Mirror failure does not block",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {},
  });

  assert.equal(selected.selectedIssueRef, "FSB-402");
});

test("Work Runtime records pull request metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/fsb-14-test",
          headSha: "abc123",
          dirty: false,
          entries: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-pr-record");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-14",
    title: "PR metadata",
    repoKeys: ["fs_python"],
    state: "queued",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
    },
  });

  await workRuntime.recordPullRequest(session.id, {
    issueRef: "FSB-14",
    repo: "fs-python",
    number: 1401,
    url: "https://github.com/BecksDevTeam/fs-python/pull/1401",
    isDraft: true,
  });

  const issue = await ledger.readIssue("FSB-14");
  assert.equal(issue?.metadata.prUrl, "https://github.com/BecksDevTeam/fs-python/pull/1401");
  assert.equal(issue?.metadata.prIsDraft, true);
  assert.equal(issue?.metadata["workflow.repos.fs_python.head_sha"], "abc123");
  assert.equal(issue?.metadata["workflow.repos.fs_python.dirty"], false);
});

test("Work Runtime reconciliation adopts matching pull request into Beads state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/fsb-17-test",
          headSha: "def456",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "fs-python");
        assert.equal(headRefName, "feature/fsb-17-test");
        return [
          {
            repo,
            number: 17,
            title: "FSB-17",
            url: "https://github.com/BecksDevTeam/fs-python/pull/17",
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
    ref: "FSB-17",
    title: "PR reconcile",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prUrl, "https://github.com/BecksDevTeam/fs-python/pull/17");
  assert.equal(issue.metadata.prNumber, 17);
  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(issue.metadata.prMergeable, "MERGEABLE");
  assert.equal(issue.metadata.prMergeStateStatus, "CLEAN");
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata.prChecksPassing, true);
  assert.equal(issue.metadata["workflow.repos.fs_python.head_sha"], "def456");
});

test("Work Runtime reconciliation discovers routing from an unrouted matching pull request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests(repo) {
        if (repo !== "fs-public-api") return [];
        return [
          {
            repo,
            number: 3026,
            title: "feat(FSB-15397): use shared flower task priorities",
            url: "https://github.com/BecksDevTeam/fs-public-api/pull/3026",
            headRefName: "feature/fsb-15397-standardize-task-priority-constants",
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
    ref: "FSB-15397",
    title: "Standardize task priority into shared constants module",
    repoKeys: [],
    state: "ready_to_run",
    metadata: {},
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.deepEqual(issue.repoKeys, ["fs_public_api"]);
  assert.equal(issue.metadata.prUrl, "https://github.com/BecksDevTeam/fs-public-api/pull/3026");
  assert.equal(issue.metadata.prNumber, 3026);
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.humanReviewRequired, true);
  assert.equal(issue.metadata["workflow.repos.fs_public_api.pr_url"], "https://github.com/BecksDevTeam/fs-public-api/pull/3026");
});

test("Work Runtime doctor reports visibility, blockers, and next action", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests(repo) {
        if (repo !== "fs-public-api") return [];
        return [
          {
            repo,
            number: 3026,
            title: "feat(FSB-15397): use shared flower task priorities",
            url: "https://github.com/BecksDevTeam/fs-public-api/pull/3026",
            headRefName: "feature/fsb-15397-standardize-task-priority-constants",
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
    ref: "FSB-15397",
    title: "Standardize task priority into shared constants module",
    repoKeys: [],
    state: "ready_to_run",
    metadata: {},
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.issue.repoKeys, ["fs_public_api"]);
  assert.equal(result.visibility.repoRouting, true);
  assert.equal(result.visibility.pullRequest, true);
  assert.equal(result.visibility.preparedWorktree, false);
  assert.equal(result.review?.prUrl, "https://github.com/BecksDevTeam/fs-public-api/pull/3026");
  assert.equal(result.nextAction.type, "prepare_workspace");
  assert.equal(
    result.findings.some((finding) => finding.summary === "Auto review has must-fix feedback."),
    true,
  );
});

test("Work Runtime reconciliation adopts open issue PR when branch has changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/fsb-15607-old",
          headSha: "oldsha",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "fs-python");
        if (headRefName) {
          assert.equal(headRefName, "feature/fsb-15607-old");
          return [];
        }
        return [
          {
            repo,
            number: 1404,
            title: "FSB-15607 fix Panorama app key environment endpoint",
            url: "https://github.com/BecksDevTeam/fs-python/pull/1404",
            headRefName: "bug/FSB-15607-panorama-app-key-env",
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
    ref: "FSB-15607",
    title: "PR branch changed",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      jiraStatus: "In Review",
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
      "workflow.repos.fs_python.pr_url": "https://github.com/BecksDevTeam/fs-python/pull/1385",
      "workflow.repos.fs_python.pr_number": 1385,
      "workflow.repos.fs_python.pr_repo": "fs-python",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prUrl, "https://github.com/BecksDevTeam/fs-python/pull/1404");
  assert.equal(issue.metadata.prNumber, 1404);
  assert.equal(issue.metadata.prIsDraft, true);
  assert.equal(issue.state, "blocked");
  assert.equal(issue.metadata["workflow.repos.fs_python.pr_url"], "https://github.com/BecksDevTeam/fs-python/pull/1404");
  assert.equal(issue.metadata["workflow.repos.fs_python.branch"], "feature/fsb-15607-old");
});

test("Work Runtime reconciliation selects blocking pull request across routed repos", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/fsb-15607-test",
          headSha: "abc15607",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(headRefName, "feature/fsb-15607-test");
        if (repo === "fs-public-api") {
          return [
            {
              repo,
              number: 2971,
              title: "FSB-15607",
              url: "https://github.com/BecksDevTeam/fs-public-api/pull/2971",
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
            number: repo === "fs-python" ? 1385 : 3178,
            title: "FSB-15607",
            url: `https://github.com/BecksDevTeam/${repo}/pull/${repo === "fs-python" ? 1385 : 3178}`,
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
    ref: "FSB-15607",
    title: "Cross-repo PR aggregate",
    repoKeys: ["fs_python", "fs_public_api", "fs_client_pwa"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
      "workflow.repos.fs_public_api.worktree_path": "/tmp/fs-public-api-worktree",
      "workflow.repos.fs_client_pwa.worktree_path": "/tmp/fs-client-pwa-worktree",
    },
  });

  const issue = await workRuntime.reconcileIssue(session.id);

  assert.equal(issue.metadata.prRepo, "fs-public-api");
  assert.equal(issue.metadata.prNumber, 2971);
  assert.equal(issue.metadata.prUrl, "https://github.com/BecksDevTeam/fs-public-api/pull/2971");
  assert.equal(issue.metadata.prAutoReviewMustFix, true);
  assert.equal(issue.metadata.prAutoReviewMustFixDetail, "New test files use // @ts-nocheck.");
  assert.equal(issue.metadata["workflow.repos.fs_client_pwa.pr_url"], "https://github.com/BecksDevTeam/fs-client-pwa/pull/3178");
});

test("Work Runtime turns remediable PR review blockers into Worker requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-review-remediation");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-72",
    title: "Fix review feedback",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/72",
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
  assert.equal(pending.session.pendingConfirmation?.summary, "Remediate PR review feedback for FSB-72 in fs_python.");

  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "worker_requested");
  assert.match(approved.workerRequest?.prompt ?? "", /Review remediation target:/);
  assert.match(approved.workerRequest?.prompt ?? "", /Keep TEMP_PATH type-compatible/);
  const jobs = await ledger.listWorkJobs("FSB-72");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.remediate");
  assert.equal(approved.workerRequest?.workJobId, jobs[0].id);
});

test("Work Runtime turns failed PR checks into review remediation work", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-review-checks-remediation");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-73",
    title: "Fix failed PR checks",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/73",
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
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        return [];
      },
      async postPullRequestComment(repo, number, body) {
        posted = { repo, number, body };
        return {
          url: `https://github.com/BecksDevTeam/${repo}/pull/${number}#issuecomment-1`,
          body,
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-review-confirmation");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-15676",
    title: "Leaf confirmation",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      prRepo: "fs-python",
      prNumber: 1402,
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1402",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm Leaf semantics.",
      evidenceRecorded: true,
      documentationRecorded: true,
    },
  });

  const issue = await workRuntime.recordReviewConfirmation(session.id, {
    issueRef: "FSB-15676",
    repo: "fs-python",
    number: 1402,
    disposition: "accept",
    summary: "Confirmed from Leaf docs and focused regression tests.",
    evidence: "Leaf PROCESSED status plus batch status sections govern completion.",
    verification: "pixi run pytest worker/tests/services/leaf/test_user_upload_batch_status.py",
  });

  assert.equal(posted?.repo, "fs-python");
  assert.equal(posted?.number, 1402);
  assert.match(posted?.body ?? "", /Addressing the auto-review confirmation question for FSB-15676/);
  assert.match(posted?.body ?? "", /Confirmed from Leaf docs and focused regression tests/);
  assert.doesNotMatch(posted?.body ?? "", /Disposition:/);
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationDisposition, "accept");
  assert.equal(
    issue.metadata.prAutoReviewNeedsConfirmationPostedUrl,
    "https://github.com/BecksDevTeam/fs-python/pull/1402#issuecomment-1",
  );
  assert.equal(
    issue.metadata["workflow.repos.fs_python.pr_auto_review_needs_confirmation_disposition"],
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
  const workRuntime = new FlowWorkRuntime({
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
    ref: "FSB-15272",
    title: "Coverage confirmation",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      prRepo: "fs-python",
      prNumber: 1406,
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1406",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      prAutoReviewNeedsConfirmation: true,
      prAutoReviewNeedsConfirmationDetail: "Confirm pixi.lock truly does not change.",
      evidenceRecorded: true,
      documentationRecorded: true,
      "workflow.repos.fs_python.pr_number": 1344,
      "workflow.repos.fs_python.pr_url": "https://github.com/BecksDevTeam/fs-python/pull/1344",
    },
  });

  const issue = await workRuntime.recordReviewConfirmation(session.id, {
    issueRef: "FSB-15272",
    repo: "fs-python",
    number: 1344,
    disposition: "accept",
    summary: "pixi.toml changed only task command text and pixi.lock is unchanged.",
    verification: "pixi lock --check",
    githubCommentUrl: "https://github.com/BecksDevTeam/fs-python/pull/1344#issuecomment-1",
  });

  assert.equal(issue.metadata.prRepo, "fs-python");
  assert.equal(issue.metadata.prNumber, 1344);
  assert.equal(issue.metadata.prUrl, "https://github.com/BecksDevTeam/fs-python/pull/1344");
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationPostedUrl, "https://github.com/BecksDevTeam/fs-python/pull/1344#issuecomment-1");
  assert.equal(
    issue.metadata["workflow.repos.fs_python.pr_auto_review_needs_confirmation_posted_url"],
    "https://github.com/BecksDevTeam/fs-python/pull/1344#issuecomment-1",
  );
});

test("Work Runtime reconciliation refreshes existing PR metadata when draft state changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/fsb-18-test",
          headSha: "def789",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "fs-python");
        assert.equal(headRefName, "feature/fsb-18-test");
        return [
          {
            repo,
            number: 18,
            title: "FSB-18",
            url: "https://github.com/BecksDevTeam/fs-python/pull/18",
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
    ref: "FSB-18",
    title: "PR refresh",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/18",
      prIsDraft: true,
      prChecksPassing: false,
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
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
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/fsb-1407-test",
          headSha: "abc1407",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "fs-python");
        assert.equal(headRefName, "feature/fsb-1407-test");
        return [
          {
            repo,
            number: 1407,
            title: "FSB-15615",
            url: "https://github.com/BecksDevTeam/fs-python/pull/1407",
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
    ref: "FSB-15615",
    title: "Tank mix override",
    repoKeys: ["fs_python"],
    state: "running",
    metadata: {
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1407",
      prIsDraft: true,
      "workflow.repos.fs_python.branch": "feature/fsb-1407-test",
      "workflow.repos.fs_python.worktree_path": "/tmp/fs-python-worktree",
    },
  });
  await ledger.recordWorkerRun({
    taskId: "worker-fsb-15615-undraft-pr1407",
    issueRef: "FSB-15615",
    repoKey: "fs_python",
    status: "running",
    summary: "Undraft PR #1407.",
    blockers: [],
    updatedAt: nowIso(),
  });

  const issue = await workRuntime.reconcileIssue(session.id);
  const runs = await ledger.listWorkerRuns("FSB-15615");

  assert.equal(issue.metadata.prIsDraft, false);
  assert.equal(runs.at(-1)?.status, "succeeded");
  assert.match(runs.at(-1)?.summary ?? "", /no longer draft/);
});

test("Work Runtime reconciliation refreshes stale recorded PR merge fields from GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    github: {
      async findPullRequests() {
        throw new Error("Recorded PR refresh should use getPullRequest");
      },
      async getPullRequest(repo, number) {
        assert.equal(repo, "fs-python");
        assert.equal(number, 1402);
        return {
          repo,
          number,
          title: "FSB-15676",
          url: "https://github.com/BecksDevTeam/fs-python/pull/1402",
          headRefName: "feature/fsb-15676-leaf-unable-to-process-files-com",
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
    ref: "FSB-15676",
    title: "Stale recorded PR",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      prRepo: "fs-python",
      prNumber: 1402,
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1402",
      prMergeable: "",
      prMergeStateStatus: "",
      prReviewDecision: "",
      "workflow.repos.fs_python.pr_repo": "fs-python",
      "workflow.repos.fs_python.pr_number": 1402,
      "workflow.repos.fs_python.pr_url": "https://github.com/BecksDevTeam/fs-python/pull/1402",
    },
  });

  const issue = await workRuntime.refreshReviewState(session.id, "FSB-15676");

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
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-pr-stale-global");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-20",
    title: "Stale aggregate PR",
    repoKeys: ["fs_public_api"],
    state: "ready_to_run",
    metadata: {
      prRepo: "fs-public-api",
      prNumber: 20,
      prUrl: "https://github.com/BecksDevTeam/fs-public-api/pull/20",
      prChecksPassing: false,
      prMergeStateStatus: "BLOCKED",
      "workflow.repos.fs_public_api.pr_repo": "fs-public-api",
      "workflow.repos.fs_public_api.pr_number": 20,
      "workflow.repos.fs_public_api.pr_url": "https://github.com/BecksDevTeam/fs-public-api/pull/20",
      "workflow.repos.fs_public_api.pr_checks_passing": true,
      "workflow.repos.fs_public_api.pr_mergeable": "MERGEABLE",
      "workflow.repos.fs_public_api.pr_merge_state_status": "CLEAN",
      "workflow.repos.fs_public_api.pr_review_decision": "APPROVED",
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
  const workRuntime = new FlowWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    git: {
      async inspect() {
        return {
          branch: "feature/FSB-15272-test-coverage-ci",
          headSha: "21e22d6e9759a9830564d9fc24e674c50da1b3c9",
          dirty: false,
          entries: [],
        };
      },
    },
    github: {
      async findPullRequests(repo, headRefName) {
        assert.equal(repo, "fs-python");
        if (headRefName === "feature/FSB-15272-test-coverage-ci") {
          return [{
            repo,
            number: 1344,
            title: "feat(FSB-15272): add local coverage delta tooling",
            url: "https://github.com/BecksDevTeam/fs-python/pull/1344",
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
        assert.equal(repo, "fs-python");
        if (number === 1406) {
          return {
            repo,
            number,
            title: "Unrelated stale PR",
            url: "https://github.com/BecksDevTeam/fs-python/pull/1406",
            headRefName: "bug/FSB-15725-panorama-app-key-idempotent",
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
    ref: "FSB-15272",
    title: "Coverage PR",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      prRepo: "fs-python",
      prNumber: 1406,
      prUrl: "https://github.com/BecksDevTeam/fs-python/pull/1406",
      prState: "MERGED",
      prMergedAt: "2026-05-13T10:00:00Z",
      "workflow.repos.fs_python.branch": "feature/FSB-15272-test-coverage-ci",
      "workflow.repos.fs_python.worktree_path": "/repo/fs-python/.worktrees/feature-FSB-15272-test-coverage-ci",
      "workflow.repos.fs_python.pr_repo": "fs-python",
      "workflow.repos.fs_python.pr_number": 1344,
      "workflow.repos.fs_python.pr_url": "https://github.com/BecksDevTeam/fs-python/pull/1344",
      "workflow.repos.fs_python.pr_auto_review_needs_confirmation_disposition": "accept",
      "workflow.repos.fs_python.pr_auto_review_needs_confirmation_posted_url": "https://github.com/BecksDevTeam/fs-python/pull/1344#issuecomment-4461307698",
    },
  });

  const issue = await workRuntime.refreshReviewState(session.id, "FSB-15272");

  assert.equal(issue.metadata.prNumber, 1344);
  assert.equal(issue.metadata.prUrl, "https://github.com/BecksDevTeam/fs-python/pull/1344");
  assert.equal(issue.metadata.prState, "OPEN");
  assert.equal(issue.metadata.prMergedAt, undefined);
  assert.equal(issue.metadata.prReviewDecision, "REVIEW_REQUIRED");
  assert.equal(issue.metadata.prAutoReviewNeedsConfirmationDisposition, "accept");
  assert.equal(
    issue.metadata.prAutoReviewNeedsConfirmationPostedUrl,
    "https://github.com/BecksDevTeam/fs-python/pull/1344#issuecomment-4461307698",
  );
});

test("Work Runtime runWorker blocks cleanly when worker workspace path is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = new FlowWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-run-worker-missing-workspace");
  await workRuntime.selectIssue(session.id, {
    ref: "FSB-19",
    title: "Missing workspace",
    repoKeys: ["fs_python"],
    state: "ready_to_run",
    metadata: {},
  });

  const result = await workRuntime.runWorker(
    session.id,
    {
      id: "task-1",
      issueRef: "FSB-19",
      repoKey: "fs_python",
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
    ref: "FSB-15",
    title: "Review ready",
    repoKeys: ["fs_python"],
    state: "review_ready",
    metadata: {
      "workflow.repos.fs_python.head_sha": "abc123",
    },
  });

  assert.equal(metadata["workflow.phase"], "ready_for_review");
  assert.equal(metadata["workflow.ready_for_review"], true);
  assert.equal(metadata["workflow.repos.fs_python.head_sha"], "abc123");
});

test("Beads metadata preserves branch kind and Jira issue type for workspace prep", () => {
  const metadata = workItemToBeadsMetadata({
    ref: "FSB-15720",
    title: "AgLeader AgFiniti Leaf Integration",
    repoKeys: ["fs_python"],
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
    key: "FSB-6",
    fields: {
      summary: "Adapter test",
      issuetype: { name: "Bug" },
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      resolution: { name: "Unresolved" },
      assignee: { displayName: "Camden Lowrance" },
      labels: ["fs_python"],
      updated: "2026-05-11T12:00:00.000-0400",
    },
  });

  assert.equal(issue.key, "FSB-6");
  assert.equal(issue.summary, "Adapter test");
  assert.equal(issue.issueType, "Bug");
  assert.equal(issue.status, "In Progress");
  assert.equal(issue.statusCategory, "indeterminate");
  assert.equal(issue.resolution, "Unresolved");
});

test("Jira adapter parses comment URL JSON", () => {
  assert.equal(
    parseJiraCommentUrl({ comment: { self: "https://beckshybrids.atlassian.net/rest/api/3/comment/10001" } }),
    "https://beckshybrids.atlassian.net/rest/api/3/comment/10001",
  );
});

test("Jira adapter parses workitem search JSON", () => {
  const issues = parseJiraSearch({
    values: [
      {
        key: "FSB-7",
        fields: {
          summary: "Search result",
          status: { name: "Ready for Dev" },
          labels: ["fs_public_api"],
        },
      },
    ],
  });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, "FSB-7");
  assert.equal(issues[0].summary, "Search result");
});

test("Jira adapter queue query includes active dev and review work only", () => {
  assert.equal(
    currentUserOpenSprintJql(),
    "project = FSB AND assignee = currentUser() AND sprint in openSprints() AND status in ('Ready for Dev', 'In Progress', 'In Review')",
  );
});

test("Beads ledger issue update includes title and description", () => {
  assert.deepEqual(
    beadUpdateArgsForIssue("fsb-1", {
      title: "Current Jira title",
      summary: "Current Jira summary",
    }),
    ["update", "fsb-1", "--title", "Current Jira title", "--description", "Current Jira summary", "--allow-empty-description"],
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

FSB-1

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
    "fs-python",
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

test("GitHub adapter parses merged pull request lifecycle fields", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1393,
        title: "FSB-15594",
        url: "https://github.com/BecksDevTeam/fs-python/pull/1393",
        headRefName: "feature/fsb-15594",
        state: "MERGED",
        mergedAt: "2026-05-11T19:11:01Z",
        isDraft: false,
        body: `### JIRA Ticket or Reason for Change

FSB-15594

### Description
- [x] Bug Fix

### Summary of Changes
Changed code.

### Related PRs or Issues
None.`,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      },
    ],
    "fs-python",
  );

  assert.equal(prs[0].state, "MERGED");
  assert.equal(prs[0].mergedAt, "2026-05-11T19:11:01Z");
});

test("GitHub adapter flags pull requests missing template headings", () => {
  const prs = parsePullRequests(
    [
      {
        number: 1402,
        title: "FSB-15676",
        url: "https://github.com/BecksDevTeam/fs-python/pull/1402",
        headRefName: "feature/fsb-15676",
        isDraft: false,
        body: `## Summary
- Harden Leaf batch handling.

## Validation
- pytest`,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ],
    "fs-python",
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

  const workRuntime = new FlowWorkRuntime({
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
