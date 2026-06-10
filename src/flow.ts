#!/usr/bin/env node

import {
  bootstrapFlowConfig,
  migrateFlowConfig,
  validateFlowConfig,
} from "./config/config-loader.js";
import { GhGitHubAdapter } from "./adapters/github.js";
import { flowLayout } from "./flow-layout.js";
import { terminalWorkerStatusValues, workerExecutorValues, type WorkerExecutor, type WorkerStatus } from "./contracts/executor.js";
import {
  type AcceptanceCriterionEvidence,
  type WorkItem,
} from "./contracts.js";
import { repoRoot } from "./flow-runtime.js";
import { JsonCliError, runJsonCli } from "./json-cli.js";
import { createConfiguredWorkRuntime } from "./runtime-factory.js";
import {
  requireWorkItem,
  requireCreateIssueOptions,
  requireWorkJobExecutor,
  requireWorkJobResult,
} from "./dispatch-validators.js";
import { resolveCliIssue } from "./cli-issue.js";

const configValidation = await validateFlowConfig({ projectRoot: repoRoot });
const configuredRuntime = createConfiguredWorkRuntime({ projectRoot: repoRoot, flowConfig: configValidation.config });
const flowConfig = configuredRuntime.flowConfig;
const defaultSessionId = configString(flowConfig?.runtime, "defaultSessionId") ?? "cli";
const workflowLedger = configuredRuntime.workflowLedger;
const configuredIssueTracker = configuredRuntime.issueTracker;
const rawWorkRuntimeMethods = [
  "inspectDashboardQueue",
  "inspectQueue",
  "inspectBacklog",
  "createSession",
  "selectIssue",
  "intakeIssue",
  "createIssue",
  "claimWorkJob",
  "listWorkJobs",
  "recordWorkJobResult",
  "adoptBranch",
  "bootstrapIssue",
  "bootstrapJiraIssue",
  "createJiraIssue",
  "routeIssue",
  "prepareWorkspace",
  "adoptWorkspace",
  "advanceIssue",
  "diagnoseIssue",
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
const runtime = configuredRuntime.runtime;

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
  if (op === "review") return handleReviewRequest(request);
  if (op === "runtime") return dispatch(requireString(request, "method"), paramsFromRequest(request));
  throw new JsonCliError("BAD_OP", `Unsupported Flow op: ${op}`, {
    details: { supportedOps: ["manifest", "state", "queue", "backlog", "bootstrap", "config", "ledger", "issue", "workflow", "review", "runtime"] },
  });
}

async function handleConfigRequest(request: Record<string, unknown>): Promise<unknown> {
  const mode = optionalString(request, "mode") ?? "validate";
  const configPath = optionalString(request, "path");
  const result = await validateFlowConfig({ projectRoot: repoRoot, configPath });
  if (mode === "validate") {
    const { config: _config, ...publicResult } = result;
    return publicResult;
  }
  if (mode === "migrate") {
    return migrateFlowConfig({
      projectRoot: repoRoot,
      configPath,
      write: request.write === true,
    });
  }
  if (mode !== "explain") throw badMode("config", mode, ["validate", "explain", "migrate"]);
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
        store: config.runtime.store,
        agentSession: config.runtime.agentSession,
        executionPlane: config.runtime.executionPlane
          ? {
            type: config.runtime.executionPlane.type,
            workerName: config.runtime.executionPlane.workerName,
            slots: config.runtime.executionPlane.slots,
            dashboardUrl: config.runtime.executionPlane.dashboardUrl,
          }
          : undefined,
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
  const issues = await workflowLedger.listIssues(1);
  return {
    ok: true,
    backend: configuredRuntime.workflowLedgerPath === "<postgres>" ? "postgres" : "sqlite",
    path: configuredRuntime.workflowLedgerPath,
    sampleIssueCount: issues.length,
  };
}

async function handleIssueRequest(request: Record<string, unknown>): Promise<unknown> {
  const mode = requireString(request, "mode");
  if (mode === "view") return runtime.inspectIssue(requireId(request));
  if (mode === "triage") {
    return runtime.triageIssues({
      dryRun: request.apply === true ? false : true,
      apply: request.apply === true,
      limit: typeof request.limit === "number" ? request.limit : undefined,
      ids: asStringArray(request.ids),
    });
  }
  const activeSessionId = sessionId(request);
  await ensureSession(activeSessionId);
  switch (mode) {
    case "select":
      return runtime.selectIssue(activeSessionId, await queueIssue(requireId(request)));
    case "route":
      return runtime.routeIssue(activeSessionId, requireId(request), asStringArray(request.repoKeys) ?? []);
    case "intake":
      return runtime.intakeIssue(activeSessionId, {
        projectKey: optionalString(request, "projectKey"),
        issueType: parseJiraIssueType(optionalString(request, "issueType") ?? "Bug"),
        branchKind: parseBranchKind(optionalString(request, "branchKind")),
        title: optionalString(request, "title"),
        summary: requireString(request, "summary"),
        description: optionalString(request, "description"),
        repoKeys: asStringArray(request.repoKeys),
        select: typeof request.select === "boolean" ? request.select : true,
        apply: request.apply === true,
        dryRun: request.apply === true ? false : true,
        review: request.review === true,
      });
    case "create":
      return runtime.createIssue(activeSessionId, {
        projectKey: optionalString(request, "projectKey"),
        issueType: parseJiraIssueType(optionalString(request, "issueType") ?? "Bug"),
        branchKind: parseBranchKind(optionalString(request, "branchKind")),
        title: optionalString(request, "title"),
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
      throw badMode("issue", mode, ["view", "select", "intake", "create", "route", "adoptBranch", "adoptWorkspace", "triage"]);
  }
}

async function handleWorkflowRequest(request: Record<string, unknown>): Promise<unknown> {
  const mode = requireString(request, "mode");
  const activeSessionId = sessionId(request);
  await ensureSession(activeSessionId);
  const issueRef = optionalString(request, "id");
  if (["advance", "doctor", "audit", "adoptHandoff", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation", "recordAcceptance", "observe"].includes(mode)) {
    requireValue(issueRef, "id");
  }
  if (issueRef && ["advance", "doctor", "adoptHandoff", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation", "recordAcceptance"].includes(mode)) {
    await runtime.selectIssue(activeSessionId, await queueIssue(issueRef));
  }
  switch (mode) {
    case "advance":
      return runtime.advanceIssue(activeSessionId, optionalString(request, "approveConfirmationId"));
    case "doctor":
    case "audit": {
      const diagnosis = await runtime.diagnoseIssue(activeSessionId, issueRef);
      if (request.strict === true && doctorStrictFailure(diagnosis)) {
        throw new JsonCliError("DOCTOR_STRICT_FAILED", `Flow doctor reported ${diagnosis.status} status for ${diagnosis.issueRef}.`, {
          manifestTarget: "workflow",
          details: {
            issueRef: diagnosis.issueRef,
            status: diagnosis.status,
            blockers: diagnosis.findings.filter((finding) => finding.severity === "blocker").length,
            warnings: diagnosis.findings.filter((finding) => finding.severity === "warning").length,
            nextAction: diagnosis.nextAction,
          },
        });
      }
      return diagnosis;
    }
    case "handoff":
      return runtime.summarizeHandoff(activeSessionId);
    case "adoptHandoff":
      return runtime.adoptPendingLocalThread(activeSessionId, {
        adopter: optionalString(request, "adopter"),
        summary: optionalString(request, "summary"),
      });
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
        checksPending: typeof request.checksPending === "boolean" ? request.checksPending : undefined,
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
    case "recordAcceptance": {
      const evidenceSummary = optionalString(request, "evidenceSummary") ?? requireString(request, "summary");
      const evidenceSource = optionalString(request, "source") ?? "local";
      const documentationSummary = optionalString(request, "documentationSummary") ?? requireString(request, "summary");
      const evidence = await runtime.recordEvidence(activeSessionId, {
        issueRef: requireValue(issueRef, "issueRef"),
        summary: evidenceSummary,
        source: evidenceSource,
        criteria: parseEvidenceCriteria(request.criteria, evidenceSummary, evidenceSource),
      });
      const documentation = await runtime.recordDocumentation(activeSessionId, {
        issueRef: requireValue(issueRef, "issueRef"),
        disposition: parseDocumentationDisposition(request.disposition),
        summary: documentationSummary,
      });
      return { evidence, documentation };
    }
    case "observe":
      return runtime.observeFlowSubject({
        type: optionalString(request, "type") ?? "issue",
        ref: requireValue(issueRef, "ref"),
      });
    default:
      throw badMode("workflow", mode, ["advance", "audit", "doctor", "handoff", "adoptHandoff", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation", "recordAcceptance", "observe"]);
  }
}

async function handleReviewRequest(request: Record<string, unknown>): Promise<unknown> {
  const rawTarget = optionalString(request, "mode") ?? optionalString(request, "target") ?? "local";
  const target = rawTarget === "codeReview" ? "code_review" : rawTarget;
  if (target !== "local" && target !== "code_review") {
    throw badMode("review", rawTarget, ["local", "code_review", "codeReview"]);
  }
  const activeSessionId = sessionId(request);
  await ensureSession(activeSessionId);
  const issueRef = requireId(request);
  await runtime.selectIssue(activeSessionId, await queueIssue(issueRef));
  if (target === "local") {
    return runtime.reviewLocal(activeSessionId, issueRef);
  }
  return runtime.reviewCodeReview(activeSessionId, issueRef, {
    repo: optionalString(request, "repo"),
    post: request.post === true,
  });
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
      targets: ["workflow", "issue", "review", "runtime", "config", "layout"],
      ops: {
        manifest: "Get compact or targeted capability metadata.",
        state: "Read current Flow state, optionally scoped by id.",
        queue: "Inspect active issue queue.",
        backlog: "Inspect backlog.",
        bootstrap: "Create Flow config from repo metadata.",
        config: "Validate or explain Flow config.",
        ledger: "Verify workflow ledger.",
        issue: "Inspect, create, select, or adopt issue/workspace state through the configured issue tracker.",
        workflow: "Advance, audit, record, or observe workflow state.",
        review: "Provider-neutral review of local readiness or external code review state.",
        runtime: "Call a raw Work Runtime method by name.",
      },
    };
  }
  if (target === "workflow") {
    return {
      target,
      modes: ["advance", "audit", "doctor", "handoff", "adoptHandoff", "recordResult", "recordPullRequest", "recordEvidence", "recordDocumentation", "recordAcceptance", "observe"],
      examples: [
        { op: "workflow", mode: "audit", id: "FLOW-123" },
        { op: "workflow", mode: "adoptHandoff", id: "FLOW-123", adopter: "claude" },
        { op: "workflow", mode: "recordResult", id: "FLOW-123", repoKey: "main", status: "succeeded", summary: "Implemented the handoff.", changedFiles: [], testsRun: [] },
        { op: "workflow", mode: "recordEvidence", id: "FLOW-123", summary: "npm test passed", criteria: ["tests"] },
        { op: "workflow", mode: "recordAcceptance", id: "FLOW-123", summary: "npm test passed", criteria: ["tests"], disposition: "not_needed" },
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
        "Use intake with review:true before create when semantic dedupe is needed.",
        "Use create only when the user asks to create new tracked work.",
        "Use adoptBranch/adoptWorkspace for local work that should stay Flow-local until published.",
        "Use triage to analyze open issues and propose cleanup actions.",
      ],
      modes: ["view", "select", "intake", "create", "route", "adoptBranch", "adoptWorkspace", "triage"],
      examples: [
        { op: "issue", mode: "view", id: issueRefExample() },
        { op: "issue", mode: "select", id: "FLOW-123" },
        { op: "issue", mode: "intake", dryRun: true, review: true, summary: "Add SQL workflow ledger", issueType: "Task" },
        { op: "issue", mode: "intake", apply: true, summary: "Add SQL workflow ledger", issueType: "Task" },
        { op: "issue", mode: "route", id: "FLOW-123", repoKeys: ["main"] },
        { op: "issue", mode: "adoptWorkspace", id: "FLOW-123", repoKey: "main", worktreePath: "/path/to/worktree" },
        { op: "issue", mode: "triage", dryRun: true, limit: 50 },
        { op: "issue", mode: "triage", apply: true, ids: ["GH-123", "GH-124"] },
      ],
      id: "Required issue/work item id for existing work items; create/intake/adoptBranch may omit id to allocate one. Triage mode does not require id.",
    };
  }
  if (target === "review") {
    return {
      target,
      modes: ["local", "codeReview"],
      targets: ["local", "code_review"],
      examples: [
        { op: "review", id: "FLOW-123" },
        { op: "review", id: "FLOW-123", mode: "local" },
        { op: "review", id: "FLOW-123", mode: "codeReview" },
        { op: "review", id: "FLOW-123", mode: "codeReview", repo: "owner/repo", post: false },
      ],
      id: "Required issue/work item id.",
      target_description: {
        local: "Review local readiness state: worker results, evidence, documentation, findings.",
        code_review: "Review external code review state: pull request status, checks, review decision.",
      },
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
      modes: ["validate", "explain", "migrate"],
      examples: [
        { op: "config", mode: "validate" },
        { op: "config", mode: "explain" },
        { op: "config", mode: "migrate" },
        { op: "config", mode: "migrate", write: true },
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
      targets: ["workflow", "issue", "review", "runtime", "config", "layout"],
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
      search: Boolean(capabilities?.canSearchIssues && configuredIssueTracker.searchIssues),
      tagging: Boolean(capabilities?.canTagIssues && configuredIssueTracker.addIssueTags),
      planningLane: Boolean(capabilities?.canManageActivePlanningLane && configuredIssueTracker.moveIssuesToActivePlanningLane),
      triage: true,
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
  return resolveCliIssue(runtime, issueRef, (candidate, ref) =>
    candidate.ref.toUpperCase() === ref.toUpperCase() || issueMatchesPullRequest(candidate, ref)
  );
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
      return runtime.selectIssue(String(params.sessionId ?? defaultSessionId), requireWorkItem(params.issue, method));
    case "intakeIssue":
      return runtime.intakeIssue(
        String(params.sessionId ?? defaultSessionId),
        requireCreateIssueOptions(params.options, method),
      );
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
        requireCreateIssueOptions(params.options, method),
      );
    case "listWorkJobs":
      return runtime.listWorkJobs(
        String(params.sessionId ?? defaultSessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
    case "claimWorkJob":
      return runtime.claimWorkJob(
        String(params.sessionId ?? defaultSessionId),
        String(params.jobId),
        requireWorkJobExecutor(params.executor, method),
      );
    case "recordWorkJobResult":
      return runtime.recordWorkJobResult(
        String(params.sessionId ?? defaultSessionId),
        requireWorkJobResult(params.result, method),
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
        requireCreateIssueOptions(params.options, method),
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
        checksPending: typeof params.checksPending === "boolean" ? params.checksPending : undefined,
        reviewDecision: typeof params.reviewDecision === "string" ? params.reviewDecision : undefined,
      });
    case "diagnoseIssue":
      return runtime.diagnoseIssue(
        String(params.sessionId ?? defaultSessionId),
        typeof params.issueRef === "string" ? params.issueRef : undefined,
      );
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

function parseBootstrapStorage(value: unknown): "user" | "repo-untracked" | "repo-tracked" {
  if (value === "user" || value === "repo-untracked" || value === "repo-tracked") return value;
  throw new Error(`Expected bootstrap storage user, repo-untracked, or repo-tracked, got ${String(value)}.`);
}

function doctorStrictFailure(diagnosis: { status: string; findings: Array<{ severity: string }> }): boolean {
  if (diagnosis.status !== "ok") return true;
  return diagnosis.findings.some((finding) => finding.severity === "warning" || finding.severity === "blocker");
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

function configString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
