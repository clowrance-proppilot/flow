#!/usr/bin/env node
import { Command, CommanderError } from "commander";

import {
  AcliJiraAdapter,
  assessIssue,
  bootstrapFlowConfig,
  createDefaultWorkerSpawner,
  createWorkflowLedger,
  configToProjectTopology,
  configToWorkTypeRegistry,
  FlowStore,
  FlowWorkRuntime,
  GhGitHubAdapter,
  IssueStateValue,
  WorkerExecutorValue,
  flowLayout,
  flowRuntimePath,
  flowWorkflowLedgerPath,
  terminalWorkerStatusValues,
  type AcceptanceCriterionEvidence,
  validateFlowConfig,
  verifyJsonlWorkflowLedger,
  type CreateIssueOptions,
  type LocalThreadResultInput,
  type WorkerExecutor,
  type WorkerStatus,
  type WorkItem,
  workerExecutorValues,
} from "./index.js";
import { GhGitHubIssueTrackerAdapter } from "./adapters/github.js";
import { LocalIssueTrackerAdapter, NoopCodeCollaborationAdapter } from "./adapters/local.js";
import { repoRoot } from "./flow-runtime.js";

const configValidation = await validateFlowConfig({ projectRoot: repoRoot });
const flowConfig = configValidation.config;
const defaultSessionId = configString(flowConfig?.runtime, "defaultSessionId") ?? "cli";
const workflowLedger = createWorkflowLedger({
  cwd: repoRoot,
  adapter: configString(flowConfig?.ledger, "type"),
  path: configString(flowConfig?.runtime, "workflowLedgerPath"),
});
const rawWorkRuntimeMethods = [
  "inspectDashboardQueue",
  "inspectQueue",
  "inspectBacklog",
  "createSession",
  "selectIssue",
  "createIssue",
  "bootstrapIssue",
  "bootstrapJiraIssue",
  "createJiraIssue",
  "routeIssue",
  "prepareWorkspace",
  "adoptWorkspace",
  "advanceIssue",
  "diagnoseIssue",
  "autoFlowIssue",
  "resetAutoflowState",
  "refreshReviewState",
  "adoptPendingLocalThread",
  "adoptLocalThread",
  "recordExecutorResult",
  "recordLocalThreadResult",
  "recordEvidence",
  "recordDocumentation",
  "recordPullRequest",
  "summarizeHandoff",
  "observeFlowSubject",
];
const runtime = new FlowWorkRuntime({
  store: new FlowStore({ root: flowRuntimePath(repoRoot) }),
  ledger: workflowLedger,
  collaboration: createCollaboration(),
  issueTracker: createIssueTracker(),
  defaultJiraProjectKey: configString(flowConfig?.issueTracker, "projectKey"),
  autoflowBlockedThreshold: flowConfig?.runtime?.autoflowBlockedThreshold,
  workerTimeoutMs: flowConfig?.runtime?.worker?.timeoutMs,
  debugEnabled: flowConfig?.runtime?.debug,
  ...(flowConfig
    ? {
      topology: configToProjectTopology(flowConfig),
      workTypes: configToWorkTypeRegistry(flowConfig),
    }
    : {}),
  projectRoot: repoRoot,
  readiness: { assess: assessIssue },
});

const program = new Command()
  .name("flow")
  .description("Flow agent protocol CLI. Emits JSON on stdout and diagnostics on stderr.")
  .helpOption(false)
  .configureOutput({
    writeOut: (value) => process.stderr.write(value),
    writeErr: (value) => process.stderr.write(value),
  })
  .action(() => {
    const manifest = commandManifest();
    writeJson({
      ok: false,
      error: "command required",
      commands: manifest.commands.map((command) => command.name),
      hint: "Run `flow commands` or `flow manifest` for the command contract.",
    });
    process.exitCode = 1;
  });

program
  .command("commands")
  .description("Emit supported agent protocol commands.")
  .action(() => {
    const manifest = commandManifest();
    writeJson({
      commands: manifest.commands.map((command) => command.name),
      descriptions: Object.fromEntries(manifest.commands.map((command) => [command.name, command.description])),
      rawWorkRuntimeMethods,
      stdout: manifest.stdout,
      stderr: manifest.stderr,
      layout: manifest.layout,
      manifest,
    });
  });

program
  .command("manifest")
  .description("Emit the machine-readable CLI command contract derived from registered commands.")
  .action(() => writeJson(commandManifest()));

program
  .command("bootstrap")
  .description("Create .flow/config.yaml for this project from local repo metadata.")
  .option("--force", "overwrite an existing .flow/config.yaml")
  .action(async (options: { force?: boolean }) => {
    writeJson(await bootstrapFlowConfig({ projectRoot: repoRoot, force: Boolean(options.force) }));
  });

program
  .command("config-validate")
  .description("Validate .flow/config.yaml and emit machine-readable diagnostics.")
  .option("--path <path>", "config path")
  .action(async (options: { path?: string }) => {
    const result = await validateFlowConfig({ projectRoot: repoRoot, configPath: options.path });
    const { config: _config, ...publicResult } = result;
    writeJson(publicResult);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("config-explain")
  .description("Summarize the active Flow config without dumping secrets or provider credentials.")
  .option("--path <path>", "config path")
  .action(async (options: { path?: string }) => {
    const result = await validateFlowConfig({ projectRoot: repoRoot, configPath: options.path });
    const config = result.config;
    writeJson({
      ok: result.ok,
      path: result.path,
      errors: result.errors,
      project: config?.project,
      topology: config
        ? {
          repos: Object.fromEntries(Object.entries(config.topology.repos).map(([key, repo]) => [key, {
            name: repo.name,
            baseBranch: repo.baseBranch,
            pathFromRoot: repo.pathFromRoot,
          }])),
          branchPattern: config.topology.branchPattern,
          pullRequestUrlPattern: config.topology.pullRequestUrlPattern,
          issueInferenceRules: config.topology.issueInference.length,
        }
        : undefined,
      adapters: config
        ? {
          issueTracker: config.issueTracker?.type,
          collaboration: config.collaboration?.type,
          sourceControl: config.sourceControl?.type,
          ledger: config.ledger?.type,
        }
        : undefined,
      runtime: config?.runtime
        ? {
          defaultSessionId: config.runtime.defaultSessionId,
          dashboard: config.runtime.dashboard
            ? {
              host: config.runtime.dashboard.host,
              port: config.runtime.dashboard.port,
              url: config.runtime.dashboard.url,
              defaultThemeId: config.runtime.dashboard.defaultThemeId,
            }
            : undefined,
          worker: config.runtime.worker
            ? {
              executor: config.runtime.worker.executor,
              provider: config.runtime.worker.provider,
              model: config.runtime.worker.model,
              timeoutMs: config.runtime.worker.timeoutMs,
            }
            : undefined,
        }
        : undefined,
    });
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("ledger-verify")
  .description("Verify the Flow workflow ledger and optionally rebuild issue projections.")
  .option("--path <path>", "workflow ledger path")
  .option("--rebuild-projections", "rebuild .flow/ledger/issues projections from valid ledger records")
  .action(async (options: { path?: string; rebuildProjections?: boolean }) => {
    writeJson(await verifyJsonlWorkflowLedger(
      options.path ?? configString(flowConfig?.runtime, "workflowLedgerPath") ?? flowWorkflowLedgerPath(repoRoot),
      { rebuildProjections: Boolean(options.rebuildProjections) },
    ));
  });

program
  .command("session")
  .description("Create or overwrite a named Work Runtime session.")
  .argument("[id]", "session id", defaultSessionId)
  .action(async (id: string) => writeJson(await runtime.createSession(id)));

program
  .command("queue")
  .description("Inspect current configured issue queue.")
  .option("-l, --limit <count>", "issue limit", parsePositiveInteger, 10)
  .action(async (options: { limit: number }) => writeJson(await runtime.inspectQueue(options.limit)));

program
  .command("backlog")
  .description("Inspect configured issue backlog.")
  .option("-l, --limit <count>", "issue limit", parsePositiveInteger, 10)
  .action(async (options: { limit: number }) => writeJson(await runtime.inspectBacklog(options.limit)));

program
  .command("select")
  .description("Select an issue in a file-backed Work Runtime session.")
  .argument("<issue-ref>", "issue key or ref")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (issueRef: string, options: { session: string }) => {
    await ensureSession(options.session);
    writeJson(await runtime.selectIssue(options.session, await queueIssue(issueRef)));
  });

program
  .command("create-issue")
  .description("Create an issue through the configured issue tracker and select it by default.")
  .requiredOption("--summary <text>", "issue summary")
  .option("--description <text>", "issue description")
  .option("--type <type>", "issue type: Bug, Task, or Story", "Bug")
  .option("--project <key>", "issue tracker project key")
  .option("--repo <keys>", "comma-separated routed repo keys")
  .option("--branch-kind <kind>", "Flow branch kind: bug or feature")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--no-select", "create and store the issue without selecting it")
  .action(async (options: {
    summary: string;
    description?: string;
    type: "Bug" | "Task" | "Story";
    project?: string;
    repo?: string;
    branchKind?: "bug" | "feature";
    session: string;
    select: boolean;
  }) => {
    await ensureSession(options.session);
    writeJson(await runtime.createIssue(options.session, {
      projectKey: options.project,
      issueType: parseJiraIssueType(options.type),
      branchKind: parseBranchKind(options.branchKind),
      summary: options.summary,
      description: options.description,
      repoKeys: asStringArray(options.repo),
      select: options.select,
    }));
  });

program
  .command("adopt-workspace")
  .description("Record an existing worktree as the prepared workspace for an issue.")
  .argument("<issue-ref>", "issue key or ref")
  .requiredOption("--path <path>", "existing worktree path")
  .option("--repo <key>", "repo key")
  .option("--base-branch <branch>", "base branch")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (issueRef: string, options: { path: string; repo?: string; baseBranch?: string; session: string }) => {
    await ensureSession(options.session);
    writeJson(await runtime.adoptWorkspace(options.session, issueRef, {
      repoKey: options.repo,
      worktreePath: options.path,
      baseBranch: options.baseBranch,
    }));
  });

program
  .command("advance")
  .description("Advance a selected issue, or select the issue first when provided.")
  .argument("[issue-ref]", "issue key or ref")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--approve <confirmation-id>", "approve pending confirmation id")
  .action(async (issueRef: string | undefined, options: { session: string; approve?: string }) => {
    await ensureSession(options.session);
    if (issueRef) await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.advanceIssue(options.session, options.approve));
  });

program
  .command("autoflow")
  .description("Run deterministic autoflow for an issue.")
  .argument("<issue-ref>", "issue key or ref")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--steps <count>", "maximum Work Runtime autoflow steps", parsePositiveInteger, 20)
  .option("--no-worker", "do not run a background executor")
  .action(async (issueRef: string, options: { session: string; steps: number; worker: boolean }) => {
    await ensureSession(options.session);
    await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.autoFlowIssue(
      options.session,
      createConfiguredWorkerSpawner(),
      {
        autoPrepareWorkspace: true,
        autoApproveWorker: true,
        runWorker: options.worker,
        maxSteps: options.steps,
      },
    ));
  });

program
  .command("complete-worker")
  .description("Record the current local agent thread as the Worker result for an issue.")
  .argument("[issue-ref]", "issue key or ref")
  .requiredOption("--summary <text>", "worker result summary")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--repo <key>", "repo key")
  .option("--task-id <id>", "worker task id to close")
  .option("--work-job-id <id>", "typed work job id to close")
  .option("--status <status>", "result status: succeeded, blocked, or failed", "succeeded")
  .option("--changed-files <files>", "comma-separated changed files")
  .option("--tests-run <commands>", "comma-separated verification commands")
  .option("--blockers <items>", "comma-separated blockers")
  .option("--next-pickup <text>", "next pickup guidance for blocked/failed work")
  .action(async (issueRef: string | undefined, options: {
    session: string;
    summary: string;
    repo?: string;
    taskId?: string;
    workJobId?: string;
    status: string;
    changedFiles?: string;
    testsRun?: string;
    blockers?: string;
    nextPickup?: string;
  }) => {
    await ensureSession(options.session);
    if (issueRef) await runtime.selectIssue(options.session, await queueIssue(issueRef));
    const input: LocalThreadResultInput = {
      issueRef,
      repoKey: options.repo,
      taskId: options.taskId,
      workJobId: options.workJobId,
      status: parseWorkerResultStatus(options.status),
      summary: options.summary,
      changedFiles: asStringArray(options.changedFiles),
      testsRun: asStringArray(options.testsRun),
      blockers: asStringArray(options.blockers),
      nextPickup: options.nextPickup,
    };
    writeJson(await runtime.recordLocalThreadResult(options.session, input));
  });

program
  .command("record-pr")
  .description("Record an existing pull request for an issue.")
  .argument("<issue-ref>", "issue key or ref")
  .requiredOption("--repo <name>", "repo name or key")
  .requiredOption("--number <number>", "pull request number", parsePositiveInteger)
  .requiredOption("--url <url>", "pull request URL")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--draft", "record the pull request as draft")
  .option("--checks-passing", "record checks as passing")
  .option("--review-decision <decision>", "review decision")
  .action(async (issueRef: string, options: {
    session: string;
    repo: string;
    number: number;
    url: string;
    draft?: boolean;
    checksPassing?: boolean;
    reviewDecision?: string;
  }) => {
    await ensureSession(options.session);
    await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.recordPullRequest(options.session, {
      issueRef,
      repo: options.repo,
      number: options.number,
      url: options.url,
      isDraft: Boolean(options.draft),
      checksPassing: options.checksPassing,
      reviewDecision: options.reviewDecision,
    }));
  });

program
  .command("record-evidence")
  .description("Record acceptance evidence for an issue.")
  .argument("<issue-ref>", "issue key or ref")
  .requiredOption("--summary <text>", "evidence summary")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--source <text>", "evidence source", "local")
  .option("--criteria <items>", "comma-separated acceptance criteria")
  .action(async (issueRef: string, options: {
    session: string;
    summary: string;
    source: string;
    criteria?: string;
  }) => {
    await ensureSession(options.session);
    await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.recordEvidence(options.session, {
      issueRef,
      summary: options.summary,
      source: options.source,
      criteria: parseEvidenceCriteria(options.criteria, options.summary, options.source),
    }));
  });

program
  .command("record-documentation")
  .description("Record documentation disposition for an issue.")
  .argument("<issue-ref>", "issue key or ref")
  .requiredOption("--disposition <value>", "documentation disposition")
  .requiredOption("--summary <text>", "documentation summary")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (issueRef: string, options: {
    session: string;
    disposition: string;
    summary: string;
  }) => {
    await ensureSession(options.session);
    await runtime.selectIssue(options.session, await queueIssue(issueRef));
    writeJson(await runtime.recordDocumentation(options.session, {
      issueRef,
      disposition: parseDocumentationDisposition(options.disposition),
      summary: options.summary,
    }));
  });

program
  .command("doctor")
  .description("Diagnose Flow visibility, routing, PR state, readiness blockers, and next action.")
  .argument("[issue-ref]", "issue key or ref")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .option("--json", "emit JSON output; included for explicit CI and agent contracts")
  .option("--strict", "exit nonzero when Flow diagnosis is blocked or degraded")
  .action(async (issueRef: string | undefined, options: { session: string; strict?: boolean }) => {
    await ensureSession(options.session);
    const issue = issueRef ? await queueIssue(issueRef) : undefined;
    if (issue) await runtime.selectIssue(options.session, issue);
    const diagnosis = await runtime.diagnoseIssue(options.session, issue?.ref);
    writeJson(diagnosis);
    if (options.strict && diagnosis.status !== "ok") process.exitCode = 1;
  });

program
  .command("handoff")
  .description("Summarize current session handoff state.")
  .option("-s, --session <id>", "session id", defaultSessionId)
  .action(async (options: { session: string }) => {
    await ensureSession(options.session);
    writeJson(await runtime.summarizeHandoff(options.session));
  });

program
  .command("observe")
  .description("Observe projected workflow state for a subject.")
  .argument("<ref>", "subject reference, defaults to issue ref")
  .option("-t, --type <type>", "subject type", "issue")
  .action(async (ref: string, options: { type: string }) => {
    writeJson(await runtime.observeFlowSubject({ type: options.type, ref }));
  });

program
  .command("call")
  .description("Call a Work Runtime method with raw JSON params.")
  .argument("<method>", "Work Runtime method")
  .argument("[params-json]", "JSON object params", "{}")
  .action(async (method: string, paramsJson: string) => {
    const params = JSON.parse(paramsJson) as Record<string, unknown>;
    writeJson(await dispatch(method, params));
  });

try {
  await program.exitOverride().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    writeJson({ ok: false, error: error.message, code: error.code });
    process.exitCode = error.exitCode;
  } else {
  writeJson({ ok: false, error: errorMessage(error) });
  process.exitCode = 1;
  }
}

async function ensureSession(sessionId: string): Promise<void> {
  try {
    await runtime.summarizeHandoff(sessionId);
  } catch {
    await runtime.createSession(sessionId);
  }
}

async function queueIssue(issueRef: string): Promise<WorkItem> {
  const resolvedIssueRef = await resolveIssueRef(issueRef);
  if (resolvedIssueRef) issueRef = resolvedIssueRef;
  const issueKey = issueRef.toUpperCase();
  const queue = await runtime.inspectQueue(50);
  const issue = queue.find((candidate) =>
    candidate.ref.toUpperCase() === issueKey || issueMatchesPullRequest(candidate, issueRef)
  );
  if (issue) return issue;
  return { ref: issueKey, title: issueKey, repoKeys: [], state: IssueStateValue.Queued, metadata: {} };
}

async function resolveIssueRef(ref: string): Promise<string | undefined> {
  const pullRequest = parsePullRequestRef(ref);
  if (!pullRequest) return undefined;

  const queueMatch = (await runtime.inspectQueue(50)).find((issue) => issueMatchesPullRequest(issue, ref));
  if (queueMatch) return queueMatch.ref;

  const pr = await runtimeGithubPullRequest(pullRequest.repo, pullRequest.number);
  return pr ? extractIssueRef([pr.title, pr.body, pr.headRefName, pr.url]) : undefined;
}

async function runtimeGithubPullRequest(repo: string, number: number) {
  try {
    return await runtimeGithub().getPullRequest(repo, number);
  } catch {
    return undefined;
  }
}

function runtimeGithub(): GhGitHubAdapter {
  return new GhGitHubAdapter({ cwd: repoRoot, owner: configString(flowConfig?.collaboration, "owner") });
}

function createConfiguredWorkerSpawner() {
  const worker = flowConfig?.runtime?.worker;
  return createDefaultWorkerSpawner({
    flowRoot: repoRoot,
    executor: parseConfiguredWorkerExecutor(worker?.executor),
    provider: worker?.provider,
    model: worker?.model,
    timeoutMs: worker?.timeoutMs,
    sdkModulePath: worker?.sdkModulePath,
    extensionPath: worker?.extensionPath,
    agentDir: worker?.agentDir,
    command: worker?.codexCommand,
  });
}

function parseConfiguredWorkerExecutor(value: unknown): WorkerExecutor | undefined {
  if (value === WorkerExecutorValue.Pi || value === WorkerExecutorValue.Codex || value === WorkerExecutorValue.LiveAgentThread) {
    return value;
  }
  return undefined;
}

function parsePullRequestRef(ref: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(ref.trim());
  if (!match) return undefined;
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

function issueMatchesPullRequest(issue: WorkItem, ref: string): boolean {
  const normalized = ref.trim();
  if (!normalized) return false;
  const metadata = issue.metadata ?? {};
  if (metadata.prUrl === normalized) return true;
  return Object.entries(metadata).some(([key, value]) =>
    key.endsWith(".pr_url") && value === normalized
  );
}

function extractIssueRef(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const match = /(?:^|[^A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?=$|[^A-Z0-9])/i.exec(value ?? "");
    if (match) return match[1].toUpperCase();
  }
  return undefined;
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "inspectDashboardQueue":
      return runtime.inspectDashboardQueue(Number(params.limit ?? 10));
    case "inspectQueue":
      return runtime.inspectQueue(Number(params.limit ?? 10));
    case "inspectBacklog":
      return runtime.inspectBacklog(Number(params.limit ?? 10));
    case "createSession":
      return runtime.createSession(typeof params.id === "string" ? params.id : undefined);
    case "selectIssue":
      return runtime.selectIssue(String(params.sessionId ?? defaultSessionId), params.issue as WorkItem);
    case "bootstrapJiraIssue":
    case "bootstrapIssue":
      return runtime.bootstrapJiraIssue(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        params.options ?? {},
      );
    case "createIssue":
      return runtime.createIssue(
        String(params.sessionId ?? defaultSessionId),
        params.options as CreateIssueOptions,
      );
    case "createJiraIssue":
      return runtime.createJiraIssue(
        String(params.sessionId ?? defaultSessionId),
        params.options as CreateIssueOptions,
      );
    case "routeIssue":
      return runtime.routeIssue(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        asStringArray(params.repoKeys) ?? [],
      );
    case "prepareWorkspace":
      return runtime.prepareWorkspace(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        params.options ?? {},
      );
    case "adoptWorkspace":
      return runtime.adoptWorkspace(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
        {
          repoKey: typeof params.repoKey === "string" ? params.repoKey : undefined,
          worktreePath: String(params.worktreePath),
          baseBranch: typeof params.baseBranch === "string" ? params.baseBranch : undefined,
        },
      );
    case "advanceIssue":
      return runtime.advanceIssue(String(params.sessionId ?? defaultSessionId), typeof params.approveConfirmationId === "string" ? params.approveConfirmationId : undefined);
    case "adoptPendingLocalThread":
      return runtime.adoptPendingLocalThread(
        String(params.sessionId ?? defaultSessionId),
        {
          adopter: typeof params.adopter === "string" ? params.adopter : undefined,
          summary: typeof params.summary === "string" ? params.summary : undefined,
        },
      );
    case "adoptLocalThread":
      return runtime.adoptLocalThread(
        String(params.sessionId ?? defaultSessionId),
        {
          id: String(params.id),
          issueRef: String(params.issueRef),
          repoKey: String(params.repoKey),
          workJobId: typeof params.workJobId === "string" ? params.workJobId : undefined,
          executor: parseWorkerExecutor(params.executor),
          prompt: String(params.prompt),
          workspacePath: String(params.workspacePath),
          createdAt: typeof params.createdAt === "string" ? params.createdAt : new Date().toISOString(),
        },
        {
          adopter: typeof params.adopter === "string" ? params.adopter : undefined,
          summary: typeof params.summary === "string" ? params.summary : undefined,
        },
      );
    case "recordExecutorResult":
      return runtime.recordExecutorResult(String(params.sessionId ?? defaultSessionId), {
        taskId: String(params.taskId),
        issueRef: String(params.issueRef),
        repoKey: String(params.repoKey),
        workJobId: typeof params.workJobId === "string" ? params.workJobId : undefined,
        executor: parseWorkerExecutor(params.executor),
        status: parseWorkerResultStatus(params.status),
        summary: String(params.summary),
        changedFiles: asStringArray(params.changedFiles) ?? [],
        testsRun: asStringArray(params.testsRun) ?? [],
        blockers: asStringArray(params.blockers) ?? [],
        nextPickup: typeof params.nextPickup === "string" ? params.nextPickup : undefined,
        handoffPrompt: typeof params.handoffPrompt === "string" ? params.handoffPrompt : undefined,
        evidenceCandidate: typeof params.evidenceCandidate === "string" ? params.evidenceCandidate : undefined,
        completedAt: typeof params.completedAt === "string" ? params.completedAt : new Date().toISOString(),
      });
    case "recordLocalThreadResult":
      return runtime.recordLocalThreadResult(
        String(params.sessionId ?? defaultSessionId),
        {
          issueRef: typeof params.issueRef === "string" ? params.issueRef : undefined,
          repoKey: typeof params.repoKey === "string" ? params.repoKey : undefined,
          taskId: typeof params.taskId === "string" ? params.taskId : undefined,
          workJobId: typeof params.workJobId === "string" ? params.workJobId : undefined,
          status: parseWorkerResultStatus(params.status),
          summary: String(params.summary),
          changedFiles: asStringArray(params.changedFiles),
          testsRun: asStringArray(params.testsRun),
          blockers: asStringArray(params.blockers),
          nextPickup: typeof params.nextPickup === "string" ? params.nextPickup : undefined,
          handoffPrompt: typeof params.handoffPrompt === "string" ? params.handoffPrompt : undefined,
          evidenceCandidate: typeof params.evidenceCandidate === "string" ? params.evidenceCandidate : undefined,
          completedAt: typeof params.completedAt === "string" ? params.completedAt : undefined,
        },
      );
    case "recordEvidence":
      return runtime.recordEvidence(String(params.sessionId ?? defaultSessionId), {
        issueRef: String(params.issueRef),
        summary: String(params.summary),
        source: typeof params.source === "string" ? params.source : "local",
        criteria: parseEvidenceCriteria(params.criteria, String(params.summary), typeof params.source === "string" ? params.source : "local"),
      });
    case "recordDocumentation":
      return runtime.recordDocumentation(String(params.sessionId ?? defaultSessionId), {
        issueRef: String(params.issueRef),
        disposition: parseDocumentationDisposition(params.disposition),
        summary: String(params.summary),
      });
    case "recordPullRequest":
      return runtime.recordPullRequest(String(params.sessionId ?? defaultSessionId), {
        issueRef: String(params.issueRef),
        repo: String(params.repo),
        number: Number(params.number),
        url: String(params.url),
        isDraft: Boolean(params.isDraft),
        checksPassing: typeof params.checksPassing === "boolean" ? params.checksPassing : undefined,
        reviewDecision: typeof params.reviewDecision === "string" ? params.reviewDecision : undefined,
      });
    case "diagnoseIssue":
      return runtime.diagnoseIssue(
        String(params.sessionId ?? defaultSessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
    case "autoFlowIssue":
      return runtime.autoFlowIssue(String(params.sessionId ?? defaultSessionId), createConfiguredWorkerSpawner(), params.options ?? {});
    case "resetAutoflowState":
      return runtime.resetAutoflowState(String(params.sessionId ?? defaultSessionId), asStringArray(params.issueRefs));
    case "refreshReviewState":
      return runtime.refreshReviewState(
        String(params.sessionId ?? defaultSessionId),
        String(params.issueRef),
      );
    case "summarizeHandoff":
      return runtime.summarizeHandoff(String(params.sessionId ?? defaultSessionId));
    case "observeFlowSubject":
      return runtime.observeFlowSubject({
        type: typeof params.type === "string" ? params.type : "issue",
        ref: String(params.ref),
      });
    default:
      throw new Error(`Unsupported CLI Work Runtime method: ${method}`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function commandManifest() {
  return {
    manifestVersion: 1,
    stdout: "json",
    stderr: "diagnostics",
    layout: flowLayout,
    commands: program.commands.map((command) => ({
      name: command.name(),
      description: command.description(),
      arguments: command.registeredArguments.map((argument) => ({
        name: argument.name(),
        description: argument.description,
        required: argument.required,
        variadic: argument.variadic,
        default: serializableDefault(argument.defaultValue),
        choices: argument.argChoices,
      })),
      options: command.options.map((option) => ({
        name: option.attributeName(),
        flags: option.flags,
        description: option.description,
        requiredValue: option.required,
        optionalValue: option.optional,
        mandatory: option.mandatory,
        boolean: option.isBoolean(),
        negated: option.negate,
        variadic: option.variadic,
        default: serializableDefault(option.defaultValue),
        choices: option.argChoices,
      })),
    })),
    rawWorkRuntimeMethods,
  };
}

function serializableDefault(value: unknown): unknown {
  return value === undefined ? undefined : value;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, got ${value}.`);
  return parsed;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function parseWorkerExecutor(value: unknown): WorkerExecutor | undefined {
  if (value === undefined) return undefined;
  if (workerExecutorValues.includes(value as WorkerExecutor)) return value as WorkerExecutor;
  throw new Error(`Expected executor ${workerExecutorValues.join(", ")}, got ${String(value)}.`);
}

function parseWorkerResultStatus(value: unknown): Extract<WorkerStatus, "succeeded" | "blocked" | "failed"> {
  if ((terminalWorkerStatusValues as readonly string[]).includes(String(value))) return value as Extract<WorkerStatus, "succeeded" | "blocked" | "failed">;
  throw new Error(`Expected worker result status ${terminalWorkerStatusValues.join(", ")}, got ${String(value)}.`);
}

function parseEvidenceCriteria(value: unknown, summary: string, source: string): AcceptanceCriterionEvidence[] {
  return (asStringArray(value) ?? []).map((label) => ({
    label,
    status: "passed",
    evidence: summary,
    source,
  }));
}

function parseDocumentationDisposition(value: unknown): "not_needed" | "updated" | "needed" {
  if (value === "not_needed" || value === "updated" || value === "needed") return value;
  throw new Error(`Expected documentation disposition not_needed, updated, or needed, got ${String(value)}.`);
}

function parseJiraIssueType(value: string): "Bug" | "Task" | "Story" {
  if (value === "Bug" || value === "Task" || value === "Story") return value;
  throw new Error(`Expected issue type Bug, Task, or Story, got ${value}.`);
}

function parseBranchKind(value: string | undefined): "bug" | "feature" | undefined {
  if (value === undefined) return undefined;
  if (value === "bug" || value === "feature") return value;
  throw new Error(`Expected branch kind bug or feature, got ${value}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createIssueTracker() {
  const issueTracker = flowConfig?.issueTracker;
  const type = configString(issueTracker, "type") ?? "jira";
  if (type === "local") {
    return new LocalIssueTrackerAdapter({
      ledger: workflowLedger,
      projectName: flowConfig?.project.name,
      prefix: configString(issueTracker, "prefix"),
    });
  }
  if (type === "github" || type === "github_issues") {
    return new GhGitHubIssueTrackerAdapter({
      cwd: repoRoot,
      owner: configString(issueTracker, "owner") ?? configString(flowConfig?.collaboration, "owner"),
      repo: configString(issueTracker, "repo") ?? configString(flowConfig?.collaboration, "repo") ?? "flow",
      assignee: configString(issueTracker, "assignee"),
      activeLabels: configStringArray(issueTracker, "activeLabels"),
      backlogLabels: configStringArray(issueTracker, "backlogLabels"),
    });
  }
  return new AcliJiraAdapter({
    cwd: repoRoot,
    siteUrl: configString(issueTracker, "siteUrl"),
    projectKey: configString(issueTracker, "projectKey"),
    activeQueueJql: configString(issueTracker, "activeQueueJql"),
    backlogQueueJql: configString(issueTracker, "backlogQueueJql"),
    email: configString(issueTracker, "email"),
    apiToken: configString(issueTracker, "apiToken"),
  });
}

function createCollaboration() {
  const collaboration = flowConfig?.collaboration;
  const type = configString(collaboration, "type") ?? (configString(flowConfig?.issueTracker, "type") === "local" ? "none" : "github");
  if (type === "none" || type === "local") {
    return new NoopCodeCollaborationAdapter();
  }
  return new GhGitHubAdapter({ cwd: repoRoot, owner: configString(collaboration, "owner") });
}

function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configStringArray(config: Record<string, unknown> | undefined, key: string): string[] {
  const value = config?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
