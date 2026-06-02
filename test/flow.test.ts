import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import express, { type Express } from "express";

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
  createWorkflowLedger,
  verifyJsonlWorkflowLedger,
  bootstrapFlowConfig,
  configToProjectTopology,
  configToWorkTypeRegistry,
  flowConfigPath,
  flowContextProjectionPath,
  flowIssueProjectionFileName,
  flowIssueProjectionPath,
  flowContextRecordSchema,
  flowUserConfigPath,
  flowUserContextProjectionPath,
  flowUserIssueProjectionPath,
  flowUserRuntimePath,
  flowUserStateRoot,
  flowUserWorkflowLedgerDatabasePath,
  flowUserWorkflowLedgerPath,
  flowWorkflowLedgerPath,
  resolveFlowPath,
  resolveCliIssue,
  canClaimWork,
  canCompleteWork,
  canResolveBlocker,
  existingString,
  flowConfigSchema,
  mapWithConcurrency,
  loadFlowConfig,
  migrateFlowConfig,
  metadataBoolean,
  metadataNumber,
  metadataStringArray,
  metadataValueEquals,
  normalizeRepoKey,
  normalizeRepoKeys,
  validateFlowConfig,
  createConfiguredWorkRuntime,
  createId,
  LocalThreadExecutor,
  LocalIssueTrackerAdapter,
  NoopCodeCollaborationAdapter,
  AutoflowService,
  StandaloneAutoflowRunner,
  ReconciliationEngine,
  ProviderAdapterError,
  classifyProviderCliError,
  GitAdapter,
  triageIssues as triageIssuesEngine,
  type CreateIssueOptions,
  type ProjectedWorkSubject,
  type WorkItem,
} from "../src/index.js";
import { JsonCliError, runJsonCli, type JsonCliOptions } from "../src/json-cli.js";
import {
  requireWorkItem,
  requireCreateIssueOptions,
  requireWorkJobExecutor,
  requireWorkJobResult,
} from "../src/dispatch-validators.js";
import type { ProjectTopology } from "../src/project-topology.js";
import { githubIssueCreateBody, normalizePullRequest, parseGitHubIssues, parsePullRequests } from "../src/adapters/github.js";
import { currentUserBacklogJql, currentUserOpenSprintJql, parseJiraCommentUrl, parseJiraIssue, parseJiraSearch } from "../src/adapters/jira.js";
import { testWorkRuntime, configString, legacyHostConfig, legacyHostTopology, execFileAsync } from "./helpers/test-fixtures.js";
import { DesktopActionRouter, isDesktopAction } from "../desktop/action-router.js";
import { desktopActionValues } from "../desktop/action-types.js";
import { LruMap } from "../desktop/lru-map.js";
import {
  desktopAutoflowReconcileIntervals,
  nextAutoflowReconcileDelay,
  runEnabledProjectAutoflowReconcile,
} from "../desktop/autoflow-reconcile.js";
import { PiSessionDriver } from "../src/pi-session-driver.js";
import { FLOW_PI_AGENT_TOOLS, PiSdkSessionRunner, childRunnerSource } from "../src/pi-sdk-runner.js";
import { ClaudeAgentRunner } from "../src/claude-agent-runner.js";
import { ClaudeSessionDriver } from "../src/claude-session-driver.js";
import { DesktopProjectRegistry } from "../desktop/project-registry.js";
import type { DesktopProjectRecord } from "../desktop/project-registry.js";
import type { DesktopProjectSurface } from "../desktop/route-types.js";
import { DesktopPromptRouter } from "../desktop/prompt-router.js";
import { defaultDesktopRefreshIntervals, desktopRefreshIntervalsFromSettings } from "../desktop/renderer/refresh-settings.js";
import { registerWorkRoutes } from "../desktop/work-routes.js";
import { registerStaticRoutes } from "../desktop/static-routes.js";
import { projectThemeFor } from "../src/theme/project-theme.js";


function desktopProjectRecordStub(input: Partial<DesktopProjectRecord>): DesktopProjectRecord {
  return {
    id: input.id ?? "project",
    root: input.root ?? "/tmp/project",
    name: input.name ?? input.id ?? "project",
    configPath: input.configPath ?? "/tmp/project/.flow/config.yaml",
    valid: input.valid ?? true,
    addedAt: input.addedAt ?? "2026-05-31T00:00:00.000Z",
    lastOpenedAt: input.lastOpenedAt ?? "2026-05-31T00:00:00.000Z",
    icon: input.icon,
    error: input.error,
  };
}

function desktopProjectRegistryStub(projects: DesktopProjectRecord[]): DesktopProjectRegistry {
  return {
    listProjects: async () => projects,
    activeProject: async () => projects.find((project) => project.valid) ?? projects[0],
  } as unknown as DesktopProjectRegistry;
}

class MemoryAutoflowRunnerState {
  private readonly values = new Map<string, unknown>();

  async getProjectState<T = unknown>(projectId: string, key: string): Promise<T | undefined> {
    return this.values.get(`${projectId}:${key}`) as T | undefined;
  }

  async setProjectState(projectId: string, key: string, value: unknown): Promise<void> {
    this.values.set(`${projectId}:${key}`, value);
  }
}

function desktopProjectSurfaceStub(
  queue: Pick<WorkItem, "ref" | "state">[],
  tick: () => void | Promise<void> = () => {},
  autoflowEnabled = true,
): DesktopProjectSurface {
  return {
    configured: {
      runtime: {
        inspectQueue: async () => queue,
      },
    },
    autoflowRunner: {
      status: async () => ({
        enabled: autoflowEnabled,
        maxConcurrency: 5,
        activeCount: 0,
        issues: {},
        summary: autoflowEnabled ? "Autoflow idle." : "Autoflow is paused.",
        updatedAt: nowIso(),
      }),
      tick: async () => {
        await tick();
        return {
          enabled: autoflowEnabled,
          maxConcurrency: 5,
          activeCount: 0,
          issues: {},
          summary: "Autoflow idle.",
          updatedAt: nowIso(),
        };
      },
    },
  } as unknown as DesktopProjectSurface;
}

async function listenExpress(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolveServer, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolveServer(listener));
    listener.on("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

async function approveIssueIntake(
  runtime: FlowWorkRuntime,
  sessionId: string,
  options: CreateIssueOptions,
): Promise<void> {
  const intake = await runtime.intakeIssue(sessionId, { ...options, dryRun: true });
  const reviewJob = intake.reviewJob;
  if (!reviewJob) assert.fail("expected issue intake review job");
  await runtime.recordWorkJobResult(sessionId, {
    jobId: reviewJob.id,
    issueRef: reviewJob.issueRef,
    repoKey: reviewJob.repoKey,
    workType: reviewJob.workType,
    status: "succeeded",
    summary: "Executor approved issue intake.",
    evidence: ["Executor reviewed duplicate candidates."],
    completedAt: nowIso(),
  });
}

async function commandPath(command: string): Promise<string> {
  const finder = process.platform === "win32" ? "where" : "which";
  const { stdout } = await execFileAsync(finder, [command]);
  const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) throw new Error(`Could not resolve ${command}.`);
  return first;
}

async function captureJsonCli(
  argv: string[],
  options: {
    stdin?: NodeJS.ReadableStream;
    route?: JsonCliOptions["route"];
  } = {},
): Promise<{ exitCode: string | number | undefined; payload: any; routeCalls: number }> {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalWrite = process.stdout.write;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  let output = "";
  let routeCalls = 0;

  process.argv = ["node", "flow", ...argv];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  if (options.stdin) {
    Object.defineProperty(process, "stdin", { value: options.stdin, configurable: true });
  }

  try {
    await runJsonCli({
      manifest: () => ({ targets: [] }),
      route: async (request, context) => {
        routeCalls += 1;
        if (options.route) return options.route(request, context);
        return { ok: true };
      },
    });
    return {
      exitCode: process.exitCode,
      payload: parseCapturedJsonCliOutput(output),
      routeCalls,
    };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stdout.write = originalWrite;
    if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
  }
}

function parseCapturedJsonCliOutput(output: string): any {
  const start = output.indexOf('{"ok"');
  if (start === -1) {
    throw new Error(`JSON CLI did not write a response envelope: ${JSON.stringify(output)}`);
  }
  const end = output.indexOf("\n", start);
  const json = end === -1 ? output.slice(start) : output.slice(start, end);
  return JSON.parse(json);
}

function projectedWorkSubject(overrides: Partial<ProjectedWorkSubject> = {}): ProjectedWorkSubject {
  return {
    subject: { type: "issue", ref: "GH-266" },
    state: "queued",
    claims: [],
    blockers: [],
    links: [],
    records: [],
    handoffs: [],
    ...overrides,
  };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  assert.fail("Timed out waiting for condition.");
}

test("Flow layout paths resolve under the project root", () => {
  const root = join(tmpdir(), "Flow Root With Spaces");

  assert.equal(flowConfigPath(root), join(resolve(root), ".flow", "config.yaml"));
  assert.equal(flowWorkflowLedgerPath(root), join(resolve(root), ".flow", "ledger", "workflow.jsonl"));
  assert.equal(flowContextProjectionPath(root), join(resolve(root), ".flow", "ledger", "context.json"));
  assert.equal(flowIssueProjectionPath(root, "GH-267"), join(resolve(root), ".flow", "ledger", "issues", "GH-267.json"));
});

test("Flow layout sanitizes special characters in issue projection refs", () => {
  const root = join(tmpdir(), "flow-layout-special");
  const issueRef = "GH/267:bad?name*with spaces";
  const expectedFileName = "GH_267_bad_name_with_spaces";

  assert.equal(flowIssueProjectionFileName(issueRef), expectedFileName);
  assert.equal(flowIssueProjectionPath(root, issueRef), join(resolve(root), ".flow", "ledger", "issues", `${expectedFileName}.json`));
  assert.equal(flowUserIssueProjectionPath(root, issueRef), join(flowUserStateRoot(root), "ledger", "issues", `${expectedFileName}.json`));
});

test("Flow layout uses a stable fallback file name for empty issue refs", () => {
  const root = join(tmpdir(), "flow-layout-empty-ref");

  assert.equal(flowIssueProjectionFileName(""), "issue");
  assert.equal(flowIssueProjectionFileName("///"), "___");
  assert.equal(flowIssueProjectionPath(root, ""), join(resolve(root), ".flow", "ledger", "issues", "issue.json"));
});

test("Flow user state root includes the project basename and truncated SHA-256 digest", () => {
  const root = resolve(join(tmpdir(), "flow layout digest"));
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const userStateRoot = flowUserStateRoot(root);

  assert.equal(basename(userStateRoot), `${basename(root)}-${digest}`);
  assert.equal(digest.length, 16);
  assert.equal(flowUserConfigPath(root), join(userStateRoot, "config.yaml"));
  assert.equal(flowUserRuntimePath(root), join(userStateRoot, "runtime"));
  assert.equal(flowUserWorkflowLedgerPath(root), join(userStateRoot, "ledger", "workflow.jsonl"));
  assert.equal(flowUserWorkflowLedgerDatabasePath(root), join(userStateRoot, "ledger", "workflow.db"));
  assert.equal(flowUserContextProjectionPath(root), join(userStateRoot, "ledger", "context.json"));
});

test("Flow path resolver keeps absolute paths and resolves relative paths from the project root", () => {
  const root = resolve(join(tmpdir(), "flow-layout-resolve"));
  const absolute = join(root, "outside", "config.yaml");

  assert.equal(resolveFlowPath(root, absolute), absolute);
  assert.equal(resolveFlowPath(root, join(".flow", "config.yaml")), flowConfigPath(root));
  assert.equal(resolveFlowPath(root, "config.yaml"), join(root, "config.yaml"));
});

test("Work state policy allows completion when blockers and readiness are clear", () => {
  const projection = projectedWorkSubject();

  assert.deepEqual(canCompleteWork({ projection }), { accepted: true, blockers: [] });
  assert.deepEqual(canCompleteWork({ projection, readinessPassed: true }), { accepted: true, blockers: [] });
});

test("Work state policy blocks completion for unresolved blockers", () => {
  const projection = projectedWorkSubject({
    blockers: [{
      eventId: "ask-1",
      actorId: "executor",
      askedAt: nowIso(),
    }],
  });

  assert.deepEqual(canCompleteWork({ projection }), {
    accepted: false,
    blockers: ["Unresolved blockers remain."],
  });
});

test("Work state policy requires linked pull requests for code-producing completion", () => {
  const projection = projectedWorkSubject();
  const linkedProjection = projectedWorkSubject({
    links: [{
      eventId: "link-1",
      type: "code_review",
      target: { type: "pull_request", ref: "https://github.com/camden-lowrance/flow/pull/266" },
      linkedAt: nowIso(),
    }],
  });

  assert.deepEqual(canCompleteWork({ projection, codeProducing: true }), {
    accepted: false,
    blockers: ["Code-producing work requires a linked pull request."],
  });
  assert.deepEqual(canCompleteWork({ projection: linkedProjection, codeProducing: true }), { accepted: true, blockers: [] });
});

test("Work state policy blocks completion when readiness has failed", () => {
  const projection = projectedWorkSubject();

  assert.deepEqual(canCompleteWork({ projection, readinessPassed: false }), {
    accepted: false,
    blockers: ["Readiness checks have not passed."],
  });
});

test("Work state policy reports every completion blocker together", () => {
  const projection = projectedWorkSubject({
    blockers: [{
      eventId: "ask-1",
      actorId: "executor",
      askedAt: nowIso(),
    }],
  });

  assert.deepEqual(canCompleteWork({ projection, codeProducing: true, readinessPassed: false }), {
    accepted: false,
    blockers: [
      "Unresolved blockers remain.",
      "Code-producing work requires a linked pull request.",
      "Readiness checks have not passed.",
    ],
  });
});

test("Work state policy allows claims for unclaimed work and optional parallel claims", () => {
  const claimed = projectedWorkSubject({
    state: "running",
    claims: [{
      eventId: "claim-1",
      actorId: "executor",
      claimedAt: nowIso(),
    }],
  });

  assert.deepEqual(canClaimWork(projectedWorkSubject()), { accepted: true, blockers: [] });
  assert.deepEqual(canClaimWork(claimed, { allowParallelClaims: true }), { accepted: true, blockers: [] });
});

test("Work state policy blocks claims for completed or actively claimed work", () => {
  const completed = projectedWorkSubject({ state: "done", completedAt: nowIso(), completedByEventId: "done-1" });
  const claimed = projectedWorkSubject({
    state: "running",
    claims: [{
      eventId: "claim-1",
      actorId: "executor",
      claimedAt: nowIso(),
    }],
  });

  assert.deepEqual(canClaimWork(completed), {
    accepted: false,
    blockers: ["Work is already complete."],
  });
  assert.deepEqual(canClaimWork(claimed), {
    accepted: false,
    blockers: ["An active claim already exists."],
  });
});

test("Work state policy resolves only existing unresolved blockers", () => {
  const projection = projectedWorkSubject({
    blockers: [
      {
        eventId: "ask-open",
        actorId: "executor",
        askedAt: nowIso(),
      },
      {
        eventId: "ask-resolved",
        actorId: "executor",
        askedAt: nowIso(),
        resolvedByEventId: "resolve-1",
        resolvedAt: nowIso(),
      },
    ],
  });

  assert.deepEqual(canResolveBlocker(projection, "ask-open"), { accepted: true, blockers: [] });
  assert.deepEqual(canResolveBlocker(projection, "ask-missing"), {
    accepted: false,
    blockers: ["No blocker exists for ask event ask-missing."],
  });
  assert.deepEqual(canResolveBlocker(projection, "ask-resolved"), {
    accepted: false,
    blockers: ["Blocker ask-resolved is already resolved."],
  });
});

test("Runtime utils normalize repo keys and remove duplicates", () => {
  assert.equal(normalizeRepoKey("web-app"), "web_app");
  assert.equal(normalizeRepoKey("Flow App/API"), "Flow_App_API");
  assert.equal(normalizeRepoKey("already_valid_123"), "already_valid_123");

  assert.deepEqual(normalizeRepoKeys([" web-app ", "web_app", "", "api/service", "api_service"]), ["web_app", "api_service"]);
});

test("Runtime utils return only existing non-empty strings", () => {
  assert.equal(existingString("value"), "value");
  assert.equal(existingString(""), undefined);
  assert.equal(existingString(123), undefined);
  assert.equal(existingString(null), undefined);
});

test("Runtime utils parse metadata booleans", () => {
  assert.equal(metadataBoolean(true), true);
  assert.equal(metadataBoolean("true"), true);
  assert.equal(metadataBoolean("1"), true);
  assert.equal(metadataBoolean(false), false);
  assert.equal(metadataBoolean("false"), false);
  assert.equal(metadataBoolean("0"), false);
  assert.equal(metadataBoolean("yes"), undefined);
});

test("Runtime utils parse metadata numbers", () => {
  assert.equal(metadataNumber(12), 12);
  assert.equal(metadataNumber("12.5"), 12.5);
  assert.equal(metadataNumber(""), 0);
  assert.equal(metadataNumber("not-a-number"), undefined);
  assert.equal(metadataNumber(Number.POSITIVE_INFINITY), undefined);
});

test("Runtime utils parse metadata string arrays", () => {
  assert.deepEqual(metadataStringArray(["one", 2, "", false]), ["one", "2", "false"]);
  assert.deepEqual(metadataStringArray('["one","two",""]'), ["one", "two"]);
  assert.deepEqual(metadataStringArray("one, two, , three"), ["one", "two", "three"]);
  assert.equal(metadataStringArray(""), undefined);
  assert.equal(metadataStringArray("{\"not\":\"array\"}"), undefined);
  assert.equal(metadataStringArray(123), undefined);
});

test("Runtime utils compare metadata values", () => {
  assert.equal(metadataValueEquals("same", "same"), true);
  assert.equal(metadataValueEquals(1, "1"), false);
  assert.equal(metadataValueEquals(["a", "b"], ["a", "b"]), true);
  assert.equal(metadataValueEquals(["a", "b"], ["b", "a"]), false);
  assert.equal(metadataValueEquals(undefined, []), true);
});

test("Runtime utils mapWithConcurrency preserves result order and limits active work", async () => {
  const started: number[] = [];
  const release: Array<(() => void) | undefined> = [];
  const work = mapWithConcurrency([10, 20, 30], 2, async (item, index) => {
    started.push(index);
    await new Promise<void>((resolvePromise) => {
      release[index] = resolvePromise;
    });
    return item * 2;
  });

  await waitForCondition(() => started.length === 2);
  assert.deepEqual(started, [0, 1]);

  release[0]?.();
  await waitForCondition(() => started.length === 3);
  assert.deepEqual(started, [0, 1, 2]);

  release[1]?.();
  release[2]?.();
  assert.deepEqual(await work, [20, 40, 60]);
});

test("Runtime utils mapWithConcurrency handles empty input and coerces low concurrency to one worker", async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async (item: number) => item), []);

  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    active -= 1;
    return item + 1;
  });

  assert.deepEqual(results, [2, 3, 4]);
  assert.equal(maxActive, 1);
});

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
  assert.equal(workTypes.executorCanRun("live_agent_thread", job.workType, job.requiredCapabilities), true);
  assert.equal(workTypes.executorCanRun("background_worker", job.workType, job.requiredCapabilities), false);
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

test("createId uses UUID-backed identifiers with the requested prefix", () => {
  const id = createId("worker");

  assert.match(id, /^worker-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("Flow config schema validates topology and adapter declarations", () => {
  const config = flowConfigSchema.parse({
    version: "1",
    project: { name: "Example", icon: "./assets/example.svg" },
    topology: {
      repos: {
        main: { name: "example", baseBranch: "main" },
      },
      issueInference: [{ repo: "main", keywords: ["frontend"] }],
    },
    issueTracker: { type: "github", owner: "example", repo: "example" },
    collaboration: { type: "github", owner: "example" },
    runtime: { store: { type: "sqlite" } },
  });

  assert.equal(config.project.name, "Example");
  assert.equal(config.project.icon, "./assets/example.svg");
  assert.equal(config.issueTracker?.type, "github");
  assert.equal(config.runtime?.store?.type, "sqlite");
  assert.equal(config.topology.issueInference[0].repo, "main");

  const localConfig = flowConfigSchema.parse({
    version: "1",
    project: { name: "Local Example" },
    topology: {
      repos: {
        main: { name: "example", baseBranch: "main" },
      },
    },
    issueTracker: { type: "local", prefix: "LOCAL" },
    collaboration: { type: "none" },
    sourceControl: { type: "git" },
    ledger: { type: "flow" },
  });
  assert.equal(localConfig.issueTracker?.type, "local");
  assert.equal(localConfig.collaboration?.type, "none");

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
  assert.throws(() =>
    flowConfigSchema.parse({
      version: "1",
      project: { name: "Bad branch pattern" },
      topology: {
        repos: { main: { name: "example" } },
        branchPattern: "feature/{slug}",
      },
    }),
    /branchPattern must include/,
  );
  assert.throws(() =>
    flowConfigSchema.parse({
      version: "1",
      project: { name: "Bad GitHub labels" },
      topology: {
        repos: { main: { name: "example" } },
      },
      issueTracker: { type: "github", owner: "example", repo: "example", activeLabels: ["ready", ""] },
    }),
    /activeLabels must be an array/,
  );
  assert.throws(() =>
    flowConfigSchema.parse({
      version: "1",
      project: { name: "Bad store" },
      topology: {
        repos: { main: { name: "example" } },
      },
      runtime: { store: { type: "postgres" } },
    }),
    /Invalid option/,
  );
});

test("Flow config loader reads YAML and builds topology", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
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
  assert.equal(topology.repoPath(root, "api"), `${root.replace(/\\/g, "/")}/services/api`);
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

test("Flow config validator returns machine-readable diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
    'version: "1"',
    "project:",
    '  name: "Broken"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '  branchPattern: "feature/{slug}"',
  ].join("\n"), "utf8");

  const result = await validateFlowConfig({ projectRoot: root });

  assert.equal(result.ok, false);
  assert.equal(result.path, flowConfigPath(root));
  assert.match(result.errors.join("\n"), /branchPattern must include/);
  assert.equal(result.config, undefined);
});

test("Flow config migrate reports current version as no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-migrate-current-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
    'version: "1"',
    "project:",
    '  name: "Example"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '      baseBranch: "main"',
    "",
  ].join("\n"), "utf8");

  const result = await migrateFlowConfig({ projectRoot: root });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.wrote, false);
  assert.equal(result.fromVersion, "1");
  assert.equal(result.toVersion, "1");
  assert.equal(result.errors.length, 0);
});

test("Flow config migrate can add missing version metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-config-migrate-versionless-"));
  await mkdir(dirname(flowConfigPath(root)), { recursive: true });
  await writeFile(flowConfigPath(root), [
    "project:",
    '  name: "Example"',
    "topology:",
    "  repos:",
    "    main:",
    '      name: "example"',
    '      baseBranch: "main"',
    "",
  ].join("\n"), "utf8");

  const preview = await migrateFlowConfig({ projectRoot: root });
  assert.equal(preview.ok, true);
  assert.equal(preview.changed, true);
  assert.equal(preview.wrote, false);
  assert.equal(preview.fromVersion, "0");
  assert.equal(preview.toVersion, "1");

  const beforeWrite = await readFile(flowConfigPath(root), "utf8");
  assert.equal(beforeWrite.includes('version: "1"'), false);

  const written = await migrateFlowConfig({ projectRoot: root, write: true });
  assert.equal(written.ok, true);
  assert.equal(written.changed, true);
  assert.equal(written.wrote, true);

  const afterWrite = await readFile(flowConfigPath(root), "utf8");
  assert.match(afterWrite, /version:\s*"1"/);

  const validation = await validateFlowConfig({ projectRoot: root });
  assert.equal(validation.ok, true);
});

test("Flow config bootstrap creates hidden user-state config by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-"));
  const home = await mkdtemp(join(tmpdir(), "flow-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await bootstrapFlowConfig({ projectRoot: root });

    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.storage, "user");
    assert.equal(result.path, flowUserConfigPath(root));
    assert.equal(result.repoName, result.projectName);

    const config = await loadFlowConfig({ projectRoot: root });
    assert.ok(config);
    assert.equal(config.project.name, result.projectName);
    assert.equal(config.topology.repos.main.name, result.repoName);
    assert.equal(config.topology.repos.main.baseBranch, "main");
    assert.equal(config.issueTracker?.type, "local");
    assert.equal(config.collaboration?.type, "none");
    assert.equal(config.sourceControl?.type, "git");
    assert.equal(config.ledger?.type, "sql");
    assert.equal(configString(config.ledger, "dialect"), "sqlite");
    assert.equal(config.runtime?.store?.type, "sqlite");
    assert.equal(config.runtime?.stateDir, flowUserRuntimePath(root));

    await assert.rejects(
      () => bootstrapFlowConfig({ projectRoot: root }),
      /Flow config already exists/,
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("Flow config bootstrap can create tracked repo config", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-tracked-"));
  const result = await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.storage, "repo-tracked");
  assert.equal(result.path, flowConfigPath(root));
});

test("Flow config bootstrap keeps providers local when a GitHub remote exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-github-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:example-org/example.git"], { cwd: root });

  const result = await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const config = await loadFlowConfig({ projectRoot: root });

  assert.ok(config);
  assert.equal(result.owner, undefined);
  assert.equal(config.topology.repos.main.name, "example");
  assert.equal(config.issueTracker?.type, "local");
  assert.equal(config.collaboration?.type, "none");
  assert.equal(config.sourceControl?.type, "git");
});

test("Configured runtime uses Kysely SQLite for SQL workflow ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-sql-ledger-config-"));
  const config = flowConfigSchema.parse({
    version: "1",
    project: { name: "SQL Ledger Fixture" },
    topology: {
      repos: {
        main: { name: "flow", baseBranch: "main" },
      },
    },
    issueTracker: { type: "local" },
    collaboration: { type: "none" },
    sourceControl: { type: "git" },
    ledger: { type: "sql", dialect: "sqlite", path: ".flow/ledger/workflow.db" },
    runtime: { store: { type: "sqlite" } },
  });

  const configured = createConfiguredWorkRuntime({ projectRoot: root, flowConfig: config });
  await configured.workflowLedger.writeIssue({
    ref: "FLOW-SQL-1",
    title: "SQL workflow ledger",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });

  const reloaded = createConfiguredWorkRuntime({ projectRoot: root, flowConfig: config });
  assert.match(configured.workflowLedgerPath, /workflow\.db$/);
  assert.equal((await reloaded.workflowLedger.readIssue("FLOW-SQL-1"))?.title, "SQL workflow ledger");

  await (configured.workflowLedger as { close?(): Promise<void> }).close?.();
  await (reloaded.workflowLedger as { close?(): Promise<void> }).close?.();
});

test("Configured SQL workflow ledger imports existing JSONL records idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-sql-ledger-migrate-"));
  const jsonlPath = join(root, ".flow", "ledger", "workflow.jsonl");
  await mkdir(dirname(jsonlPath), { recursive: true });
  const completedAt = nowIso();
  const issue = {
    ref: "FLOW-MIG-1",
    title: "Migrate JSONL",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  };
  const workerResult = {
    taskId: "task-migrate-1",
    issueRef: "FLOW-MIG-1",
    repoKey: "main",
    executor: "live_agent_thread",
    status: "succeeded",
    summary: "Imported.",
    changedFiles: ["src/runtime-factory.ts"],
    testsRun: ["npm test"],
    blockers: [],
    completedAt,
  };
  await writeFile(jsonlPath, [
    JSON.stringify({ kind: "issue", value: issue }),
    JSON.stringify({ kind: "workerResult", value: workerResult }),
    "",
  ].join("\n"), "utf8");
  const config = flowConfigSchema.parse({
    version: "1",
    project: { name: "SQL Migration Fixture" },
    topology: {
      repos: {
        main: { name: "flow", baseBranch: "main" },
      },
    },
    issueTracker: { type: "local" },
    collaboration: { type: "none" },
    sourceControl: { type: "git" },
    ledger: { type: "sql", dialect: "sqlite", path: ".flow/ledger/workflow.db" },
    runtime: { store: { type: "sqlite" } },
  });

  const configured = createConfiguredWorkRuntime({ projectRoot: root, flowConfig: config });
  assert.equal((await configured.workflowLedger.readIssue("FLOW-MIG-1"))?.title, "Migrate JSONL");
  assert.equal((await configured.workflowLedger.listWorkerResults("FLOW-MIG-1")).length, 1);

  const reloaded = createConfiguredWorkRuntime({ projectRoot: root, flowConfig: config });
  assert.equal((await reloaded.workflowLedger.listWorkerResults("FLOW-MIG-1")).length, 1);
  assert.match(await readFile(jsonlPath, "utf8"), /FLOW-MIG-1/);
});

test("Configured workflow ledger defaults to SQLite in user state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-default-sql-ledger-"));
  const config = flowConfigSchema.parse({
    version: "1",
    project: { name: "Default SQL Ledger Fixture" },
    topology: {
      repos: {
        main: { name: "flow", baseBranch: "main" },
      },
    },
    issueTracker: { type: "local" },
    collaboration: { type: "none" },
    sourceControl: { type: "git" },
    runtime: { store: { type: "sqlite" } },
  });

  const configured = createConfiguredWorkRuntime({ projectRoot: root, flowConfig: config });
  await configured.workflowLedger.writeIssue({
    ref: "FLOW-DEFAULT-SQL-1",
    title: "Default SQL workflow ledger",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });

  assert.equal(configured.workflowLedgerPath, flowUserWorkflowLedgerDatabasePath(root));
  assert.equal((await configured.workflowLedger.readIssue("FLOW-DEFAULT-SQL-1"))?.title, "Default SQL workflow ledger");
  assert.equal(existsSync(join(root, ".flow", "ledger", "workflow.jsonl")), false);
  assert.equal(existsSync(join(root, ".flow", "ledger", "issues", "FLOW-DEFAULT-SQL-1.json")), false);

  await (configured.workflowLedger as { close?(): Promise<void> }).close?.();
});

test("Configured runtime can select Postgres SQL workflow ledger from urlSecret", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-postgres-ledger-config-"));
  const original = process.env.FLOW_TEST_DATABASE_URL;
  const config = flowConfigSchema.parse({
    version: "1",
    project: { name: "Postgres Ledger Fixture" },
    topology: {
      repos: {
        main: { name: "flow", baseBranch: "main" },
      },
    },
    issueTracker: { type: "local" },
    collaboration: { type: "none" },
    sourceControl: { type: "git" },
    ledger: { type: "sql", dialect: "postgres", urlSecret: "FLOW_TEST_DATABASE_URL" },
    runtime: { store: { type: "sqlite" } },
  });
  delete process.env.FLOW_TEST_DATABASE_URL;
  assert.throws(
    () => createConfiguredWorkRuntime({ projectRoot: root, flowConfig: config }),
    /Postgres SQL workflow ledger requires/,
  );

  process.env.FLOW_TEST_DATABASE_URL = "postgres://flow@example.local/flow";
  const configured = createConfiguredWorkRuntime({ projectRoot: root, flowConfig: config });
  assert.equal(configured.workflowLedgerPath, "<postgres>");
  await (configured.workflowLedger as { close?(): Promise<void> }).close?.();

  if (original === undefined) delete process.env.FLOW_TEST_DATABASE_URL;
  else process.env.FLOW_TEST_DATABASE_URL = original;
});

test("CLI issue resolver hydrates provider issue refs before workflow commands", async () => {
  const hydrated: WorkItem = {
    ref: "GH-165",
    title: "Harden Autoflow into a real project runner",
    repoKeys: ["flow"],
    state: "queued",
    metadata: { issueType: "story", branchKind: "feature" },
  };

  const resolved = await resolveCliIssue({
    inspectQueue: async () => [],
    inspectIssue: async () => hydrated,
  }, "GH-165");

  assert.equal(resolved.title, "Harden Autoflow into a real project runner");
  assert.deepEqual(resolved.repoKeys, ["flow"]);
  assert.equal(resolved.metadata.branchKind, "feature");
});

test("Flow CLI core works with only git available on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-git-only-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const gitPath = await commandPath("git");
  const gitOnlyPath = dirname(gitPath);
  const env = {
    ...process.env,
    PATH: gitOnlyPath,
    Path: gitOnlyPath,
  };
  const flowBin = join(process.cwd(), "bin", "flow");
  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowBin, JSON.stringify(body)], {
      cwd: root,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const config = await loadFlowConfig({ projectRoot: root });
  assert.equal(config?.issueTracker?.type, "local");
  assert.equal(config?.collaboration?.type, "none");
  assert.equal(config?.sourceControl?.type, "git");
  assert.equal(config?.runtime && "worker" in config.runtime, false);

  const issueRequest = {
    op: "issue",
    mode: "create",
    summary: "Git-only Flow core",
    issueType: "Task",
  };
  const intake = await callFlow({ ...issueRequest, mode: "intake", dryRun: true });
  const reviewJob = intake.reviewJob as { id: string; issueRef: string; repoKey: string; workType: string };
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
  const issue = await callFlow(issueRequest);
  assert.equal(issue.title, "Git-only Flow core");

  const manifest = await callFlow({ op: "manifest", target: "issue" });
  const issueTrackerManifest = manifest.issueTracker as Record<string, unknown>;
  assert.deepEqual(manifest.modes, ["view", "select", "intake", "create", "route", "adoptBranch", "adoptWorkspace", "triage"]);
  assert.equal(issueTrackerManifest.type, "local");
  assert.match(String(issueTrackerManifest.refHint), /^FLOW-GIT-ONLY-[A-Z0-9]+-123$/);
  assert.equal(issueTrackerManifest.sourceOfTruth, ".flow/config.yaml");
  assert.deepEqual(issueTrackerManifest.capabilities, {
    view: true,
    queue: true,
    backlog: true,
    create: true,
    transition: true,
    comments: true,
    search: true,
    tagging: true,
    planningLane: false,
    triage: true,
  });

  const viewed = await callFlow({ op: "issue", mode: "view", id: issue.ref });
  assert.equal(viewed.ref, issue.ref);
  assert.equal(viewed.title, "Git-only Flow core");
});

test("Flow CLI honors FLOW_ROOT when invoked from another directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-root-env-"));
  const otherCwd = await mkdtemp(join(tmpdir(), "flow-root-env-cwd-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowBin = join(process.cwd(), "bin", "flow");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowBin, JSON.stringify(body)], {
      cwd: otherCwd,
      env: { ...process.env, FLOW_ROOT: root },
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const explained = await callFlow({ op: "config", mode: "explain" });

  assert.equal(explained.path, flowConfigPath(root));
});

test("JSON CLI returns INVALID_JSON for malformed argv input", async () => {
  const result = await captureJsonCli(["not-json"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, "INVALID_JSON");
  assert.equal(result.payload.error.details.body, "not-json");
  assert.equal(result.routeCalls, 0);
});

test("JSON CLI returns BAD_REQUEST when op is missing", async () => {
  const result = await captureJsonCli([JSON.stringify({ mode: "state" })]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, "BAD_REQUEST");
  assert.equal(result.payload.error.message, "JSON body must include a non-empty string op.");
  assert.deepEqual(result.payload.error.details.expected, { op: "string" });
  assert.equal(result.routeCalls, 0);
});

test("JSON CLI returns BAD_ARGS for multiple body arguments", async () => {
  const result = await captureJsonCli(["{}", "{}"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, "BAD_ARGS");
  assert.equal(result.payload.error.details.expected, "flow, flow manifest, or flow '<json-body>'");
  assert.equal(result.routeCalls, 0);
});

test("JSON CLI returns RUNTIME_ERROR for route exceptions", async () => {
  const result = await captureJsonCli([JSON.stringify({ op: "state" })], {
    route: () => {
      throw new Error("route exploded");
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, "RUNTIME_ERROR");
  assert.equal(result.payload.error.message, "route exploded");
  assert.deepEqual(result.payload.error.details, { op: "state" });
  assert.equal(result.routeCalls, 1);
});

test("JSON CLI preserves JsonCliError details and manifest target", async () => {
  const result = await captureJsonCli([JSON.stringify({ op: "review", target: "invalid" })], {
    route: () => {
      throw new JsonCliError("BAD_TARGET", "Unknown review target.", {
        manifestTarget: "review",
        details: { target: "invalid" },
      });
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, "BAD_TARGET");
  assert.equal(result.payload.error.manifest.body.target, "review");
  assert.equal(result.payload.error.details.op, "review");
  assert.equal(result.payload.error.details.target, "invalid");
  assert.deepEqual(result.payload.error.details.manifest, { op: "manifest", target: "review" });
  assert.equal(result.routeCalls, 1);
});

test("JSON CLI returns UNHANDLED_ERROR when stdin cannot be read", async () => {
  const stdin = new Readable({
    read() {
      this.destroy(new Error("stdin exploded"));
    },
  });
  const result = await captureJsonCli([], { stdin });

  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, "UNHANDLED_ERROR");
  assert.equal(result.payload.error.message, "stdin exploded");
  assert.equal(result.routeCalls, 0);
});

test("JSON CLI routes valid stdin bodies with stdin source context", async () => {
  const stdin = Readable.from([JSON.stringify({ op: "state" })]);
  const result = await captureJsonCli([], {
    stdin,
    route: (_request, context) => ({ source: context.source }),
  });

  assert.equal(result.exitCode, undefined);
  assert.deepEqual(result.payload, {
    ok: true,
    op: "state",
    result: { source: "stdin" },
  });
  assert.equal(result.routeCalls, 1);
});

test("Flow CLI can record evidence and documentation in one workflow call", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-record-acceptance-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const issueRequest = {
    op: "issue",
    mode: "create",
    summary: "Record acceptance",
    issueType: "Task",
  };
  const intake = await callFlow({ ...issueRequest, mode: "intake", dryRun: true });
  const reviewJob = intake.reviewJob as { id: string; issueRef: string; repoKey: string; workType: string };
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
  const issue = await callFlow(issueRequest) as { ref: string };

  const result = await callFlow({
    op: "workflow",
    mode: "recordAcceptance",
    id: issue.ref,
    evidenceSummary: "npm test passed",
    documentationSummary: "No docs needed for CLI acceptance metadata.",
    disposition: "not_needed",
    criteria: ["tests"],
  }) as { evidence: WorkItem; documentation: WorkItem };

  assert.equal(result.evidence.metadata.evidenceSummary, "npm test passed");
  assert.equal(result.documentation.metadata.documentationDisposition, "not_needed");
});

test("Flow CLI workflow recordResult and observe return next JSON commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-cli-next-json-commands-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const issueRequest = {
    op: "issue",
    mode: "create",
    summary: "Observe JSON commands",
    issueType: "Task",
  };
  const intake = await callFlow({ ...issueRequest, mode: "intake", dryRun: true });
  const reviewJob = intake.reviewJob as { id: string; issueRef: string; repoKey: string; workType: string };
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
  const issue = await callFlow(issueRequest) as { ref: string };

  const result = await callFlow({
    op: "workflow",
    mode: "recordResult",
    id: issue.ref,
    repoKey: "main",
    status: "succeeded",
    summary: "Thread completed the change.",
    changedFiles: ["src/work-runtime.ts"],
    testsRun: ["npm run check"],
  }) as { nextJsonCommands: Array<{ label: string; request: Record<string, unknown> }> };
  const observed = await callFlow({
    op: "workflow",
    mode: "observe",
    id: issue.ref,
  }) as { nextJsonCommands: Array<{ label: string; request: Record<string, unknown> }> };

  assert.deepEqual(result.nextJsonCommands.map((command) => command.request.mode), [
    "recordEvidence",
    "recordPullRequest",
    "observe",
    "advance",
  ]);
  assert.equal(observed.nextJsonCommands[0].request.mode, "recordEvidence");
  assert.equal(observed.nextJsonCommands[0].request.id, issue.ref);
});

test("Flow workflow doctor strict mode exits nonzero when readiness is not ok", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-doctor-strict-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const encoded = JSON.stringify(body);
    try {
      const { stdout } = await execFileAsync(process.execPath, [flowCli, encoded], {
        cwd: root,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { exitCode: 0, payload: JSON.parse(stdout) as Record<string, unknown> };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string };
      return {
        exitCode: failed.code ?? 1,
        payload: failed.stdout ? JSON.parse(failed.stdout) as Record<string, unknown> : {},
      };
    }
  };

  const bootstrap = await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  assert.equal(bootstrap.exitCode, 0);
  assert.equal(bootstrap.payload.ok, true);

  const issueRequest = {
    op: "issue",
    mode: "create",
    summary: "Strict doctor check",
    issueType: "Task",
  };
  const intake = await callFlow({ ...issueRequest, mode: "intake", dryRun: true });
  const reviewJob = (intake.payload.result as { reviewJob?: { id: string; issueRef: string; repoKey: string; workType: string } }).reviewJob;
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
  const created = await callFlow(issueRequest);
  assert.equal(created.exitCode, 0);
  assert.equal(created.payload.ok, true);
  const issue = created.payload.result as { ref: string };
  assert.ok(issue.ref);

  const doctor = await callFlow({
    op: "workflow",
    mode: "doctor",
    id: issue.ref,
  });
  assert.equal(doctor.exitCode, 0);
  assert.equal(doctor.payload.ok, true);

  const strict = await callFlow({
    op: "workflow",
    mode: "doctor",
    id: issue.ref,
    strict: true,
  });
  assert.notEqual(strict.exitCode, 0);
  assert.equal(strict.payload.ok, false);
  const error = strict.payload.error as { code: string; details?: Record<string, unknown> };
  assert.equal(error.code, "DOCTOR_STRICT_FAILED");
  assert.equal(error.details?.status, "blocked");
});

test("Flow CLI review command returns local readiness state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-local-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const issueRequest = {
    op: "issue",
    mode: "create",
    summary: "Review local test",
    issueType: "Task",
  };
  const intake = await callFlow({ ...issueRequest, mode: "intake", dryRun: true });
  const reviewJob = intake.reviewJob as { id: string; issueRef: string; repoKey: string; workType: string };
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
  const issue = await callFlow(issueRequest) as { ref: string };

  const review = await callFlow({
    op: "review",
    id: issue.ref,
  }) as { issueRef: string; state: string; repoKeys: string[]; readiness: { readyToAdvance: boolean; reviewReady: boolean; findings: unknown[] }; evidenceRecorded: boolean; documentationRecorded: boolean };

  assert.equal(review.issueRef, issue.ref);
  assert.ok(review.state);
  assert.ok(Array.isArray(review.repoKeys));
  assert.ok(typeof review.readiness === "object");
  assert.ok(typeof review.readiness.readyToAdvance === "boolean");
  assert.ok(typeof review.readiness.reviewReady === "boolean");
  assert.ok(Array.isArray(review.readiness.findings));
  assert.equal(review.evidenceRecorded, false);
  assert.equal(review.documentationRecorded, false);
});

test("Flow CLI review command accepts explicit local target", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-local-explicit-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const issueRequest = {
    op: "issue",
    mode: "create",
    summary: "Review local explicit target",
    issueType: "Task",
  };
  const intake = await callFlow({ ...issueRequest, mode: "intake", dryRun: true });
  const reviewJob = intake.reviewJob as { id: string; issueRef: string; repoKey: string; workType: string };
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
  const issue = await callFlow(issueRequest) as { ref: string };

  const review = await callFlow({
    op: "review",
    id: issue.ref,
    target: "local",
  }) as { issueRef: string; readiness: { readyToAdvance: boolean } };

  assert.equal(review.issueRef, issue.ref);
  assert.ok(typeof review.readiness.readyToAdvance === "boolean");
});

test("Flow CLI review command returns code_review state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-code-review-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  await callFlow({ op: "bootstrap", storage: "repo-tracked" });
  const issueRequest = {
    op: "issue",
    mode: "create",
    summary: "Review code review test",
    issueType: "Task",
  };
  const intake = await callFlow({ ...issueRequest, mode: "intake", dryRun: true });
  const reviewJob = intake.reviewJob as { id: string; issueRef: string; repoKey: string; workType: string };
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
  const issue = await callFlow(issueRequest) as { ref: string };

  const review = await callFlow({
    op: "review",
    id: issue.ref,
    target: "code_review",
  }) as { issueRef: string; codeReviewRequired: boolean; collaboration: string; pullRequest: unknown; blockers: string[] };

  assert.equal(review.issueRef, issue.ref);
  assert.equal(review.codeReviewRequired, false);
  assert.equal(review.collaboration, "none");
  assert.equal(review.pullRequest, undefined);
  assert.ok(Array.isArray(review.blockers));
});

test("Flow CLI review manifest includes review target", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-manifest-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  const callFlow = async (body: Record<string, unknown>) => {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify(body)], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
    if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
    return parsed.result as Record<string, unknown>;
  };

  const manifest = await callFlow({ op: "manifest" }) as { targets: string[]; ops: Record<string, string> };
  assert.ok(manifest.targets.includes("review"));
  assert.ok(typeof manifest.ops.review === "string");

  const reviewManifest = await callFlow({ op: "manifest", target: "review" }) as { target: string; targets: string[]; id: string };
  assert.equal(reviewManifest.target, "review");
  assert.deepEqual(reviewManifest.targets, ["local", "code_review"]);
  assert.ok(typeof reviewManifest.id === "string");
});

test("Flow CLI review command rejects invalid target", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-bad-target-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  try {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify({
      op: "review",
      id: "FLOW-1",
      target: "invalid",
    })], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: { code?: string } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.code, "BAD_MODE");
  } catch (error) {
    const failed = error as { stdout?: string };
    if (failed.stdout) {
      const parsed = JSON.parse(failed.stdout) as { ok?: boolean; error?: { code?: string } };
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error?.code, "BAD_MODE");
    } else {
      throw error;
    }
  }
});

test("Flow CLI workflow command rejects autoflow mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-workflow-autoflow-reject-"));
  await execFileAsync("git", ["init"], { cwd: root });
  const flowCli = join(process.cwd(), ".tmp", "test", "src", "flow.js");

  try {
    const { stdout } = await execFileAsync(process.execPath, [flowCli, JSON.stringify({
      op: "workflow",
      mode: "autoflow",
      id: "FLOW-1",
    })], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: { code?: string; details?: { supportedModes?: string[] } } };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error?.code, "BAD_MODE");
    assert.ok(parsed.error?.details?.supportedModes?.includes("advance"));
    assert.ok(parsed.error?.details?.supportedModes?.includes("doctor"));
    assert.ok(!parsed.error?.details?.supportedModes?.includes("autoflow"));
  } catch (error) {
    const failed = error as { stdout?: string };
    if (failed.stdout) {
      const parsed = JSON.parse(failed.stdout) as { ok?: boolean; error?: { code?: string; details?: { supportedModes?: string[] } } };
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error?.code, "BAD_MODE");
      assert.ok(!parsed.error?.details?.supportedModes?.includes("autoflow"));
    } else {
      throw error;
    }
  }
});

test("reviewLocal runtime method returns complete readiness state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-local-runtime-"));
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "FLOW-LOCAL-1",
    title: "Local review runtime test",
    repoKeys: ["main"],
    state: "running",
    metadata: {},
  });
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
  });
  await runtime.createSession("review-local-session");
  await runtime.selectIssue("review-local-session", {
    ref: "FLOW-LOCAL-1",
    title: "Local review runtime test",
    repoKeys: ["main"],
    state: "running",
    metadata: {},
  });

  const result = await runtime.reviewLocal("review-local-session", "FLOW-LOCAL-1");

  assert.equal(result.issueRef, "FLOW-LOCAL-1");
  assert.equal(result.state, "selected");
  assert.deepEqual(result.repoKeys, ["main"]);
  assert.ok(typeof result.readiness.readyToAdvance === "boolean");
  assert.ok(typeof result.readiness.reviewReady === "boolean");
  assert.ok(Array.isArray(result.readiness.findings));
  assert.equal(result.worker, undefined);
  assert.equal(result.evidenceRecorded, false);
  assert.equal(result.documentationRecorded, false);
});

test("reviewCodeReview runtime method returns provider-neutral state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-cr-runtime-"));
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "FLOW-CR-1",
    title: "Code review runtime test",
    repoKeys: ["main"],
    state: "running",
    metadata: {},
  });
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
    collaboration: new NoopCodeCollaborationAdapter(),
  });
  await runtime.createSession("review-cr-session");
  await runtime.selectIssue("review-cr-session", {
    ref: "FLOW-CR-1",
    title: "Code review runtime test",
    repoKeys: ["main"],
    state: "selected",
    metadata: {},
  });

  const result = await runtime.reviewCodeReview("review-cr-session", "FLOW-CR-1");

  assert.equal(result.issueRef, "FLOW-CR-1");
  assert.deepEqual(result.repoKeys, ["main"]);
  assert.equal(result.codeReviewRequired, false);
  assert.equal(result.collaboration, "none");
  assert.equal(result.pullRequest, undefined);
  assert.deepEqual(result.blockers, []);
});

test("reviewCodeReview runtime method returns pull request metadata when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-cr-pr-"));
  const ledger = new MemoryWorkflowLedger();
  const prUrl = "https://github.com/example/repo/pull/42";
  await ledger.writeIssue({
    ref: "FLOW-CR-2",
    title: "Code review with PR",
    repoKeys: ["main"],
    state: "awaiting_review",
    metadata: {
      prUrl,
      prState: "OPEN",
      prIsDraft: false,
      prChecksPassing: true,
      prReviewDecision: "APPROVED",
      prMergeable: "MERGEABLE",
    },
  });
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
    collaboration: new NoopCodeCollaborationAdapter(),
  });
  await runtime.createSession("review-cr-pr-session");
  await runtime.selectIssue("review-cr-pr-session", {
    ref: "FLOW-CR-2",
    title: "Code review with PR",
    repoKeys: ["main"],
    state: "selected",
    metadata: {
      prUrl,
      prState: "OPEN",
      prIsDraft: false,
      prChecksPassing: true,
      prReviewDecision: "APPROVED",
      prMergeable: "MERGEABLE",
    },
  });

  const result = await runtime.reviewCodeReview("review-cr-pr-session", "FLOW-CR-2");

  assert.equal(result.issueRef, "FLOW-CR-2");
  assert.equal(result.codeReviewRequired, false);
  assert.ok(result.pullRequest);
  assert.equal(result.pullRequest?.url, prUrl);
  assert.equal(result.pullRequest?.isDraft, false);
  assert.equal(result.pullRequest?.reviewDecision, "APPROVED");
  assert.equal(result.pullRequest?.mergeable, "MERGEABLE");
  assert.equal(result.pullRequest?.autoReviewMustFix, false);
  assert.equal(result.pullRequest?.autoReviewNeedsConfirmation, false);
});

test("reviewCodeReview runtime method posts provider-neutral review comment when requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-review-cr-post-"));
  const ledger = new MemoryWorkflowLedger();
  const prUrl = "https://github.com/example/repo/pull/42";
  let posted: { repo: string; id: string | number; body: string } | undefined;
  await ledger.writeIssue({
    ref: "FLOW-CR-3",
    title: "Code review post test",
    repoKeys: ["main"],
    state: "awaiting_review",
    metadata: {
      prUrl,
      prNumber: 42,
      prState: "OPEN",
      prIsDraft: false,
      prChecksPassing: true,
      prReviewDecision: "APPROVED",
      prMergeable: "MERGEABLE",
    },
  });
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
    collaboration: {
      capabilities: { requiresCodeReview: false, canMarkReady: true, canPostComments: true, canMerge: true },
      async findCodeReviews() {
        return [];
      },
      async getCodeReviewDiff(repo, id) {
        return { files: ["src/review.ts"], patch: `diff --git a/src/review.ts b/src/review.ts` };
      },
      async postReviewComment(repo, id, body) {
        posted = { repo, id, body };
        return { url: `https://github.com/example/repo/pull/${id}#issuecomment-1`, body };
      },
    },
  });
  await runtime.createSession("review-cr-post-session");
  await runtime.selectIssue("review-cr-post-session", {
    ref: "FLOW-CR-3",
    title: "Code review post test",
    repoKeys: ["main"],
    state: "selected",
    metadata: {
      prUrl,
      prNumber: 42,
      prState: "OPEN",
      prIsDraft: false,
      prChecksPassing: true,
      prReviewDecision: "APPROVED",
      prMergeable: "MERGEABLE",
    },
  });

  const result = await runtime.reviewCodeReview("review-cr-post-session", "FLOW-CR-3", { post: true });

  assert.equal(posted?.repo, "repo");
  assert.equal(posted?.id, 42);
  assert.match(posted?.body ?? "", /<!-- flow-pr-review -->/);
  assert.equal(result.postedComment?.url, "https://github.com/example/repo/pull/42#issuecomment-1");
});

test("Flow config bootstrap can keep repo-local config in local git exclude", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-bootstrap-untracked-"));
  await execFileAsync("git", ["init"], { cwd: root });

  const result = await bootstrapFlowConfig({ projectRoot: root, storage: "repo-untracked" });
  const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");

  assert.equal(result.storage, "repo-untracked");
  assert.equal(result.path, flowConfigPath(root));
  assert.equal(result.localExcludeUpdated, true);
  assert.match(exclude, /^\.flow\/$/m);
});

test("Desktop project registry tracks active Flow projects from config roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-project-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "flow-desktop-project-two-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["init"], { cwd: secondRoot });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  await bootstrapFlowConfig({ projectRoot: secondRoot, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });

  const project = await registry.addProject(root);
  const secondProject = await registry.addProject(secondRoot);
  const projects = await registry.listProjects();
  const active = await registry.activeProject();
  const reactivated = await registry.setActiveProject(project.id);

  assert.equal(project.valid, true);
  assert.equal(project.root, root);
  assert.equal(project.configPath, flowConfigPath(root));
  assert.equal(projects.length, 2);
  assert.equal(active?.id, secondProject.id);
  assert.equal(reactivated.id, project.id);
  assert.equal((await registry.activeProject())?.id, project.id);
});

test("Desktop project registry can store active project state in SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-project-db-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-db-state-"));
  const dbPath = join(stateRoot, "desktop-state.db");
  const registry = new DesktopProjectRegistry({ dbPath });

  const project = await registry.addProject(root);
  const reloaded = new DesktopProjectRegistry({ dbPath });
  const active = await reloaded.activeProject();

  assert.equal(active?.id, project.id);
  assert.equal(active?.root, root);
});

test("Project theme generates stable colors and initials", () => {
  const theme = projectThemeFor({ id: "flow-123", name: "Flow Desktop", root: "C:/repo/flow" });
  const repeated = projectThemeFor({ id: "flow-123", name: "Flow Desktop", root: "C:/repo/flow" });
  const withIcon = projectThemeFor({ id: "flow-123", name: "Flow Desktop", icon: "./assets/flow.svg" });

  assert.equal(theme.initials, "FD");
  assert.equal(theme.color, repeated.color);
  assert.match(theme.color, /^#[0-9a-f]{6}$/i);
  assert.equal(withIcon.iconUrl, "./assets/flow.svg");
});

test("Desktop project registry hides stale project records without config files", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-project-live-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-stale-"));
  const statePath = join(stateRoot, "projects.json");
  const registry = new DesktopProjectRegistry({ statePath });
  const project = await registry.addProject(root);
  const staleRoot = join(tmpdir(), "flow-desktop-smoke-stale");

  await writeFile(statePath, `${JSON.stringify({
    activeProjectId: "stale",
    projects: [
      {
        id: "stale",
        name: "desktop-smoke",
        root: staleRoot,
        configPath: join(staleRoot, ".flow", "config.yaml"),
        valid: true,
        addedAt: nowIso(),
        lastOpenedAt: nowIso(),
      },
      project,
    ],
  }, null, 2)}\n`, "utf8");

  const projects = await registry.listProjects();
  const active = await registry.activeProject();

  assert.deepEqual(projects.map((candidate) => candidate.id), [project.id]);
  assert.equal(active?.id, project.id);
});

test("Desktop prompt router records ledger context and agent artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-prompt-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const router = new DesktopPromptRouter({
    projects: registry,
    agent: {
      async sendPrompt(input) {
        assert.equal(input.project.id, project.id);
        assert.equal(input.issueRef, "ISSUE-50");
        assert.match(input.threadId, /^thread-/);
        return {
          session: {
            id: "session-50",
            provider: "pi",
            workspacePath: root,
            status: "active",
          },
          artifacts: [{
            id: "artifact-50",
            artifactType: "diff",
            title: "Prompt router diff",
            uri: "artifact://artifact-50",
          }],
          summary: "Prompt routed",
        };
      },
    },
  });

  const result = await router.submit({
    prompt: "Route this to the active project.",
    issueRef: "ISSUE-50",
  });
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.readContext);
  const projection = await ledger.readContext({ projectId: project.id });

  assert.equal(result.project.id, project.id);
  assert.equal(result.sessionId, "session-50");
  assert.deepEqual(result.artifactRefs, ["artifact-50"]);
  assert.equal(projection.active.projectId, project.id);
  assert.equal(projection.active.issueRef, "ISSUE-50");
  assert.equal(projection.active.sessionId, "session-50");
  assert.equal(projection.active.artifactId, "artifact-50");
  assert.equal(projection.prompts[0].target, "artifact");
  assert.equal(projection.sessions[0].provider, "pi");
  assert.equal(projection.artifacts[0].title, "Prompt router diff");
});

test("Desktop prompt router preserves prompt context when agent routing fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-prompt-error-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-state-error-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const router = new DesktopPromptRouter({
    projects: registry,
    agent: {
      async sendPrompt() {
        throw new Error("Pi SDK is not installed.");
      },
    },
  });

  const result = await router.submit({
    prompt: "Route this even if pi is missing.",
    issueRef: "ISSUE-51",
  });
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.readContext);
  const projection = await ledger.readContext({ projectId: project.id });

  assert.match(result.error ?? "", /Pi SDK is not installed/);
  assert.equal(projection.prompts.length, 1);
  assert.equal(projection.prompts[0].prompt, "Route this even if pi is missing.");
  assert.match(projection.prompts[0].summary ?? "", /Pi SDK is not installed/);
  assert.equal(projection.active.issueRef, "ISSUE-51");
});

test("Desktop action router records evidence, result, docs, and doctor output", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-actions-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-action-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root: join(root, ".flow", "runtime") }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-54",
    title: "Record workflow outcomes from desktop",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });

  const router = new DesktopActionRouter({
    projects: registry,
    runtimeForProject: () => runtime,
    ledgerForProject: () => ledger,
  });
  const evidence = await router.invoke({
    action: "record_evidence",
    issueRef: "ISSUE-54",
    payload: { summary: "Tests passed.", source: "npm test" },
  });
  await router.invoke({
    action: "record_result",
    issueRef: "ISSUE-54",
    payload: { summary: "Implementation done.", status: "succeeded", testsRun: ["npm test"] },
  });
  await router.invoke({
    action: "record_documentation",
    issueRef: "ISSUE-54",
    payload: { summary: "No docs needed.", disposition: "not_needed" },
  });
  const doctor = await router.invoke({ action: "run_doctor", issueRef: "ISSUE-54" });

  const issue = await ledger.readIssue("ISSUE-54");
  const results = await ledger.listWorkerResults("ISSUE-54");
  const projection = await ledger.readContext({ projectId: project.id });

  assert.equal(evidence.summary, "Evidence recorded for ISSUE-54.");
  assert.equal(issue?.metadata.evidenceRecorded, true);
  assert.equal(issue?.metadata.documentationRecorded, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].summary, "Implementation done.");
  assert.match(doctor.summary, /Doctor/);
  assert.equal(projection.artifacts.length, 4);
});

test("Desktop action router and renderer share action values", () => {
  assert.deepEqual([...desktopActionValues], [
    "autoflow",
    "approve_confirmation",
    "record_evidence",
    "record_result",
    "record_documentation",
    "run_doctor",
  ]);
  for (const action of desktopActionValues) {
    assert.equal(isDesktopAction(action), true);
  }
  assert.equal(isDesktopAction("missing_action"), false);
});

test("Desktop action router runs Autoflow as the primary issue action", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-autoflow-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await bootstrapFlowConfig({ projectRoot: root, storage: "repo-tracked" });
  const stateRoot = await mkdtemp(join(tmpdir(), "flow-desktop-autoflow-state-"));
  const registry = new DesktopProjectRegistry({ statePath: join(stateRoot, "projects.json") });
  const project = await registry.addProject(root);
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root: join(root, ".flow", "runtime") }), ledger });
  await ledger.writeIssue({
    ref: "ISSUE-55",
    title: "Autoflow from desktop",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      work_dir: "/tmp/app-api-worktree",
    },
  });

  const router = new DesktopActionRouter({
    projects: registry,
    runtimeForProject: () => runtime,
    ledgerForProject: () => ledger,
  });
  const result = await router.invoke({ action: "autoflow", issueRef: "ISSUE-55" });

  const issue = await ledger.readIssue("ISSUE-55");
  const projection = await ledger.readContext({ projectId: project.id });

  assert.match(result.summary, /Autoflow needs_confirmation for ISSUE-55/);
  assert.equal(issue?.metadata["workflow.autoflow.attempts"], 1);
  assert.equal(projection.artifacts.length, 1);
  assert.equal(projection.artifacts[0].title, "Autoflow output");
  assert.equal(projection.artifacts[0].metadata.action, "autoflow");
});

test("Desktop Autoflow reconcile skips invalid projects and honors disabled runner state", async () => {
  let surfaceLoads = 0;
  const registry = desktopProjectRegistryStub([
    desktopProjectRecordStub({ id: "invalid", valid: false }),
    desktopProjectRecordStub({ id: "disabled" }),
  ]);

  const summary = await runEnabledProjectAutoflowReconcile(registry, async () => {
    surfaceLoads++;
    return desktopProjectSurfaceStub([], undefined, false);
  });

  assert.deepEqual(summary, { enabledProjects: 0, pendingProjects: 0, reconciledProjects: 0 });
  assert.equal(surfaceLoads, 1);
  assert.equal(nextAutoflowReconcileDelay(summary), desktopAutoflowReconcileIntervals.idleMs);
});

test("Desktop Autoflow reconcile checks queue before ticking runner", async () => {
  let tickCalls = 0;
  const summary = await runEnabledProjectAutoflowReconcile(
    desktopProjectRegistryStub([desktopProjectRecordStub({ id: "enabled" })]),
    async () => desktopProjectSurfaceStub([], () => {
      tickCalls++;
    }),
  );

  assert.deepEqual(summary, { enabledProjects: 1, pendingProjects: 0, reconciledProjects: 0 });
  assert.equal(tickCalls, 0);
});

test("Desktop Autoflow reconcile ticks runner for queued work", async () => {
  let tickCalls = 0;
  const summary = await runEnabledProjectAutoflowReconcile(
    desktopProjectRegistryStub([desktopProjectRecordStub({ id: "enabled" })]),
    async () => desktopProjectSurfaceStub([{ ref: "GH-260", state: "queued" }], () => {
      tickCalls++;
    }),
  );

  assert.deepEqual(summary, { enabledProjects: 1, pendingProjects: 1, reconciledProjects: 1 });
  assert.equal(tickCalls, 1);
  assert.equal(nextAutoflowReconcileDelay(summary), desktopAutoflowReconcileIntervals.activeMs);
});

test("Desktop Autoflow routes call the shared runner surface", async () => {
  let tickCalls = 0;
  const app = express();
  const project = desktopProjectRecordStub({ id: "enabled" });
  registerWorkRoutes(
    app,
    {
      projectRegistry: desktopProjectRegistryStub([project]),
      projectSurface: async () => desktopProjectSurfaceStub([{ ref: "GH-385", state: "queued" }], () => {
        tickCalls++;
      }),
    },
    {
      promptRouter: {} as never,
      actionRouter: {} as never,
    },
    express.json(),
  );
  const server = await listenExpress(app);
  try {
    const statusResponse = await fetch(`${server.url}/api/autoflow/status`);
    const statusPayload = await statusResponse.json() as { ok?: boolean; status?: { enabled?: boolean; summary?: string } };
    const tickResponse = await fetch(`${server.url}/api/autoflow/tick`, { method: "POST" });
    const tickPayload = await tickResponse.json() as { ok?: boolean; status?: { enabled?: boolean } };

    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.status?.enabled, true);
    assert.equal(statusPayload.status?.summary, "Autoflow idle.");
    assert.equal(tickPayload.ok, true);
    assert.equal(tickPayload.status?.enabled, true);
    assert.equal(tickCalls, 1);
  } finally {
    await server.close();
  }
});

test("Desktop refresh intervals use defaults and settings overrides", () => {
  assert.deepEqual(desktopRefreshIntervalsFromSettings(), defaultDesktopRefreshIntervals);
  assert.deepEqual(desktopRefreshIntervalsFromSettings({ refreshIntervalMs: 12_000 }), {
    dashboardMs: 12_000,
    autoflowStatusMs: 12_000,
  });
  assert.deepEqual(desktopRefreshIntervalsFromSettings({
    refreshIntervalMs: 12_000,
    dashboardRefreshIntervalMs: 7_500,
    autoflowStatusRefreshIntervalMs: 30_000,
  }), {
    dashboardMs: 7_500,
    autoflowStatusMs: 30_000,
  });
  assert.deepEqual(desktopRefreshIntervalsFromSettings({
    refreshIntervalMs: -1,
    dashboardRefreshIntervalMs: Number.NaN,
    autoflowStatusRefreshIntervalMs: 0,
  }), defaultDesktopRefreshIntervals);
});

test("Desktop LruMap evicts least recently used entries", () => {
  const cache = new LruMap<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);

  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);

  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.size, 2);
});

test("Desktop LruMap rejects empty cache sizes", () => {
  assert.throws(() => new LruMap<string, number>(0), /maxSize must be at least 1/);
});

test("Desktop static routes serve built HTML and keep missing UI 404s", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-desktop-static-"));
  const desktopDir = join(root, "desktop");
  const dashboardDir = join(root, "dashboard");
  await mkdir(desktopDir, { recursive: true });
  await mkdir(dashboardDir, { recursive: true });
  const desktopFilePath = join(desktopDir, "index.html");
  const dashboardFilePath = join(dashboardDir, "missing.html");
  await writeFile(desktopFilePath, "<!doctype html><title>Desktop</title>");

  const app = express();
  registerStaticRoutes(app, { desktopFilePath, dashboardFilePath });
  const server = await listenExpress(app);
  try {
    const desktopResponse = await fetch(`${server.url}/`);
    assert.equal(desktopResponse.status, 200);
    assert.equal(await desktopResponse.text(), "<!doctype html><title>Desktop</title>");
    assert.equal((desktopResponse.headers.get("content-type") ?? "").includes("text/html"), true);

    const dashboardResponse = await fetch(`${server.url}/dashboard`);
    assert.equal(dashboardResponse.status, 404);
    assert.equal(await dashboardResponse.text(), "Dashboard UI not built.");
  } finally {
    await server.close();
  }
});

test("Pi session driver starts issue-linked sessions and records provider-neutral session link", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-start-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-34",
    title: "Wire issue click to pi coding agent session",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-gh-34",
    },
  });

  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });

  const session = await driver.startSession("gh-34");
  assert.equal(session.issueRef, "GH-34");
  assert.equal(session.flowSessionId, "desktop");
  assert.equal(session.timeline.length, 1);
  assert.match(session.timeline[0].content, /Agent session started/);

  const linksRaw = await readFile(join(root, ".flow", "runtime", "pi-session-links.json"), "utf8");
  const linksPayload = JSON.parse(linksRaw) as { links: Array<{ issueRef: string; flowSessionId: string; provider: string; sessionId: string }> };
  assert.equal(linksPayload.links[0].issueRef, "GH-34");
  assert.equal(linksPayload.links[0].flowSessionId, "desktop");
  assert.equal(linksPayload.links[0].provider, "pi");
  assert.equal(linksPayload.links[0].sessionId, session.id);
});

test("Pi session driver appends user prompt and assistant response", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-prompt-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-35",
    title: "Add composer to send prompts to pi sessions",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });

  const started = await driver.startSession("GH-35");
  const updated = await driver.postPrompt(started.id, "Please draft implementation steps.");
  const userMessage = updated.timeline.find((item) => item.role === "user");
  const assistantMessage = updated.timeline.find((item) => item.role === "assistant");

  assert.equal(userMessage?.content, "Please draft implementation steps.");
  assert.match(assistantMessage?.content ?? "", /Queued prompt for GH-35/);
  assert.equal(updated.timeline.length >= 3, true);
});

test("Claude session driver starts issue-linked sessions and records provider-neutral session link", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-claude-session-start-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-425",
    title: "Add Claude agent session runner",
    repoKeys: ["flow"],
    state: "queued",
    metadata: {
      "workflow.repos.flow.worktree_path": "/repo/flow/.worktrees/feature-gh-425",
    },
  });

  const driver = new ClaudeSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });

  const session = await driver.startSession("gh-425");
  assert.equal(session.issueRef, "GH-425");
  assert.equal(session.provider, "claude");
  assert.equal(session.workspacePath, "/repo/flow/.worktrees/feature-gh-425");

  const linksRaw = await readFile(join(root, ".flow", "runtime", "claude-session-links.json"), "utf8");
  const linksPayload = JSON.parse(linksRaw) as { links: Array<{ issueRef: string; flowSessionId: string; provider: string; sessionId: string }> };
  assert.equal(linksPayload.links[0].issueRef, "GH-425");
  assert.equal(linksPayload.links[0].flowSessionId, "desktop");
  assert.equal(linksPayload.links[0].provider, "claude");
  assert.equal(linksPayload.links[0].sessionId, session.id);
});

test("Claude agent runner maps SDK messages into AgentRunner result", async () => {
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
  const runner = new ClaudeAgentRunner({
    allowedTools: ["Read", "Edit"],
    loadModule: async () => ({
      query({ prompt, options }) {
        calls.push({ prompt, options: options as Record<string, unknown> });
        return (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "123e4567-e89b-12d3-a456-426614174000",
            uuid: "init-1",
            cwd: "/repo/flow",
          };
          yield {
            type: "assistant",
            session_id: "123e4567-e89b-12d3-a456-426614174000",
            uuid: "assistant-1",
            message: { content: [{ type: "text", text: "Implemented Claude runner." }] },
          };
          yield {
            type: "tool_progress",
            session_id: "123e4567-e89b-12d3-a456-426614174000",
            uuid: "tool-1",
            tool_use_id: "tool-call-1",
            tool_name: "Edit",
            elapsed_time_seconds: 1.25,
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "123e4567-e89b-12d3-a456-426614174000",
            uuid: "result-1",
            is_error: false,
            result: "Claude prompt completed with edits.",
          };
        })();
      },
    }),
  });
  const events: string[] = [];

  const result = await runner.prompt({
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
    issueRef: "GH-425",
    prompt: "Implement the runner.",
    repoRoot: "/repo/flow",
    workspacePath: "/repo/flow/.worktrees/gh-425",
    onEvent: (event) => { events.push(event.type); },
  });

  assert.equal(calls[0]?.prompt, "Implement the runner.");
  assert.equal(calls[0]?.options?.cwd, "/repo/flow/.worktrees/gh-425");
  assert.deepEqual(calls[0]?.options?.allowedTools, ["Read", "Edit"]);
  assert.equal((calls[0]?.options?.systemPrompt as { preset?: string })?.preset, "claude_code");
  assert.equal(calls[0]?.options?.sessionId, "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(result.sessionId, "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(result.status, "active");
  assert.equal(result.summary, "Claude prompt completed with edits.");
  assert.ok(result.timeline?.some((item) => item.content.includes("Implemented Claude runner.")));
  assert.ok(result.timeline?.some((item) => item.role === "tool" && item.toolName === "Edit"));
  assert.ok(events.includes("assistantDelta"));
  assert.ok(events.includes("toolUpdated"));
});

test("Claude agent runner resumes follow-up sessions", async () => {
  const calls: Array<{ options?: Record<string, unknown> }> = [];
  const runner = new ClaudeAgentRunner({
    loadModule: async () => ({
      query({ options }) {
        calls.push({ options: options as Record<string, unknown> });
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            session_id: "123e4567-e89b-12d3-a456-426614174111",
            uuid: "result-1",
            is_error: false,
            result: "Follow-up done.",
          };
        })();
      },
    }),
  });

  await runner.prompt({
    sessionId: "123e4567-e89b-12d3-a456-426614174111",
    issueRef: "GH-425",
    mode: "followUp",
    prompt: "Continue.",
    repoRoot: "/repo/flow",
  });

  assert.equal(calls[0]?.options?.resume, "123e4567-e89b-12d3-a456-426614174111");
  assert.equal(calls[0]?.options?.sessionId, undefined);
});

test("Pi session driver queues follow-up prompts while a run is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-queue-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-168",
    title: "Queue follow-up prompts",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const prompts: string[] = [];
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: {
      async prompt(input) {
        prompts.push(input.prompt);
        if (prompts.length === 1) await firstGate;
        return {
          sessionId: input.sessionId,
          status: "active",
          summary: `Handled ${prompts.length}.`,
        };
      },
    },
  });

  const started = await driver.startSession("GH-168");
  const first = await driver.sendUserMessage(started.id, { text: "First prompt" });
  const second = await driver.sendUserMessage(started.id, { text: "Second prompt" });

  assert.equal(first.status, "running");
  assert.equal(second.timeline.filter((item) => item.role === "user").length, 2);
  assert.equal(prompts.length, 1);
  releaseFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /First prompt/);
  assert.match(prompts[1], /Second prompt/);
  assert.doesNotMatch(prompts[0], /Issue: GH-168/);
  assert.match(started.timeline.find((item) => item.role === "system")?.content ?? "", /Issue: GH-168/);
});

test("Pi session driver persists issue-linked session state for reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-reopen-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-38",
    title: "Persist desktop pi session state",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });

  const first = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });
  const started = await first.startSession("GH-38");
  await first.postPrompt(started.id, "Remember this turn.");

  const second = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: false,
  });
  const reopened = await second.getSession(started.id);

  assert.equal(reopened.issueRef, "GH-38");
  assert.equal(reopened.timeline.some((item) => item.role === "user" && item.content === "Remember this turn."), true);
});

test("Pi session driver records clear failure when pi runtime fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-session-error-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-36",
    title: "Report missing pi runtime",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop",
    agent: {
      async prompt() {
        throw new Error("No pi auth configured.");
      },
    },
  });

  const started = await driver.startSession("GH-36");
  const updated = await driver.postPrompt(started.id, "Run the real agent.");
  const assistantMessage = updated.timeline.find((item) => item.role === "assistant");
  const linksRaw = await readFile(join(root, ".flow", "runtime", "pi-session-links.json"), "utf8");
  const linksPayload = JSON.parse(linksRaw) as { links: Array<{ issueRef: string; status?: string }> };

  assert.equal(updated.status, "failed");
  assert.match(updated.error ?? "", /No pi auth configured/);
  assert.match(assistantMessage?.content ?? "", /Pi session failed: No pi auth configured/);
  assert.equal(linksPayload.links[0].status, "failed");
});

test("Standalone Autoflow runner starts the next ready issue and records a result", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-autoflow-runner-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-56",
    title: "Run through orchestrator",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {
      "workflow.repos.app_api.worktree_path": root,
    },
  });
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop-project",
    agent: {
      async prompt() {
        return {
          sessionId: "pi-gh-56",
          workspacePath: root,
          status: "active",
          summary: "Implemented by Pi.",
          timeline: [{
            id: "assistant-1",
            role: "assistant",
            content: "Implemented by Pi and committed the changes.",
            createdAt: nowIso(),
          }, {
            id: "write-1",
            role: "tool",
            toolName: "write",
            content: "Wrote test file.",
            diff: { path: "test/flowstore.test.ts", content: "test" },
            createdAt: nowIso(),
          }, {
            id: "test-1",
            role: "tool",
            toolName: "npm test",
            content: "Tests passed.",
            createdAt: nowIso(),
          }],
        };
      },
    },
  });
  const runner = new StandaloneAutoflowRunner({
    projectId: "project",
    runtime,
    state: new MemoryAutoflowRunnerState(),
    agentSessionDriver: driver,
  });

  await runner.tick();
  for (let index = 0; index < 100; index += 1) {
    if ((await ledger.listWorkerResults("GH-56")).length) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const results = await ledger.listWorkerResults("GH-56");
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "succeeded");
  assert.match(results[0].summary, /Implemented by Pi/);
  for (let index = 0; index < 100; index += 1) {
    const issueStatus = (await runner.status()).issues["GH-56"];
    if (issueStatus?.phase === "needs_input") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const issueStatus = (await runner.status()).issues["GH-56"];
  assert.equal(issueStatus?.phase, "needs_input");
  assert.match(issueStatus?.summary ?? "", /Pull request is missing/);
});

test("Standalone Autoflow runner records timed-out worker jobs as terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-autoflow-runner-timeout-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-379",
    title: "Fix standalone Autoflow timeout and running-status drift",
    repoKeys: ["flow"],
    state: "queued",
    metadata: {
      "workflow.repos.flow.worktree_path": root,
    },
  });
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop-project",
    agent: {
      async prompt() {
        return new Promise(() => undefined);
      },
    },
  });
  const runner = new StandaloneAutoflowRunner({
    projectId: "project",
    runtime,
    state: new MemoryAutoflowRunnerState(),
    agentSessionDriver: driver,
    postPromptTimeoutMs: 20,
  });

  const status = await runner.tick({ wait: true });
  const jobs = await ledger.listWorkJobs("GH-379");
  const results = await ledger.listWorkJobResults("GH-379");

  assert.equal(status.issues["GH-379"]?.phase, "failed");
  assert.equal(jobs.at(-1)?.status, "failed");
  assert.equal(results.at(-1)?.status, "failed");
  assert.match(results.at(-1)?.summary ?? "", /timed out/);
});

test("Autoflow service can be instantiated without Desktop modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-autoflow-service-"));
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger: new MemoryWorkflowLedger() });
  const service = new AutoflowService({
    projectId: "project",
    runtime,
    enabled: () => false,
    agentSessionDriver: {
      async getSession() {
        throw new Error("not used");
      },
      async openOrCreateIssueSession() {
        throw new Error("not used");
      },
      async sendUserMessage() {
        throw new Error("not used");
      },
      async postPrompt() {
        throw new Error("not used");
      },
    },
  });

  const status = service.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.summary, "Autoflow is paused.");
});

test("Standalone Autoflow runner sends follow-up messages to running sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-autoflow-runner-followup-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-57",
    title: "Follow up while running",
    repoKeys: [],
    state: "queued",
    metadata: {},
  });
  const modes: Array<string | undefined> = [];
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop-project",
    agent: {
      async prompt(input) {
        modes.push(input.mode);
        return {
          sessionId: input.sessionId,
          status: "active",
          summary: "ok",
          timeline: [],
        };
      },
    },
  });
  const started = await driver.startSession("GH-57");
  started.status = "running";
  const runner = new StandaloneAutoflowRunner({
    projectId: "project",
    runtime,
    state: new MemoryAutoflowRunnerState(),
    agentSessionDriver: driver,
  });

  await runner.sendUserMessage({ issueRef: "GH-57", sessionId: started.id, text: "More detail." });
  assert.deepEqual(modes, ["followUp"]);
});

test("Standalone Autoflow runner doctors stale external issues instead of starting Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-autoflow-runner-stale-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  await ledger.writeIssue({
    ref: "GH-58",
    title: "Missing external issue",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: {},
  });
  const driver = new PiSessionDriver({
    runtime,
    repoRoot: root,
    flowSessionId: "desktop-project",
    agent: {
      async prompt() {
        throw new Error("Pi should not start for stale issues.");
      },
    },
  });
  const doctorRuntime = Object.create(runtime) as typeof runtime;
  doctorRuntime.diagnoseIssue = async () => {
    throw new Error("GraphQL: Could not resolve to an issue or pull request with the number of 58. (repository.issue)");
  };
  const runner = new StandaloneAutoflowRunner({
    projectId: "project",
    runtime: doctorRuntime,
    state: new MemoryAutoflowRunnerState(),
    agentSessionDriver: driver,
  });

  await runner.tick();
  for (let index = 0; index < 20; index += 1) {
    const issueStatus = (await runner.status()).issues["GH-58"];
    if (issueStatus?.phase === "needs_input") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const status = await runner.status();
  const issueStatus = status.issues["GH-58"];
  assert.equal(status.summary, "1 issue needs input.");
  assert.equal(issueStatus?.phase, "needs_input");
  assert.match(issueStatus?.summary ?? "", /External issue GH-58 is missing or stale/);
  assert.equal((await ledger.listWorkerResults("GH-58")).length, 0);
});

test("Pi SDK session runner maps real SDK events into desktop timeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-sdk-runner-"));
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const driverEvents: string[] = [];
  let sessionOptions: Record<string, unknown> | undefined;
  const runner = new PiSdkSessionRunner({
    loadModule: async () => ({
      SessionManager: {
        create: () => ({ mode: "create" }),
        open: () => ({ mode: "open" }),
      },
      createAgentSession: async (options) => {
        sessionOptions = options;
        return {
          session: {
            sessionId: "real-pi-session",
            sessionFile: join(root, "session.jsonl"),
            subscribe(next) {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            async prompt() {
              listener?.({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
              listener?.({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: "ok", isError: false });
              listener?.({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Done from pi." },
              });
            },
            dispose() {},
          },
        };
      },
    }),
  });

  const result = await runner.prompt({
    sessionId: "seed",
    issueRef: "GH-37",
    prompt: "Use pi.",
    repoRoot: root,
    onEvent(event) {
      driverEvents.push(event.type);
      if (event.type === "assistantDelta") {
        assert.equal(event.text, "Done from pi.");
      }
    },
  });

  assert.equal(result.sessionId, "real-pi-session");
  assert.equal(result.sessionFile, join(root, "session.jsonl"));
  assert.match(result.summary ?? "", /Done from pi/);
  assert.equal(result.timeline?.some((item) => item.role === "tool" && item.toolName === "read"), true);
  assert.deepEqual(driverEvents, ["toolStarted", "toolFinished", "assistantDelta"]);
  assert.deepEqual(sessionOptions?.tools, [...FLOW_PI_AGENT_TOOLS]);
  assert.equal((sessionOptions?.tools as string[]).includes("claude"), false);
  assert.equal((sessionOptions?.tools as string[]).includes("subagent"), false);
});

test("Pi SDK child runner source forwards Flow-owned tool policy", () => {
  const source = childRunnerSource();
  assert.match(source, /const tools = Array\.isArray\(input\.tools\)/);
  assert.match(source, /createAgentSession\(\{ cwd, sessionManager, tools \}\)/);
});

test("Local issue tracker creates issues through the Flow ledger surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-local-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = new FlowWorkRuntime({
    store: new FlowStore({ root: join(root, ".flow/runtime") }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
    collaboration: new NoopCodeCollaborationAdapter(),
    projectRoot: root,
    readiness: { assess: assessIssue },
  });

  await runtime.createSession("local-session");
  const options = {
    issueType: "Task",
    summary: "Spike local surface",
    description: "Keep Flow usable without GitHub.",
  } satisfies CreateIssueOptions;
  await approveIssueIntake(runtime, "local-session", options);
  const issue = await runtime.createIssue("local-session", options);

  assert.equal(issue.ref, "FLOW-1");
  assert.equal(issue.title, "Spike local surface");
  assert.equal((await ledger.readIssue("FLOW-1"))?.ref, "FLOW-1");
  assert.deepEqual(await new NoopCodeCollaborationAdapter().findCodeReviews("flow"), []);
});

test("Work Runtime triages local issues without mutating during dry-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-triage-dry-run-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
  });
  await ledger.writeIssue({
    ref: "FLOW-1",
    title: "Add SQL workflow ledger",
    summary: "Needs implementation.",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  await ledger.writeIssue({
    ref: "FLOW-2",
    title: "Add SQL workflow ledger",
    summary: "Needs implementation.",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });

  const result = await runtime.triageIssues({ dryRun: true, ids: ["FLOW-1", "FLOW-2"] });

  assert.equal(result.dryRun, true);
  assert.equal(result.issuesScanned, 2);
  assert.equal(result.appliedActions, undefined);
  assert.ok(result.proposedActions.some((action) => action.type === "add_tag" && action.target === "FLOW-1"));
  assert.ok(result.issues[0].missingSections.some((section) => section.section === "Acceptance criteria"));
  assert.ok(result.issues[0].duplicateCandidates.some((candidate) => candidate.ref === "FLOW-2"));
  assert.deepEqual((await ledger.readIssue("FLOW-1"))?.metadata.issueLabels, undefined);
});

test("Work Runtime triage apply can tag and comment through provider capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-triage-apply-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
  });
  await ledger.writeIssue({
    ref: "FLOW-1",
    title: "Fix desktop runner timeout",
    summary: "Short body.",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });

  const result = await runtime.triageIssues({ apply: true, ids: ["FLOW-1"] });
  const issue = await ledger.readIssue("FLOW-1");

  assert.equal(result.dryRun, false);
  assert.ok((result.appliedActions ?? []).some((action) => action.type === "add_tag"));
  assert.ok((result.appliedActions ?? []).some((action) => action.type === "add_comment"));
  assert.deepEqual(issue?.metadata.issueLabels, ["priority-p1", "lane-desktop-runner"]);
  assert.equal(Array.isArray(issue?.metadata.localComments), true);
});

test("Issue creation dedupes existing issues with matching title", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-local-dedupe-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = new FlowWorkRuntime({
    store: new FlowStore({ root: join(root, ".flow/runtime") }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
    collaboration: new NoopCodeCollaborationAdapter(),
    projectRoot: root,
    readiness: { assess: assessIssue },
  });

  await runtime.createSession("dedupe-session");
  
  // Create first issue
  const firstOptions = {
    issueType: "Task",
    summary: "Fix authentication bug",
    description: "Users cannot login.",
  } satisfies CreateIssueOptions;
  await approveIssueIntake(runtime, "dedupe-session", firstOptions);
  const first = await runtime.createIssue("dedupe-session", firstOptions);
  assert.equal(first.ref, "FLOW-1");
  assert.equal(first.title, "Fix authentication bug");

  // Try to create duplicate - should return existing issue
  const duplicate = await runtime.createIssue("dedupe-session", {
    issueType: "Task",
    summary: "Fix authentication bug",
    description: "Different description.",
  });
  assert.equal(duplicate.ref, "FLOW-1");
  assert.equal(duplicate.title, "Fix authentication bug");

  // Verify only one issue exists in ledger
  const allIssues = await ledger.listIssues(100);
  assert.equal(allIssues.length, 1);
  assert.equal(allIssues[0].ref, "FLOW-1");
});

test("Issue intake dry-run proposes structured issue without creating", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-intake-dry-run-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
  });
  await runtime.createSession("intake-session");

  const result = await runtime.intakeIssue("intake-session", {
    issueType: "Task",
    summary: "Add SQLite workflow ledger",
    description: "Persist workflow state in SQLite before adding Postgres.",
    repoKeys: ["main"],
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.status, "ready");
  assert.equal(result.proposal.body.includes("## Problem"), true);
  assert.equal(result.proposal.body.includes("## Acceptance criteria"), true);
  assert.equal(result.proposal.tags.includes("lane-sql"), true);
  assert.equal((await ledger.listIssues(10)).length, 0);
});

test("Issue intake blocks vague apply requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-intake-vague-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
  });
  await runtime.createSession("intake-session");

  const dryRun = await runtime.intakeIssue("intake-session", {
    issueType: "Task",
    summary: "Fix",
    dryRun: true,
  });
  assert.equal(dryRun.status, "needs_input");
  assert.equal(dryRun.reasons.length > 0, true);

  await assert.rejects(
    runtime.intakeIssue("intake-session", {
      issueType: "Task",
      summary: "Fix",
      apply: true,
    }),
    /Issue intake needs more detail/,
  );
});

test("Issue intake can submit executor review job for semantic dedupe", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-intake-executor-"));
  const ledger = new MemoryWorkflowLedger();
  await ledger.writeIssue({
    ref: "FLOW-99",
    title: "Persist workflow state in SQLite",
    summary: "Existing semantic duplicate.",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
  });
  await runtime.createSession("intake-session");

  const result = await runtime.intakeIssue("intake-session", {
    issueType: "Task",
    summary: "Add a local database backed ledger",
    description: "Use SQLite for durable workflow state.",
    dryRun: true,
    review: true,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.reviewJob?.workType, "flow.issue_intake");
  assert.equal(result.reviewJob?.requiredCapabilities.includes("issue.intake"), true);
  assert.equal(JSON.stringify(result.reviewJob?.input).includes("FLOW-99"), true);
});

test("Issue creation requires completed executor intake review", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-intake-review-required-"));
  const ledger = new MemoryWorkflowLedger();
  const runtime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, projectName: "Flow" }),
  });
  await runtime.createSession("intake-session");

  try {
    await runtime.createIssue("intake-session", {
      issueType: "Task",
      summary: "Add SQLite workflow ledger",
      description: "Persist workflow state in SQLite before adding Postgres.",
      repoKeys: ["main"],
    });
    assert.fail("issue creation should require executor review");
  } catch (error) {
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message.includes("completed executor review"), true);
  }

  assert.equal((await ledger.listIssues(10)).length, 0);
  const intake = await runtime.intakeIssue("intake-session", {
    issueType: "Task",
    summary: "Add SQLite workflow ledger",
    description: "Persist workflow state in SQLite before adding Postgres.",
    repoKeys: ["main"],
    dryRun: true,
  });
  assert.equal(intake.reviewJob?.workType, "flow.issue_intake");

  await runtime.recordWorkJobResult("intake-session", {
    jobId: intake.reviewJob?.id ?? assert.fail("expected review job"),
    issueRef: intake.reviewJob?.issueRef ?? assert.fail("expected review issue ref"),
    repoKey: "main",
    workType: "flow.issue_intake",
    status: "succeeded",
    summary: "Executor approved issue intake.",
    evidence: ["Live executor reviewed duplicate candidates."],
    completedAt: nowIso(),
  });

  const created = await runtime.createIssue("intake-session", {
    issueType: "Task",
    summary: "Add SQLite workflow ledger",
    description: "Persist workflow state in SQLite before adding Postgres.",
    repoKeys: ["main"],
  });
  assert.equal(created.title, "Add SQLite workflow ledger");
});

test("Issue intake works through Flow CLI without creating during dry-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-intake-cli-"));
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
  const result = await callFlow({
    op: "issue",
    mode: "intake",
    dryRun: true,
    review: true,
    issueType: "Task",
    summary: "Add SQLite workflow ledger",
    description: "Persist workflow state in SQLite before adding Postgres.",
  });

  assert.equal(result.ok, true);
  const intake = result.result as { status: string; dryRun: boolean; reviewJob?: { workType: string }; proposal: { body: string; tags: string[] } };
  assert.equal(intake.dryRun, true);
  assert.equal(intake.status, "ready");
  assert.equal(intake.reviewJob?.workType, "flow.issue_intake");
  assert.equal(intake.proposal.body.includes("## Problem"), true);
  assert.equal(intake.proposal.tags.includes("lane-sql"), true);
});

test("Flow config builds the default work type registry when no work types are configured", () => {
  const baseConfig = flowConfigSchema.parse({
    version: "1",
    project: { name: "Example" },
    topology: { repos: { main: { name: "example" } } },
  });

  const defaultRegistry = configToWorkTypeRegistry(baseConfig);

  assert.equal(defaultRegistry.workTypeForCategory("implement"), "flow.implement");
  assert.equal(defaultRegistry.workTypeForCategory("remediate"), "flow.remediate");
  assert.equal(defaultRegistry.has("flow.issue_intake"), true);
  assert.equal(defaultRegistry.executorCanRun("live_agent_thread", "flow.implement", ["code.edit"]), true);
});

test("Flow config builds a custom work type registry from configured definitions", () => {
  const baseConfig = flowConfigSchema.parse({
    version: "1",
    project: { name: "Example" },
    topology: { repos: { main: { name: "example" } } },
  });

  const customRegistry = configToWorkTypeRegistry(flowConfigSchema.parse({
    ...baseConfig,
    workTypes: [
      {
        name: "project.fix",
        category: "implement",
        requiredCapabilities: ["code.edit"],
        allowedExecutors: ["live_agent_thread"],
        outputType: "worker_result",
      },
      {
        name: "project.verify",
        category: "verify",
        requiredCapabilities: ["test.run"],
        allowedExecutors: ["live_agent_thread"],
        outputType: "evidence_result",
      },
    ],
    executors: [{
      name: "live_agent_thread",
      capabilities: ["code.edit", "test.run"],
      outputs: ["worker_result", "evidence_result"],
    }],
  }));

  assert.equal(customRegistry.workTypeForCategory("implement"), "project.fix");
  assert.equal(customRegistry.workTypeForCategory("verify"), "project.verify");
  assert.equal(customRegistry.get("project.fix")?.outputType, "worker_result");
  assert.equal(customRegistry.executorCanRun("live_agent_thread", "project.fix", ["code.edit"]), true);
  assert.equal(customRegistry.executorCanRun("live_agent_thread", "project.verify", ["test.run"]), true);
});

test("Flow config work type registry falls back to the default executor definition", () => {
  const registry = configToWorkTypeRegistry(flowConfigSchema.parse({
    version: "1",
    project: { name: "Example" },
    topology: { repos: { main: { name: "example" } } },
    workTypes: [{
      name: "project.fix",
      category: "implement",
      requiredCapabilities: ["code.edit"],
      allowedExecutors: ["live_agent_thread"],
      outputType: "worker_result",
    }],
  }));

  assert.equal(registry.executorCanRun("live_agent_thread", "project.fix"), true);
  assert.equal(registry.executorCanRun("live_agent_thread", "project.fix", ["deploy.prod"]), false);
  assert.deepEqual(registry.getExecutor("live_agent_thread")?.canSubmit, ["project.fix"]);
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

function expectRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

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

test("Work envelopes parse nested metadata, arrays, booleans, nulls, and quoted scalars", () => {
  const envelope = parseWorkEnvelope(`---
workType: flow.implement
issueRef: ISSUE-125
repoKey: app_api
executionMode: background
metadata:
  review:
    required: true
    owner: "agent:pi"
    blocker: null
  tags: ["coverage", 'edge:case', true, null, 42]
---

Implement the nested metadata case.
`);

  const review = expectRecord(envelope.metadata.review);
  assert.equal(review.required, true);
  assert.equal(review.owner, "agent:pi");
  assert.equal(review.blocker, null);
  assert.deepEqual(envelope.metadata.tags, ["coverage", "edge:case", true, null, 42]);
});

test("Work envelopes reject malformed frontmatter lines without a colon", () => {
  assert.throws(
    () => parseWorkEnvelope(`---
workType: flow.implement
issueRef ISSUE-126
repoKey: app_api
---

Body.
`),
    /Invalid work envelope frontmatter line: issueRef ISSUE-126/,
  );
});

test("Work envelopes reject an empty body after valid frontmatter", () => {
  assert.throws(
    () => parseWorkEnvelope(`---
workType: flow.implement
issueRef: ISSUE-127
repoKey: app_api
executionMode: background
---
`),
    /expected string to have >=1 characters/,
  );
});

test("Work envelopes preserve quoted strings with special characters", () => {
  const envelope = parseWorkEnvelope(`---
workType: flow.remediate
issueRef: ISSUE-128
repoKey: public_api
executionMode: local_thread
metadata:
  command: "npm run test:fast -- test/work-envelope.test.ts"
  path: 'src/work-envelope.ts:42'
---

Handle quoted punctuation.
`);

  assert.equal(envelope.metadata.command, "npm run test:fast -- test/work-envelope.test.ts");
  assert.equal(envelope.metadata.path, "src/work-envelope.ts:42");
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
  assert.equal(result.session.pendingConfirmation?.action, "request_execution");
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

test("Work Runtime prepares workspace before handoff confirmation", async () => {
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
  assert.equal(approved.handoffRequest?.workspacePath, "/repo/app-api/.worktrees/feature-issue-21-prepare-workspace");
  assert.match(approved.handoffRequest?.prompt ?? "", /Prepared workspace: \/repo\/app-api\/.worktrees/);
});

test("Work Runtime records actual existing worktree path returned by source control", async () => {
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
        return {
          branch: plan.branch,
          headSha: "existing-sha",
          dirty: false,
          entries: [],
          worktreePath: "/repo/app-api/.worktrees/existing-branch-worktree",
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-existing-worktree");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-210",
    title: "Existing workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const prepared = await workRuntime.prepareWorkspace(session.id, "ISSUE-210", { repoKey: "app_api" });

  assert.equal(
    prepared.metadata["workflow.repos.app_api.worktree_path"],
    "/repo/app-api/.worktrees/existing-branch-worktree",
  );
  assert.equal(prepared.metadata.work_dir, "/repo/app-api/.worktrees/existing-branch-worktree");
});

test("Work Runtime adopts an existing worktree into issue metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    sourceControl: {
      async inspect(repoPath) {
        assert.equal(repoPath, "/repo/app-api/.worktrees/feature-issue-3026");
        return {
          branch: "feature/issue-3026",
          headSha: "adopted-sha",
          dirty: true,
          entries: [" M src/app.ts"],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-adopt-workspace");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-3026",
    title: "Adopt workspace",
    repoKeys: ["app_api"],
    state: "queued",
    metadata: { branchKind: "feature" },
  });

  const adopted = await workRuntime.adoptWorkspace(session.id, "ISSUE-3026", {
    repoKey: "app_api",
    worktreePath: "/repo/app-api/.worktrees/feature-issue-3026",
  });
  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(adopted.metadata["workflow.repos.app_api.worktree_path"], "/repo/app-api/.worktrees/feature-issue-3026");
  assert.equal(adopted.metadata["workflow.repos.app_api.branch"], "feature/issue-3026");
  assert.equal(adopted.metadata["workflow.repos.app_api.head_sha"], "adopted-sha");
  assert.equal(adopted.metadata["workflow.repos.app_api.dirty"], true);
  assert.notEqual(advanced.message, "Prepare workspace for ISSUE-3026 in app_api.");
});

test("Work Runtime adopts a branch as stealth-mode Flow work", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
    sourceControl: {
      async inspect(repoPath) {
        assert.equal(repoPath, "/repo/public-api");
        return {
          branch: "work/spike-local-work",
          headSha: "branch-sha",
          dirty: false,
          entries: [],
          worktreePath: "/repo/public-api",
        };
      },
    },
    issueTracker: {
      async viewIssue() {
        throw new Error("external issue tracker should not be read for branch adoption");
      },
    },
  });
  const session = await workRuntime.createSession("session-adopt-branch");

  const adopted = await workRuntime.adoptBranch(session.id, {
    repoKey: "public_api",
    worktreePath: "/repo/public-api",
    summary: "Spike local work",
  });
  const selected = await workRuntime.summarizeHandoff(session.id);

  assert.equal(adopted.ref, "FLOW-1");
  assert.equal(adopted.title, "Spike local work");
  assert.deepEqual(adopted.repoKeys, ["public_api"]);
  assert.equal(adopted.metadata["workflow.issue.origin"], "branch");
  assert.equal(adopted.metadata["workflow.external.issue.status"], "unpublished");
  assert.equal(adopted.metadata["workflow.external.code_review.status"], "unpublished");
  assert.equal(adopted.metadata["workflow.repos.public_api.branch"], "work/spike-local-work");
  assert.equal(adopted.metadata["workflow.repos.public_api.head_sha"], "branch-sha");
  assert.match(selected, /FLOW-1: Spike local work/);
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
  assert.equal(queue[0].metadata.issueStatus, "Ready for Dev");
  assert.equal(queue[0].metadata.issueType, "story");
  assert.equal(queue[0].metadata.jiraStatus, undefined);
});

test("Work Runtime inspects a configured issue tracker issue without writing ledger state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: "/repo",
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
          title: "Provider issue view",
          status: "Ready for Dev",
          statusCategory: "To Do",
          type: "story",
          url: `https://tracker.example/${ref}`,
          labels: ["app-api"],
        };
      },
    },
  });

  const issue = await workRuntime.inspectIssue("ISSUE-901");
  const stored = await ledger.readIssue("ISSUE-901");

  assert.equal(issue.ref, "ISSUE-901");
  assert.equal(issue.title, "Provider issue view");
  assert.deepEqual(issue.repoKeys, ["app_api"]);
  assert.equal(issue.metadata.issueStatus, "Ready for Dev");
  assert.equal(stored, undefined);
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
    issueTracker: {
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
    issueTracker: {
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

  const options = {
    issueType: "Bug",
    summary: "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema",
    description: "Follow-up from ISSUE-15461.",
    repoKeys: ["app_api"],
  } satisfies CreateIssueOptions;
  await approveIssueIntake(workRuntime, session.id, options);
  const issue = await workRuntime.createJiraIssue(session.id, options);
  const selectedSession = await store.readSession(session.id);

  const jiraCreatedInput = createdInput as { projectKey?: string; issueType?: string; summary?: string; description?: string; title?: string };
  assert.equal(jiraCreatedInput.projectKey, "ISSUE");
  assert.equal(jiraCreatedInput.issueType, "Bug");
  assert.equal(jiraCreatedInput.summary, "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema");
  assert.equal(jiraCreatedInput.title, "GeoParquet Provider ETL fails on GeoArrow WKB parquet schema");
  assert.equal(jiraCreatedInput.description?.includes("## Problem"), true);
  assert.equal(issue.ref, "ISSUE-15738");
  assert.equal(issue.metadata.jiraIssueType, "Bug");
  assert.deepEqual(issue.metadata.jiraLabels, []);
  assert.deepEqual(issue.repoKeys, ["app_api"]);
  assert.equal(selectedSession?.selectedIssueRef, "ISSUE-15738");
});

test("Work Runtime creates provider-neutral issues without requiring a Jira project key", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  let createdInput: unknown;
  const workRuntime = new FlowWorkRuntime({
    store,
    ledger,
    topology: legacyHostTopology,
    issueTracker: {
      capabilities: {
        canCreateIssues: true,
        canTransitionIssues: false,
        canPostComments: false,
        canManageActivePlanningLane: false,
      },
      async getIssue(ref) {
        return {
          ref,
          title: "Harden Flow issue creation",
          type: "task",
          status: "Open",
          statusCategory: "To Do",
          url: `https://github.com/example/flow/issues/${ref.replace("GH-", "")}`,
          labels: [],
        };
      },
      async createIssue(input) {
        createdInput = input;
        return {
          ref: "GH-15738",
          title: input.summary,
          description: input.description,
          type: input.issueType.toLowerCase(),
          status: "Open",
          statusCategory: "To Do",
          url: "https://github.com/example/flow/issues/15738",
          labels: [],
        };
      },
    },
  });
  const session = await workRuntime.createSession("session-create-provider-neutral");

  const options = {
    issueType: "Task",
    summary: "Harden Flow issue creation",
    description: "Provider-neutral issue creation should not require Jira config.",
    repoKeys: ["main"],
  } satisfies CreateIssueOptions;
  await approveIssueIntake(workRuntime, session.id, options);
  const issue = await workRuntime.createIssue(session.id, options);

  const neutralCreatedInput = createdInput as { projectKey?: string; issueType?: string; summary?: string; description?: string; title?: string };
  assert.equal(neutralCreatedInput.projectKey, undefined);
  assert.equal(neutralCreatedInput.issueType, "Task");
  assert.equal(neutralCreatedInput.summary, "Harden Flow issue creation");
  assert.equal(neutralCreatedInput.title, "Harden Flow issue creation");
  assert.equal(neutralCreatedInput.description?.includes("## Problem"), true);
  assert.equal(issue.ref, "GH-15738");
  assert.equal(issue.metadata.issueType, "task");
  assert.equal(issue.metadata.jiraIssueType, undefined);
  assert.deepEqual(issue.repoKeys, ["main"]);
});

test("GitHub issue creation keeps structured descriptions in the issue body", () => {
  const body = githubIssueCreateBody({
    summary: "Add first-class Flow review command",
    description: "## Problem\nDetailed issue body.",
  });

  assert.equal(body, "## Problem\nDetailed issue body.");
  assert.equal(githubIssueCreateBody({ summary: "Fallback summary" }), "Fallback summary");
});

test("Work Runtime keeps local provider issue metadata provider-neutral", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const store = new FlowStore({ root });
  const workRuntime = new FlowWorkRuntime({
    store,
    ledger,
    issueTracker: new LocalIssueTrackerAdapter({ ledger, prefix: "FLOW" }),
  });
  const session = await workRuntime.createSession("session-create-local");

  const options = {
    issueType: "Task",
    summary: "Local provider metadata",
  } satisfies CreateIssueOptions;
  await approveIssueIntake(workRuntime, session.id, options);
  const issue = await workRuntime.createIssue(session.id, options);

  assert.equal(issue.ref, "FLOW-1");
  assert.equal(issue.metadata.issueStatus, "To Do");
  assert.equal(issue.metadata.issueType, "Task");
  assert.equal(issue.metadata.issueUrl, "flow://local/issues/FLOW-1");
  assert.equal(issue.metadata["workflow.external.issue.status"], "unpublished");
  assert.equal(issue.metadata["workflow.external.code_review.status"], "unpublished");
  assert.equal(issue.metadata.jiraStatus, undefined);
  assert.equal(issue.metadata.jiraIssueType, undefined);
  assert.equal(issue.metadata.jiraUrl, undefined);

  await ledger.writeIssue({
    ref: "FLOW-2",
    title: "Legacy local metadata",
    repoKeys: [],
    state: "queued",
    metadata: {
      jiraStatus: "To Do",
      jiraIssueType: "Task",
      jiraUrl: "flow://local/issues/FLOW-2",
    },
  });

  const legacyIssue = (await workRuntime.inspectQueue(10)).find((candidate) => candidate.ref === "FLOW-2");
  assert.equal(legacyIssue?.metadata.issueStatus, "To Do");
  assert.equal(legacyIssue?.metadata.issueType, "Task");
  assert.equal(legacyIssue?.metadata.issueUrl, "flow://local/issues/FLOW-2");
  assert.equal(legacyIssue?.metadata["workflow.external.issue.status"], "unpublished");
  assert.equal(legacyIssue?.metadata.jiraStatus, undefined);
  assert.equal(legacyIssue?.metadata.jiraIssueType, undefined);
  assert.equal(legacyIssue?.metadata.jiraUrl, undefined);
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
    issueTracker: {
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
    issueTracker: {
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
    issueTracker: {
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
    issueTracker: {
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
    issueTracker: {
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
    issueTracker: {
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
    issueTracker: {
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

test("Work Runtime approval creates a handoff request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-approve");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-3",
    title: "Create handoff",
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

  assert.equal(approved.status, "execution_handoff");
  assert.equal(approved.handoffRequest?.issueRef, "ISSUE-3");
  assert.ok(approved.handoffRequest?.workJobId);
  assert.match(approved.handoffRequest?.prompt ?? "", /Use Flow to work this prompt/);
  const jobs = await workRuntime.listWorkJobs(session.id, "ISSUE-3");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.implement");
  assert.equal(jobs[0].status, "queued");
  assert.equal(approved.handoffRequest?.workJobId, jobs[0].id);
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
    sourceControl: {
      async inspect() {
        return { branch: "bug/issue-15738-geoparquet-provider-etl-fails", headSha: "abc123", dirty: false, entries: [] };
      },
      async prepareWorktree(plan: any) {
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
    sourceControl: {
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
    sourceControl: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan: any) {
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
    issueTracker: {
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
    sourceControl: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan: any) {
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
  const ledger = createWorkflowLedger({ cwd: root });
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

  const reloaded = createWorkflowLedger({ cwd: root });
  assert.equal((await reloaded.readIssue("ISSUE-90"))?.title, "Native ledger");
  assert.equal((await reloaded.listWorkerResults("ISSUE-90"))[0]?.taskId, "worker-90");
  const projection = JSON.parse(await readFile(flowIssueProjectionPath(root, "ISSUE-90"), "utf8"));
  assert.equal(projection.issue.title, "Native ledger");
  assert.equal(projection.workerRuns[0].taskId, "worker-90");
  assert.equal(projection.workerResults[0].taskId, "worker-90");
});

test("Flow context records validate prompt routing metadata", () => {
  const now = nowIso();
  const record = flowContextRecordSchema.parse({
    kind: "prompt",
    id: "prompt-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    sessionId: "session-1",
    artifactRefs: ["artifact-1"],
    prompt: "Render the artifact canvas.",
    target: "artifact",
    summary: "Canvas prompt",
    createdAt: now,
    updatedAt: now,
  });

  assert.equal(record.kind, "prompt");
  assert.equal(record.projectId, "flow");
  assert.equal(record.issueRef, "ISSUE-58");
  assert.equal(record.threadId, "thread-1");
  assert.equal(record.sessionId, "session-1");
  assert.deepEqual(record.artifactRefs, ["artifact-1"]);
});

test("Workflow ledger persists prompt, thread, session, and artifact context", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-context-ledger-"));
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.recordContext);
  assert.ok(ledger.readContext);
  const now = nowIso();

  await ledger.recordContext({
    kind: "thread",
    id: "thread-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    title: "Desktop canvas direction",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  await ledger.recordContext({
    kind: "session",
    id: "session-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    provider: "pi",
    workspacePath: root,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  await ledger.recordContext({
    kind: "artifact",
    id: "artifact-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    sessionId: "session-1",
    artifactType: "html",
    title: "Dashboard preview",
    uri: "artifact://artifact-1",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
  await ledger.recordContext({
    kind: "prompt",
    id: "prompt-1",
    projectId: "flow",
    issueRef: "ISSUE-58",
    threadId: "thread-1",
    sessionId: "session-1",
    artifactRefs: ["artifact-1"],
    prompt: "Improve the dashboard preview.",
    target: "artifact",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });

  const reloaded = createWorkflowLedger({ cwd: root });
  assert.ok(reloaded.readContext);
  const projection = await reloaded.readContext({ projectId: "flow" });
  const storedProjection = JSON.parse(await readFile(flowContextProjectionPath(root), "utf8"));

  assert.equal(projection.active.projectId, "flow");
  assert.equal(projection.active.threadId, "thread-1");
  assert.equal(projection.active.sessionId, "session-1");
  assert.equal(projection.active.artifactId, "artifact-1");
  assert.equal(projection.threads[0].title, "Desktop canvas direction");
  assert.equal(projection.sessions[0].provider, "pi");
  assert.equal(projection.artifacts[0].artifactType, "html");
  assert.equal(projection.prompts[0].prompt, "Improve the dashboard preview.");
  assert.equal(storedProjection.prompts[0].id, "prompt-1");
});

test("Flow workflow ledger verification rebuilds issue projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ledger-"));
  const ledger = createWorkflowLedger({ cwd: root });
  await ledger.writeIssue({
    ref: "ISSUE-91",
    title: "Projection rebuild",
    repoKeys: ["main"],
    state: "queued",
    metadata: {},
  });
  await writeFile(flowIssueProjectionPath(root, "ISSUE-91"), "{\"issue\":{\"title\":\"stale\"}}\n", "utf8");

  const result = await verifyJsonlWorkflowLedger(join(root, ".flow", "ledger", "workflow.jsonl"), {
    rebuildProjections: true,
  });
  const projection = JSON.parse(await readFile(flowIssueProjectionPath(root, "ISSUE-91"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.validRecords, 1);
  assert.equal(result.rebuiltProjections, 1);
  assert.equal(projection.issue.title, "Projection rebuild");
});

test("Flow workflow ledger verification rebuilds context projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-context-rebuild-"));
  const ledger = createWorkflowLedger({ cwd: root });
  assert.ok(ledger.recordContext);
  await ledger.recordContext({
    kind: "thread",
    id: "thread-rebuild",
    projectId: "flow",
    title: "Rebuild context projection",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    metadata: {},
  });
  await writeFile(flowContextProjectionPath(root), "{\"threads\":[]}\n", "utf8");

  const result = await verifyJsonlWorkflowLedger(join(root, ".flow", "ledger", "workflow.jsonl"), {
    rebuildProjections: true,
  });
  const projection = JSON.parse(await readFile(flowContextProjectionPath(root), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.validRecords, 1);
  assert.equal(result.rebuiltProjections, 1);
  assert.equal(projection.threads[0].id, "thread-rebuild");
});

test("Flow workflow ledger verification reports malformed records", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-ledger-"));
  const ledgerPath = join(root, ".flow", "ledger", "workflow.jsonl");
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, "{\"kind\":\"unknown\",\"value\":{}}\nnot-json\n", "utf8");

  const result = await verifyJsonlWorkflowLedger(ledgerPath, { rebuildProjections: true });

  assert.equal(result.ok, false);
  assert.equal(result.invalidRecords, 2);
  assert.equal(result.rebuiltProjections, 0);
  assert.match(result.diagnostics[0].message, /Unsupported ledger record kind/);
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
    claimedBy: "live_agent_thread",
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
  assert.equal(jobs[0].claimedBy, "live_agent_thread");
  assert.equal(results.length, 1);
  assert.equal(results[0].summary, "Done");
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
  assert.match(result.message, /Execution handoff is already active/);
  assert.equal(jobs.length, 0);
  assert.equal(queue.find((issue) => issue.ref === "ISSUE-71")?.workStatus, "Running");
});

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

test("Work Runtime blocked handoff includes copy-ready handoff prompt", async () => {
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
  assert.match(advanced.message, /Copy-ready handoff prompt/);
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
    summary: "Agent handoff could not find provider credentials.",
    changedFiles: [],
    testsRun: [],
    blockers: ["Agent handoff could not find provider credentials."],
    nextPickup: "Configure credentials, then undraft PR #1406.",
    handoffPrompt: "Convert PR https://github.com/ExampleOrg/app-api/pull/1406 from draft to ready for review.",
    completedAt: nowIso(),
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.status, "blocked");
  assert.match(advanced.message, /Auto review requires confirmation/);
  assert.doesNotMatch(advanced.message, /1406/);
  assert.doesNotMatch(advanced.message, /provider credentials/);
  assert.doesNotMatch(advanced.message, /Copy-ready handoff prompt/);
});

test("Work Runtime synthesizes paste-ready handoff for existing blocked handoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-legacy-blocked-handoff");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-78",
    title: "Existing blocked handoff",
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
  assert.match(advanced.message, /Copy-ready handoff prompt/);
  assert.match(advanced.message, /Use Flow to work this prompt/);
  assert.doesNotMatch(advanced.message, /Direct Jira\/GitHub/);
  assert.match(advanced.message, /feature-issue-78/);
  assert.match(advanced.message, /Requested work/);
});

test("Work Runtime lets a live agent thread adopt and close a handoff run", async () => {
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
    summary: "Live thread completed the handoff assignment.",
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

test("Work Runtime adopts the pending handoff request into a live thread", async () => {
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

  const request = await workRuntime.adoptPendingLiveWorker(session.id, { adopter: "agent-thread" });
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
  assert.match(runs[0].summary ?? "", /agent-thread/);
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

  const request = await workRuntime.adoptPendingLiveWorker(session.id, { adopter: "agent-thread" });
  await workRuntime.recordWorkerResult(session.id, {
    taskId: request.id,
    issueRef: request.issueRef,
    repoKey: request.repoKey,
    executor: "live_agent_thread",
    status: "succeeded",
    summary: "Agent thread completed the handoff assignment.",
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

test("Work Runtime records current local thread against a pending handoff request", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-agent-handoff-result");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-33",
    title: "Agent handoff result",
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
  assert.equal(requested.status, "execution_handoff");

  const record = await workRuntime.recordLocalThreadResult(session.id, {
    issueRef: "ISSUE-33",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Agent thread completed the handoff assignment.",
    changedFiles: ["src/work-runtime.ts"],
    testsRun: ["npm test"],
  });

  const results = await ledger.listWorkerResults("ISSUE-33");
  const runs = await ledger.listWorkerRuns("ISSUE-33");
  const jobs = await ledger.listWorkJobs("ISSUE-33");
  const jobResults = await ledger.listWorkJobResults("ISSUE-33");
  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(record.result.taskId, requested.handoffRequest?.id);
  assert.equal(record.result.workJobId, requested.handoffRequest?.workJobId);
  assert.equal(record.result.executor, "live_agent_thread");
  assert.deepEqual(record.nextJsonCommands?.map((command) => command.request.mode), [
    "recordEvidence",
    "recordPullRequest",
    "observe",
    "advance",
  ]);
  assert.deepEqual(record.nextJsonCommands?.[0]?.request, {
    op: "workflow",
    mode: "recordEvidence",
    id: "ISSUE-33",
    summary: "<verification summary>",
    criteria: ["<acceptance criterion>"],
  });
  assert.equal(results[0].executor, "live_agent_thread");
  assert.equal(runs.at(-1)?.status, "succeeded");
  assert.equal(jobs[0].claimedBy, "live_agent_thread");
  assert.equal(jobs[0].status, "succeeded");
  assert.equal(jobResults[0].workerResult?.taskId, requested.handoffRequest?.id);
  assert.notEqual(advanced.session.pendingConfirmation?.action, "request_execution");
});

test("Work Runtime reports next JSON commands for active handoffs in observe", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-observe-json-commands-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-observe-json-commands");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-34",
    title: "Observe JSON commands",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-issue-34",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const requested = await workRuntime.advanceIssue(session.id, confirmationId);
  const observed = await workRuntime.observeFlowSubject({ ref: "ISSUE-34" });

  assert.equal(requested.status, "execution_handoff");
  assert.deepEqual(requested.nextJsonCommands?.[0]?.request, {
    op: "workflow",
    mode: "recordResult",
    id: "ISSUE-34",
    repoKey: "app_api",
    taskId: requested.handoffRequest?.id,
    workJobId: requested.handoffRequest?.workJobId,
    status: "succeeded",
    summary: "<summary>",
    changedFiles: [],
    testsRun: [],
  });
  assert.deepEqual(observed.nextJsonCommands?.[0]?.request, requested.nextJsonCommands?.[0]?.request);
});

test("Work Runtime retries retryable executor setup failures without recreating the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-retry-executor-setup");
  const workspacePath = "/repo/app-api/.worktrees/bug-gh-376";
  await workRuntime.selectIssue(session.id, {
    ref: "GH-376",
    title: "Retry executor setup",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": workspacePath,
    },
  });

  const firstPending = await workRuntime.advanceIssue(session.id);
  const firstConfirmationId = firstPending.session.pendingConfirmation?.id;
  assert.ok(firstConfirmationId);
  const firstApproved = await workRuntime.advanceIssue(session.id, firstConfirmationId);
  assert.equal(firstApproved.status, "execution_handoff");
  assert.ok(firstApproved.handoffRequest?.workJobId);
  assert.ok(firstApproved.handoffRequest?.id);

  await workRuntime.recordLocalThreadResult(session.id, {
    issueRef: "GH-376",
    repoKey: "app_api",
    taskId: firstApproved.handoffRequest.id,
    workJobId: firstApproved.handoffRequest.workJobId,
    status: "failed",
    summary: "Executor setup failed: @earendil-works/pi-coding-agent could not be imported.",
    blockers: ["Install @earendil-works/pi-coding-agent, then retry the handoff."],
  });

  const doctor = await workRuntime.diagnoseIssue(session.id);
  assert.equal(doctor.nextAction.type, "retry_execution");
  assert.match(doctor.nextAction.summary, /Retry the execution handoff/);

  const retryPending = await workRuntime.advanceIssue(session.id);
  const retryConfirmationId = retryPending.session.pendingConfirmation?.id;
  assert.equal(retryPending.status, "needs_confirmation");
  assert.equal(retryPending.session.pendingConfirmation?.action, "request_execution");
  assert.ok(retryConfirmationId);
  const retryApproved = await workRuntime.advanceIssue(session.id, retryConfirmationId);
  assert.equal(retryApproved.status, "execution_handoff");
  assert.ok(retryApproved.handoffRequest?.workJobId);

  const jobs = await ledger.listWorkJobs("GH-376");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[1].status, "queued");
  assert.equal(jobs[0].input.workspacePath, workspacePath);
  assert.equal(jobs[1].input.workspacePath, workspacePath);
  assert.equal((await ledger.readIssue("GH-376"))?.metadata["workflow.repos.app_api.worktree_path"], workspacePath);
});

test("Work Runtime doctor treats blocked execution jobs without Worker results as retryable handoff failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-retry-blocked-job");
  const workspacePath = "/repo/app-api/.worktrees/bug-gh-378";
  await workRuntime.selectIssue(session.id, {
    ref: "GH-378",
    title: "Retry raw blocked work job",
    repoKeys: ["app_api"],
    state: "selected",
    metadata: {
      "workflow.repos.app_api.worktree_path": workspacePath,
    },
  });
  const job = await workRuntime.submitWorkEnvelope(session.id, {
    issueRef: "GH-378",
    repoKey: "app_api",
    workType: "flow.implement",
    executionMode: "local_thread",
    body: "Use Flow to work this prompt.",
    metadata: {
      workspacePath,
      handoffTaskId: "worker-gh-378",
    },
    requiredCapabilities: [],
  });
  const completedAt = nowIso();
  await ledger.recordWorkJob({
    ...job,
    status: "blocked",
    claimedBy: "live_agent_thread",
    claimedAt: completedAt,
    updatedAt: completedAt,
    completedAt,
  });
  await ledger.recordWorkJobResult({
    jobId: job.id,
    issueRef: "GH-378",
    repoKey: "app_api",
    workType: "flow.implement",
    status: "blocked",
    summary: "Autoflow worker session stalled after reading large source files.",
    evidence: ["Flow status reported idle while the work job remained running."],
    completedAt,
  });

  const doctor = await workRuntime.diagnoseIssue(session.id);
  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(doctor.nextAction.type, "retry_execution");
  assert.equal(advanced.status, "needs_confirmation");
  assert.equal(advanced.session.pendingConfirmation?.action, "request_execution");
});

test("Work Runtime keeps non-retryable worker failures blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-nonretryable-worker-failure");
  await workRuntime.selectIssue(session.id, {
    ref: "GH-377",
    title: "Non-retryable worker failure",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/bug-gh-377",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);
  assert.equal(approved.status, "execution_handoff");
  assert.ok(approved.handoffRequest?.workJobId);
  assert.ok(approved.handoffRequest?.id);

  await workRuntime.recordLocalThreadResult(session.id, {
    issueRef: "GH-377",
    repoKey: "app_api",
    taskId: approved.handoffRequest.id,
    workJobId: approved.handoffRequest.workJobId,
    status: "failed",
    summary: "Tests failed.",
    blockers: ["npm test failed."],
    testsRun: ["npm test"],
  });

  const blocked = await workRuntime.advanceIssue(session.id);
  const jobs = await ledger.listWorkJobs("GH-377");

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.session.pendingConfirmation, undefined);
  assert.match(blocked.message, /npm test failed/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed");
});

test("AutoflowService retries a targeted blocked issue when the latest failure is retryable", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: new NoopCodeCollaborationAdapter(),
  });
  const session = await workRuntime.createSession("session-autoflow-targeted-retry");
  const workspacePath = "/repo/app-api/.worktrees/bug-gh-376";
  await workRuntime.selectIssue(session.id, {
    ref: "GH-376",
    title: "Targeted Autoflow retry",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      "workflow.repos.app_api.worktree_path": workspacePath,
    },
  });

  const firstPending = await workRuntime.advanceIssue(session.id);
  const firstConfirmationId = firstPending.session.pendingConfirmation?.id;
  assert.ok(firstConfirmationId);
  const firstApproved = await workRuntime.advanceIssue(session.id, firstConfirmationId);
  assert.ok(firstApproved.handoffRequest?.id);
  assert.ok(firstApproved.handoffRequest?.workJobId);
  await workRuntime.recordLocalThreadResult(session.id, {
    issueRef: "GH-376",
    repoKey: "app_api",
    taskId: firstApproved.handoffRequest.id,
    workJobId: firstApproved.handoffRequest.workJobId,
    status: "failed",
    summary: "Executor setup failed: Pi SDK import failed.",
    blockers: ["@earendil-works/pi-coding-agent is installed incorrectly."],
  });

  const service = new AutoflowService({
    projectId: "flow",
    runtime: workRuntime,
    agentSessionDriver: {
      async getSession() {
        return {
          id: "agent-gh-376",
          workspacePath,
          status: "done",
          timeline: [],
        };
      },
      async openOrCreateIssueSession() {
        return {
          id: "agent-gh-376",
          workspacePath,
          status: "active",
          timeline: [],
        };
      },
      async sendUserMessage() {
        return {
          id: "agent-gh-376",
          workspacePath,
          status: "done",
          summary: "Implemented and committed GH-376.",
          timeline: [],
        };
      },
      async postPrompt() {
        return {
          id: "agent-gh-376",
          workspacePath,
          status: "done",
          summary: "Implemented and committed GH-376.",
          timeline: [
            {
              id: "tool-edit",
              role: "tool",
              toolName: "apply_patch",
              content: "edited",
              diff: { path: "src/work-runtime.ts" },
              createdAt: nowIso(),
            },
            {
              id: "tool-test",
              role: "tool",
              toolName: "npm test",
              content: "tests passed",
              createdAt: nowIso(),
            },
            {
              id: "tool-commit",
              role: "tool",
              toolName: "git",
              content: "commit abc123",
              createdAt: nowIso(),
            },
            {
              id: "assistant-done",
              role: "assistant",
              content: "Implemented and committed GH-376.",
              createdAt: nowIso(),
            },
          ],
        };
      },
    },
    autoReconcileOnSlotAvailable: false,
  });

  const started = await service.reconcile({ issueRefs: ["GH-376"] });
  assert.equal(started.activeCount, 1);
  const status = await service.waitForIdle();
  const jobs = await ledger.listWorkJobs("GH-376");
  const results = await ledger.listWorkerResults("GH-376");

  assert.equal(status.issues["GH-376"]?.phase, "idle");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[1].status, "succeeded");
  assert.equal(results.at(-1)?.status, "succeeded");
  assert.equal(results.at(-1)?.workJobId, jobs[1].id);
  assert.equal((await ledger.readIssue("GH-376"))?.state, "awaiting_review");
});

test("Work Runtime routes and prepares main work in the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "host-root-"));
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger: new MemoryWorkflowLedger(),
    projectRoot,
    sourceControl: {
      async inspect() {
        throw new Error("unused");
      },
      async prepareWorktree(plan: any) {
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
  assert.equal(
    prepared.metadata["workflow.repos.main.worktree_path"],
    `${projectRoot.replace(/\\/g, "/")}/.worktrees/feature-issue-31-flow-root-work`,
  );
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
    issueTracker: {
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
  let pruned: { repoPath: string; worktreePath: string; branch?: string; requireClean?: boolean } | undefined;
  let prMerged = false;
  let jiraReads = 0;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    sourceControl: {
      async inspect(repoPath) {
        return { branch: "feature/ISSUE-19-closeout", headSha: "abc123", dirty: false, entries: [], worktreePath: repoPath };
      },
      async pruneWorktree(input) {
        pruned = input;
        return { removed: true, worktreePath: input.worktreePath, branch: input.branch };
      },
    },
    collaboration: {
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
    issueTracker: {
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
      "workflow.repos.app_api.branch": "feature/ISSUE-19-closeout",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-19-closeout",
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
  assert.deepEqual(pruned, {
    repoPath: join(root, "app-api").replaceAll("\\", "/"),
    worktreePath: "/repo/app-api/.worktrees/feature-ISSUE-19-closeout",
    branch: "feature/ISSUE-19-closeout",
    requireClean: true,
  });
  assert.deepEqual(result.prunedWorktrees, [{
    repoKey: "app_api",
    removed: true,
    reason: undefined,
    worktreePath: "/repo/app-api/.worktrees/feature-ISSUE-19-closeout",
    branch: "feature/ISSUE-19-closeout",
  }]);
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

test("Work Runtime advance closes out review-ready PRs without requesting execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let prMerged = false;
  let pruned = false;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    projectRoot: root,
    sourceControl: {
      async inspect(repoPath) {
        return { branch: "feature/ISSUE-20-closeout", headSha: "def456", dirty: false, entries: [], worktreePath: repoPath };
      },
      async pruneWorktree() {
        pruned = true;
        return { removed: true, worktreePath: "/repo/app-api/.worktrees/feature-ISSUE-20-closeout", branch: "feature/ISSUE-20-closeout" };
      },
    },
    collaboration: {
      async findPullRequests() {
        return [];
      },
      async getPullRequest(repo, number) {
        return {
          repo,
          number,
          title: "Closeout PR",
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          headRefName: "feature/ISSUE-20-closeout",
          state: prMerged ? "MERGED" : "OPEN",
          mergedAt: prMerged ? "2026-05-15T15:00:00Z" : undefined,
          mergeCommitSha: prMerged ? "def456" : undefined,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          checksPassing: true,
          autoReviewStatus: "passed",
          autoReviewMustFix: false,
        };
      },
      async mergePullRequest(repo, number) {
        assert.equal(repo, "app-api");
        assert.equal(number, 20);
        prMerged = true;
        return {
          url: "https://github.com/ExampleOrg/app-api/pull/20",
          mergedAt: "2026-05-15T15:00:00Z",
          mergeCommitSha: "def456",
        };
      },
    },
    issueTracker: {
      async viewIssue(key) {
        return {
          key,
          summary: "Closeout issue",
          status: prMerged ? "Closed" : "In Review",
          statusCategory: prMerged ? "Done" : "In Progress",
          labels: [],
        };
      },
      async postIssueComment(_key, body) {
        return { body };
      },
    },
  });
  const session = await workRuntime.createSession("session-advance-closeout");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-20",
    title: "Advance closeout",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 20,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/20",
      prIsDraft: false,
      prChecksPassing: true,
      prAutoReviewStatus: "passed",
      "workflow.repos.app_api.branch": "feature/ISSUE-20-closeout",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-20-closeout",
      evidenceRecorded: true,
      evidenceSummary: "Acceptance criteria passed.",
      evidenceSource: "npm test",
      documentationRecorded: true,
      documentationDisposition: "not_needed",
      documentationSummary: "No docs needed.",
    },
  });
  await workRuntime.recordLocalThreadResult(session.id, {
    issueRef: "ISSUE-20",
    repoKey: "app_api",
    status: "succeeded",
    summary: "Implemented closeout work.",
    changedFiles: ["src/work-runtime.ts"],
    testsRun: ["npm test"],
  });

  const advanced = await workRuntime.advanceIssue(session.id);

  assert.equal(advanced.session.pendingConfirmation, undefined);
  assert.equal(advanced.issue?.state, "done");
  assert.match(advanced.message, /closeout completed/);
  assert.equal(pruned, true);
});

test("Work Runtime records preserved worktrees when closeout prune refuses dirty work", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect(repoPath) {
        return { branch: "feature/ISSUE-21-closeout", headSha: "abc123", dirty: true, entries: [" M src/app.ts"], worktreePath: repoPath };
      },
      async pruneWorktree(input) {
        return { removed: false, reason: "worktree is dirty", worktreePath: input.worktreePath, branch: input.branch };
      },
    },
    collaboration: {
      async findPullRequests() {
        return [];
      },
      async getPullRequest(repo, number) {
        return {
          repo,
          number,
          title: "Already merged",
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          headRefName: "feature/ISSUE-21-closeout",
          state: "MERGED",
          mergedAt: "2026-05-15T15:00:00Z",
          mergeCommitSha: "abc123",
          isDraft: false,
          checksPassing: true,
          autoReviewStatus: "passed",
          autoReviewMustFix: false,
        };
      },
      async mergePullRequest() {
        throw new Error("already merged PR should not be merged again");
      },
    },
    issueTracker: {
      async viewIssue(key) {
        return {
          key,
          summary: "Closeout issue",
          status: "Closed",
          statusCategory: "Done",
          labels: [],
        };
      },
      async postIssueComment(_key, body) {
        return { body };
      },
    },
  });
  const session = await workRuntime.createSession("session-closeout-dirty-worktree");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-21",
    title: "Dirty closeout",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 21,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/21",
      "workflow.repos.app_api.branch": "feature/ISSUE-21-closeout",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-21-closeout",
      evidenceRecorded: true,
      evidenceSummary: "Acceptance criteria passed.",
      evidenceSource: "npm test",
      documentationRecorded: true,
      documentationDisposition: "not_needed",
      documentationSummary: "No docs needed.",
    },
  });

  const result = await workRuntime.closeoutAfterApproval(session.id, {
    jiraPollAttempts: 1,
    jiraPollIntervalMs: 0,
  });

  assert.equal(result.status, "already_merged_cleanup_needed");
  assert.deepEqual(result.blockers, ["Worktree cleanup needed for app_api at /repo/app-api/.worktrees/feature-ISSUE-21-closeout: worktree is dirty"]);
  assert.equal(result.prunedWorktrees?.[0]?.removed, false);
  assert.equal(result.prunedWorktrees?.[0]?.reason, "worktree is dirty");
  const issue = await ledger.readIssue("ISSUE-21");
  assert.equal(issue?.metadata["workflow.closeout.cleanup_needed"], true);
  assert.match(String(issue?.metadata["workflow.closeout.pruned_worktrees"]), /worktree is dirty/);
});

test("Work Runtime returns partial success when cleanup fails after merge and retries cleanup without remerging", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let prMerged = false;
  let mergeCalls = 0;
  let pruneCalls = 0;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    sourceControl: {
      async inspect(repoPath) {
        return { branch: "feature/ISSUE-22-closeout", headSha: "abc123", dirty: false, entries: [], worktreePath: repoPath };
      },
      async pruneWorktree(input) {
        pruneCalls += 1;
        if (pruneCalls === 1) {
          throw new Error(`failed to delete '${input.worktreePath}': Filename too long`);
        }
        return { removed: true, worktreePath: input.worktreePath, branch: input.branch };
      },
    },
    collaboration: {
      async findPullRequests() {
        return [];
      },
      async getPullRequest(repo, number) {
        return {
          repo,
          number,
          title: "Cleanup retry",
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          headRefName: "feature/ISSUE-22-closeout",
          state: prMerged ? "MERGED" : "OPEN",
          mergedAt: prMerged ? "2026-05-15T15:00:00Z" : undefined,
          mergeCommitSha: prMerged ? "abc123" : undefined,
          isDraft: false,
          checksPassing: true,
          autoReviewStatus: "passed",
          autoReviewMustFix: false,
        };
      },
      async mergePullRequest(repo, number) {
        mergeCalls += 1;
        prMerged = true;
        return {
          url: `https://github.com/ExampleOrg/${repo}/pull/${number}`,
          mergedAt: "2026-05-15T15:00:00Z",
          mergeCommitSha: "abc123",
        };
      },
    },
    issueTracker: {
      async viewIssue(key) {
        return {
          key,
          summary: "Closeout issue",
          status: "Closed",
          statusCategory: "Done",
          labels: [],
        };
      },
      async postIssueComment(_key, body) {
        return { body };
      },
    },
  });
  const session = await workRuntime.createSession("session-closeout-cleanup-retry");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-22",
    title: "Cleanup retry",
    repoKeys: ["app_api"],
    state: "awaiting_review",
    metadata: {
      prRepo: "app-api",
      prNumber: 22,
      prUrl: "https://github.com/ExampleOrg/app-api/pull/22",
      "workflow.repos.app_api.branch": "feature/ISSUE-22-closeout",
      "workflow.repos.app_api.worktree_path": "/repo/app-api/.worktrees/feature-ISSUE-22-closeout",
      evidenceRecorded: true,
      evidenceSummary: "Acceptance criteria passed.",
      evidenceSource: "npm test",
      documentationRecorded: true,
      documentationDisposition: "not_needed",
      documentationSummary: "No docs needed.",
    },
  });

  const first = await workRuntime.closeoutAfterApproval(session.id, {
    jiraPollAttempts: 1,
    jiraPollIntervalMs: 0,
  });
  const doctor = await workRuntime.diagnoseIssue(session.id);
  const second = await workRuntime.closeoutAfterApproval(session.id, {
    jiraPollAttempts: 1,
    jiraPollIntervalMs: 0,
  });

  assert.equal(first.status, "merged_cleanup_needed");
  assert.equal(first.issue.state, "done");
  assert.equal(first.blockers.length, 1);
  assert.match(first.blockers[0], /Filename too long/);
  assert.equal(doctor.nextAction.type, "cleanup_worktrees");
  assert.equal(second.status, "already_merged_jira_verified");
  assert.deepEqual(second.blockers, []);
  assert.equal(mergeCalls, 1);
  assert.equal(pruneCalls, 2);
  assert.equal(second.issue.metadata["workflow.closeout.cleanup_needed"], false);
});

test("GitAdapter pruneWorktree removes only the intended worktree and does not follow dependency junctions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flow-git-prune-"));
  const repoPath = join(root, "repo");
  const worktreePath = join(repoPath, ".worktrees", "feature-long-cleanup-path");
  const sharedTarget = join(root, "shared-node-modules");
  await mkdir(repoPath, { recursive: true });
  await mkdir(sharedTarget, { recursive: true });
  await writeFile(join(repoPath, "README.md"), "root\n");
  await writeFile(join(sharedTarget, "keep.txt"), "shared\n");
  await execFileAsync("git", ["-C", repoPath, "init"]);
  await execFileAsync("git", ["-C", repoPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repoPath, "-c", "user.email=flow@example.test", "-c", "user.name=Flow Test", "commit", "-m", "init"]);
  await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", "feature/long-cleanup-path", worktreePath]);
  await mkdir(join(worktreePath, "node_modules"), { recursive: true });
  try {
    await symlink(sharedTarget, join(worktreePath, "node_modules", "shared"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("symlink creation is unavailable on this filesystem");
    return;
  }

  const result = await new GitAdapter().pruneWorktree({
    repoPath,
    worktreePath,
    branch: "feature/long-cleanup-path",
    requireClean: false,
  });

  assert.equal(result.removed, true);
  assert.equal(existsSync(worktreePath), false);
  await access(join(sharedTarget, "keep.txt"));
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
    sourceControl: {
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
    headRefName: "feature/issue-14-test",
    isDraft: true,
  });

  const issue = await ledger.readIssue("ISSUE-14");
  assert.equal(issue?.metadata.prUrl, "https://github.com/ExampleOrg/app-api/pull/1401");
  assert.equal(issue?.metadata.prHeadRefName, "feature/issue-14-test");
  assert.equal(issue?.metadata["workflow.repos.app_api.pr_head_ref_name"], "feature/issue-14-test");
  assert.equal(issue?.metadata.prIsDraft, true);
  assert.equal(issue?.metadata["workflow.repos.app_api.head_sha"], "abc123");
  assert.equal(issue?.metadata["workflow.repos.app_api.dirty"], false);
});

test("Work Runtime records pull request metadata for repos outside configured topology", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
  });
  const session = await workRuntime.createSession("session-pr-external-record");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15407",
    title: "External PR metadata",
    repoKeys: [],
    state: "queued",
    metadata: {
      prRepo: "fs-python",
      prNumber: 1416,
      prUrl: "https://github.com/ExampleOrg/fs-python/pull/1416",
      "workflow.repos.fs_python.pr_repo": "fs-python",
      "workflow.repos.fs_python.pr_number": 1416,
      "workflow.repos.fs_python.pr_url": "https://github.com/ExampleOrg/fs-python/pull/1416",
    },
  });

  await workRuntime.recordPullRequest(session.id, {
    issueRef: "ISSUE-15407",
    repo: "fs-python",
    number: 1416,
    url: "https://github.com/ExampleOrg/fs-python/pull/1416",
    headRefName: "feature/issue-15407-sedona",
    isDraft: true,
  });

  const issue = await ledger.readIssue("ISSUE-15407");
  assert.deepEqual(issue?.repoKeys, []);
  assert.equal(issue?.metadata.prHeadRefName, "feature/issue-15407-sedona");
  assert.equal(issue?.metadata["workflow.repos.fs_python.pr_head_ref_name"], "feature/issue-15407-sedona");
});

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

test("Work Runtime doctor reports visibility, blockers, and next action", async () => {
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
  assert.equal(result.visibility.codeReview, true);
  assert.equal(result.visibility.preparedWorktree, false);
  assert.equal(result.codeReview?.prUrl, "https://github.com/ExampleOrg/public-api/pull/3026");
  assert.equal(result.nextAction.type, "adopt_workspace");
  assert.match(result.nextAction.command ?? "", /"op":"issue","mode":"adoptWorkspace","id":"ISSUE-15397","repoKey":"public_api"/);
  assert.equal(
    result.findings.some((finding) => finding.summary === "Auto review has must-fix feedback."),
    true,
  );
});

test("Work Runtime doctor treats no PR as healthy when collaboration is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: new NoopCodeCollaborationAdapter(),
  });
  const session = await workRuntime.createSession("session-doctor-no-pr");
  await workRuntime.selectIssue(session.id, {
    ref: "LOCAL-1",
    title: "Local-only work",
    repoKeys: ["public_api"],
    state: "selected",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/local-only-work",
    },
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "ok");
  assert.equal(result.visibility.codeReview, false);
  assert.equal(result.visibility.codeReviewRequired, false);
  assert.equal(result.nextAction.type, "advance");
});

test("Work Runtime doctor prioritizes present review comments before approval wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-doctor-review-comments");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-3026",
    title: "Review comments",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/feature-issue-3026",
      prUrl: "https://github.com/ExampleOrg/public-api/pull/3026",
      prReviewDecision: "REVIEW_REQUIRED",
      humanReviewRequired: true,
      prReviewCommentCount: 3,
      prReviewCommentAuthors: ["khwiri", "developer-hla"],
      prChecksPassing: true,
      prIsDraft: false,
      prMergeable: "MERGEABLE",
      prMergeStateStatus: "BLOCKED",
    },
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.nextAction.type, "address_review_comments");
  assert.equal(
    result.findings.some((finding) => finding.summary === "Review comments are present."),
    true,
  );
  assert.equal(
    result.findings.some((finding) => finding.summary === "Approval review is required."),
    true,
  );
});

test("Work Runtime doctor waits for pending pull request checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-doctor-pending-checks");
  await workRuntime.selectIssue(session.id, {
    ref: "GH-239",
    title: "Expand CONTRIBUTING.md with development setup guide",
    repoKeys: ["flow"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.flow.worktree_path": "/repo/flow/.worktrees/feature-gh-239",
      prUrl: "https://github.com/camden-lowrance/flow/pull/393",
      prIsDraft: false,
      prChecksPending: true,
      prAutoReviewStatus: "missing",
      evidenceRecorded: true,
      documentationRecorded: true,
    },
  });
  await ledger.recordWorkerResult({
    taskId: "worker-gh-239",
    issueRef: "GH-239",
    repoKey: "flow",
    status: "succeeded",
    summary: "Updated CONTRIBUTING.md.",
    changedFiles: ["CONTRIBUTING.md"],
    testsRun: ["npm test"],
    blockers: [],
    completedAt: nowIso(),
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "blocked");
  assert.equal(result.nextAction.type, "wait_for_checks");
  assert.equal(
    result.findings.some((finding) => finding.summary === "Pull request checks are still running."),
    true,
  );
  assert.equal(
    result.findings.some((finding) => finding.summary === "Pull request checks are not passing."),
    false,
  );
});

test("Work Runtime doctor preserves awaiting review issue state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-doctor-awaiting-review");
  await ledger.writeIssue({
    ref: "ISSUE-77",
    title: "Review-ready issue",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/issue-77",
      prUrl: "https://github.com/ExampleOrg/public-api/pull/77",
      prChecksPassing: true,
      prIsDraft: false,
    },
  });
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-77",
    title: "Review-ready issue",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {},
  });

  const result = await workRuntime.diagnoseIssue(session.id, "ISSUE-77");

  assert.equal(result.issue.state, "awaiting_review");
  assert.equal((await ledger.readIssue("ISSUE-77"))?.state, "awaiting_review");
});

test("Work Runtime doctor reports no next action for merged Done issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-doctor-done");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-15397",
    title: "Merged and done",
    repoKeys: ["public_api"],
    state: "awaiting_review",
    metadata: {
      "workflow.repos.public_api.worktree_path": "/repo/public-api/.worktrees/feature-issue-15397",
      prUrl: "https://github.com/ExampleOrg/public-api/pull/3026",
      prState: "MERGED",
      prMergedAt: "2026-05-21T13:00:00Z",
      prChecksPassing: true,
      prIsDraft: false,
      jiraStatus: "Done",
      jiraStatusCategory: "Done",
      jiraResolution: "Done",
    },
  });

  const result = await workRuntime.diagnoseIssue(session.id);

  assert.equal(result.status, "ok");
  assert.equal(result.nextAction.type, "done");
  assert.match(result.nextAction.summary, /complete/);
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

test("Work Runtime turns remediable PR review blockers into handoff requests", async () => {
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
  assert.equal(pending.session.pendingConfirmation?.action, "request_execution");
  assert.equal(pending.session.pendingConfirmation?.summary, "Hand off PR review remediation for ISSUE-72 in app_api.");

  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "execution_handoff");
  assert.match(approved.handoffRequest?.prompt ?? "", /Prompt: address these review findings/);
  assert.match(approved.handoffRequest?.prompt ?? "", /Keep TEMP_PATH type-compatible/);
  const jobs = await ledger.listWorkJobs("ISSUE-72");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].workType, "flow.remediate");
  assert.equal(approved.handoffRequest?.workJobId, jobs[0].id);
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
  assert.equal(pending.session.pendingConfirmation?.action, "request_execution");
  assert.match(pending.session.pendingConfirmation?.summary ?? "", /Hand off PR review remediation/);
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);
  assert.equal(approved.status, "execution_handoff");
  assert.match(approved.handoffRequest?.prompt ?? "", /Pull request checks are not passing/);
  assert.match(approved.handoffRequest?.prompt ?? "", /Auto review checks failed/);
});

test("Work Runtime records review confirmation and posts it to GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-"));
  const ledger = new MemoryWorkflowLedger();
  let posted: { repo: string; number: number; body: string } | undefined;
  const workRuntime = testWorkRuntime({
    store: new FlowStore({ root }),
    ledger,
    collaboration: {
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
    collaboration: {
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

test("Work Runtime advance sends merge-conflict resolution handoff with a specific prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-pi-merge-conflict-prompt-"));
  const ledger = new MemoryWorkflowLedger();
  const workRuntime = testWorkRuntime({ store: new FlowStore({ root }), ledger });
  const session = await workRuntime.createSession("session-merge-conflict-prompt");
  await workRuntime.selectIssue(session.id, {
    ref: "ISSUE-19",
    title: "Resolve merge conflicts",
    repoKeys: ["app_api"],
    state: "ready_to_run",
    metadata: {
      prUrl: "https://github.com/ExampleOrg/app-api/pull/19",
      prIsDraft: false,
      prMergeable: "CONFLICTING",
      prMergeStateStatus: "DIRTY",
      prChecksPassing: true,
      "workflow.repos.app_api.worktree_path": "/tmp/app-api-worktree",
    },
  });

  const pending = await workRuntime.advanceIssue(session.id);

  assert.equal(pending.status, "needs_confirmation");
  assert.equal(pending.session.pendingConfirmation?.action, "request_execution");
  assert.equal(pending.session.pendingConfirmation?.summary, "Hand off PR merge-conflict resolution for ISSUE-19 in app_api.");
  const confirmationId = pending.session.pendingConfirmation?.id;
  assert.ok(confirmationId);
  const approved = await workRuntime.advanceIssue(session.id, confirmationId);

  assert.equal(approved.status, "execution_handoff");
  assert.match(approved.handoffRequest?.prompt ?? "", /Prompt: resolve the merge conflicts on this pull request/);
  assert.match(approved.handoffRequest?.prompt ?? "", /Pull request has merge conflicts/);
  const jobs = await ledger.listWorkJobs("ISSUE-19");
  assert.equal(jobs.length, 1);
  assert.equal(approved.handoffRequest?.workJobId, jobs[0].id);
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

test("requireWorkItem returns valid WorkItem for correct input", () => {
  const valid = { ref: "FLOW-1", title: "Test issue", repoKeys: ["main"], state: "queued" as const, metadata: {} };
  const result = requireWorkItem(valid, "selectIssue");
  assert.equal(result.ref, "FLOW-1");
  assert.equal(result.title, "Test issue");
  assert.deepEqual(result.repoKeys, ["main"]);
});

test("requireWorkItem throws BAD_FIELD for missing ref", () => {
  assert.throws(
    () => requireWorkItem({ title: "No ref" }, "selectIssue"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      assert.match(error.message, /selectIssue/);
      assert.equal(error.manifestTarget, "runtime");
      const details = error.details as { method: string; field: string; issues: unknown[] };
      assert.equal(details.method, "selectIssue");
      assert.equal(details.field, "params.issue");
      assert.ok(details.issues.length > 0);
      return true;
    },
  );
});

test("requireWorkItem throws BAD_FIELD for non-object input", () => {
  assert.throws(
    () => requireWorkItem("not-an-object", "selectIssue"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      assert.equal((error.details as { method: string }).method, "selectIssue");
      return true;
    },
  );
});

test("requireWorkItem throws BAD_FIELD for empty ref", () => {
  assert.throws(
    () => requireWorkItem({ ref: "", title: "Test" }, "selectIssue"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      return true;
    },
  );
});

test("requireCreateIssueOptions returns valid options for correct input", () => {
  const valid = { summary: "Add feature", issueType: "Task" as const };
  const result = requireCreateIssueOptions(valid, "createIssue");
  assert.equal(result.summary, "Add feature");
  assert.equal(result.issueType, "Task");
});

test("requireCreateIssueOptions throws BAD_FIELD for missing summary", () => {
  assert.throws(
    () => requireCreateIssueOptions({ issueType: "Task" }, "createIssue"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      assert.match(error.message, /createIssue/);
      const details = error.details as { method: string; field: string };
      assert.equal(details.method, "createIssue");
      assert.equal(details.field, "params.options");
      return true;
    },
  );
});

test("requireCreateIssueOptions throws BAD_FIELD for invalid issueType", () => {
  assert.throws(
    () => requireCreateIssueOptions({ summary: "test", issueType: "Epic" }, "intakeIssue"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      const details = error.details as { method: string; field: string };
      assert.equal(details.method, "intakeIssue");
      assert.equal(details.field, "params.options");
      return true;
    },
  );
});

test("requireCreateIssueOptions accepts optional fields", () => {
  const result = requireCreateIssueOptions({
    summary: "Full options",
    projectKey: "PROJ",
    issueType: "Story",
    branchKind: "feature",
    title: "Custom title",
    description: "Detailed description",
    repoKeys: ["main", "api"],
    select: true,
  }, "createIssue");
  assert.equal(result.summary, "Full options");
  assert.equal(result.projectKey, "PROJ");
  assert.equal(result.issueType, "Story");
  assert.equal(result.branchKind, "feature");
  assert.equal(result.title, "Custom title");
  assert.equal(result.description, "Detailed description");
  assert.deepEqual(result.repoKeys, ["main", "api"]);
  assert.equal(result.select, true);
});

test("requireCreateIssueOptions preserves intake control fields", () => {
  const result = requireCreateIssueOptions({
    summary: "Review intake",
    dryRun: true,
    apply: false,
    review: true,
  }, "intakeIssue") as { dryRun?: boolean; apply?: boolean; review?: boolean };
  assert.equal(result.dryRun, true);
  assert.equal(result.apply, false);
  assert.equal(result.review, true);
});

test("requireWorkJobExecutor returns valid executor for correct input", () => {
  const result = requireWorkJobExecutor("live_agent_thread", "claimWorkJob");
  assert.equal(result, "live_agent_thread");
});

test("requireWorkJobExecutor throws BAD_FIELD for invalid executor", () => {
  assert.throws(
    () => requireWorkJobExecutor("invalid_executor", "claimWorkJob"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      const details = error.details as { method: string; field: string };
      assert.equal(details.method, "claimWorkJob");
      assert.equal(details.field, "params.executor");
      return true;
    },
  );
});

test("requireWorkJobResult returns valid result for correct input", () => {
  const valid = {
    jobId: "job-1",
    issueRef: "FLOW-1",
    repoKey: "main",
    workType: "implement",
    status: "succeeded" as const,
    summary: "Done",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
  const result = requireWorkJobResult(valid, "recordWorkJobResult");
  assert.equal(result.jobId, "job-1");
  assert.equal(result.status, "succeeded");
});

test("requireWorkJobResult throws BAD_FIELD for missing jobId", () => {
  assert.throws(
    () => requireWorkJobResult({
      issueRef: "FLOW-1",
      repoKey: "main",
      workType: "implement",
      status: "succeeded",
      summary: "Done",
      completedAt: "2026-01-01T00:00:00.000Z",
    }, "recordWorkJobResult"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      const details = error.details as { method: string; field: string };
      assert.equal(details.method, "recordWorkJobResult");
      assert.equal(details.field, "params.result");
      return true;
    },
  );
});

test("requireWorkJobResult throws BAD_FIELD for invalid status", () => {
  assert.throws(
    () => requireWorkJobResult({
      jobId: "job-1",
      issueRef: "FLOW-1",
      repoKey: "main",
      workType: "implement",
      status: "invalid_status",
      summary: "Done",
      completedAt: "2026-01-01T00:00:00.000Z",
    }, "recordWorkJobResult"),
    (error: unknown) => {
      assert.ok(error instanceof JsonCliError);
      assert.equal(error.code, "BAD_FIELD");
      return true;
    },
  );
});
