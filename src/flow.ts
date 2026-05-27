#!/usr/bin/env node

import {
  AcliJiraAdapter,
  assessIssue,
  bootstrapFlowConfig,
  createWorkflowLedger,
  configToProjectTopology,
  configToWorkTypeRegistry,
  FlowStore,
  FlowWorkRuntime,
  GhGitHubAdapter,
  IssueStateValue,
  flowLayout,
  flowRuntimePath,
  flowWorkflowLedgerPath,
  resolveFlowPath,
  terminalWorkerStatusValues,
  type AcceptanceCriterionEvidence,
  validateFlowConfig,
  verifyJsonlWorkflowLedger,
  type CreateIssueOptions,
  type IssueTrackerProvider,
  type WorkerExecutor,
  type WorkerStatus,
  type WorkItem,
  workerExecutorValues,
} from "./index.js";
import { GhGitHubIssueTrackerAdapter } from "./adapters/github.js";
import { LocalIssueTrackerAdapter, NoopCodeCollaborationAdapter } from "./adapters/local.js";
import { repoRoot } from "./flow-runtime.js";
import { JsonCliError, runJsonCli } from "./json-cli.js";

const configValidation = await validateFlowConfig({ projectRoot: repoRoot });
const flowConfig = configValidation.config;
const defaultSessionId = configString(flowConfig?.runtime, "defaultSessionId") ?? "cli";
const workflowLedger = createWorkflowLedger({
  cwd: repoRoot,
  adapter: configString(flowConfig?.ledger, "type"),
  path: resolveWorkflowLedgerPath(),
});
const configuredIssueTracker: IssueTrackerProvider = createIssueTracker();
const configuredCollaboration = createCollaboration();
const rawWorkRuntimeMethods = [
  "inspectDashboardQueue",
  "inspectQueue",
  "inspectBacklog",
  "createSession",
  "selectIssue",
  "createIssue",
  "adoptBranch",
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
  store: new FlowStore({ root: resolveRuntimeStorePath() }),
  ledger: workflowLedger,
  collaboration: configuredCollaboration,
  issueTracker: configuredIssueTracker,
  defaultJiraProjectKey: configString(flowConfig?.issueTracker, "projectKey"),
  autoflowBlockedThreshold: flowConfig?.runtime?.autoflowBlockedThreshold,
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

await runJsonCli({
  manifest: ({ target }) => flowManifest(target),
  route: routeFlowRequest,
});

async function routeFlowRequest(request: Record<string, unknown>): Promise<unknown> {
  const op = requireString(request, "op");
  if (op === "manifest") return flowManifest(optionalString(request, "target"));
  if (op !== "runtime") rejectLegacyPublicFields(request);
  if (op === "state") {
    const activeSessionId = sessionId(request);
    await ensureSession(activeSessionId);
    return runtime.summarizeHandoff(activeSessionId);
  }
  if (op === "queue") return runtime.inspectQueue(limit(request));
  if (op === "backlog") return runtime.inspectBacklog(limit(request));
  if (op === "bootstrap") {
    return bootstrapFlowConfig({
      projectRoot: repoRoot,
      force: Boolean(request.force),
      storage: parseBootstrapStorage(request.storage ?? "user"),
    });
  }
  if (op === "config") return handleConfigRequest(request);
  if (op === "ledger") return handleLedgerRequest(request);
  if (op === "issue") return handleIssueRequest(request);
  if (op === "workflow") return handleWorkflowRequest(request);
  if (op === "runtime") return dispatch(requireString(request, "method"), paramsFromRequest(request));
  throw new JsonCliError("BAD_OP", `Unsupported Flow op: ${op}`, {
    details: { supportedOps: ["manifest", "state", "queue", "backlog", "bootstrap", "config", "ledger", "issue", "workflow", "runtime"] },
  });
}

async function handleConfigRequest(request: Record<string, unknown>): Promise<unknown> {
  const mode = optionalString(request, "mode") ?? "validate";
  const result = await validateFlowConfig({ projectRoot: repoRoot, configPath: optionalString(request, "path") });
  if (mode === "validate") {
    const { config: _config, ...publicResult } = result;
    return publicResult;
  }
  if (mode !== "explain") throw badMode("config", mode, ["validate", "explain"]);
  const config = result.config;
  return {
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
          }
          : undefined,
      }
      : undefined,
  };
}

async function handleLedgerRequest(request: Record<string, unknown>): Promise<unknown> {
  const mode = optionalString(request, "mode") ?? "verify";
  if (mode !== "verify") throw badMode("ledger", mode, ["verify"]);
  return verifyJsonlWorkflowLedger(
    optionalString(request, "path") ?? resolveWorkflowLedgerPath(),
    { rebuildProjections: Boolean(request.rebuildProjections) },
  );
}

async function handleIssueRequest(request: Record<string, unknown>): Promise<unknown> {
  const mode = requireString(request, "mode");
  if (mode === "view") return runtime.inspectIssue(requireId(request));
  const activeSessionId = sessionId(request);
  await ensureSession(activeSessionId);
  switch (mode) {
    case "select":
      return runtime.selectIssue(activeSessionId, await queueIssue(requireId(request)));
    case "route":
      return runtime.routeIssue(activeSessionId, requireId(request), asStringArray(request.repoKeys) ?? []);
    case "create":
      return runtime.createIssue(activeSessionId, {
        projectKey: optionalString(request, "projectKey"),
        issueType: parseJiraIssueType(optionalString(request, "issueType") ?? "Bug"),
        branchKind: parseBranchKind(optionalString(request, "branchKind")),
        summary: requireString(request, "summary"),
        description: optionalString(request, "description"),
        repoKeys: asStringArray(request.repoKeys),
        select: typeof request.select === "boolean" ? request.select : true,
      });
    case "adoptBranch":
      return runtime.adoptBranch(activeSessionId, {
        issueRef: optionalString(request, "id"),
        summary: optionalString(request, "summary"),
        description: optionalString(request, "description"),
        repoKey: optionalString(request, "repoKey"),
        worktreePath: optionalString(request, "worktreePath"),
        baseBranch: optionalString(request, "baseBranch"),
        prefix: optionalString(request, "prefix") ?? configString(flowConfig?.issueTracker, "prefix") ?? "FLOW",
        select: typeof request.select === "boolean" ? request.select : true,
      });
    case "adoptWorkspace":
      return runtime.adoptWorkspace(activeSessionId, requireId(request), {
        repoKey: optionalString(request, "repoKey"),
        worktreePath: requireString(request, "worktreePath"),
        baseBranch: optionalString(request, "baseBranch"),
      });
    default:
      throw badMode("issue", mode, ["view", "select", "create", "route", "adoptBranch", "adoptWorkspace"]);
  }
}

async function handleWorkflowRequest(request: Record<string, unknown>): Promise<unknown> {
  const mode = requireString(request, "mode");
  const activeSessionId = sessionId(request);
  await ensureSession(activeSessionId);
  const issueRef = optionalString(request, "id");
  if (["advance", "autoflow", "doctor", "audit", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation", "observe"].includes(mode)) {
    requireValue(issueRef, "id");
  }
  if (issueRef && ["advance", "autoflow", "doctor", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation"].includes(mode)) {
    await runtime.selectIssue(activeSessionId, await queueIssue(issueRef));
  }
  switch (mode) {
    case "advance":
      return runtime.advanceIssue(activeSessionId, optionalString(request, "approveConfirmationId"));
    case "autoflow":
      return runtime.autoFlowIssue(activeSessionId, {
        autoPrepareWorkspace: true,
        maxSteps: limit(request, 20),
      });
    case "doctor":
    case "audit":
      return runtime.diagnoseIssue(activeSessionId, issueRef);
    case "handoff":
      return runtime.summarizeHandoff(activeSessionId);
    case "recordResult":
      return runtime.recordLocalThreadResult(activeSessionId, {
        issueRef,
        repoKey: optionalString(request, "repoKey"),
        taskId: optionalString(request, "taskId"),
        workJobId: optionalString(request, "workJobId"),
        status: parseWorkerResultStatus(request.status ?? "succeeded"),
        summary: requireString(request, "summary"),
        changedFiles: asStringArray(request.changedFiles),
        testsRun: asStringArray(request.testsRun),
        blockers: asStringArray(request.blockers),
        nextPickup: optionalString(request, "nextPickup"),
      });
    case "recordPullRequest":
      return runtime.recordPullRequest(activeSessionId, {
        issueRef: requireValue(issueRef, "issueRef"),
        repo: requireString(request, "repo"),
        number: Number(request.number),
        url: requireString(request, "url"),
        headRefName: optionalString(request, "headRefName"),
        isDraft: Boolean(request.isDraft),
        checksPassing: typeof request.checksPassing === "boolean" ? request.checksPassing : undefined,
        reviewDecision: optionalString(request, "reviewDecision"),
      });
    case "recordEvidence": {
      const summary = requireString(request, "summary");
      const source = optionalString(request, "source") ?? "local";
      return runtime.recordEvidence(activeSessionId, {
        issueRef: requireValue(issueRef, "issueRef"),
        summary,
        source,
        criteria: parseEvidenceCriteria(request.criteria, summary, source),
      });
    }
    case "recordDocumentation":
      return runtime.recordDocumentation(activeSessionId, {
        issueRef: requireValue(issueRef, "issueRef"),
        disposition: parseDocumentationDisposition(request.disposition),
        summary: requireString(request, "summary"),
      });
    case "observe":
      return runtime.observeFlowSubject({
        type: optionalString(request, "type") ?? "issue",
        ref: requireValue(issueRef, "ref"),
      });
    default:
      throw badMode("workflow", mode, ["advance", "audit", "autoflow", "doctor", "handoff", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation", "observe"]);
  }
}

function flowManifest(target?: string) {
  if (!target) {
    return {
      manifestVersion: 2,
      surface: "flow",
      transport: {
        stdin: "json-body",
        argv: "single-json-body",
        stdout: "single-json-document",
        stderr: "diagnostics",
      },
      invocation: {
        manifest: ["flow", "flow manifest", "flow --help"],
        body: ["flow '{\"op\":\"state\"}'", "printf '%s\\n' '{\"op\":\"state\"}' | flow"],
      },
      detail: { op: "manifest", target: "<op>" },
      targets: ["workflow", "issue", "runtime", "config", "layout"],
      ops: {
        manifest: "Get compact or targeted capability metadata.",
        state: "Read current Flow state, optionally scoped by id.",
        queue: "Inspect active issue queue.",
        backlog: "Inspect backlog.",
        bootstrap: "Create Flow config from repo metadata.",
        config: "Validate or explain Flow config.",
        ledger: "Verify workflow ledger.",
        issue: "Inspect, create, select, or adopt issue/workspace state through the configured issue tracker.",
        workflow: "Advance, audit, autoflow, record, or observe workflow state.",
        runtime: "Call a raw Work Runtime method by name.",
      },
    };
  }
  if (target === "workflow") {
    return {
      target,
      modes: ["advance", "audit", "autoflow", "doctor", "handoff", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation", "observe"],
      examples: [
        { op: "workflow", mode: "audit", id: "FLOW-123" },
        { op: "workflow", mode: "autoflow", id: "FLOW-123", limit: 20 },
        { op: "workflow", mode: "recordEvidence", id: "FLOW-123", summary: "npm test passed", criteria: ["tests"] },
      ],
      id: "Required issue/work item id for issue-scoped workflow modes.",
    };
  }
  if (target === "issue") {
    return {
      target,
      issueTracker: issueTrackerManifest(),
      recommendedAgentFlow: [
        "If the user gives an issue id, call issue view first.",
        "Use queue/backlog for active configured-tracker work discovery.",
        "Use create only when the user asks to create new tracked work.",
        "Use adoptBranch/adoptWorkspace for local work that should stay Flow-local until published.",
      ],
      modes: ["view", "select", "create", "route", "adoptBranch", "adoptWorkspace"],
      examples: [
        { op: "issue", mode: "view", id: issueRefExample() },
        { op: "issue", mode: "select", id: "FLOW-123" },
        { op: "issue", mode: "route", id: "FLOW-123", repoKeys: ["main"] },
        { op: "issue", mode: "adoptWorkspace", id: "FLOW-123", repoKey: "main", worktreePath: "/path/to/worktree" },
      ],
      id: "Required issue/work item id for existing work items; create/adoptBranch may omit id to allocate one.",
    };
  }
  if (target === "runtime") {
    return {
      target,
      shape: { op: "runtime", method: "<method>", params: {} },
      methods: rawWorkRuntimeMethods,
    };
  }
  if (target === "config") {
    return {
      target,
      modes: ["validate", "explain"],
      examples: [
        { op: "config", mode: "validate" },
        { op: "config", mode: "explain" },
      ],
    };
  }
  if (target === "layout") {
    return {
      target,
      layout: flowLayout,
    };
  }
  return {
    target,
    error: {
      code: "UNKNOWN_MANIFEST_TARGET",
      message: `Unknown manifest target: ${target}`,
      targets: ["workflow", "issue", "runtime", "config", "layout"],
    },
  };
}

function issueTrackerManifest() {
  const issueTracker = flowConfig?.issueTracker;
  const type = configString(issueTracker, "type") ?? "local";
  const capabilities = configuredIssueTracker.capabilities;
  return {
    type,
    refHint: issueRefExample(),
    sourceOfTruth: ".flow/config.yaml",
    capabilities: {
      view: typeof configuredIssueTracker.getIssue === "function",
      queue: typeof configuredIssueTracker.fetchActiveQueue === "function",
      backlog: typeof configuredIssueTracker.fetchBacklogQueue === "function",
      create: Boolean(capabilities?.canCreateIssues && configuredIssueTracker.createIssue),
      transition: Boolean(capabilities?.canTransitionIssues && configuredIssueTracker.transitionIssue),
      comments: Boolean(capabilities?.canPostComments && configuredIssueTracker.postComment),
      planningLane: Boolean(capabilities?.canManageActivePlanningLane && configuredIssueTracker.moveIssuesToActivePlanningLane),
    },
  };
}

function issueRefExample(): string {
  const type = configString(flowConfig?.issueTracker, "type") ?? "local";
  if (type === "github" || type === "github_issues") return "GH-123";
  if (type === "jira") return `${configString(flowConfig?.issueTracker, "projectKey") ?? "PROJ"}-123`;
  return `${configString(flowConfig?.issueTracker, "prefix") ?? "FLOW"}-123`;
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
      return runtime.inspectDashboardQueue(
        Number(params.limit ?? 10),
        typeof params.sessionId === "string" ? params.sessionId : undefined,
      );
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
    case "adoptBranch":
      return runtime.adoptBranch(String(params.sessionId ?? defaultSessionId), {
        issueRef: typeof params.issueRef === "string" ? params.issueRef : undefined,
        summary: typeof params.summary === "string" ? params.summary : undefined,
        description: typeof params.description === "string" ? params.description : undefined,
        repoKey: typeof params.repoKey === "string" ? params.repoKey : undefined,
        worktreePath: typeof params.worktreePath === "string" ? params.worktreePath : undefined,
        baseBranch: typeof params.baseBranch === "string" ? params.baseBranch : undefined,
        prefix: typeof params.prefix === "string" ? params.prefix : undefined,
        select: typeof params.select === "boolean" ? params.select : undefined,
      });
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
        headRefName: typeof params.headRefName === "string" ? params.headRefName : undefined,
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
      return runtime.autoFlowIssue(String(params.sessionId ?? defaultSessionId), params.options ?? {});
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
      throw new JsonCliError("BAD_METHOD", `Unsupported Work Runtime method: ${method}`, {
        manifestTarget: "runtime",
        details: { supportedMethods: rawWorkRuntimeMethods },
      });
  }
}

function resolveRuntimeStorePath(): string {
  const configured = configString(flowConfig?.runtime, "storeDir") ?? configString(flowConfig?.runtime, "stateDir");
  return configured ? resolveFlowPath(repoRoot, configured) : flowRuntimePath(repoRoot);
}

function resolveWorkflowLedgerPath(): string {
  const configured = configString(flowConfig?.runtime, "workflowLedgerPath");
  return configured ? resolveFlowPath(repoRoot, configured) : flowWorkflowLedgerPath(repoRoot);
}

function parseBootstrapStorage(value: unknown): "user" | "repo-untracked" | "repo-tracked" {
  if (value === "user" || value === "repo-untracked" || value === "repo-tracked") return value;
  throw new Error(`Expected bootstrap storage user, repo-untracked, or repo-tracked, got ${String(value)}.`);
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function limit(request: Record<string, unknown>, fallback = 10): number {
  const value = request.limit ?? fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer limit, got ${String(value)}.`);
  return parsed;
}

function sessionId(request: Record<string, unknown>): string {
  return optionalString(request, "id") ?? defaultSessionId;
}

function requireId(request: Record<string, unknown>): string {
  return requireString(request, "id");
}

function rejectLegacyPublicFields(request: Record<string, unknown>): void {
  if (Object.hasOwn(request, "issueRef")) throw badField("issueRef", "unsupported; use id");
  if (Object.hasOwn(request, "sessionId")) throw badField("sessionId", "unsupported; work-item id scopes runtime state");
}

function paramsFromRequest(request: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(request.params)) return request.params;
  const { op: _op, method: _method, ...params } = request;
  return params;
}

function requireString(request: Record<string, unknown>, key: string): string {
  const value = request[key];
  if (typeof value === "string" && value.trim()) return value;
  throw badField(key, "non-empty string");
}

function optionalString(request: Record<string, unknown>, key: string): string | undefined {
  const value = request[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requireValue(value: string | undefined, key: string): string {
  if (value) return value;
  throw badField(key, "non-empty string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badMode(target: string, mode: string, supportedModes: string[]): JsonCliError {
  return new JsonCliError("BAD_MODE", `Unsupported ${target} mode: ${mode}`, {
    manifestTarget: target,
    details: { supportedModes },
  });
}

function badField(field: string, expected: string): JsonCliError {
  if (expected.startsWith("unsupported")) {
    return new JsonCliError("BAD_FIELD", `Unsupported field: ${field}`, {
      details: { field, expected },
    });
  }
  return new JsonCliError("BAD_FIELD", `Expected ${expected} field: ${field}`, {
    details: { field, expected },
  });
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
  const type = configString(issueTracker, "type") ?? "local";
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
  const type = configString(collaboration, "type") ?? "none";
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
