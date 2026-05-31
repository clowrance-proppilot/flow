import {
  type AcceptanceCriterionEvidence,
  type WorkRuntimeSession,
  type PendingConfirmation,
  type WorkerExecutor,
  type WorkerStatus,
  type WorkerTaskRequest,
  type WorkerRunRecord,
  type WorkJob,
  type WorkJobExecutor,
  type WorkJobResult,
  type WorkEnvelope,
  type WorkType,
  type WorkItem,
  type WorkerTaskResult,
  type DocumentationRecord,
  type EvidenceRecord,
  type ReadinessFinding,
  type InvestigationDisposition,
  type InvestigationRecord,
  type ProviderEscalationRecord,
  type ReviewConfirmationDisposition,
  type ReviewConfirmationRecord,
  ExecutionModeValue,
  IssueStateValue,
  WorkerExecutorValue,
  WorkerStatusValue,
  WorkJobExecutorValue,
  WorkJobStatusValue,
  createId,
  nowIso,
  workerTaskRequestSchema,
  terminalWorkJobStatusValues,
  workJobResultSchema,
  workJobSchema,
} from "./contracts.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "pathe";
import { GitAdapter, type GitRepoStatus, type WorktreePlan } from "./adapters/git.js";
import { type PullRequestMergeResult, type PullRequestStatus } from "./adapters/github.js";
import type { JiraIssue, JiraSprintMoveResult } from "./adapters/jira.js";
import type {
  CodeCollaborationProvider,
  IssueTrackerProvider,
  SourceControlProvider,
  UnifiedCodeReview,
  UnifiedIssue,
  UnifiedWorkspaceStatus,
  TriageOptions,
  TriageResult,
  IssueIntakeCandidate,
} from "./adapters/provider-contracts.js";
import { triageIssues } from "./triage.js";
import { assessIssue } from "./readiness.js";
import type { WorkflowLedger } from "./ledger.js";
import type { FlowStoreInterface } from "./store.js";
import { parseWorkEnvelope } from "./work-envelope.js";
import { type WorkTypeRegistry, createDefaultFlowWorkTypeRegistry, workerExecutorToWorkExecutor } from "./work-registry.js";
import { DefaultProjectTopology, type ProjectTopology } from "./project-topology.js";
import {
  ReconciliationEngine,
  type PullRequestsByRepo,
  collectPullRequestSnapshots,
  selectPullRequestForGate,
  repoFromPullRequestUrl,
  inferredRepoKeys,
  findPullRequestForIssue,
  pullRequestMetadata,
  globalPullRequestMetadata,
  pullRequestStatusSnapshot,
  isPullRequestConflicted,
  type PullRequestMetadataSnapshot,
} from "./reconciliation.js";
import {
  normalizeRepoKey,
  normalizeRepoKeys,
  existingString,
  metadataBoolean,
  metadataNumber,
  metadataStringArray,
  metadataValueEquals,
  mapWithConcurrency,
  workRuntimeQueueConcurrency,
} from "./runtime-utils.js";
import type { ProjectedWorkSubject } from "./core/work-projection.js";
import type { ExecutorAdapter } from "./executors/executor-contracts.js";

export interface WorkRuntimeOptions {
  store: FlowStoreInterface;
  ledger: WorkflowLedger;
  topology?: ProjectTopology;
  sourceControl?: SourceControlIntegration | SourceControlProvider;
  collaboration?: CodeCollaborationIntegration | CodeCollaborationProvider;
  issueTracker?: IssueTrackerIntegration | IssueTrackerProvider;
  workTypes?: WorkTypeRegistry;
  executors?: ExecutorAdapter[];
  projectRoot?: string;
  defaultJiraProjectKey?: string;
  autoflowBlockedThreshold?: number;
  debugEnabled?: boolean;
  readiness?: ReadinessEvaluator;
}
export interface ReadinessEvaluator {
  assess(input: Parameters<typeof assessIssue>[0]): ReturnType<typeof assessIssue> | Promise<ReturnType<typeof assessIssue>>;
}

export interface DashboardQueueIssue {
  ref: string;
  title: string;
  workStatus: string;
  workStatusDetail?: string;
  statusLabel?: string;
  repositories: string[];
  prStatus?: string;
  reviewStatus?: string;
  evidenceStatus: string;
  documentationStatus: string;
  updatedLabel?: string;
  blockerLabels: string[];
  nextPickup?: string;
  handoffPrompt?: string;
}

export interface GitInspector {
  inspect(repoPath: string): Promise<GitRepoStatus>;
  prepareWorktree?(plan: WorktreePlan): Promise<GitRepoStatus>;
}

export type SourceControlIntegration = GitInspector & Partial<SourceControlProvider>;

export interface GitHubInspector {
  findPullRequests(repo: string, headRefName?: string): Promise<PullRequestStatus[]>;
  createPullRequest?(input: {
    repo: string;
    title: string;
    body: string;
    headRefName: string;
    baseRefName: string;
    isDraft?: boolean;
  }): Promise<PullRequestStatus>;
  getPullRequest?(repo: string, number: number): Promise<PullRequestStatus | undefined>;
  markPullRequestReadyForReview?(repo: string, number: number): Promise<PullRequestStatus | undefined>;
  postPullRequestComment?(repo: string, number: number, body: string): Promise<{ url?: string; body: string }>;
  mergePullRequest?(
    repo: string,
    number: number,
    options?: { method?: PullRequestMergeMethod },
  ): Promise<PullRequestMergeResult>;
}

export type CodeCollaborationIntegration = GitHubInspector & Partial<CodeCollaborationProvider>;

export interface JiraInspector {
  viewIssue(key: string): Promise<JiraIssue>;
  searchCurrentUserOpenSprintIssues?(limit?: number): Promise<JiraIssue[]>;
  searchCurrentUserBacklogIssues?(limit?: number): Promise<JiraIssue[]>;
  postIssueComment?(key: string, body: string): Promise<{ url?: string; body: string }>;
  transitionIssueToStatus?(key: string, status: string): Promise<unknown>;
  moveIssuesToActiveSprint?(input: {
    issueKeys: string[];
    projectKey?: string;
    boardId?: number;
    sprintId?: number;
  }): Promise<JiraSprintMoveResult>;
  createIssue?(input: {
    projectKey?: string;
    issueType: string;
    title?: string;
    summary: string;
    description?: string;
  }): Promise<JiraIssue>;
}

export type IssueTrackerIntegration = JiraInspector & Omit<Partial<IssueTrackerProvider>, "createIssue">;
type NormalizedIssueTrackerIssue = JiraIssue & {
  source?: "unified";
  raw?: unknown;
};

type EvidenceRecordInput = Omit<EvidenceRecord, "recordedAt" | "criteria"> & {
  criteria?: AcceptanceCriterionEvidence[];
};

export interface AdvanceIssueResult {
  status: "needs_issue" | "needs_confirmation" | "blocked" | "execution_handoff" | "awaiting_review";
  session: WorkRuntimeSession;
  issue?: WorkItem;
  message: string;
  handoffRequest?: {
    id: string;
    issueRef: string;
    repoKey: string;
    workJobId?: string;
    prompt: string;
    workspacePath?: string;
    createdAt?: string;
  };
}

export interface AutoFlowIssueOptions {
  autoPrepareWorkspace?: boolean;
  maxSteps?: number;
}

export interface LiveWorkerAdoptionOptions {
  adopter?: string;
  summary?: string;
}

export interface LocalThreadResultInput {
  issueRef?: string;
  repoKey?: string;
  taskId?: string;
  workJobId?: string;
  status: Extract<WorkerStatus, "succeeded" | "blocked" | "failed">;
  summary: string;
  changedFiles?: string[];
  testsRun?: string[];
  blockers?: string[];
  nextPickup?: string;
  handoffPrompt?: string;
  evidenceCandidate?: string;
  completedAt?: string;
}

export interface LocalThreadResultRecord {
  session: WorkRuntimeSession;
  result: WorkerTaskResult;
  adoptedRun?: WorkerRunRecord;
}

export interface BootstrapJiraIssueOptions {
  repoKeys?: string[];
  branch?: string;
  branchKind?: BranchKind;
  worktreePath?: string;
  baseBranch?: string;
  select?: boolean;
}

export type BranchKind = "bug" | "feature";

export interface AdoptBranchOptions {
  issueRef?: string;
  summary?: string;
  description?: string;
  repoKey?: string;
  worktreePath?: string;
  baseBranch?: string;
  prefix?: string;
  select?: boolean;
}

export interface CreateJiraIssueOptions {
  projectKey?: string;
  issueType?: "Bug" | "Task" | "Story";
  branchKind?: BranchKind;
  title?: string;
  summary: string;
  description?: string;
  repoKeys?: string[];
  select?: boolean;
}

export type CreateIssueOptions = CreateJiraIssueOptions;

export interface IssueIntakeOptions extends CreateIssueOptions {
  apply?: boolean;
  dryRun?: boolean;
  review?: boolean;
}

export interface IssueIntakeProposal {
  title: string;
  summary: string;
  body: string;
  issueType: string;
  repoKeys: string[];
  tags: string[];
  priority?: string;
  lane?: string;
  missingSections: string[];
  dependencies: string[];
  concurrencyNotes: string[];
}

export interface IssueIntakeResult {
  dryRun: boolean;
  apply: boolean;
  status: "ready" | "needs_input" | "duplicate" | "created";
  proposal: IssueIntakeProposal;
  duplicateIssue?: WorkItem;
  issue?: WorkItem;
  reviewJob?: WorkJob;
  reasons: string[];
}

export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export interface CloseoutAfterApprovalOptions {
  issueRef?: string;
  mergeMethod?: PullRequestMergeMethod;
  jiraPollAttempts?: number;
  jiraPollIntervalMs?: number;
}

export interface CloseoutAfterApprovalResult {
  status: "blocked" | "merged_jira_verified" | "merged_jira_pending" | "already_merged_jira_verified" | "already_merged_jira_pending";
  issue: WorkItem;
  pr?: PullRequestStatus;
  blockers: string[];
  acceptanceCommentUrl?: string;
  merge?: PullRequestMergeResult;
  jiraStatusBefore?: string;
  jiraStatusAfter?: string;
}

export interface SubmitWorkJobInput {
  issueRef: string;
  repoKey: string;
  workType: WorkType;
  input?: Record<string, unknown>;
  requiredCapabilities?: string[];
  parentJobId?: string;
  idempotencyKey?: string;
}

export interface AutoFlowIssueResult {
  status: AdvanceIssueResult["status"] | "max_steps_reached";
  message: string;
  steps: AdvanceIssueResult[];
  workerResults: WorkerTaskResult[];
  session: WorkRuntimeSession;
  issue?: WorkItem;
  handoffRequest?: AdvanceIssueResult["handoffRequest"];
}

export interface FlowDoctorResult {
  issueRef: string;
  status: "ok" | "blocked" | "degraded";
  issue: {
    ref: string;
    title: string;
    state: WorkItem["state"];
    repoKeys: string[];
    issueStatus?: string;
  };
  visibility: {
    ledger: boolean;
    issueTracker: boolean;
    repoRouting: boolean;
    preparedWorktree: boolean;
    codeReview: boolean;
    codeReviewRequired: boolean;
  };
  codeReview?: ReturnType<typeof reviewMetadata>;
  findings: ReadinessFinding[];
  nextAction: {
    type: string;
    command?: string;
    summary: string;
  };
}

export class FlowWorkRuntime {
  private readonly store: FlowStoreInterface;
  private readonly ledger: WorkflowLedger;
  readonly topology: ProjectTopology;
  private readonly sourceControl: SourceControlIntegration;
  private readonly collaboration?: CodeCollaborationIntegration;
  private readonly issueTracker?: IssueTrackerIntegration;
  private readonly workTypes: WorkTypeRegistry;
  private readonly projectRoot: string;
  private readonly defaultJiraProjectKey?: string;
  private readonly autoflowBlockedThreshold: number;
  private readonly debugEnabled: boolean;
  private readonly readiness: ReadinessEvaluator;
  private readonly reconciliation: ReconciliationEngine;
  private readonly issueMutationQueues = new Map<string, Promise<unknown>>();

  constructor(options: WorkRuntimeOptions) {
    this.store = options.store;
    this.ledger = options.ledger;
    this.topology = options.topology ?? new DefaultProjectTopology();
    this.sourceControl = normalizeSourceControlIntegration(options.sourceControl ?? new GitAdapter());
    this.collaboration = normalizeCodeCollaborationIntegration(options.collaboration);
    this.issueTracker = normalizeIssueTrackerIntegration(options.issueTracker);
    this.workTypes = options.workTypes ?? createDefaultFlowWorkTypeRegistry();
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.defaultJiraProjectKey = options.defaultJiraProjectKey;
    this.autoflowBlockedThreshold = positiveNumber(options.autoflowBlockedThreshold, 3);
    this.debugEnabled = options.debugEnabled ?? false;
    this.readiness = options.readiness ?? { assess: assessIssue };
    this.reconciliation = new ReconciliationEngine({
      topology: this.topology,
      sourceControl: this.sourceControl,
      collaboration: this.collaboration,
      ledger: this.ledger,
      debug: (event, details) => this.debug(event, details),
    });
  }

  private codeReviewRequired(): boolean {
    return collaborationRequiresCodeReview(this.collaboration);
  }

  private resolveAdoptBranchRepoKey(repoKey: string | undefined, worktreePath: string): string {
    if (repoKey) {
      const normalized = normalizeRepoKey(repoKey);
      if (!this.topology.isValidRepoKey(normalized)) {
        throw new Error(`Unknown repo key ${repoKey}. Allowed repo keys: ${[...this.topology.validRepoKeys].join(", ")}.`);
      }
      return normalized;
    }
    const repoKeys = [...this.topology.validRepoKeys];
    const matchingRepoKeys = repoKeys.filter((candidate) =>
      pathWithin(worktreePath, this.topology.repoPath(this.projectRoot, candidate))
    );
    if (matchingRepoKeys.length === 1) return matchingRepoKeys[0];
    if (repoKeys.length === 1) return repoKeys[0];
    throw new Error(`Repo key is required. Allowed repo keys: ${repoKeys.join(", ")}.`);
  }

  private async nextLocalWorkItemRef(prefix = "FLOW"): Promise<string> {
    const normalizedPrefix = normalizeLocalRefPrefix(prefix);
    const issues = await this.ledger.listIssues(1000);
    const next = issues.reduce((max, issue) => {
      const match = new RegExp(`^${escapeRegExp(normalizedPrefix)}-(\\d+)$`, "i").exec(issue.ref);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    return `${normalizedPrefix}-${next}`;
  }

  private debug(event: string, details: Record<string, unknown>): void {
    if (!this.debugEnabled) return;
    console.error(`[flow debug] ${event} ${JSON.stringify(details)}`);
  }

  async createSession(id?: string): Promise<WorkRuntimeSession> {
    await this.store.ensure();
    const session = await this.store.createSession(id);
    await this.store.appendEvent({
      sessionId: session.id,
      type: "session.created",
      message: "Work Runtime session created.",
      payload: {},
    });
    return session;
  }

  async observeFlowSubject(subject: { type?: string; ref: string }): Promise<ProjectedWorkSubject> {
    const flowSubject = { type: subject.type ?? "issue", ref: subject.ref };
    if (flowSubject.type !== "issue") {
      return {
        subject: flowSubject,
        state: "queued",
        claims: [],
        blockers: [],
        links: [],
        records: [],
        handoffs: [],
      };
    }
    const [issue, jobs, jobResults, workerResults] = await Promise.all([
      this.ledger.readIssue(flowSubject.ref),
      this.ledger.listWorkJobs(flowSubject.ref),
      this.ledger.listWorkJobResults(flowSubject.ref),
      this.ledger.listWorkerResults(flowSubject.ref),
    ]);
    const claims = jobs
      .filter((job) => job.claimedBy || job.claimedAt)
      .map((job) => ({
        eventId: `workflow:work_job:${job.id}:claim`,
        actorId: job.claimedBy ?? "unknown",
        claimedAt: job.claimedAt ?? job.updatedAt,
        input: { jobId: job.id, repoKey: job.repoKey, workType: job.workType },
      }));
    const records = [
      ...jobs.map((job) => ({
        eventId: `workflow:work_job:${job.id}`,
        recordedAt: job.updatedAt,
        input: { kind: "work_job", repoKey: job.repoKey, workType: job.workType },
        result: { job },
      })),
      ...jobResults.map((result) => ({
        eventId: `workflow:work_job_result:${result.jobId}`,
        recordedAt: result.completedAt,
        input: { kind: "work_job_result", jobId: result.jobId, repoKey: result.repoKey, workType: result.workType },
        result,
      })),
      ...workerResults.map((result) => ({
        eventId: `workflow:worker_result:${result.taskId}`,
        recordedAt: result.completedAt,
        input: { kind: "worker_result", taskId: result.taskId, repoKey: result.repoKey },
        result,
      })),
    ];
    const blockers = workerResults
      .filter((result) => result.status === "blocked" || result.blockers.length)
      .map((result) => ({
        eventId: `workflow:worker_result:${result.taskId}:blocker`,
        actorId: result.executor ?? "worker",
        askedAt: result.completedAt,
        input: { taskId: result.taskId, blockers: result.blockers },
      }));
    const handoffs = workerResults
      .filter((result) => result.handoffPrompt?.trim())
      .map((result) => ({
        eventId: `workflow:worker_result:${result.taskId}:handoff`,
        actorId: result.executor ?? "worker",
        handedOffAt: result.completedAt,
        input: { taskId: result.taskId },
        result: { handoffPrompt: result.handoffPrompt },
      }));
    return {
      subject: flowSubject,
      state: issue?.state ?? "queued",
      claims,
      blockers,
      links: [],
      records,
      handoffs,
      completedAt: issue?.state === "done" ? issue.updatedAt : undefined,
      completedByEventId: issue?.state === "done" ? `workflow:issue:${flowSubject.ref}` : undefined,
    };
  }

  async selectIssue(sessionId: string, issue: WorkItem): Promise<WorkRuntimeSession> {
    const session = await this.requireSession(sessionId);
    const existing = await this.ledger.readIssue(issue.ref);
    const storedIssue = await this.ledger.ensureIssue({
      ...existing,
      ...issue,
      title: issue.title || existing?.title || issue.ref,
      repoKeys: issue.repoKeys.length ? issue.repoKeys : existing?.repoKeys ?? [],
      state: selectedWorkflowState(issue.state, existing?.state),
      summary: issue.summary ?? existing?.summary,
      updatedAt: issue.updatedAt ?? existing?.updatedAt,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...issue.metadata,
      },
    });
    const updated = await this.store.writeSession({
      ...session,
      selectedIssueRef: storedIssue.ref,
      selectedRepoKey: storedIssue.repoKeys[0],
      pendingConfirmation: undefined,
      findings: [],
    });
    await this.store.appendEvent({
      sessionId,
      type: "issue.selected",
      issueRef: storedIssue.ref,
      message: `Selected ${storedIssue.ref}.`,
      payload: { issue: storedIssue },
    });
    return updated;
  }

  async bootstrapJiraIssue(
    sessionId: string,
    issueRef: string,
    options: BootstrapJiraIssueOptions = {},
  ): Promise<WorkItem> {
    const session = await this.requireSession(sessionId);
    if (!this.issueTracker) {
      throw new Error("Jira inspection is not available in this runtime.");
    }

    const jiraIssue = await this.issueTracker.viewIssue(issueRef);
    const existing = await this.ledger.readIssue(jiraIssue.key);
    const queueIssue = this.mergeJiraQueueIssue(jiraIssue, existing);
    const repoKeys = options.repoKeys?.length
      ? this.resolveRoutedRepoKeys(options.repoKeys)
      : queueIssue.repoKeys;
    const primaryRepoKey = repoKeys[0];
    const metadata = {
      ...queueIssue.metadata,
      ...(primaryRepoKey && options.branch ? { [`workflow.repos.${primaryRepoKey}.branch`]: options.branch, branch: options.branch } : {}),
      ...(options.branchKind ? { branchKind: options.branchKind } : {}),
      ...(primaryRepoKey && options.worktreePath
        ? {
          [`workflow.repos.${primaryRepoKey}.worktree_path`]: options.worktreePath,
          work_dir: options.worktreePath,
          worktree_path: options.worktreePath,
        }
        : {}),
      ...(primaryRepoKey && options.baseBranch ? { [`workflow.repos.${primaryRepoKey}.base_branch`]: options.baseBranch } : {}),
    };
    const shouldSelect = options.select ?? true;
    const storedIssue = await this.ledger.ensureIssue({
      ...queueIssue,
      repoKeys,
      state: shouldSelect ? "selected" : queueIssue.state,
      metadata,
    });

    if (shouldSelect) {
      await this.store.writeSession({
        ...session,
        selectedIssueRef: storedIssue.ref,
        selectedRepoKey: storedIssue.repoKeys[0],
        pendingConfirmation: undefined,
        findings: [],
      });
    }
    await this.store.appendEvent({
      sessionId,
      type: "issue.bootstrapped",
      issueRef: storedIssue.ref,
      message: `Bootstrapped ${storedIssue.ref} from Jira.`,
      payload: { issue: storedIssue, selected: shouldSelect },
    });
    return storedIssue;
  }

  async createJiraIssue(
    sessionId: string,
    options: CreateJiraIssueOptions,
  ): Promise<WorkItem> {
    return this.createIssue(sessionId, options);
  }

  async createIssue(
    sessionId: string,
    options: CreateIssueOptions,
  ): Promise<WorkItem> {
    const intake = await this.intakeIssue(sessionId, { ...options, apply: true });
    if (intake.issue) return intake.issue;
    if (intake.duplicateIssue) return intake.duplicateIssue;
    throw new Error(intake.reasons[0] ?? "Issue intake did not produce an issue.");
  }

  async intakeIssue(
    sessionId: string,
    options: IssueIntakeOptions,
  ): Promise<IssueIntakeResult> {
    await this.requireSession(sessionId);
    if (!options.summary?.trim()) throw new Error("Issue summary is required.");
    const issueType = options.issueType ?? "Bug";
    const createInput = this.issueCreateInput(options, issueType);
    const candidates = await this.issueIntakeCandidates(createInput);
    const proposal = this.issueIntakeProposal(options, createInput);
    const reasons = issueIntakeProblems(createInput.summary, options.description);
    const duplicateIssue = await this.findDuplicateIssue(createInput, candidates);
    const reviewJob = !duplicateIssue && reasons.length === 0
      ? await this.submitIssueIntakeReviewJob(sessionId, createInput, proposal, candidates)
      : undefined;
    const apply = options.apply === true;
    const dryRun = !apply;

    if (duplicateIssue) {
      await this.store.appendEvent({
        sessionId,
        type: "issue.deduped",
        issueRef: duplicateIssue.ref,
        message: `Issue already exists: ${duplicateIssue.ref} - ${duplicateIssue.title}`,
        payload: { existing: duplicateIssue, requested: createInput, proposal },
      });
      if (apply && (options.select ?? true)) {
        await this.selectIssue(sessionId, duplicateIssue);
      }
      return {
        dryRun,
        apply,
        status: "duplicate",
        proposal,
        duplicateIssue,
        reviewJob,
        reasons: [`Likely duplicate of ${duplicateIssue.ref}.`],
      };
    }

    if (reasons.length > 0) {
      if (apply) throw new Error(`Issue intake needs more detail: ${reasons.join("; ")}`);
      return { dryRun, apply, status: "needs_input", proposal, reviewJob, reasons };
    }

    if (!apply) {
      return { dryRun, apply, status: "ready", proposal, reviewJob, reasons: [] };
    }

    if (!await this.issueIntakeReviewSucceeded(reviewJob)) {
      const reviewRef = reviewJob ? ` job ${reviewJob.id}` : "";
      throw new Error(`Issue intake requires a completed executor review before creation${reviewRef}.`);
    }

    let issue = await this.createIssueAfterIntake(sessionId, options, {
      ...createInput,
      title: proposal.title,
      description: proposal.body,
    });
    if (proposal.tags.length > 0 && this.issueTracker?.addIssueTags) {
      await this.issueTracker.addIssueTags(issue.ref, proposal.tags);
      const labels = metadataStringArray(issue.metadata.issueLabels) ?? [];
      issue = await this.ledger.writeIssue({
        ...issue,
        metadata: {
          ...issue.metadata,
          issueLabels: [...new Set([...labels, ...proposal.tags])],
        },
      });
    }
    return { dryRun, apply, status: "created", proposal, issue, reviewJob, reasons: [] };
  }

  private issueCreateInput(options: CreateIssueOptions, issueType: string): {
    projectKey?: string;
    issueType: string;
    title?: string;
    summary: string;
    description?: string;
  } {
    const createInput: {
      projectKey?: string;
      issueType: string;
      title?: string;
      summary: string;
      description?: string;
    } = {
      projectKey: options.projectKey ?? this.defaultJiraProjectKey,
      issueType,
      summary: options.summary.trim(),
      description: options.description?.trim(),
    };
    if (options.title?.trim()) createInput.title = options.title.trim();
    return createInput;
  }

  private async createIssueAfterIntake(
    sessionId: string,
    options: CreateIssueOptions,
    createInput: {
      projectKey?: string;
      issueType: string;
      title?: string;
      summary: string;
      description?: string;
    },
  ): Promise<WorkItem> {
    const session = await this.requireSession(sessionId);
    if (!this.issueTracker?.createIssue) {
      throw new Error("Issue creation is not available in this runtime.");
    }
    const createdIssue = await this.issueTracker.createIssue(createInput);
    const queueIssue = this.mergeJiraQueueIssue(createdIssue);
    const repoKeys = options.repoKeys?.length
      ? this.resolveRoutedRepoKeys(options.repoKeys)
      : queueIssue.repoKeys;
    const shouldSelect = options.select ?? true;
    const storedIssue = await this.ledger.ensureIssue({
      ...queueIssue,
      repoKeys,
      state: shouldSelect ? "selected" : queueIssue.state,
      metadata: {
        ...queueIssue.metadata,
        issueType: createdIssue.issueType ?? createInput.issueType,
        ...(isJiraIssueTrackerIssue(createdIssue) ? { jiraIssueType: createdIssue.issueType ?? createInput.issueType } : {}),
        ...(options.branchKind ? { branchKind: options.branchKind } : {}),
      },
    });
    if (shouldSelect) {
      await this.store.writeSession({
        ...session,
        selectedIssueRef: storedIssue.ref,
        selectedRepoKey: storedIssue.repoKeys[0],
        pendingConfirmation: undefined,
        findings: [],
      });
    }
    await this.store.appendEvent({
      sessionId,
      type: "issue.created",
      issueRef: storedIssue.ref,
      message: `Created issue ${storedIssue.ref}.`,
      payload: { issue: storedIssue, selected: shouldSelect },
    });
    return storedIssue;
  }

  private async issueIntakeCandidates(input: {
    title?: string;
    summary: string;
    projectKey?: string;
    issueType?: string;
  }): Promise<IssueIntakeCandidate[]> {
    const candidates = new Map<string, IssueIntakeCandidate>();
    const ledgerIssues = await this.ledger.listIssues(1000);
    for (const issue of ledgerIssues) {
      if (issue.state === "done") continue;
      candidates.set(issue.ref, {
        ref: issue.ref,
        title: issue.title,
        summary: issue.summary,
        labels: metadataStringArray(issue.metadata.issueLabels),
      });
    }
    if (this.issueTracker?.searchIssues) {
      try {
        const searchResults = await this.issueTracker.searchIssues({
          title: input.title,
          summary: input.summary,
          projectKey: input.projectKey,
          issueType: input.issueType,
          state: "open",
          limit: 5,
        });
        for (const result of searchResults) {
          candidates.set(result.ref, {
            ref: result.ref,
            title: result.title,
            summary: result.description,
            url: result.url,
            labels: result.labels,
          });
        }
      } catch {
        // Search is best-effort. Intake can continue with ledger candidates.
      }
    }
    return [...candidates.values()];
  }

  private async findDuplicateIssue(
    input: {
      title?: string;
      summary: string;
      projectKey?: string;
      issueType?: string;
    },
    candidates: IssueIntakeCandidate[],
  ): Promise<WorkItem | undefined> {
    const query = (input.title || input.summary).toLowerCase().trim();
    for (const candidate of candidates) {
      const title = candidate.title.toLowerCase().trim();
      const summary = (candidate.summary || "").toLowerCase().trim();
      if (title === query || summary === query) {
        const resolved = await this.resolveIntakeCandidate(candidate.ref, candidates);
        if (resolved) return resolved;
      }
    }
    return undefined;
  }

  private async submitIssueIntakeReviewJob(
    sessionId: string,
    input: {
      title?: string;
      summary: string;
      description?: string;
      issueType: string;
    },
    proposal: IssueIntakeProposal,
    candidates: IssueIntakeCandidate[],
  ): Promise<WorkJob | undefined> {
    const session = await this.requireSession(sessionId);
    const workType = this.workTypeForCategory("custom");
    const repoKey = proposal.repoKeys[0] ?? session.selectedRepoKey ?? this.topology.validRepoKeys.values().next().value ?? "main";
    const issueRef = `INTAKE-${createHash("sha256").update(`${proposal.title}\n${proposal.summary}`).digest("hex").slice(0, 8).toUpperCase()}`;
    return this.submitWorkJob(sessionId, {
      issueRef,
      repoKey,
      workType,
      requiredCapabilities: ["issue.intake"],
      idempotencyKey: `issue-intake:${proposal.title}:${proposal.summary}`,
      input: {
        request: input,
        proposal,
        candidates,
        prompt: issueIntakeReviewPrompt(input, proposal, candidates),
      },
    });
  }

  private async issueIntakeReviewSucceeded(reviewJob?: WorkJob): Promise<boolean> {
    if (!reviewJob) return false;
    const results = await this.ledger.listWorkJobResults(reviewJob.issueRef);
    return results.some((result) => result.jobId === reviewJob.id && result.status === "succeeded");
  }

  private async resolveIntakeCandidate(ref: string, candidates: IssueIntakeCandidate[]): Promise<WorkItem | undefined> {
    const existing = await this.ledger.readIssue(ref);
    if (existing) return existing;
    const candidate = candidates.find((item) => item.ref === ref);
    if (!candidate) return undefined;
    return this.ledger.ensureIssue({
      ref: candidate.ref,
      title: candidate.title,
      summary: candidate.summary,
      repoKeys: this.topology.inferRepoKeysFromIssue({
        title: candidate.title,
        description: candidate.summary,
        labels: candidate.labels ?? [],
      }),
      state: "queued",
      metadata: {
        issueUrl: candidate.url,
        issueLabels: candidate.labels,
      },
    });
  }

  private issueIntakeProposal(
    options: CreateIssueOptions,
    input: {
      title?: string;
      summary: string;
      description?: string;
      issueType: string;
    },
  ): IssueIntakeProposal {
    const title = input.title?.trim() || input.summary;
    const body = structuredIssueBody(input.description, input.summary, options.repoKeys);
    const missingSections = missingIntakeSections(body);
    const priority = proposeIssuePriority(title, body);
    const lane = proposeIssueLane(title, body);
    const tags = [priority, lane].filter((tag): tag is string => Boolean(tag));
    return {
      title,
      summary: input.summary,
      body,
      issueType: input.issueType,
      repoKeys: options.repoKeys ?? [],
      tags,
      priority,
      lane,
      missingSections,
      dependencies: extractSectionLines(body, "Dependencies"),
      concurrencyNotes: extractSectionLines(body, "Concurrency notes"),
    };
  }

  async moveIssuesToActiveSprint(
    sessionId: string,
    issueRefs: string[],
    options: { projectKey?: string; boardId?: number; sprintId?: number } = {},
  ): Promise<JiraSprintMoveResult> {
    await this.requireSession(sessionId);
    const refs = issueRefs.map((ref) => ref.trim().toUpperCase()).filter(Boolean);
    if (refs.length === 0) throw new Error("At least one issueRef is required.");
    if (!this.issueTracker?.moveIssuesToActiveSprint) {
      throw new Error("Jira sprint movement is not available in this runtime.");
    }
    const moved = await this.issueTracker.moveIssuesToActiveSprint({
      issueKeys: refs,
      projectKey: options.projectKey ?? this.requireDefaultJiraProjectKey(),
      boardId: options.boardId,
      sprintId: options.sprintId,
    });
    for (const ref of refs) {
      const issue = await this.ledger.readIssue(ref);
      if (!issue) continue;
      await this.ledger.writeIssue({
        ...issue,
        metadata: {
          ...issue.metadata,
          jiraSprintId: moved.sprintId,
          jiraSprintName: moved.sprintName ?? "",
          jiraSprintBoardId: moved.boardId ?? "",
        },
      });
    }
    await this.store.appendEvent({
      sessionId,
      type: "jira.sprint_moved",
      message: `Moved ${refs.join(", ")} to active Jira sprint ${moved.sprintName ?? moved.sprintId}.`,
      payload: { ...moved },
    });
    return moved;
  }

  async resetAutoflowState(sessionId: string, issueRefs?: string[]): Promise<WorkItem[]> {
    const session = await this.requireSession(sessionId);
    const refs = (issueRefs?.length ? issueRefs : session.selectedIssueRef ? [session.selectedIssueRef] : [])
      .map((ref) => ref.trim().toUpperCase())
      .filter(Boolean);
    if (refs.length === 0) throw new Error("At least one issueRef is required to reset Autoflow state.");
    const resetIssues: WorkItem[] = [];
    for (const ref of refs) {
      const issue = await this.ledger.readIssue(ref);
      if (!issue) throw new Error(`Cannot reset Autoflow state: ${ref} is not in the Flow ledger.`);
      await this.ledger.writeIssue({
        ...issue,
        metadata: {
          ...issue.metadata,
          "workflow.autoflow.attempts": 0,
          "workflow.autoflow.last_attempted_at": "",
          "workflow.autoflow.current_action": "",
          "workflow.autoflow.current_action_started_at": "",
        },
      });
      const reset = await this.ledger.readIssue(ref);
      if (reset) resetIssues.push(reset);
    }
    await this.store.appendEvent({
      sessionId,
      type: "autoflow.reset",
      message: `Reset Autoflow state for ${refs.join(", ")}.`,
      payload: { issueRefs: refs },
    });
    return resetIssues;
  }

  async inspectQueue(limit = 10): Promise<WorkItem[]> {
    if (this.issueTracker?.searchCurrentUserOpenSprintIssues) {
      const jiraIssues = await this.issueTracker.searchCurrentUserOpenSprintIssues(limit);
      const activeIssues = jiraIssues.filter((jiraIssue) => !isJiraDone(jiraIssue));
      const existingIssues = this.ledger.readIssues
        ? await this.ledger.readIssues(activeIssues.map((jiraIssue) => jiraIssue.key))
        : new Map<string, WorkItem>();
      const issues: WorkItem[] = [];
      for (const jiraIssue of activeIssues) {
        const existing = existingIssues.get(jiraIssue.key) ?? await this.ledger.readIssue(jiraIssue.key);
        issues.push(this.mergeJiraQueueIssue(jiraIssue, existing));
      }
      const pullRequestsByRepo = await this.preloadOpenPullRequests(issues);
      return mapWithConcurrency(issues, workRuntimeQueueConcurrency(), (issue) =>
        this.reconcileExternalStateSafely(issue, pullRequestsByRepo, { persist: false })
      );
    }

    const issues = await this.ledger.listIssues(limit);
    return mapWithConcurrency(issues, workRuntimeQueueConcurrency(), (issue) =>
      this.reconcileExternalStateSafely(issue, undefined, { persist: false })
    );
  }

  async inspectDashboardQueue(limit = 10, sessionId?: string): Promise<DashboardQueueIssue[]> {
    const sourceIssues = await this.ledger.listIssues(Math.max(limit * 4, 1000));
    const session = sessionId ? await this.store.readSession(sessionId) : undefined;
    const selectedIssueRef = session?.selectedIssueRef;
    const reconciledIssues = await mapWithConcurrency(sourceIssues, workRuntimeQueueConcurrency(), (issue) =>
      this.reconcileDashboardTerminalState(issue)
    );
    const issues = reconciledIssues
      .filter((issue) => issue.state !== "done")
      .slice(0, limit);
    return mapWithConcurrency(issues, workRuntimeQueueConcurrency(), async (issue) => {
      const review = reviewMetadata(issue);
      const workerResults = await this.ledger.listWorkerResults(issue.ref);
      const assessment = await this.readiness.assess({
        issue,
        workerResults,
        evidenceRecorded: hasRecordedEvidence(issue),
        documentationRecorded: hasRecordedDocumentation(issue),
        review,
        codeReviewRequired: this.codeReviewRequired(),
      });
      const blockers = assessment.findings
        .filter((finding) => finding.severity === "blocker" || finding.severity === "warning")
        .map((finding) => finding.summary);
      const activeWorkerRun = await this.latestActiveWorkerRun(issue.ref);
      const latestWorkerResult = workerResults.at(-1);
      const workStatus = dashboardWorkStatus({
        issue,
        selectedIssueRef,
        activeWorkerRun,
        latestWorkerResult,
        review,
        reviewReady: assessment.reviewReady,
        evidenceRecorded: hasRecordedEvidence(issue),
        documentationRecorded: hasRecordedDocumentation(issue),
      });
      return {
        ref: issue.ref,
        title: issue.title,
        workStatus: workStatus.label,
        workStatusDetail: workStatus.detail,
        statusLabel: issueTrackerStatus(issue),
        repositories: issue.repoKeys.map((key) => dashboardRepositoryLabel(key)),
        prStatus: review ? dashboardPullRequestStatus(review.isDraft, review.checksPassing) : undefined,
        reviewStatus: review ? dashboardReviewStatus(existingString(issue.metadata.prReviewDecision), review.humanReviewRequired === true) : undefined,
        evidenceStatus: dashboardRecordStatus(hasRecordedEvidence(issue)),
        documentationStatus: dashboardRecordStatus(hasRecordedDocumentation(issue)),
        updatedLabel: dashboardRelativeTime(issue.updatedAt),
        blockerLabels: blockers.map((blocker) => dashboardBlockerLabel(blocker)),
        nextPickup: latestWorkerResult?.nextPickup?.trim() || undefined,
        handoffPrompt: latestWorkerResult?.handoffPrompt?.trim() || undefined,
      };
    });
  }

  private async reconcileDashboardTerminalState(issue: WorkItem): Promise<WorkItem> {
    if (issue.state === "done" || !isIssueTrackerDone(issue)) return issue;
    return this.ledger.writeIssue({ ...issue, state: "done" });
  }

  async inspectBacklog(limit = 10): Promise<WorkItem[]> {
    if (!this.issueTracker?.searchCurrentUserBacklogIssues) {
      throw new Error("Jira backlog inspection is not available in this runtime.");
    }
    const jiraIssues = await this.issueTracker.searchCurrentUserBacklogIssues(limit);
    const activeIssues = jiraIssues.filter((jiraIssue) => !isJiraDone(jiraIssue));
    const existingIssues = this.ledger.readIssues
      ? await this.ledger.readIssues(activeIssues.map((jiraIssue) => jiraIssue.key))
      : new Map<string, WorkItem>();
    const issues = activeIssues.map((jiraIssue) =>
      this.mergeJiraQueueIssue(jiraIssue, existingIssues.get(jiraIssue.key))
    );
    const pullRequestsByRepo = await this.preloadOpenPullRequests(issues);
    return mapWithConcurrency(issues, workRuntimeQueueConcurrency(), (issue) =>
      this.reconcileExternalStateSafely(issue, pullRequestsByRepo, { persist: false })
    );
  }

  async inspectIssue(issueRef: string): Promise<WorkItem> {
    if (this.issueTracker?.viewIssue) {
      const issue = await this.issueTracker.viewIssue(issueRef);
      const existing = await this.ledger.readIssue(issue.key);
      const projected = this.mergeJiraQueueIssue(issue, existing);
      return this.reconcileExternalStateSafely(projected, undefined, { persist: false });
    }

    const issue = await this.ledger.readIssue(issueRef);
    if (!issue) throw new Error(`Issue ${issueRef} was not found in the Flow ledger.`);
    return this.reconcileExternalStateSafely(issue, undefined, { persist: false });
  }

  async triageIssues(options: TriageOptions = {}): Promise<TriageResult> {
    if (!this.issueTracker) {
      throw new Error("Issue tracker is not configured. Cannot triage issues.");
    }

    // Fetch open issues from the issue tracker
    let issues: UnifiedIssue[];
    if (this.issueTracker.fetchOpenIssues) {
      issues = await this.issueTracker.fetchOpenIssues(options.limit ?? 100);
    } else if (this.issueTracker.searchCurrentUserOpenSprintIssues) {
      const jiraIssues = await this.issueTracker.searchCurrentUserOpenSprintIssues(options.limit ?? 100);
      issues = jiraIssues
        .filter((jiraIssue) => !isJiraDone(jiraIssue))
        .map((jiraIssue) => this.mergeJiraQueueIssue(jiraIssue))
        .map((workItem) => ({
          ref: workItem.ref,
          title: workItem.title,
          description: workItem.summary,
          status: existingString(workItem.metadata.issueStatus) ?? "Open",
          statusCategory: existingString(workItem.metadata.issueStatusCategory) ?? "To Do",
          type: existingString(workItem.metadata.issueType) ?? "task",
          url: existingString(workItem.metadata.issueUrl) ?? existingString(workItem.metadata.jiraUrl) ?? "",
          updatedAt: workItem.updatedAt,
          labels: metadataStringArray(workItem.metadata.issueLabels) ?? [],
          assignee: existingString(workItem.metadata.assignee),
        }));
    } else {
      // Fall back to local ledger
      const localIssues = await this.ledger.listIssues(options.limit ?? 100);
      issues = localIssues
        .filter((issue) => issue.state !== "done")
        .map((issue) => ({
          ref: issue.ref,
          title: issue.title,
          description: issue.summary,
          status: existingString(issue.metadata.localStatus) ?? "To Do",
          statusCategory: existingString(issue.metadata.localStatusCategory) ?? "To Do",
          type: existingString(issue.metadata.issueType) ?? "task",
          url: existingString(issue.metadata.localUrl) ?? `flow://local/issues/${encodeURIComponent(issue.ref)}`,
          updatedAt: issue.updatedAt,
          labels: [],
        }));
    }

    // Run triage analysis
    const result = await triageIssues({
      issues,
      options,
      postComment: this.issueTracker?.postComment ? (ref, body) => this.issueTracker!.postComment!(ref, body) : undefined,
      transitionIssue: this.issueTracker?.transitionIssue ? (ref, status) => this.issueTracker!.transitionIssue!(ref, status) : undefined,
      addTags: this.issueTracker?.addIssueTags ? (ref, tags) => this.issueTracker!.addIssueTags!(ref, tags) : undefined,
      removeTags: this.issueTracker?.removeIssueTags ? (ref, tags) => this.issueTracker!.removeIssueTags!(ref, tags) : undefined,
    });

    return result;
  }

  async routeIssue(sessionId: string, issueRef: string, repoKeys: string[]): Promise<WorkItem> {
    const session = await this.requireSession(sessionId);
    const issue = await this.reconcileIssue(sessionId, issueRef);
    const normalizedRepoKeys = this.resolveRoutedRepoKeys(repoKeys);
    if (normalizedRepoKeys.length === 0) {
      throw new Error(`No valid repo keys provided. Allowed repo keys: ${[...this.topology.validRepoKeys].join(", ")}.`);
    }
    const updated = await this.ledger.writeIssue({
      ...issue,
      repoKeys: normalizedRepoKeys,
      state: session.selectedIssueRef === issue.ref ? "selected" : issue.state,
    });
    if (session.selectedIssueRef === issue.ref) {
      await this.store.writeSession({
        ...session,
        selectedRepoKey: normalizedRepoKeys[0],
        pendingConfirmation: undefined,
      });
    }
    await this.store.appendEvent({
      sessionId,
      type: "issue.routed",
      issueRef,
      message: `Routed ${issueRef} to ${normalizedRepoKeys.join(", ")}.`,
      payload: { repoKeys: normalizedRepoKeys },
    });
    return updated;
  }

  async prepareWorkspace(
    sessionId: string,
    issueRef: string,
    options: { repoKey?: string; baseBranch?: string } = {},
  ): Promise<WorkItem> {
    const issue = await this.reconcileIssue(sessionId, issueRef);
    const repoKey = normalizeRepoKey(options.repoKey ?? issue.repoKeys[0] ?? "");
    if (!repoKey) throw new Error("Repo routing is missing.");
    if (!issue.repoKeys.includes(repoKey)) {
      throw new Error(`${repoKey} is not routed for ${issueRef}.`);
    }
    if (!this.sourceControl.prepareWorktree) {
      throw new Error("Workspace preparation is not available in this runtime.");
    }

    const repoPath = this.topology.repoPath(this.projectRoot, repoKey);
    const branch = existingString(issue.metadata[`workflow.repos.${repoKey}.branch`]) ??
      existingString(issue.metadata.branch) ??
      this.topology.branchName(issue);
    const worktreePath = existingString(issue.metadata[`workflow.repos.${repoKey}.worktree_path`]) ??
      existingString(issue.metadata.work_dir) ??
      join(repoPath, ".worktrees", branch.replace(/\//g, "-"));
    const baseRef = options.baseBranch ??
      existingString(issue.metadata[`workflow.repos.${repoKey}.base_branch`]) ??
      this.topology.defaultBaseBranch(repoKey);
    const status = await this.sourceControl.prepareWorktree({ repoPath, worktreePath, branch, baseRef });
    const preparedWorktreePath = existingString(status.worktreePath) ?? worktreePath;
    const session = await this.requireSession(sessionId);
    if (session.selectedIssueRef === issue.ref) {
      await this.store.writeSession({
        ...session,
        selectedRepoKey: repoKey,
        pendingConfirmation: undefined,
      });
    }
    const updated = await this.ledger.writeIssue({
      ...issue,
      state: "selected",
      metadata: {
        ...issue.metadata,
        work_dir: preparedWorktreePath,
        branch,
        [`workflow.repos.${repoKey}.base_branch`]: baseRef,
        [`workflow.repos.${repoKey}.branch`]: status.branch || branch,
        [`workflow.repos.${repoKey}.head_sha`]: status.headSha,
        [`workflow.repos.${repoKey}.dirty`]: status.dirty,
        [`workflow.repos.${repoKey}.worktree_path`]: preparedWorktreePath,
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "workspace.prepared",
      issueRef,
      message: `Prepared ${repoKey} workspace for ${issueRef}.`,
      payload: { repoKey, repoPath, worktreePath: preparedWorktreePath, branch, baseRef },
    });
    return await this.transitionJiraWorkStarted(sessionId, updated);
  }

  async adoptWorkspace(
    sessionId: string,
    issueRef: string,
    options: { repoKey?: string; worktreePath: string; baseBranch?: string },
  ): Promise<WorkItem> {
    const issue = await this.reconcileIssue(sessionId, issueRef);
    const repoKey = normalizeRepoKey(options.repoKey ?? issue.repoKeys[0] ?? "");
    if (!repoKey) throw new Error("Repo routing is missing.");
    if (!issue.repoKeys.includes(repoKey)) {
      throw new Error(`${repoKey} is not routed for ${issueRef}.`);
    }

    const worktreePath = options.worktreePath;
    if (!worktreePath) throw new Error("Workspace path is required.");
    const status = await this.sourceControl.inspect(worktreePath);
    const branch = existingString(status.branch) ??
      existingString(issue.metadata[`workflow.repos.${repoKey}.branch`]) ??
      existingString(issue.metadata.branch) ??
      this.topology.branchName(issue);
    const baseRef = options.baseBranch ??
      existingString(issue.metadata[`workflow.repos.${repoKey}.base_branch`]) ??
      this.topology.defaultBaseBranch(repoKey);
    const session = await this.requireSession(sessionId);
    if (session.selectedIssueRef === issue.ref) {
      await this.store.writeSession({
        ...session,
        selectedRepoKey: repoKey,
        pendingConfirmation: undefined,
      });
    }
    const updated = await this.ledger.writeIssue({
      ...issue,
      state: "selected",
      metadata: {
        ...issue.metadata,
        work_dir: worktreePath,
        branch,
        [`workflow.repos.${repoKey}.base_branch`]: baseRef,
        [`workflow.repos.${repoKey}.branch`]: branch,
        [`workflow.repos.${repoKey}.head_sha`]: status.headSha,
        [`workflow.repos.${repoKey}.dirty`]: status.dirty,
        [`workflow.repos.${repoKey}.worktree_path`]: worktreePath,
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "workspace.adopted",
      issueRef,
      message: `Adopted ${repoKey} workspace for ${issueRef}.`,
      payload: { repoKey, worktreePath, branch, baseRef },
    });
    return await this.transitionJiraWorkStarted(sessionId, updated);
  }

  async adoptBranch(sessionId: string, options: AdoptBranchOptions = {}): Promise<WorkItem> {
    const session = await this.requireSession(sessionId);
    const worktreePath = options.worktreePath ?? this.projectRoot;
    const status = await this.sourceControl.inspect(worktreePath);
    const branch = existingString(status.branch);
    if (!branch) throw new Error("Cannot adopt a detached HEAD or unnamed branch.");
    const repoKey = this.resolveAdoptBranchRepoKey(options.repoKey, worktreePath);
    const issueRef = options.issueRef?.trim() || await this.nextLocalWorkItemRef(options.prefix);
    const existing = await this.ledger.readIssue(issueRef);
    const existingRepoKeys = existing?.repoKeys ?? [];
    const repoKeys = existingRepoKeys.includes(repoKey) ? existingRepoKeys : [...existingRepoKeys, repoKey];
    const baseRef = options.baseBranch ??
      existingString(existing?.metadata[`workflow.repos.${repoKey}.base_branch`]) ??
      this.topology.defaultBaseBranch(repoKey);
    const title = options.summary?.trim() || existing?.title || titleFromBranch(branch);
    const selected = options.select !== false;
    const preparedWorktreePath = existingString(status.worktreePath) ?? worktreePath;
    const statusIssue: WorkItem = existing ?? { ref: issueRef, title, repoKeys, state: "queued", metadata: {} };
    const updated = await this.ledger.writeIssue({
      ref: issueRef,
      title,
      repoKeys,
      state: selected ? "selected" : existing?.state ?? "queued",
      summary: options.description?.trim() || existing?.summary,
      metadata: {
        ...(existing?.metadata ?? {}),
        issueStatus: issueTrackerStatus(statusIssue) ?? "In Progress",
        issueStatusCategory: issueTrackerStatusCategory(statusIssue) ?? "In Progress",
        localStatus: existingString(existing?.metadata.localStatus) ?? "In Progress",
        localStatusCategory: existingString(existing?.metadata.localStatusCategory) ?? "In Progress",
        localUrl: existingString(existing?.metadata.localUrl) ?? localIssueUrl(issueRef),
        branchKind: existingBranchKind(existing) ?? branchKindFromBranch(branch),
        work_dir: preparedWorktreePath,
        branch,
        "workflow.issue.origin": existingString(existing?.metadata["workflow.issue.origin"]) ?? "branch",
        "workflow.external.issue.status": existingString(existing?.metadata["workflow.external.issue.status"]) ?? "unpublished",
        "workflow.external.code_review.status": existingString(existing?.metadata["workflow.external.code_review.status"]) ??
          "unpublished",
        [`workflow.repos.${repoKey}.base_branch`]: baseRef,
        [`workflow.repos.${repoKey}.branch`]: branch,
        [`workflow.repos.${repoKey}.head_sha`]: status.headSha,
        [`workflow.repos.${repoKey}.dirty`]: status.dirty,
        [`workflow.repos.${repoKey}.worktree_path`]: preparedWorktreePath,
      },
    });
    if (selected) {
      await this.store.writeSession({
        ...session,
        selectedIssueRef: updated.ref,
        selectedRepoKey: repoKey,
        pendingConfirmation: undefined,
      });
    }
    await this.store.appendEvent({
      sessionId,
      type: "branch.adopted",
      issueRef: updated.ref,
      message: `Adopted branch ${branch} as stealth-mode Flow work ${updated.ref}.`,
      payload: { repoKey, worktreePath: preparedWorktreePath, branch, baseRef },
    });
    return updated;
  }

  private async transitionJiraWorkStarted(sessionId: string, issue: WorkItem): Promise<WorkItem> {
    if (!this.issueTracker?.viewIssue) return issue;
    const currentJira = await this.issueTracker.viewIssue(issue.ref);
    const currentStatus = (currentJira.status ?? existingString(issue.metadata.jiraStatus) ?? "").toLowerCase();
    const currentCategory = (currentJira.statusCategory ?? existingString(issue.metadata.jiraStatusCategory) ?? "").toLowerCase();
    const shouldTransition = currentCategory === "new" || currentStatus === "ready for dev" || currentStatus === "to do";
    if (!shouldTransition || !this.issueTracker?.transitionIssueToStatus) return issue;

    await this.issueTracker.transitionIssueToStatus(issue.ref, "In Progress");
    const jiraIssue = await this.issueTracker.viewIssue(issue.ref);
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        jiraStatus: jiraIssue.status,
        jiraStatusCategory: jiraIssue.statusCategory,
        jiraResolution: jiraIssue.resolution,
        jiraUpdated: jiraIssue.updated,
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "jira.work_started",
      issueRef: issue.ref,
      message: `Moved ${issue.ref} to ${jiraIssue.status ?? "In Progress"} after workspace preparation.`,
      payload: { before: issue.metadata.jiraStatus, after: jiraIssue.status },
    });
    return updated;
  }

  async reconcileIssue(sessionId: string, issueRef?: string): Promise<WorkItem> {
    const session = await this.requireSession(sessionId);
    const ref = issueRef ?? session.selectedIssueRef;
    if (!ref) throw new Error("No issue selected.");
    const issue = await this.ledger.readIssue(ref);
    if (!issue) throw new Error(`Issue ${ref} is not in Flow ledger state.`);
    const reconciled = await this.reconcileExternalState(issue);
    await this.store.appendEvent({
      sessionId,
      type: "issue.reconciled",
      issueRef: ref,
      message: `Reconciled ${ref}.`,
      payload: { issue: reconciled },
    });
    return reconciled;
  }

  async refreshReviewState(sessionId: string, issueRef?: string): Promise<WorkItem> {
    return this.reconcileIssue(sessionId, issueRef);
  }

  async explainBlocker(sessionId: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    const issue = await this.selectedIssue(session);
    const assessment = await this.readiness.assess({
      issue,
      workerResults: await this.ledger.listWorkerResults(issue.ref),
      evidenceRecorded: hasRecordedEvidence(issue),
      documentationRecorded: hasRecordedDocumentation(issue),
      review: reviewMetadata(issue),
      codeReviewRequired: this.codeReviewRequired(),
    });
    if (assessment.findings.length === 0) {
      return `${issue.ref} has no Readiness blockers in Flow ledger state.`;
    }
    return assessment.findings.map((finding) => `${finding.severity}: ${finding.summary}`).join("\n");
  }

  async diagnoseIssue(sessionId: string, issueRef?: string): Promise<FlowDoctorResult> {
    const issue = await this.reconcileIssue(sessionId, issueRef);
    const workerResults = await this.ledger.listWorkerResults(issue.ref);
    const review = reviewMetadata(issue);
    const assessment = await this.readiness.assess({
      issue,
      workerResults,
      evidenceRecorded: hasRecordedEvidence(issue),
      documentationRecorded: hasRecordedDocumentation(issue),
      review,
      codeReviewRequired: this.codeReviewRequired(),
    });
    const preparedWorktree = issue.repoKeys.some((repoKey) => Boolean(worktreePathForRepo(issue, repoKey)));
    const codeReviewRequired = this.codeReviewRequired();
    const visibility = {
      ledger: true,
      issueTracker: Boolean(this.issueTracker?.viewIssue) ||
        Boolean(issueTrackerStatus(issue) || existingString(issue.metadata.issueUpdated)),
      repoRouting: issue.repoKeys.length > 0,
      preparedWorktree,
      codeReview: Boolean(review?.prUrl),
      codeReviewRequired,
    };
    const blockingFindings = assessment.findings.filter((finding) => finding.severity === "blocker");
    const hasRequiredReviewVisibility = visibility.codeReview || !visibility.codeReviewRequired;
    const status = blockingFindings.length > 0
      ? "blocked"
      : visibility.repoRouting && hasRequiredReviewVisibility
      ? "ok"
      : "degraded";
    return {
      issueRef: issue.ref,
      status,
      issue: {
        ref: issue.ref,
        title: issue.title,
        state: issue.state,
        repoKeys: issue.repoKeys,
        issueStatus: issueTrackerStatus(issue),
      },
      visibility,
      codeReview: review,
      findings: assessment.findings,
      nextAction: doctorNextAction(issue, assessment.findings, visibility),
    };
  }

  async advanceIssue(sessionId: string, approveConfirmationId?: string): Promise<AdvanceIssueResult> {
    const session = await this.requireSession(sessionId);
    if (!session.selectedIssueRef) {
      return {
        status: "needs_issue",
        session,
        message: "Select an issue before advancing work.",
      };
    }

    if (approveConfirmationId) {
      return this.approveConfirmation(session, approveConfirmationId);
    }

    const issue = await this.reconcileIssue(sessionId, session.selectedIssueRef);
    const latestSession = await this.requireSession(sessionId);
    await this.reconcileStaleWorkerRuns(issue.ref);
    const workerResults = await this.ledger.listWorkerResults(issue.ref);
    const latestWorkerResult = workerResults.at(-1);
    const assessment = await this.readiness.assess({
      issue,
      workerResults,
      evidenceRecorded: hasRecordedEvidence(issue),
      documentationRecorded: hasRecordedDocumentation(issue),
      review: reviewMetadata(issue),
      codeReviewRequired: this.codeReviewRequired(),
    });
    const sessionWithFindings = await this.store.writeSession({
      ...latestSession,
      findings: assessment.findings,
    });
    this.debug("advance.assessed", {
      sessionId,
      issueRef: issue.ref,
      selectedRepoKey: latestSession.selectedRepoKey,
      readyToAdvance: assessment.readyToAdvance,
      reviewReady: assessment.reviewReady,
      findings: assessment.findings.map((finding) => ({
        severity: finding.severity,
        summary: finding.summary,
        detail: finding.detail,
      })),
      review: reviewMetadata(issue),
      latestWorker: latestWorkerResult
        ? {
            status: latestWorkerResult.status,
            summary: latestWorkerResult.summary,
            blockers: latestWorkerResult.blockers,
            nextPickup: latestWorkerResult.nextPickup,
            completedAt: latestWorkerResult.completedAt,
          }
        : undefined,
    });

    if (assessment.reviewReady) {
      await this.ledger.writeIssue({ ...issue, state: "awaiting_review" });
      const message = this.codeReviewRequired()
        ? `${issue.ref} is review-ready in Readiness assessment.`
        : `${issue.ref} is ready for local closeout; no code review provider is configured.`;
      return {
        status: "awaiting_review",
        session: sessionWithFindings,
        issue,
        message,
      };
    }

    const activeWorkerRun = await this.latestActiveWorkerRun(issue.ref);
    if (activeWorkerRun) {
      return {
        status: "blocked",
        session: sessionWithFindings,
        issue,
        message: `Execution handoff is already active for ${issue.ref} (${activeWorkerRun.taskId}).`,
      };
    }

    if (!assessment.readyToAdvance) {
      const prepareWorkspaceConfirmation = this.prepareWorkspaceConfirmation(issue, latestSession, assessment.findings);
      if (prepareWorkspaceConfirmation) {
        const updated = await this.store.writeSession({
          ...sessionWithFindings,
          pendingConfirmation: prepareWorkspaceConfirmation,
        });
        await this.store.appendEvent({
          sessionId,
          type: "confirmation.requested",
          issueRef: issue.ref,
          message: prepareWorkspaceConfirmation.summary,
          payload: { confirmation: prepareWorkspaceConfirmation },
        });
        return {
          status: "needs_confirmation",
          session: updated,
          issue,
          message: prepareWorkspaceConfirmation.summary,
        };
      }
      const resolveConflictsConfirmation = this.resolveConflictsConfirmation(issue, latestSession, assessment.findings);
      if (resolveConflictsConfirmation) {
        const updated = await this.store.writeSession({
          ...sessionWithFindings,
          pendingConfirmation: resolveConflictsConfirmation,
        });
        await this.store.appendEvent({
          sessionId,
          type: "confirmation.requested",
          issueRef: issue.ref,
          message: resolveConflictsConfirmation.summary,
          payload: { confirmation: resolveConflictsConfirmation },
        });
        return {
          status: "needs_confirmation",
          session: updated,
          issue,
          message: resolveConflictsConfirmation.summary,
        };
      }
      const reviewRemediationConfirmation = this.reviewRemediationConfirmation(issue, latestSession, assessment.findings);
      if (reviewRemediationConfirmation) {
        const updated = await this.store.writeSession({
          ...sessionWithFindings,
          pendingConfirmation: reviewRemediationConfirmation,
        });
        await this.store.appendEvent({
          sessionId,
          type: "confirmation.requested",
          issueRef: issue.ref,
          message: reviewRemediationConfirmation.summary,
          payload: { confirmation: reviewRemediationConfirmation },
        });
        return {
          status: "needs_confirmation",
          session: updated,
          issue,
          message: reviewRemediationConfirmation.summary,
        };
      }
      return {
        status: "blocked",
        session: sessionWithFindings,
        issue,
        message: blockedFindingsMessage(sessionId, issue, assessment.findings, latestWorkerResult),
      };
    }

    const repoKey = latestSession.selectedRepoKey ?? issue.repoKeys[0];
    if (!repoKey) {
      return {
        status: "blocked",
        session: sessionWithFindings,
        issue,
        message: "Repo routing is missing.",
      };
    }
    const confirmation: PendingConfirmation = {
      id: createId("confirm"),
      issueRef: issue.ref,
      action: "request_execution",
      summary: `Request execution handoff for ${issue.ref} in ${repoKey}.`,
      payload: { repoKey },
      createdAt: nowIso(),
    };
    const updated = await this.store.writeSession({
      ...sessionWithFindings,
      pendingConfirmation: confirmation,
    });
    await this.store.appendEvent({
      sessionId,
      type: "confirmation.requested",
      issueRef: issue.ref,
      message: confirmation.summary,
      payload: { confirmation },
    });

    return {
      status: "needs_confirmation",
      session: updated,
      issue,
      message: confirmation.summary,
    };
  }

  async autoFlowIssue(
    sessionId: string,
    options: AutoFlowIssueOptions = {},
  ): Promise<AutoFlowIssueResult> {
    const maxSteps = options.maxSteps ?? 8;
    const steps: AdvanceIssueResult[] = [];
    const workerResults: WorkerTaskResult[] = [];
    let last = await this.advanceIssue(sessionId);
    await this.recordAutoflowAttempt(sessionId);
    this.debug("autoflow.start", {
      sessionId,
      maxSteps,
      options: {
        autoPrepareWorkspace: options.autoPrepareWorkspace !== false,
        executionMode: "handoff_only",
      },
      initialStatus: last.status,
      initialMessage: last.message,
      issueRef: last.issue?.ref,
    });

    for (let step = 0; step < maxSteps; step += 1) {
      steps.push(last);
      this.debug("autoflow.step", {
        sessionId,
        step,
        status: last.status,
        issueRef: last.issue?.ref,
        message: last.message,
        pendingAction: last.session.pendingConfirmation?.action,
        pendingConfirmationId: last.session.pendingConfirmation?.id,
      });

      if (last.status === "needs_confirmation") {
        const confirmationId = last.session.pendingConfirmation?.id;
        const action = last.session.pendingConfirmation?.action;
        if (!confirmationId) return this.autoFlowResult(last, steps, workerResults);
        if (action === "prepare_workspace") {
          if (options.autoPrepareWorkspace === false) return this.autoFlowResult(last, steps, workerResults);
          this.debug("autoflow.confirmation.approve", { sessionId, step, action, confirmationId });
          last = await this.advanceIssue(sessionId, confirmationId);
          continue;
        }
        return this.autoFlowResult(last, steps, workerResults);
      }

      if (last.status === "execution_handoff") {
        this.debug("autoflow.execution_handoff.ready", {
          sessionId,
          step,
          issueRef: last.handoffRequest?.issueRef,
          repoKey: last.handoffRequest?.repoKey,
          workspacePath: last.handoffRequest?.workspacePath,
        });
        return this.autoFlowResult(last, steps, workerResults);
      }

      if (last.status === "blocked") {
        const remediated = await this.autoRemediateReviewBlocker(sessionId, last);
        if (remediated) {
          last = remediated;
          continue;
        }
      }

      this.debug("autoflow.stop", {
        sessionId,
        step,
        status: last.status,
        issueRef: last.issue?.ref,
        message: last.message,
      });
      return this.autoFlowResult(last, steps, workerResults);
    }

    const session = await this.requireSession(sessionId);
    this.debug("autoflow.max_steps", {
      sessionId,
      maxSteps,
      lastStatus: last.status,
      issueRef: last.issue?.ref,
      message: last.message,
    });
    return {
      status: "max_steps_reached",
      message: `Autoflow stopped after ${maxSteps} steps.`,
      steps,
      workerResults,
      session,
      issue: last.issue,
    };
  }

  private async autoRemediateReviewBlocker(
    sessionId: string,
    last: AdvanceIssueResult,
  ): Promise<AdvanceIssueResult | undefined> {
    const issue = last.issue;
    if (!issue) return undefined;
    const review = reviewMetadata(issue);
    if (!review?.isDraft) return undefined;
    const target = closeoutPullRequestTarget(issue, (k) => this.topology.repoName(k));
    if (!target || !collaborationCanMarkReady(this.collaboration)) return undefined;
    const currentIssue = (await this.ledger.readIssue(issue.ref)) ?? issue;
    await this.ledger.writeIssue({
      ...currentIssue,
      state: "running",
      metadata: {
        ...currentIssue.metadata,
        "workflow.autoflow.current_action": "mark_pr_ready_for_review",
        "workflow.autoflow.current_action_started_at": nowIso(),
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "autoflow.pr_ready.started",
      issueRef: issue.ref,
      message: `Autoflow marking PR #${target.number} ready for review.`,
      payload: { repo: target.repo, number: target.number, url: target.url },
    });
    const pr = await this.collaboration.markPullRequestReadyForReview(target.repo, target.number);
    await this.store.appendEvent({
      sessionId,
      type: "autoflow.pr_ready.completed",
      issueRef: issue.ref,
      message: `Autoflow marked PR #${target.number} ready for review.`,
      payload: { repo: target.repo, number: target.number, pullRequest: pr },
    });
    return this.advanceIssue(sessionId);
  }

  async recordWorkerResult(sessionId: string, result: WorkerTaskResult): Promise<WorkRuntimeSession> {
    const session = await this.requireSession(sessionId);
    const inferredWorkJobId = result.workJobId ?? await this.inferWorkJobIdForWorkerResult(result);
    const parsedResult = { ...result, workJobId: inferredWorkJobId, completedAt: result.completedAt ?? nowIso() };
    if (inferredWorkJobId) {
      const job = await this.findWorkJob(session, inferredWorkJobId, parsedResult.issueRef);
      await this.recordWorkJobResult(sessionId, workJobResultFromWorkerResult(job, parsedResult));
    }
    await this.ledger.recordWorkerResult(parsedResult);
    const updated = await this.store.writeSession({
      ...session,
      pendingConfirmation: undefined,
    });
    const issue = await this.ledger.readIssue(result.issueRef);
    if (issue) {
      await this.ledger.writeIssue({
        ...issue,
        state: result.status === "succeeded" ? "ready_to_run" : "blocked",
      });
    }
    await this.store.appendEvent({
      sessionId,
      type: "worker.result_recorded",
      issueRef: result.issueRef,
      message: result.summary,
      payload: { result: parsedResult },
    });
    this.debug("worker.result_recorded", {
      sessionId,
      issueRef: result.issueRef,
      repoKey: result.repoKey,
      status: result.status,
      summary: result.summary,
      blockers: result.blockers,
      nextPickup: result.nextPickup,
    });
    return updated;
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    return this.ledger.listWorkerResults(issueRef);
  }

  private workTypeForCategory(category: Parameters<WorkTypeRegistry["workTypeForCategory"]>[0]): string {
    const workType = this.workTypes.workTypeForCategory(category);
    if (!workType) throw new Error(`No work type registered for category ${category}.`);
    return workType;
  }

  async submitWorkJob(sessionId: string, input: SubmitWorkJobInput): Promise<WorkJob> {
    return this.withIssueMutation(input.issueRef, async () => {
      await this.requireSession(sessionId);
      if (input.idempotencyKey) {
        const existing = (await this.ledger.listWorkJobs(input.issueRef)).find((job) =>
          job.input &&
          typeof job.input === "object" &&
          (job.input as { idempotencyKey?: unknown }).idempotencyKey === input.idempotencyKey
        );
        if (existing) return existing;
      }
      const definition = this.workTypes.get(input.workType);
      if (!definition) throw new Error(`Unsupported work type ${input.workType}.`);
      const now = nowIso();
      const job = workJobSchema.parse({
        id: createId("job"),
        issueRef: input.issueRef,
        repoKey: input.repoKey,
        workType: input.workType,
        status: "queued",
        input: input.idempotencyKey
          ? { ...(input.input ?? {}), idempotencyKey: input.idempotencyKey }
          : input.input ?? {},
        requiredCapabilities: input.requiredCapabilities ?? definition.requiredCapabilities,
        parentJobId: input.parentJobId,
        createdAt: now,
        updatedAt: now,
      });
      await this.ledger.recordWorkJob(job);
      await this.store.appendEvent({
        sessionId,
        type: "work.job_submitted",
        issueRef: job.issueRef,
        message: `Submitted ${job.workType} job ${job.id}.`,
        payload: { job },
      });
      return job;
    });
  }

  async submitWorkEnvelope(sessionId: string, envelopeInput: string | WorkEnvelope): Promise<WorkJob> {
    const envelope = typeof envelopeInput === "string" ? parseWorkEnvelope(envelopeInput) : envelopeInput;
    return this.submitWorkJob(sessionId, {
      issueRef: envelope.issueRef,
      repoKey: envelope.repoKey,
      workType: envelope.workType,
      requiredCapabilities: envelope.requiredCapabilities.length ? envelope.requiredCapabilities : undefined,
      parentJobId: envelope.parentJobId,
      idempotencyKey: envelope.idempotencyKey,
      input: {
        executionMode: envelope.executionMode,
        body: envelope.body,
        ...envelope.metadata,
        metadata: envelope.metadata,
      },
    });
  }

  async claimWorkJob(sessionId: string, jobId: string, executor: WorkJobExecutor): Promise<WorkJob> {
    const session = await this.requireSession(sessionId);
    const job = await this.findWorkJob(session, jobId);
    return this.withIssueMutation(job.issueRef, async () => {
      const latest = await this.findWorkJob(session, jobId, job.issueRef);
      if (!this.workTypes.executorCanRun(executor, latest.workType, latest.requiredCapabilities)) {
        throw new Error(`${executor} cannot claim ${latest.workType} job ${latest.id}.`);
      }
      const now = nowIso();
      const claimed = workJobSchema.parse({
        ...latest,
        status: "claimed",
        claimedBy: executor,
        claimedAt: now,
        updatedAt: now,
      });
      await this.ledger.recordWorkJob(claimed);
      await this.store.appendEvent({
        sessionId,
        type: "work.job_claimed",
        issueRef: claimed.issueRef,
        message: `${executor} claimed ${claimed.workType} job ${claimed.id}.`,
        payload: { job: claimed },
      });
      return claimed;
    });
  }

  async recordWorkJobResult(sessionId: string, result: WorkJobResult): Promise<WorkJobResult> {
    return this.withIssueMutation(result.issueRef, async () => {
      const session = await this.requireSession(sessionId);
      const parsed = workJobResultSchema.parse(result);
      const job = await this.findWorkJob(session, parsed.jobId, parsed.issueRef);
      const completed = workJobSchema.parse({
        ...job,
        status: parsed.status,
        updatedAt: parsed.completedAt,
        completedAt: parsed.completedAt,
      });
      await this.ledger.recordWorkJob(completed);
      await this.ledger.recordWorkJobResult(parsed);
      await this.store.appendEvent({
        sessionId,
        type: "work.job_result_recorded",
        issueRef: parsed.issueRef,
        message: parsed.summary,
        payload: { result: parsed },
      });
      return parsed;
    });
  }

  async listWorkJobs(sessionId: string, issueRef?: string): Promise<WorkJob[]> {
    const session = await this.requireSession(sessionId);
    const ref = issueRef ?? session.selectedIssueRef;
    if (!ref) return [];
    return this.ledger.listWorkJobs(ref);
  }

  async observeExecutors(sessionId: string, issueRef?: string): Promise<WorkerRunRecord[]> {
    return this.observeWorkers(sessionId, issueRef);
  }

  async adoptLocalThread(
    sessionId: string,
    request: WorkerTaskRequest,
    options: LiveWorkerAdoptionOptions = {},
  ): Promise<WorkerTaskRequest & { workJobId: string }> {
    return this.adoptLiveWorker(sessionId, request, options);
  }

  async adoptPendingLocalThread(
    sessionId: string,
    options: LiveWorkerAdoptionOptions = {},
  ): Promise<WorkerTaskRequest & { workJobId: string }> {
    return this.adoptPendingLiveWorker(sessionId, options);
  }

  async recordExecutorResult(sessionId: string, result: WorkerTaskResult): Promise<WorkRuntimeSession> {
    return this.recordWorkerResult(sessionId, result);
  }

  async recordLocalThreadResult(
    sessionId: string,
    input: LocalThreadResultInput,
  ): Promise<LocalThreadResultRecord> {
    const session = await this.requireSession(sessionId);
    const issueRef = input.issueRef ?? session.selectedIssueRef;
    if (!issueRef) throw new Error("No issue selected for local-thread executor result.");
    const issue = await this.ledger.readIssue(issueRef);
    const repoKey = input.repoKey ?? session.selectedRepoKey ?? issue?.repoKeys[0];
    if (!repoKey) throw new Error(`Repo routing is missing for ${issueRef}.`);

    const executor: WorkerExecutor = WorkerExecutorValue.LiveAgentThread;
    const workExecutor = workerExecutorToWorkExecutor(executor);
    const runs = await this.ledger.listWorkerRuns(issueRef);
    const latestActiveRun = [...runs]
      .reverse()
      .find((run) =>
        run.repoKey === repoKey &&
        (run.status === WorkerStatusValue.Queued || run.status === WorkerStatusValue.Running) &&
        (!input.taskId || run.taskId === input.taskId)
      );
    const jobs = await this.ledger.listWorkJobs(issueRef);
    const targetJob = input.workJobId
      ? jobs.find((job) => job.id === input.workJobId)
      : [...jobs]
          .reverse()
          .find((job) =>
            job.repoKey === repoKey &&
            !isTerminalWorkJobStatus(job.status) &&
            this.workTypes.isCodeProducing(job.workType)
          );
    if (input.workJobId && !targetJob) {
      throw new Error(`Work job ${input.workJobId} is not recorded for ${issueRef}.`);
    }

    const taskId = input.taskId ??
      latestActiveRun?.taskId ??
      stringFromRecord(targetJob?.input, "handoffTaskId") ??
      createId("worker-local");
    const completedAt = input.completedAt ?? nowIso();
    let adoptedRun: WorkerRunRecord | undefined;

    if (targetJob && !isTerminalWorkJobStatus(targetJob.status)) {
      const latestJob = await this.findWorkJob(session, targetJob.id, issueRef);
      const claimed = latestJob.claimedBy === workExecutor
        ? latestJob
        : await this.claimWorkJob(sessionId, latestJob.id, workExecutor);
      const startedAt = latestActiveRun?.startedAt ?? claimed.claimedAt ?? nowIso();
      await this.markWorkJobRunning(sessionId, claimed, workExecutor, startedAt);
      adoptedRun = {
        taskId,
        issueRef,
        repoKey,
        workJobId: targetJob.id,
        executor,
        status: WorkerStatusValue.Running,
        workspacePath: stringFromRecord(targetJob.input, "workspacePath") ?? latestActiveRun?.workspacePath,
        summary: `Local thread took over execution handoff ${taskId}.`,
        blockers: [],
        startedAt,
        updatedAt: startedAt,
      };
      await this.ledger.recordWorkerRun(adoptedRun);
    }

    const result: WorkerTaskResult = {
      taskId,
      issueRef,
      repoKey,
      workJobId: input.workJobId ?? targetJob?.id ?? latestActiveRun?.workJobId,
      executor,
      status: input.status,
      summary: input.summary,
      changedFiles: input.changedFiles ?? [],
      testsRun: input.testsRun ?? [],
      blockers: input.blockers ?? [],
      nextPickup: input.nextPickup,
      handoffPrompt: input.handoffPrompt,
      evidenceCandidate: input.evidenceCandidate,
      completedAt,
    };
    const updated = await this.recordWorkerResult(sessionId, result);
    return { session: updated, result, adoptedRun };
  }

  async adoptLiveWorker(
    sessionId: string,
    request: WorkerTaskRequest,
    options: LiveWorkerAdoptionOptions = {},
  ): Promise<WorkerTaskRequest & { workJobId: string }> {
    await this.requireSession(sessionId);
    const executor: WorkerExecutor = WorkerExecutorValue.LiveAgentThread;
    const adopted = workerTaskRequestSchema.parse({
      ...request,
      executor,
    });
    if (!adopted.workspacePath) {
      throw new Error(`Live execution workspace path is missing for ${adopted.repoKey}. Run prepare workspace first.`);
    }
    const startedAt = nowIso();
    const adoptedWithJob = await this.ensureWorkerWorkJob(sessionId, adopted);
    const claimedJob = await this.claimWorkJob(sessionId, adoptedWithJob.workJobId, WorkJobExecutorValue.LiveAgentThread);
    await this.markWorkJobRunning(sessionId, claimedJob, WorkJobExecutorValue.LiveAgentThread, startedAt);
    await this.ledger.recordWorkerRun({
      taskId: adoptedWithJob.id,
      issueRef: adoptedWithJob.issueRef,
      repoKey: adoptedWithJob.repoKey,
      workJobId: adoptedWithJob.workJobId,
      executor: adoptedWithJob.executor,
      status: WorkerStatusValue.Running,
      workspacePath: adoptedWithJob.workspacePath,
      summary: options.summary ?? liveWorkerAdoptionSummary(options.adopter),
      blockers: [],
      startedAt,
      updatedAt: startedAt,
    });
    const issue = await this.ledger.readIssue(adoptedWithJob.issueRef);
    if (issue) {
      await this.ledger.writeIssue({ ...issue, state: IssueStateValue.Running });
    }
    await this.store.appendEvent({
      sessionId,
      type: "worker.live_adopted",
      issueRef: adoptedWithJob.issueRef,
      message: `Live agent thread adopted execution handoff ${adoptedWithJob.id}.`,
      payload: { handoffRequest: adoptedWithJob, adopter: options.adopter },
    });
    this.debug("worker.live_adopted", {
      sessionId,
      issueRef: adoptedWithJob.issueRef,
      repoKey: adoptedWithJob.repoKey,
      workspacePath: adoptedWithJob.workspacePath,
      taskId: adoptedWithJob.id,
      adopter: options.adopter,
    });
    return adoptedWithJob;
  }

  async adoptPendingLiveWorker(
    sessionId: string,
    options: LiveWorkerAdoptionOptions = {},
  ): Promise<WorkerTaskRequest & { workJobId: string }> {
    let session = await this.requireSession(sessionId);
    let advanced: AdvanceIssueResult;

    const pending = session.pendingConfirmation;
    if (pending && isExecutionHandoffAction(pending.action)) {
      advanced = await this.advanceIssue(sessionId, pending.id);
    } else {
      advanced = await this.advanceIssue(sessionId);
    }

    session = advanced.session;
    const nextPending = session.pendingConfirmation;
    if (advanced.status === "needs_confirmation" && nextPending && isExecutionHandoffAction(nextPending.action)) {
      advanced = await this.advanceIssue(sessionId, nextPending.id);
    }

    if (advanced.status !== "execution_handoff" || !advanced.handoffRequest) {
      throw new Error(`No Work Runtime-created handoff request is available to adopt. Current state: ${advanced.status}.`);
    }

    return this.adoptLiveWorker(
      sessionId,
      {
        id: advanced.handoffRequest.id,
        issueRef: advanced.handoffRequest.issueRef,
        repoKey: advanced.handoffRequest.repoKey,
        workJobId: advanced.handoffRequest.workJobId,
        prompt: advanced.handoffRequest.prompt,
        workspacePath: advanced.handoffRequest.workspacePath,
        createdAt: advanced.handoffRequest.createdAt ?? nowIso(),
      },
      options,
    );
  }

  async observeWorkers(sessionId: string, issueRef?: string): Promise<WorkerRunRecord[]> {
    const session = await this.requireSession(sessionId);
    const ref = issueRef ?? session.selectedIssueRef;
    if (!ref) return [];
    return this.ledger.listWorkerRuns(ref);
  }

  private async ensureWorkerWorkJob(sessionId: string, request: WorkerTaskRequest): Promise<WorkerTaskRequest & { workJobId: string }> {
    if (request.workJobId) return { ...request, workJobId: request.workJobId };
    const job = await this.submitWorkEnvelope(sessionId, [
      "---",
      `workType: ${this.workTypeForCategory("implement")}`,
      `issueRef: ${request.issueRef}`,
      `repoKey: ${request.repoKey}`,
      `executionMode: ${ExecutionModeValue.LocalThread}`,
      `idempotencyKey: ${request.issueRef}:${request.repoKey}:${request.id}`,
      "---",
      request.prompt,
      request.workspacePath ? `\nPrepared workspace: ${request.workspacePath}` : "",
    ].join("\n"));
    return { ...request, workJobId: job.id };
  }

  private async inferWorkJobIdForWorkerResult(
    result: WorkerTaskResult,
  ): Promise<string | undefined> {
    const runs = await this.ledger.listWorkerRuns(result.issueRef);
    const matchingRun = [...runs]
      .reverse()
      .find((run) => run.taskId === result.taskId && run.workJobId);
    if (matchingRun?.workJobId) return matchingRun.workJobId;

    const jobs = await this.ledger.listWorkJobs(result.issueRef);
    const matchingJob = [...jobs]
      .reverse()
      .find((job) =>
        job.repoKey === result.repoKey &&
        job.status !== "succeeded" &&
        job.status !== "cancelled" &&
        job.input &&
        typeof job.input === "object" &&
        (job.input as { handoffTaskId?: unknown }).handoffTaskId === result.taskId
      );
    if (matchingJob) return matchingJob.id;

    const latestRunnableJob = [...jobs]
      .reverse()
      .find((job) =>
        job.repoKey === result.repoKey &&
        job.status !== "succeeded" &&
        job.status !== "cancelled" &&
        this.workTypes.isCodeProducing(job.workType)
      );
    if (latestRunnableJob) return latestRunnableJob.id;

    return undefined;
  }

  private async markWorkJobRunning(
    sessionId: string,
    job: WorkJob,
    executor: WorkJobExecutor,
    startedAt = nowIso(),
  ): Promise<WorkJob> {
    const running = workJobSchema.parse({
      ...job,
      status: "running",
      claimedBy: executor,
      claimedAt: job.claimedAt ?? startedAt,
      updatedAt: startedAt,
    });
    await this.ledger.recordWorkJob(running);
    await this.store.appendEvent({
      sessionId,
      type: "work.job_running",
      issueRef: running.issueRef,
      message: `${executor} started ${running.workType} job ${running.id}.`,
      payload: { job: running },
    });
    return running;
  }

  private async findWorkJob(session: WorkRuntimeSession, jobId: string, issueRef?: string): Promise<WorkJob> {
    const ref = issueRef ?? session.selectedIssueRef;
    if (!ref) throw new Error(`No selected issue is available to find Work job ${jobId}.`);
    const job = (await this.ledger.listWorkJobs(ref)).find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Work job ${jobId} is not recorded for ${ref}.`);
    return job;
  }

  private async withIssueMutation<T>(issueRef: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.issueMutationQueues.get(issueRef) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.catch(() => undefined);
    this.issueMutationQueues.set(issueRef, tail);
    try {
      return await run;
    } finally {
      if (this.issueMutationQueues.get(issueRef) === tail) {
        this.issueMutationQueues.delete(issueRef);
      }
    }
  }

  async summarizeHandoff(sessionId: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    const issue = session.selectedIssueRef ? await this.ledger.readIssue(session.selectedIssueRef) : undefined;
    const findings = issue
      ? session.findings.filter((finding) => !finding.issueRef || finding.issueRef === issue.ref)
      : session.findings;
    const lines = [
      issue ? `${issue.ref}: ${issue.title}` : "No issue selected.",
      session.pendingConfirmation && (!issue || session.pendingConfirmation.issueRef === issue.ref)
        ? `Pending: ${session.pendingConfirmation.summary}`
        : undefined,
      ...findings.map((finding) => `${finding.severity}: ${finding.summary}`),
    ].filter(Boolean);
    return lines.join("\n");
  }

  async recordEvidence(sessionId: string, record: EvidenceRecordInput): Promise<WorkItem> {
    await this.requireSession(sessionId);
    const issue = await this.reconcileIssue(sessionId, record.issueRef);
    const criteria = record.criteria ?? [];
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        evidenceRecorded: true,
        evidenceSummary: record.summary,
        evidenceSource: record.source,
        evidenceCriteria: criteria,
        "workflow.acceptance.status": "recorded",
        "workflow.acceptance.criteria_json": criteria.length ? JSON.stringify(criteria) : "",
        evidenceRecordedAt: nowIso(),
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "evidence.recorded",
      issueRef: issue.ref,
      message: record.summary,
      payload: { record },
    });
    return updated;
  }

  async recordAcceptanceWriteback(sessionId: string, issueRef?: string): Promise<WorkItem> {
    const session = await this.requireSession(sessionId);
    const ref = issueRef ?? session.selectedIssueRef;
    if (!ref) throw new Error("No issue selected for acceptance writeback.");
    const issue = await this.reconcileIssue(sessionId, ref);
    const review = reviewMetadata(issue);
    if (!review?.prUrl) throw new Error(`Cannot write acceptance evidence for ${issue.ref}: pull request is missing.`);
    if (!hasRecordedEvidence(issue)) {
      throw new Error(`Cannot write acceptance evidence for ${issue.ref}: acceptance evidence is missing.`);
    }
    if (!issueTrackerCanPostComments(this.issueTracker)) {
      throw new Error("Cannot write acceptance evidence to Jira: Jira comment writer is not configured.");
    }

    const payload = acceptanceWritebackPayload(issue, review);
    const payloadHash = stableHash(payload);
    if (
      issue.metadata["workflow.acceptance.jira_written"] === true &&
      issue.metadata["workflow.acceptance.jira_payload_hash"] === payloadHash
    ) {
      return issue;
    }

    const commentBody = formatAcceptanceWritebackComment(issue, review);
    const comment = await this.issueTracker.postIssueComment(issue.ref, commentBody);
    const writtenAt = nowIso();
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        "workflow.acceptance.jira_written": true,
        "workflow.acceptance.jira_comment_url": comment.url ?? "",
        "workflow.acceptance.jira_payload_hash": payloadHash,
        "workflow.acceptance.jira_written_at": writtenAt,
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "acceptance.jira_written",
      issueRef: issue.ref,
      message: `Acceptance evidence written to Jira for ${issue.ref}.`,
      payload: { commentUrl: comment.url, payloadHash, writtenAt },
    });
    return updated;
  }

  async closeoutAfterApproval(
    sessionId: string,
    options: CloseoutAfterApprovalOptions = {},
  ): Promise<CloseoutAfterApprovalResult> {
    const session = await this.requireSession(sessionId);
    const ref = options.issueRef ?? session.selectedIssueRef;
    if (!ref) throw new Error("No issue selected for closeout.");

    const issue = await this.reconcileIssue(sessionId, ref);
    const target = closeoutPullRequestTarget(issue, (k) => this.topology.repoName(k));
    const blockers: string[] = [];
    if (!target) blockers.push("Pull request metadata is missing.");
    if (!this.collaboration?.getPullRequest) blockers.push("GitHub pull request reader is not configured.");
    if (!this.issueTracker?.viewIssue) blockers.push("Jira issue reader is not configured.");
    if (!issueTrackerCanPostComments(this.issueTracker)) blockers.push("Jira comment writer is not configured.");
    if (!hasRecordedEvidence(issue)) blockers.push("Acceptance evidence is missing.");
    if (!hasRecordedDocumentation(issue)) blockers.push("Documentation disposition is missing.");

    let pr = target && this.collaboration?.getPullRequest
      ? await this.collaboration.getPullRequest(target.repo, target.number)
      : undefined;
    if (target && !pr) blockers.push(`Pull request ${target.repo}#${target.number} could not be read.`);
    if (pr) blockers.push(...pullRequestCloseoutBlockers(issue, pr));
    if (pr && !isPullRequestStatusMerged(pr) && !collaborationCanMerge(this.collaboration)) {
      blockers.push("GitHub pull request merge writer is not configured.");
    }

    if (blockers.length > 0 || !target || !pr || !this.issueTracker?.viewIssue) {
      const blocked = await this.ledger.writeIssue({
        ...issue,
        metadata: {
          ...issue.metadata,
          "workflow.closeout.status": "blocked",
          "workflow.closeout.blockers": blockers,
          "workflow.closeout.checked_at": nowIso(),
        },
      });
      await this.store.appendEvent({
        sessionId,
        type: "closeout.blocked",
        issueRef: issue.ref,
        message: blockers.join("; ") || "Closeout is blocked.",
        payload: { blockers, pr },
      });
      return { status: "blocked", issue: blocked, pr, blockers };
    }

    const jiraBefore = await this.issueTracker.viewIssue(issue.ref);
    const evidenceIssue = await this.recordAcceptanceWriteback(sessionId, issue.ref);
    const acceptanceCommentUrl = existingString(evidenceIssue.metadata["workflow.acceptance.jira_comment_url"]);
    const github = this.collaboration;
    if (!github?.getPullRequest) throw new Error("GitHub pull request reader is not configured.");
    if (!collaborationCanMerge(github)) throw new Error("GitHub pull request merge writer is not configured.");
    const alreadyMerged = isPullRequestStatusMerged(pr);
    const merge = alreadyMerged
      ? { url: pr.url, mergedAt: pr.mergedAt, mergeCommitSha: pr.mergeCommitSha }
      : await github.mergePullRequest(target.repo, target.number, { method: options.mergeMethod ?? "squash" });
    if (!merge) throw new Error("GitHub pull request merge writer is not configured.");
    pr = await github.getPullRequest(target.repo, target.number) ?? {
      ...pr,
      state: "MERGED",
      mergedAt: merge.mergedAt ?? nowIso(),
      mergeCommitSha: merge.mergeCommitSha,
    };

    const jiraAfter = await this.waitForJiraCloseout(issue.ref, options);
    const jiraVerified = isJiraCloseoutStatus(jiraAfter);
    const status = alreadyMerged
      ? jiraVerified ? "already_merged_jira_verified" : "already_merged_jira_pending"
      : jiraVerified ? "merged_jira_verified" : "merged_jira_pending";
    const writtenAt = nowIso();
    const updated = await this.ledger.writeIssue({
      ...evidenceIssue,
      state: jiraVerified || isPullRequestStatusMerged(pr) ? "done" : evidenceIssue.state,
      metadata: {
        ...evidenceIssue.metadata,
        ...pullRequestMetadata(this.repoKeyFromName(pr.repo), pr),
        jiraStatus: jiraAfter.status,
        jiraStatusCategory: jiraAfter.statusCategory,
        jiraResolution: jiraAfter.resolution,
        jiraUpdated: jiraAfter.updated,
        "workflow.closeout.status": status,
        "workflow.closeout.merged": true,
        "workflow.closeout.merge_method": options.mergeMethod ?? "squash",
        "workflow.closeout.merge_commit_sha": merge.mergeCommitSha ?? pr.mergeCommitSha ?? "",
        "workflow.closeout.merged_at": pr.mergedAt ?? merge.mergedAt ?? "",
        "workflow.closeout.jira_status_before": jiraBefore.status ?? "",
        "workflow.closeout.jira_status_after": jiraAfter.status ?? "",
        "workflow.closeout.jira_verified": jiraVerified,
        "workflow.closeout.checked_at": writtenAt,
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "closeout.completed",
      issueRef: issue.ref,
      message: jiraVerified
        ? `Merged ${pr.url} and verified Jira moved to ${jiraAfter.status ?? "a closeout status"}.`
        : `Merged ${pr.url}; Jira has not moved from ${jiraAfter.status ?? "current status"} yet.`,
      payload: { status, pr, merge, jiraBefore, jiraAfter, acceptanceCommentUrl, writtenAt },
    });
    return {
      status,
      issue: updated,
      pr,
      blockers: jiraVerified ? [] : ["Jira did not move to Ready for QA or Done after merge."],
      acceptanceCommentUrl,
      merge,
      jiraStatusBefore: jiraBefore.status,
      jiraStatusAfter: jiraAfter.status,
    };
  }

  async recordReviewConfirmation(
    sessionId: string,
    record: Omit<ReviewConfirmationRecord, "recordedAt">,
  ): Promise<WorkItem> {
    await this.requireSession(sessionId);
    const issue = await this.reconcileIssue(sessionId, record.issueRef);
    const commentBody = formatReviewConfirmationComment(issue, record);
    const githubComment = record.githubCommentUrl
      ? { url: record.githubCommentUrl, body: commentBody }
      : collaborationCanPostComments(this.collaboration)
      ? await this.collaboration.postPullRequestComment(record.repo, record.number, commentBody)
      : { body: commentBody };
    const commentUrl = githubComment.url ?? this.topology.pullRequestUrl(record.repo, record.number);
    const recordedAt = nowIso();
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        prRepo: record.repo,
        prNumber: record.number,
        prUrl: this.topology.pullRequestUrl(record.repo, record.number),
        prAutoReviewNeedsConfirmationDisposition: record.disposition,
        prAutoReviewNeedsConfirmationSummary: record.summary,
        prAutoReviewNeedsConfirmationEvidence: record.evidence ?? "",
        prAutoReviewNeedsConfirmationVerification: record.verification ?? "",
        prAutoReviewNeedsConfirmationPostedUrl: commentUrl,
        prAutoReviewNeedsConfirmationRecordedAt: recordedAt,
        ...repoReviewConfirmationMetadata(record.repo, {
          disposition: record.disposition,
          summary: record.summary,
          evidence: record.evidence,
          verification: record.verification,
          postedUrl: commentUrl,
          recordedAt,
        }),
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "review_confirmation.recorded",
      issueRef: issue.ref,
      message: `${record.disposition}: ${record.summary}`,
      payload: { record: { ...record, githubCommentUrl: commentUrl, recordedAt } },
    });
    return updated;
  }

  async recordProviderEscalation(
    sessionId: string,
    record: Omit<ProviderEscalationRecord, "recordedAt">,
  ): Promise<WorkItem> {
    await this.requireSession(sessionId);
    const issue = await this.reconcileIssue(sessionId, record.issueRef);
    const recordedAt = nowIso();
    const updated = await this.ledger.writeIssue({
      ...issue,
      state: "blocked",
      metadata: {
        ...issue.metadata,
        externalProviderEscalation: {
          provider: record.provider,
          summary: record.summary,
          blocker: record.blocker,
          supportUrl: record.supportUrl,
          recordedAt,
        },
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "provider_escalation.recorded",
      issueRef: issue.ref,
      message: record.summary,
      payload: { record: { ...record, recordedAt } },
    });
    return updated;
  }

  async recordInvestigation(
    sessionId: string,
    record: Omit<InvestigationRecord, "recordedAt">,
  ): Promise<WorkItem> {
    await this.requireSession(sessionId);
    const issue = await this.reconcileIssue(sessionId, record.issueRef);
    const recordedAt = nowIso();
    const updated = await this.ledger.writeIssue({
      ...issue,
      state: investigationState(record.disposition),
      metadata: {
        ...issue.metadata,
        externalProviderEscalation: undefined,
        investigationRecorded: true,
        investigationDisposition: record.disposition,
        investigationSummary: record.summary,
        investigationFindings: record.findings ?? [],
        investigationNextAction: record.nextAction,
        investigationEvidenceSource: record.evidenceSource,
        investigationRecordedAt: recordedAt,
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "investigation.recorded",
      issueRef: issue.ref,
      message: record.summary,
      payload: { record: { ...record, recordedAt } },
    });
    return updated;
  }

  async recordDocumentation(sessionId: string, record: Omit<DocumentationRecord, "recordedAt">): Promise<WorkItem> {
    await this.requireSession(sessionId);
    const issue = await this.reconcileIssue(sessionId, record.issueRef);
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        documentationRecorded: true,
        documentationDisposition: record.disposition,
        documentationSummary: record.summary,
        documentationRecordedAt: nowIso(),
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "documentation.recorded",
      issueRef: issue.ref,
      message: record.summary,
      payload: { record },
    });
    return updated;
  }

  async recordPullRequest(
    sessionId: string,
    record: {
      issueRef: string;
      repo: string;
      number: number;
      url: string;
      headRefName?: string;
      isDraft: boolean;
      checksPassing?: boolean;
      reviewDecision?: string;
    },
  ): Promise<WorkItem> {
    await this.requireSession(sessionId);
    const issue = await this.reconcileIssue(sessionId, record.issueRef);
    const repoKey = this.repoKeyFromName(record.repo);
    const gitMetadata = await this.inspectRepoForHandoff(issue, repoKey);
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        ...gitMetadata,
        ...pullRequestMetadata(repoKey, {
          repo: record.repo,
          number: record.number,
          title: "",
          url: record.url,
          headRefName: record.headRefName ?? "",
          isDraft: record.isDraft,
          checksPassing: record.checksPassing,
          reviewDecision: record.reviewDecision,
        }),
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "pull_request.recorded",
      issueRef: issue.ref,
      message: record.url,
      payload: { record },
    });
    return updated;
  }

  private async inspectRepoForHandoff(issue: WorkItem, repo: string): Promise<Record<string, unknown>> {
    const repoKey = normalizeRepoKey(repo);
    const path =
      issue.metadata[`workflow.repos.${repoKey}.worktree_path`] ??
      issue.metadata.work_dir ??
      issue.metadata.worktree_path;
    if (typeof path !== "string" || !path) return {};

    try {
      const status = await this.sourceControl.inspect(path);
      return {
        [`workflow.repos.${repoKey}.branch`]: status.branch,
        [`workflow.repos.${repoKey}.head_sha`]: status.headSha,
        [`workflow.repos.${repoKey}.dirty`]: status.dirty,
      };
    } catch {
      return {};
    }
  }

  private async waitForJiraCloseout(issueRef: string, options: CloseoutAfterApprovalOptions): Promise<JiraIssue> {
    if (!this.issueTracker?.viewIssue) throw new Error("Jira issue reader is not configured.");
    const attempts = Math.max(1, Math.floor(options.jiraPollAttempts ?? 6));
    const intervalMs = Math.max(0, Math.floor(options.jiraPollIntervalMs ?? 5000));
    let latest = await this.issueTracker.viewIssue(issueRef);
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      if (isJiraCloseoutStatus(latest)) return latest;
      if (intervalMs > 0) await sleep(intervalMs);
      latest = await this.issueTracker.viewIssue(issueRef);
    }
    return latest;
  }

  private async reconcileExternalState(
    issue: WorkItem,
    pullRequestsByRepo?: PullRequestsByRepo,
    options: { persist?: boolean } = {},
  ): Promise<WorkItem> {
    return this.reconciliation.reconcile(issue, pullRequestsByRepo, options);
  }

  private async reconcileExternalStateSafely(
    issue: WorkItem,
    pullRequestsByRepo?: PullRequestsByRepo,
    options: { persist?: boolean } = {},
  ): Promise<WorkItem> {
    return this.reconciliation.reconcileSafely(issue, pullRequestsByRepo, options);
  }

  private mergeJiraQueueIssue(jiraIssue: JiraIssue, existing?: WorkItem): WorkItem {
    const repoKeys = this.resolveJiraQueueRepoKeys(jiraIssue, existing);
    const issueUrl = existingString((jiraIssue as { url?: unknown }).url);
    const localIssue = isLocalIssueTrackerIssue(jiraIssue);
    const jiraIssueTrackerIssue = isJiraIssueTrackerIssue(jiraIssue);
    const existingMetadata = jiraIssueTrackerIssue
      ? existing?.metadata ?? {}
      : providerNeutralExistingMetadata(existing?.metadata);
    const jiraMetadata = isJiraIssueTrackerIssue(jiraIssue)
      ? {
        jiraStatus: jiraIssue.status,
        jiraIssueType: jiraIssue.issueType,
        jiraLabels: jiraIssue.labels ?? [],
        jiraStatusCategory: jiraIssue.statusCategory,
        jiraResolution: jiraIssue.resolution,
        jiraUpdated: jiraIssue.updated,
        jiraUrl: issueUrl,
      }
      : {};
    const metadata = {
      ...existingMetadata,
      issueStatus: jiraIssue.status,
      issueStatusCategory: jiraIssue.statusCategory,
      issueResolution: jiraIssue.resolution,
      issueUpdated: jiraIssue.updated,
      issueUrl,
      issueType: jiraIssue.issueType,
      issueLabels: jiraIssue.labels ?? [],
      "workflow.external.issue.status": existingString(existing?.metadata["workflow.external.issue.status"]) ??
        (localIssue ? "unpublished" : issueUrl ? "published" : "unpublished"),
      "workflow.external.code_review.status": existingString(existing?.metadata["workflow.external.code_review.status"]) ??
        "unpublished",
      ...jiraMetadata,
      branchKind: existingBranchKind(existing) ?? branchKindFromJiraIssueType(jiraIssue.issueType) ?? "",
    };
    const issue: WorkItem = {
      ref: jiraIssue.key,
      title: jiraIssue.summary || existing?.title || jiraIssue.key,
      repoKeys,
      state: existing?.state === "done" ? "queued" : existing?.state ?? "queued",
      summary: existing?.summary,
      updatedAt: existing?.updatedAt,
      metadata,
    };
    return issue;
  }

  private requireDefaultJiraProjectKey(): string {
    if (this.defaultJiraProjectKey) return this.defaultJiraProjectKey;
    throw new Error("Jira project key is required. Configure issueTracker.projectKey in .flow/config.yaml or pass projectKey.");
  }

  private resolveJiraQueueRepoKeys(jiraIssue: JiraIssue, existing?: WorkItem): string[] {
    const candidates = normalizeRepoKeys([
      ...this.topology.inferRepoKeysFromIssue({ title: jiraIssue.summary, labels: jiraIssue.labels ?? [] }),
      ...(jiraIssue.labels ?? []),
      ...(existing?.repoKeys ?? []),
      ...inferredRepoKeys(existing?.metadata ?? {}, (n) => this.repoKeyFromName(n)),
    ]);
    return this.resolveRoutedRepoKeys(candidates);
  }

  private resolveRoutedRepoKeys(repoKeys: string[]): string[] {
    return normalizeRepoKeys(repoKeys).filter((repoKey) => this.topology.isValidRepoKey(repoKey));
  }

  private async preloadOpenPullRequests(issues: WorkItem[]): Promise<PullRequestsByRepo | undefined> {
    return this.reconciliation.preloadPullRequests(issues);
  }

  private isValidRepoKey(repoKey: string): boolean {
    if (!this.topology.isValidRepoKey(repoKey)) return false;
    const repoPath = this.topology.repoPath(this.projectRoot, repoKey);
    return existsSync(repoPath);
  }

  private repoKeyFromName(repoName: string): string {
    for (const key of this.topology.validRepoKeys) {
      if (this.topology.repoName(key) === repoName) return key;
    }
    return normalizeRepoKey(repoName);
  }


  private autoFlowResult(
    last: AdvanceIssueResult,
    steps: AdvanceIssueResult[],
    workerResults: WorkerTaskResult[],
  ): AutoFlowIssueResult {
    return {
      status: last.status,
      message: last.message,
      steps,
      workerResults,
      session: last.session,
      issue: last.issue,
      handoffRequest: last.handoffRequest,
    };
  }

  private async recordAutoflowAttempt(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    if (!session.selectedIssueRef) return;
    const issue = await this.ledger.readIssue(session.selectedIssueRef);
    if (!issue) return;
    const attempts = metadataNumber(issue.metadata["workflow.autoflow.attempts"]) ?? 0;
    const attemptedAt = nowIso();
    await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        "workflow.autoflow.attempts": attempts + 1,
        "workflow.autoflow.last_attempted_at": attemptedAt,
      },
    });
    await this.store.appendEvent({
      sessionId,
      type: "autoflow.attempted",
      issueRef: issue.ref,
      message: `Autoflow attempt ${attempts + 1} recorded for ${issue.ref}.`,
      payload: { attempts: attempts + 1, attemptedAt },
    });
  }

  private async approveConfirmation(
    session: WorkRuntimeSession,
    confirmationId: string,
  ): Promise<AdvanceIssueResult> {
    const confirmation = session.pendingConfirmation;
    if (!confirmation || confirmation.id !== confirmationId) {
      return {
        status: "blocked",
        session,
        message: "No matching pending confirmation exists.",
      };
    }

    const issue = await this.selectedIssue(session);
    const repoKey = String(confirmation.payload.repoKey ?? session.selectedRepoKey ?? issue.repoKeys[0] ?? "");
    if (!repoKey) {
      return {
        status: "blocked",
        session,
        issue,
        message: "Repo routing is missing.",
      };
    }
    if (confirmation.action === "prepare_workspace") {
      await this.prepareWorkspace(session.id, issue.ref, { repoKey });
      return this.advanceIssue(session.id);
    }

    const workType = confirmation.payload.workType === this.workTypeForCategory("remediate")
      ? this.workTypeForCategory("remediate")
      : this.workTypeForCategory("implement");
    const prompt = typeof confirmation.payload.workerPrompt === "string"
      ? confirmation.payload.workerPrompt
      : buildWorkerPrompt(issue, repoKey);
    const workerId = createId("worker");
    const job = await this.submitWorkEnvelope(session.id, {
      issueRef: issue.ref,
      repoKey,
      workType,
      executionMode: ExecutionModeValue.LocalThread,
      idempotencyKey: `${issue.ref}:${repoKey}:${workerId}`,
      body: prompt,
      metadata: {
        workspacePath: worktreePathForRepo(issue, repoKey),
        handoffTaskId: workerId,
      },
      requiredCapabilities: [],
    });
    const handoffRequest = {
      id: workerId,
      issueRef: issue.ref,
      repoKey,
      workJobId: job.id,
      prompt,
      workspacePath: worktreePathForRepo(issue, repoKey),
      createdAt: nowIso(),
    };
    const updatedSession = await this.store.writeSession({
      ...session,
      pendingConfirmation: undefined,
    });
    await this.ledger.writeIssue({ ...issue, state: "running" });
      await this.store.appendEvent({
        sessionId: session.id,
        type: "handoff.requested",
        issueRef: issue.ref,
        message: `Execution handoff requested for ${issue.ref} in ${repoKey}.`,
        payload: { handoffRequest },
      });
      return {
        status: "execution_handoff",
        session: updatedSession,
        issue,
        message: `Record result for execution handoff ${handoffRequest.id}.`,
        handoffRequest,
      };
  }

  private prepareWorkspaceConfirmation(
    issue: WorkItem,
    session: WorkRuntimeSession,
    findings: ReadinessFinding[],
  ): PendingConfirmation | undefined {
    if (!this.sourceControl.prepareWorktree) return undefined;
    if (findings.length !== 1) return undefined;
    const [finding] = findings;
    if (finding.severity !== "blocker" || finding.summary !== "Prepared worktree is missing.") return undefined;

    const repoKey = session.selectedRepoKey ?? issue.repoKeys[0];
    if (!repoKey) return undefined;
    return {
      id: createId("confirm"),
      issueRef: issue.ref,
      action: "prepare_workspace",
      summary: `Prepare workspace for ${issue.ref} in ${repoKey}.`,
      payload: { repoKey },
      createdAt: nowIso(),
    };
  }

  private resolveConflictsConfirmation(
    issue: WorkItem,
    session: WorkRuntimeSession,
    findings: ReadinessFinding[],
  ): PendingConfirmation | undefined {
    const hasConflictBlocker = findings.some((finding) =>
      finding.severity === "blocker" && finding.summary === "Pull request has merge conflicts."
    );
    if (!hasConflictBlocker) return undefined;
    const repoKey = session.selectedRepoKey ?? issue.repoKeys[0];
    if (!repoKey) return undefined;
    return {
      id: createId("confirm"),
      issueRef: issue.ref,
      action: "request_execution",
      summary: `Hand off PR merge-conflict resolution for ${issue.ref} in ${repoKey}.`,
      payload: { repoKey },
      createdAt: nowIso(),
    };
  }

  private reviewRemediationConfirmation(
    issue: WorkItem,
    session: WorkRuntimeSession,
    findings: ReadinessFinding[],
  ): PendingConfirmation | undefined {
    const remediableFindings = findings.filter((finding) =>
      finding.severity === "blocker" &&
      (
        finding.summary === "Auto review has must-fix feedback." ||
        finding.summary === "Pull request does not follow the repo template." ||
        finding.summary === "Pull request checks are not passing." ||
        finding.summary === "Auto review checks failed."
      )
    );
    if (!remediableFindings.length) return undefined;
    const nonRemediableBlocker = findings.some((finding) =>
      finding.severity === "blocker" && !remediableFindings.includes(finding)
    );
    if (nonRemediableBlocker) return undefined;
    const repoKey = session.selectedRepoKey ?? issue.repoKeys[0];
    if (!repoKey) return undefined;
    return {
      id: createId("confirm"),
      issueRef: issue.ref,
      action: "request_execution",
      summary: `Hand off PR review remediation for ${issue.ref} in ${repoKey}.`,
      payload: {
        repoKey,
        workType: this.workTypeForCategory("remediate"),
        workerPrompt: buildReviewRemediationWorkerPrompt(issue, repoKey, remediableFindings),
      },
      createdAt: nowIso(),
    };
  }

  private async requireSession(id: string): Promise<WorkRuntimeSession> {
    const session = await this.store.readSession(id);
    if (!session) throw new Error(`Work Runtime session ${id} does not exist.`);
    return session;
  }

  private async selectedIssue(session: WorkRuntimeSession): Promise<WorkItem> {
    if (!session.selectedIssueRef) throw new Error("No issue selected.");
    const issue = await this.ledger.readIssue(session.selectedIssueRef);
    if (!issue) throw new Error(`Issue ${session.selectedIssueRef} is not in Flow ledger state.`);
    return issue;
  }

  private async latestActiveWorkerRun(issueRef: string): Promise<WorkerRunRecord | undefined> {
    const runs = await this.ledger.listWorkerRuns(issueRef);
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (run.status === "running" || run.status === "queued") return run;
    }
    return undefined;
  }

  private async reconcileStaleWorkerRuns(issueRef: string): Promise<void> {
    return this.reconciliation.reconcileStaleWorkerRuns(issueRef);
  }
}

const INTAKE_SECTIONS = [
  "Problem",
  "Why now",
  "Scope",
  "Out of scope",
  "Files to inspect first",
  "Acceptance criteria",
  "Verification commands",
  "Dependencies",
  "Concurrency notes",
  "Priority",
  "Lane",
];

function structuredIssueBody(description: string | undefined, summary: string, repoKeys: string[] | undefined): string {
  const body = description?.trim() ?? "";
  if (body && missingIntakeSections(body).length === 0) return body;
  const problem = body || summary;
  const files = repoKeys?.length ? repoKeys.map((repoKey) => `- ${repoKey}`).join("\n") : "- Not specified.";
  const priority = proposeIssuePriority(summary, body) ?? "priority-p2";
  const lane = proposeIssueLane(summary, body) ?? "Not specified.";
  return [
    "## Problem",
    problem,
    "",
    "## Why now",
    "Not specified.",
    "",
    "## Scope",
    summary,
    "",
    "## Out of scope",
    "Not specified.",
    "",
    "## Files to inspect first",
    files,
    "",
    "## Acceptance criteria",
    "- Requested behavior is implemented.",
    "- Existing behavior is not regressed.",
    "",
    "## Verification commands",
    "- npm run check",
    "",
    "## Dependencies",
    "- None known.",
    "",
    "## Concurrency notes",
    "- Check related open issues before editing shared files.",
    "",
    "## Priority",
    priority,
    "",
    "## Lane",
    lane,
  ].join("\n");
}

function missingIntakeSections(body: string): string[] {
  const headings = new Set(issueBodyHeadings(body).map((heading) => heading.toLowerCase()));
  return INTAKE_SECTIONS.filter((section) => !headings.has(section.toLowerCase()));
}

function issueIntakeProblems(summary: string, description: string | undefined): string[] {
  const reasons: string[] = [];
  const normalized = summary.trim().toLowerCase();
  if (summary.trim().length < 10) reasons.push("summary is too short");
  if (["fix", "update", "change", "improve", "add", "remove", "todo", "wip", "misc", "stuff", "things"].includes(normalized)) {
    reasons.push("summary is too vague");
  }
  if (!description?.trim() && summary.trim().length < 10) {
    reasons.push("description is required when the summary is vague");
  }
  return reasons;
}

function extractSectionLines(body: string, section: string): string[] {
  const lines = splitLines(body);
  const values: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = issueBodyHeading(line);
    if (heading) {
      if (inSection) break;
      inSection = heading.toLowerCase() === section.toLowerCase();
      continue;
    }
    if (inSection) values.push(stripListMarker(line));
  }
  return values
    .map((line) => line.trim())
    .filter(Boolean);
}

function proposeIssuePriority(title: string, body: string): string | undefined {
  const words = new Set(normalizeIssueWords(`${title}\n${body}`));
  if (hasAny(words, ["security", "vulnerability", "cve", "critical", "blocker"]) || `${title}\n${body}`.toLowerCase().includes("data loss")) return "priority-p0";
  if (hasAny(words, ["bug", "regression", "broken", "production", "timeout", "stuck", "runner", "autoflow", "agent"])) return "priority-p1";
  if (hasAny(words, ["chore", "cleanup", "cosmetic", "minor", "doc", "docs", "documentation"])) return "priority-p3";
  return "priority-p2";
}

function proposeIssueLane(title: string, body: string): string | undefined {
  const words = new Set(normalizeIssueWords(`${title}\n${body}`));
  if (hasAny(words, ["sql", "sqlite", "postgres", "ledger", "database", "migration"])) return "lane-sql";
  if (hasAny(words, ["desktop", "pi", "agent", "autoflow", "runner", "prompt", "session"])) return "lane-desktop-runner";
  if (hasAny(words, ["test", "coverage", "fixture", "harness", "ci"])) return "lane-test-infra";
  if (hasAny(words, ["doc", "docs", "documentation", "example", "guide", "readme"])) return "lane-docs";
  return undefined;
}

function normalizeIssueWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const char of text.toLowerCase()) {
    if (isWordChar(char)) {
      current += char;
    } else if (current) {
      if (current.length > 2) words.push(current);
      current = "";
    }
  }
  if (current.length > 2) words.push(current);
  return words;
}

function issueIntakeReviewPrompt(
  input: {
    title?: string;
    summary: string;
    description?: string;
    issueType: string;
  },
  proposal: IssueIntakeProposal,
  candidates: IssueIntakeCandidate[],
): string {
  return [
    "Review this issue intake request.",
    "Decide whether it duplicates any candidate and whether the proposed issue body is detailed enough.",
    "Return a worker result through Flow with the duplicate ref, confidence, and any improved title/body/tags in the summary or next pickup.",
    "",
    "Request:",
    JSON.stringify(input, null, 2),
    "",
    "Proposal:",
    JSON.stringify(proposal, null, 2),
    "",
    "Candidates:",
    JSON.stringify(candidates.slice(0, 50), null, 2),
  ].join("\n");
}

function splitLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function issueBodyHeadings(body: string): string[] {
  return splitLines(body).map(issueBodyHeading).filter((heading): heading is string => Boolean(heading));
}

function issueBodyHeading(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("##")) return undefined;
  let index = 0;
  while (trimmed[index] === "#") index++;
  return trimmed.slice(index).trim();
}

function stripListMarker(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) return trimmed.slice(2);
  return trimmed;
}

function hasAny(words: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => words.has(candidate));
}

function isWordChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || char === "_";
}

function investigationState(disposition: InvestigationDisposition): WorkItem["state"] {
  if (disposition === "needs_code_change") return "ready_to_run";
  return "blocked";
}

function normalizeSourceControlIntegration(
  provider: SourceControlIntegration | SourceControlProvider,
): SourceControlIntegration {
  if ("inspect" in provider && typeof provider.inspect === "function") return provider as SourceControlIntegration;
  const sourceProvider = provider as SourceControlProvider;
  return {
    ...provider,
    async inspect(repoPath: string): Promise<GitRepoStatus> {
      return gitStatusFromUnified(await sourceProvider.inspectWorkspace(repoPath));
    },
    prepareWorktree: sourceProvider.prepareWorktree
      ? async (plan: WorktreePlan): Promise<GitRepoStatus> =>
        gitStatusFromUnified(await sourceProvider.prepareWorktree?.(plan) as UnifiedWorkspaceStatus)
      : undefined,
  };
}

function normalizeIssueTrackerIntegration(
  provider: IssueTrackerIntegration | IssueTrackerProvider | undefined,
): IssueTrackerIntegration | undefined {
  if (!provider) return undefined;
  if ("viewIssue" in provider && typeof provider.viewIssue === "function") return provider as IssueTrackerIntegration;
  const issueProvider = provider as IssueTrackerProvider;
  return {
    ...provider,
    async viewIssue(ref: string): Promise<JiraIssue> {
      return jiraIssueFromUnified(await issueProvider.getIssue(ref));
    },
    searchCurrentUserOpenSprintIssues: issueProvider.fetchActiveQueue
      ? async (limit?: number): Promise<JiraIssue[]> =>
        (await issueProvider.fetchActiveQueue?.(limit) ?? []).map(jiraIssueFromUnified)
      : undefined,
    searchCurrentUserBacklogIssues: issueProvider.fetchBacklogQueue
      ? async (limit?: number): Promise<JiraIssue[]> =>
        (await issueProvider.fetchBacklogQueue?.(limit) ?? []).map(jiraIssueFromUnified)
      : undefined,
    createIssue: issueProvider.createIssue
      ? async (input): Promise<JiraIssue> => jiraIssueFromUnified(await issueProvider.createIssue?.(input) as UnifiedIssue)
      : undefined,
    transitionIssueToStatus: issueProvider.transitionIssue
      ? async (key: string, status: string): Promise<unknown> => issueProvider.transitionIssue?.(key, status)
      : undefined,
    postIssueComment: issueProvider.postComment
      ? async (key: string, body: string): Promise<{ url?: string; body: string }> => issueProvider.postComment?.(key, body) ?? { body }
      : undefined,
    postComment: issueProvider.postComment
      ? async (key: string, body: string): Promise<{ url?: string; body: string }> => issueProvider.postComment?.(key, body) ?? { body }
      : undefined,
    fetchOpenIssues: issueProvider.fetchOpenIssues
      ? async (limit?: number): Promise<UnifiedIssue[]> => issueProvider.fetchOpenIssues?.(limit) ?? []
      : undefined,
    searchIssues: issueProvider.searchIssues
      ? async (params): Promise<UnifiedIssue[]> => issueProvider.searchIssues?.(params) ?? []
      : undefined,
    addIssueTags: issueProvider.addIssueTags
      ? async (ref: string, tags: string[]): Promise<UnifiedIssue | void> => issueProvider.addIssueTags?.(ref, tags)
      : undefined,
    removeIssueTags: issueProvider.removeIssueTags
      ? async (ref: string, tags: string[]): Promise<UnifiedIssue | void> => issueProvider.removeIssueTags?.(ref, tags)
      : undefined,
    moveIssuesToActiveSprint: issueProvider.moveIssuesToActivePlanningLane
      ? async (input): Promise<JiraSprintMoveResult> => {
        const moved = await issueProvider.moveIssuesToActivePlanningLane?.({
          issueRefs: input.issueKeys,
          laneId: input.sprintId === undefined ? undefined : String(input.sprintId),
          projectKey: input.projectKey,
        });
        const sprintId = Number(moved?.laneId);
        return {
          issueKeys: input.issueKeys,
          sprintId: Number.isFinite(sprintId) ? sprintId : 0,
          sprintName: moved?.laneName,
          boardId: input.boardId,
        };
      }
      : undefined,
  } as IssueTrackerIntegration;
}

function normalizeCodeCollaborationIntegration(
  provider: CodeCollaborationIntegration | CodeCollaborationProvider | undefined,
): CodeCollaborationIntegration | undefined {
  if (!provider) return undefined;
  if ("findPullRequests" in provider && typeof provider.findPullRequests === "function") {
    return provider as CodeCollaborationIntegration;
  }
  const collaborationProvider = provider as CodeCollaborationProvider;
  return {
    ...provider,
    async findPullRequests(repo: string, headRefName?: string): Promise<PullRequestStatus[]> {
      return (await collaborationProvider.findCodeReviews(repo, headRefName)).map(pullRequestStatusFromUnified);
    },
    getPullRequest: collaborationProvider.getCodeReview
      ? async (repo: string, number: number): Promise<PullRequestStatus | undefined> => {
        const review = await collaborationProvider.getCodeReview?.(repo, number);
        return review ? pullRequestStatusFromUnified(review) : undefined;
      }
      : undefined,
    createPullRequest: collaborationProvider.createCodeReview
      ? async (input): Promise<PullRequestStatus> => {
        const review = await collaborationProvider.createCodeReview?.({
          repo: input.repo,
          title: input.title,
          body: input.body,
          sourceBranch: input.headRefName,
          targetBranch: input.baseRefName,
          draft: input.isDraft,
        });
        if (!review) throw new Error("Code review provider did not return a created review.");
        return pullRequestStatusFromUnified(review);
      }
      : undefined,
    markPullRequestReadyForReview: collaborationProvider.markReadyForReview
      ? async (repo: string, number: number): Promise<PullRequestStatus | undefined> => {
        const review = await collaborationProvider.markReadyForReview?.(repo, number);
        return review ? pullRequestStatusFromUnified(review) : undefined;
      }
      : undefined,
    postPullRequestComment: collaborationProvider.postReviewComment
      ? async (repo: string, number: number, body: string): Promise<{ url?: string; body: string }> =>
        collaborationProvider.postReviewComment?.(repo, number, body) ?? { body }
      : undefined,
    mergePullRequest: collaborationProvider.mergeCodeReview
      ? async (repo: string, number: number, options): Promise<PullRequestMergeResult> => {
        const merged = await collaborationProvider.mergeCodeReview?.(repo, number, options);
        return {
          mergeCommitSha: merged?.sha,
        };
      }
      : undefined,
  } as CodeCollaborationIntegration;
}

function gitStatusFromUnified(status: UnifiedWorkspaceStatus): GitRepoStatus {
  return {
    branch: status.branch,
    headSha: status.headSha,
    dirty: status.dirty,
    entries: status.entries,
    worktreePath: status.worktreePath,
  };
}

function jiraIssueFromUnified(issue: UnifiedIssue): JiraIssue {
  return {
    key: issue.ref,
    summary: issue.title,
    issueType: issue.type,
    status: issue.status,
    statusCategory: issue.statusCategory,
    resolution: issue.resolution,
    assignee: issue.assignee,
    updated: issue.updatedAt,
    labels: issue.labels,
    url: issue.url,
    source: "unified",
    raw: issue.raw,
  } as NormalizedIssueTrackerIssue;
}

function pullRequestStatusFromUnified(review: UnifiedCodeReview): PullRequestStatus {
  return {
    repo: review.repo,
    number: typeof review.id === "number" ? review.id : Number(review.id),
    title: review.title,
    url: review.url,
    headRefName: review.sourceBranch,
    state: review.state ?? (review.isMerged ? "MERGED" : review.isClosed ? "CLOSED" : "OPEN"),
    mergedAt: review.mergedAt,
    mergeCommitSha: review.mergeCommitSha,
    isDraft: review.isDraft,
    mergeable: review.mergeableState === "clean"
      ? "MERGEABLE"
      : review.mergeableState === "conflicting"
        ? "CONFLICTING"
        : undefined,
    reviewDecision: review.reviewDecision,
    templateMissingHeadings: review.templateMissingHeadings,
    checksPassing: review.checksPassing,
    autoReviewStatus: review.autoReviewStatus as PullRequestStatus["autoReviewStatus"],
    autoReviewMustFix: review.autoReviewMustFix,
    autoReviewMustFixDetail: review.autoReviewMustFixDetail,
    autoReviewNeedsConfirmation: review.autoReviewNeedsConfirmation,
    autoReviewNeedsConfirmationDetail: review.autoReviewNeedsConfirmationDetail,
  };
}

function hasRecordedEvidence(issue: WorkItem): boolean {
  const metadata = issue.metadata;
  if (metadata.evidenceRecorded === true) return true;
  if (typeof metadata.evidenceRecorded === "string" && metadata.evidenceRecorded.toLowerCase() === "true") return true;
  if (metadata["workflow.acceptance.status"] === "recorded") return true;
  if (metadata["workflow.acceptance.jira_written"] === true) return true;
  return false;
}

function hasRecordedDocumentation(issue: WorkItem): boolean {
  const metadata = issue.metadata;
  if (metadata.documentationRecorded === true) return true;
  if (typeof metadata.documentationRecorded === "string" && metadata.documentationRecorded.toLowerCase() === "true") return true;
  if (metadata["workflow.documentation.status"] === "recorded") return true;
  if (typeof metadata.documentationDisposition === "string" && metadata.documentationDisposition.length > 0) return true;
  return false;
}

function issueTrackerCanPostComments(
  provider: IssueTrackerIntegration | undefined,
): provider is IssueTrackerIntegration & Required<Pick<JiraInspector, "postIssueComment">> {
  return Boolean(provider?.postIssueComment && provider.capabilities?.canPostComments !== false);
}

function collaborationCanMarkReady(
  provider: CodeCollaborationIntegration | undefined,
): provider is CodeCollaborationIntegration & Required<Pick<GitHubInspector, "markPullRequestReadyForReview">> {
  return Boolean(provider?.markPullRequestReadyForReview && provider.capabilities?.canMarkReady !== false);
}

function collaborationRequiresCodeReview(provider: CodeCollaborationIntegration | undefined): boolean {
  return provider?.capabilities?.requiresCodeReview !== false;
}

function collaborationCanPostComments(
  provider: CodeCollaborationIntegration | undefined,
): provider is CodeCollaborationIntegration & Required<Pick<GitHubInspector, "postPullRequestComment">> {
  return Boolean(provider?.postPullRequestComment && provider.capabilities?.canPostComments !== false);
}

function collaborationCanMerge(
  provider: CodeCollaborationIntegration | undefined,
): provider is CodeCollaborationIntegration & Required<Pick<GitHubInspector, "mergePullRequest">> {
  return Boolean(provider?.mergePullRequest && provider.capabilities?.canMerge !== false);
}

function reviewMetadata(issue: WorkItem) {
  const metadata = issue.metadata;
  if (!metadata.prUrl) return undefined;
  const needsConfirmationDisposition = parseNeedsConfirmationDisposition(
    metadata.prAutoReviewNeedsConfirmationDisposition,
  );
  return {
    prUrl: String(metadata.prUrl),
    state: typeof metadata.prState === "string" ? metadata.prState : undefined,
    mergedAt: typeof metadata.prMergedAt === "string" ? metadata.prMergedAt : undefined,
    isDraft: metadata.prIsDraft === true,
    mergeable: typeof metadata.prMergeable === "string" ? metadata.prMergeable : undefined,
    mergeStateStatus: typeof metadata.prMergeStateStatus === "string" ? metadata.prMergeStateStatus : undefined,
    checksPassing: metadata.prChecksPassing === undefined ? undefined : metadata.prChecksPassing === true,
    templateMissingHeadings: metadataStringArray(metadata.prTemplateMissingHeadings),
    autoReviewStatus: typeof metadata.prAutoReviewStatus === "string" ? metadata.prAutoReviewStatus : undefined,
    autoReviewMustFix: metadata.prAutoReviewMustFix === true,
    autoReviewMustFixDetail:
      typeof metadata.prAutoReviewMustFixDetail === "string"
        ? metadata.prAutoReviewMustFixDetail
        : undefined,
    autoReviewNeedsConfirmation: metadata.prAutoReviewNeedsConfirmation === true,
    autoReviewNeedsConfirmationDetail:
      typeof metadata.prAutoReviewNeedsConfirmationDetail === "string"
        ? metadata.prAutoReviewNeedsConfirmationDetail
        : undefined,
    autoReviewNeedsConfirmationDisposition: needsConfirmationDisposition,
    autoReviewNeedsConfirmationPostedUrl:
      typeof metadata.prAutoReviewNeedsConfirmationPostedUrl === "string"
        ? metadata.prAutoReviewNeedsConfirmationPostedUrl
        : undefined,
    checkedAt: typeof metadata.prRecordedAt === "string" ? metadata.prRecordedAt : undefined,
    humanReviewRequired: metadata.humanReviewRequired === true,
    reviewDecision: typeof metadata.prReviewDecision === "string" ? metadata.prReviewDecision : undefined,
    reviewCommentCount: metadataNumber(metadata.prReviewCommentCount),
    reviewCommentAuthors: metadataStringArray(metadata.prReviewCommentAuthors),
  };
}

function isPullRequestMetadataMerged(review: NonNullable<ReturnType<typeof reviewMetadata>>): boolean {
  return review.state?.toUpperCase() === "MERGED" || Boolean(review.mergedAt);
}

function isPullRequestStatusMerged(pr: PullRequestStatus): boolean {
  return pr.state?.toUpperCase() === "MERGED" || Boolean(pr.mergedAt);
}

function closeoutPullRequestTarget(
  issue: WorkItem,
  repoNameFallback: (repoKey: string) => string,
): { repo: string; number: number; url?: string } | undefined {
  const snapshots = collectPullRequestSnapshots(issue.metadata, issue.repoKeys, repoNameFallback);
  const selected = selectPullRequestForGate(snapshots);
  const repo = selected?.repo ?? (selected?.url ? repoFromPullRequestUrl(selected.url) : undefined);
  const number = selected?.number;
  if (!repo || typeof number !== "number" || !Number.isFinite(number)) return undefined;
  return { repo, number, url: selected?.url };
}

function pullRequestCloseoutBlockers(issue: WorkItem, pr: PullRequestStatus): string[] {
  if (isPullRequestStatusMerged(pr)) return [];
  const blockers: string[] = [];
  if (pr.isDraft) blockers.push("Pull request is still draft.");
  if (pr.reviewDecision !== "APPROVED") blockers.push("Pull request approval review is missing.");
  if (pr.checksPassing !== true) blockers.push("Pull request checks are not passing.");
  if (isPullRequestConflicted(pr)) blockers.push("Pull request is not mergeable.");
  if (pr.templateMissingHeadings && pr.templateMissingHeadings.length > 0) {
    blockers.push(`Pull request template is missing headings: ${pr.templateMissingHeadings.join(", ")}.`);
  }
  if (pr.autoReviewStatus === "failed") blockers.push("Auto-review check is failing.");
  if (pr.autoReviewStatus === "pending") blockers.push("Auto-review check is still pending.");
  if (pr.autoReviewMustFix === true) blockers.push("Auto-review must-fix feedback is unresolved.");
  if (
    pr.autoReviewNeedsConfirmation === true &&
    issue.metadata.prAutoReviewNeedsConfirmationDisposition !== "accept" &&
    typeof issue.metadata.prAutoReviewNeedsConfirmationPostedUrl !== "string"
  ) {
    blockers.push("Auto-review confirmation is unresolved.");
  }
  return blockers;
}

function doctorNextAction(
  issue: WorkItem,
  findings: ReadinessFinding[],
  visibility: FlowDoctorResult["visibility"],
): FlowDoctorResult["nextAction"] {
  if (isFlowTerminal(issue)) {
    return {
      type: "done",
      summary: "The issue is complete: issue tracker state is done and required code review is complete.",
    };
  }
  const blockerSummaries = findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => finding.summary);
  if (!visibility.repoRouting) {
      return {
        type: "route_issue",
        command: `flow '{"op":"issue","mode":"route","id":"${issue.ref}","repoKeys":["<repo_key>"]}'`,
        summary: "Route the issue to a component repo, then rerun Flow.",
      };
  }
  if (blockerSummaries.includes("Prepared worktree is missing.")) {
    if (visibility.codeReview) {
      const repoKey = issue.repoKeys[0] ?? "<repo_key>";
      const branch = existingString(issue.metadata[`workflow.repos.${repoKey}.branch`]) ??
        existingString(issue.metadata.prHeadRefName) ??
        existingString(issue.metadata.branch);
      const pathHint = branch ? `<path-to-worktree-for-${branch.replace(/\//g, "-")}>` : "<worktree_path>";
      return {
        type: "adopt_workspace",
        command: `flow '{"op":"issue","mode":"adoptWorkspace","id":"${issue.ref}","repoKey":"${repoKey}","worktreePath":"${pathHint}"}'`,
        summary: "Adopt the existing code review worktree into Flow, or let Flow prepare a new routed workspace.",
      };
    }
    return {
      type: "prepare_workspace",
      command: `flow '{"op":"workflow","mode":"advance","id":"${issue.ref}"}'`,
      summary: "Let Flow prepare the routed workspace or approve the prepare-workspace confirmation.",
    };
  }
  if (
    blockerSummaries.includes("Auto review has must-fix feedback.") ||
    blockerSummaries.includes("Auto review checks failed.")
  ) {
    return {
      type: "remediate_review",
      command: `flow '{"op":"workflow","mode":"advance","id":"${issue.ref}"}'`,
      summary: "Remediate code review feedback through the normal Flow advance path.",
    };
  }
  if (
    blockerSummaries.includes("Auto review requires confirmation.") ||
    blockerSummaries.includes("Auto review confirmation has not been posted to the code review.")
  ) {
    return {
      type: "record_review_confirmation",
      summary: "Review the auto-review confirmation item, then record the confirmation through Flow.",
    };
  }
  if (blockerSummaries.includes("Pull request checks are not passing.")) {
    return {
      type: "fix_checks",
      summary: "Inspect failing code review checks and remediate through the review worktree.",
    };
  }
  if (findings.some((finding) => finding.summary === "Approval review is required.")) {
    if (findings.some((finding) => finding.summary === "Review comments are present.")) {
      return {
        type: "address_review_comments",
        summary: "Inspect and address any actionable code review comments, then request an approval review.",
      };
    }
    return {
      type: "wait_for_approval_review",
      summary: "The code review is waiting for an approval review; review comments alone do not satisfy approval-required review policy.",
    };
  }
  if (visibility.codeReview) {
    return {
      type: "advance",
      command: `flow '{"op":"workflow","mode":"advance","id":"${issue.ref}"}'`,
      summary: "Flow can continue from the reconciled code review state.",
    };
  }
  return {
    type: "advance",
    command: `flow '{"op":"workflow","mode":"advance","id":"${issue.ref}"}'`,
    summary: "Run Flow advance to choose the next valid workflow action.",
  };
}

function isFlowTerminal(issue: WorkItem): boolean {
  const review = reviewMetadata(issue);
  const pullRequestMerged = !review?.prUrl || isPullRequestMetadataMerged(review);
  return isIssueTrackerDone(issue) && pullRequestMerged;
}

function isIssueTrackerDone(issue: WorkItem): boolean {
  return isJiraDone({
    key: issue.ref,
    summary: issue.title,
    issueType: "Task",
    status: issueTrackerStatus(issue),
    statusCategory: issueTrackerStatusCategory(issue),
    resolution: issueTrackerResolution(issue),
    labels: [],
  });
}

function issueTrackerStatus(issue: WorkItem): string | undefined {
  return existingString(issue.metadata.issueStatus) ??
    existingString(issue.metadata.localStatus) ??
    existingString(issue.metadata.jiraStatus);
}

function issueTrackerStatusCategory(issue: WorkItem): string | undefined {
  return existingString(issue.metadata.issueStatusCategory) ??
    existingString(issue.metadata.localStatusCategory) ??
    existingString(issue.metadata.jiraStatusCategory);
}

function issueTrackerResolution(issue: WorkItem): string | undefined {
  return existingString(issue.metadata.issueResolution) ??
    existingString(issue.metadata.jiraResolution);
}

function selectedWorkflowState(issueState: WorkItem["state"], existingState?: WorkItem["state"]): WorkItem["state"] {
  if (issueState === "awaiting_review" || issueState === "awaiting_human" || issueState === "done") return issueState;
  if (
    issueState === "queued" &&
    (existingState === "awaiting_review" || existingState === "awaiting_human" || existingState === "done")
  ) {
    return existingState;
  }
  return "selected";
}

function dashboardWorkflowState(issue: WorkItem, selectedIssueRef?: string): WorkItem["state"] {
  if (!selectedIssueRef) return issue.state === "selected" ? "queued" : issue.state;
  if (issue.ref === selectedIssueRef) return "selected";
  if (issue.state === "selected") return "queued";
  return issue.state;
}

function dashboardWorkStatus(input: {
  issue: WorkItem;
  selectedIssueRef?: string;
  activeWorkerRun?: WorkerRunRecord;
  latestWorkerResult?: WorkerTaskResult;
  review?: ReturnType<typeof reviewMetadata>;
  reviewReady: boolean;
  evidenceRecorded: boolean;
  documentationRecorded: boolean;
}): { label: string; detail?: string } {
  const { issue, selectedIssueRef, activeWorkerRun, latestWorkerResult, review } = input;
  if (activeWorkerRun) {
    return {
      label: "Running",
      detail: `Active handoff ${activeWorkerRun.taskId} is ${activeWorkerRun.status}.`,
    };
  }
  if (review && isPullRequestMetadataMerged(review)) {
    return {
      label: "Done",
      detail: `Pull request ${pullRequestDisplayRef(review.prUrl)} is merged.`,
    };
  }
  if (issue.state === "done") {
    return {
      label: "Done",
      detail: "Flow has marked the issue complete.",
    };
  }
  if (latestWorkerResult?.status === "blocked" || latestWorkerResult?.status === "failed") {
    return {
      label: "Blocked",
      detail: `Latest handoff result ${latestWorkerResult.taskId} is ${latestWorkerResult.status}.`,
    };
  }
  if (review?.humanReviewRequired === true || review?.autoReviewNeedsConfirmation === true) {
    return {
      label: "Needs Input",
      detail: "Code review requires human input.",
    };
  }
  if (review) {
    return {
      label: "In Review",
      detail: `Pull request ${pullRequestDisplayRef(review.prUrl)} is open.`,
    };
  }
  if (latestWorkerResult?.status === "succeeded") {
    return {
      label: "Ready",
      detail: `Latest handoff result ${latestWorkerResult.taskId} succeeded.`,
    };
  }
  if (input.reviewReady) {
    return {
      label: "Ready",
      detail: "Readiness checks say the issue is ready for review.",
    };
  }
  if (input.evidenceRecorded && input.documentationRecorded) {
    return {
      label: "Ready",
      detail: "Evidence and documentation are recorded.",
    };
  }
  const workflowState = dashboardWorkflowState(issue, selectedIssueRef);
  if (workflowState === "selected") {
    return {
      label: "Active",
      detail: "Selected in the requested Flow session.",
    };
  }
  if (workflowState === "running") {
    return {
      label: "Running",
      detail: "Flow issue state is running.",
    };
  }
  if (workflowState === "blocked") {
    return {
      label: "Blocked",
      detail: "Flow issue state is blocked.",
    };
  }
  if (workflowState === "awaiting_human") {
    return {
      label: "Needs Input",
      detail: "Flow issue state is waiting for human input.",
    };
  }
  if (workflowState === "awaiting_review") {
    return {
      label: "Ready",
      detail: "Flow issue state is ready for review; no pull request is recorded yet.",
    };
  }
  if (workflowState === "ready_to_run") {
    return {
      label: "Ready",
      detail: "Flow issue state is ready to run.",
    };
  }
  return {
    label: dashboardWorkStatusLabel(workflowState),
    detail: "No active handoff, result, or pull request is recorded.",
  };
}

function dashboardWorkStatusLabel(state: WorkItem["state"]): string {
  if (state === "queued") return "Queued";
  if (state === "selected") return "Active";
  if (state === "ready_to_run") return "Ready";
  if (state === "running") return "Running";
  if (state === "blocked") return "Blocked";
  if (state === "awaiting_review") return "In Review";
  if (state === "awaiting_human") return "Needs Input";
  if (state === "done") return "Done";
  return "Unknown";
}

function pullRequestDisplayRef(url: string): string {
  const match = /\/pull\/(\d+)(?:$|[/?#])/.exec(url);
  return match ? `#${match[1]}` : "record";
}

function dashboardRepositoryLabel(repoKey: string): string {
  return repoKey.trim() || "Unknown";
}

function dashboardBlockerLabel(blocker: string): string {
  const value = blocker.trim();
  if (!value) return "Blocked";
  if (/worktree/i.test(value)) return "Local setup not ready.";
  if (/pull request is missing/i.test(value)) return "Pull request missing.";
  return value;
}

function dashboardRecordStatus(recorded: boolean): string {
  return recorded ? "Present" : "Needed";
}

function dashboardRelativeTime(value: unknown): string | undefined {
  const raw = existingString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function dashboardPullRequestStatus(isDraft: unknown, checksPassing: unknown): string {
  const parts = [isDraft === true ? "Draft" : isDraft === false ? "Ready" : "Present"];
  if (checksPassing === true) parts.push("Checks pass");
  if (checksPassing === false) parts.push("Checks fail");
  return parts.join(" - ");
}

function dashboardReviewStatus(decision: unknown, humanReviewRequired: boolean): string {
  const value = existingString(decision)?.toUpperCase() ?? "";
  if (value === "APPROVED") return "Approved";
  if (value === "CHANGES_REQUESTED") return "Changes requested";
  if (value === "REVIEW_REQUIRED") return "Review required";
  if (value === "COMMENTED" || value === "REVIEWED") return "Reviewed";
  if (value) return "Review updated";
  return humanReviewRequired ? "Review required" : "Pending";
}

function isJiraIssueTrackerIssue(issue: JiraIssue): boolean {
  return (issue as { source?: unknown }).source !== "unified";
}

function isLocalIssueTrackerIssue(issue: JiraIssue): boolean {
  const raw = (issue as { raw?: unknown }).raw;
  const url = existingString((issue as { url?: unknown }).url);
  return Boolean(
    raw && typeof raw === "object" && (raw as { provider?: unknown }).provider === "local"
  ) || Boolean((issue as { source?: unknown }).source === "unified" && url?.startsWith("flow://local/"));
}

function providerNeutralExistingMetadata(metadata: WorkItem["metadata"] | undefined): WorkItem["metadata"] {
  if (!metadata) return {};
  const {
    jiraStatus: _jiraStatus,
    jiraIssueType: _jiraIssueType,
    jiraLabels: _jiraLabels,
    jiraStatusCategory: _jiraStatusCategory,
    jiraResolution: _jiraResolution,
    jiraUpdated: _jiraUpdated,
    jiraUrl: _jiraUrl,
    ...neutralMetadata
  } = metadata;
  return neutralMetadata;
}

function isJiraCloseoutStatus(issue: JiraIssue): boolean {
  const status = issue.status?.toLowerCase();
  return isJiraDone(issue) || status === "ready for qa";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoReviewConfirmationMetadata(
  repo: string,
  record: {
    disposition: ReviewConfirmationDisposition;
    summary: string;
    evidence?: string;
    verification?: string;
    postedUrl?: string;
    recordedAt: string;
  },
): Record<string, unknown> {
  const prefix = `workflow.repos.${normalizeRepoKey(repo)}.pr`;
  return {
    [`${prefix}_auto_review_needs_confirmation_disposition`]: record.disposition,
    [`${prefix}_auto_review_needs_confirmation_summary`]: record.summary,
    [`${prefix}_auto_review_needs_confirmation_evidence`]: record.evidence ?? "",
    [`${prefix}_auto_review_needs_confirmation_verification`]: record.verification ?? "",
    [`${prefix}_auto_review_needs_confirmation_posted_url`]: record.postedUrl ?? "",
    [`${prefix}_auto_review_needs_confirmation_recorded_at`]: record.recordedAt,
  };
}

function formatReviewConfirmationComment(
  issue: WorkItem,
  record: Omit<ReviewConfirmationRecord, "recordedAt" | "githubCommentUrl">,
): string {
  const lines = [
    `Addressing the auto-review confirmation question for ${issue.ref}:`,
    "",
    record.summary.trim(),
  ];
  if (record.evidence) {
    lines.push("", record.evidence.trim());
  }
  if (record.verification) {
    lines.push("", "Verification run:", "", "```bash", record.verification.trim(), "```");
  }
  return lines.join("\n");
}

function formatAcceptanceWritebackComment(
  issue: WorkItem,
  review: NonNullable<ReturnType<typeof reviewMetadata>>,
): string {
  const criteria = acceptanceCriteria(issue);
  const lines = [
    "Acceptance evidence recorded for PR closeout.",
    "",
    `PR: ${review.prUrl}`,
    review.mergedAt ? `Merged: ${review.mergedAt}` : undefined,
    "",
    "Acceptance evidence:",
  ].filter((line): line is string => typeof line === "string");
  if (criteria.length > 0) {
    for (const item of criteria) {
      lines.push(`- ${item.label}: ${item.evidence}${item.source ? ` (${item.source})` : ""}`);
    }
  } else {
    lines.push(`- ${String(issue.metadata.evidenceSummary ?? "Evidence recorded in Flow.")}`);
  }
  const source = typeof issue.metadata.evidenceSource === "string" ? issue.metadata.evidenceSource : "";
  if (source) lines.push("", `Source: ${source}`);
  return lines.join("\n");
}

function acceptanceWritebackPayload(issue: WorkItem, review: NonNullable<ReturnType<typeof reviewMetadata>>) {
  return {
    issueRef: issue.ref,
    prUrl: review.prUrl,
    mergedAt: review.mergedAt ?? "",
    evidenceSummary: issue.metadata.evidenceSummary ?? "",
    evidenceSource: issue.metadata.evidenceSource ?? "",
    criteria: acceptanceCriteria(issue),
  };
}

function acceptanceCriteria(issue: WorkItem): AcceptanceCriterionEvidence[] {
  const raw = issue.metadata.evidenceCriteria ?? issue.metadata["workflow.acceptance.criteria_json"];
  if (Array.isArray(raw)) return raw.filter(isAcceptanceCriterionEvidence);
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isAcceptanceCriterionEvidence) : [];
  } catch {
    return [];
  }
}

function isAcceptanceCriterionEvidence(value: unknown): value is AcceptanceCriterionEvidence {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.label === "string" && record.label.length > 0 &&
    typeof record.evidence === "string" && record.evidence.length > 0 &&
    (record.status === undefined || record.status === "passed" || record.status === "failed" || record.status === "not_applicable") &&
    (record.source === undefined || typeof record.source === "string");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseNeedsConfirmationDisposition(value: unknown): "accept" | "reject" | "defer" | undefined {
  if (value === "accept" || value === "reject" || value === "defer") return value;
  return undefined;
}

function blockedFindingsMessage(
  sessionId: string,
  issue: WorkItem,
  findings: ReadinessFinding[],
  latestWorker?: WorkerTaskResult,
): string {
  const findingParts = findings.map((finding) => {
    const detail = typeof finding.detail === "string" ? finding.detail.trim() : "";
    return detail ? `${finding.summary} (${detail})` : finding.summary;
  }).filter(Boolean);
  const parts = [...findingParts];
  if (
    latestWorker &&
    (latestWorker.status === "blocked" || latestWorker.status === "failed") &&
    !isObsoleteSatisfiedPrWorkerResult(latestWorker, issue)
  ) {
    const nextPickup = latestWorker.nextPickup?.trim();
    if (nextPickup) parts.push(`Next action: ${nextPickup}`);
    const handoffPrompt = latestWorker.handoffPrompt?.trim() ?? buildLegacyLiveWorkerHandoffPrompt(sessionId, issue, latestWorker);
    if (handoffPrompt) parts.push(`Copy-ready handoff prompt:\n${handoffPrompt}`);
  }
  return parts.join("\n\n");
}

function isObsoleteSatisfiedPrWorkerResult(result: WorkerTaskResult, issue: WorkItem): boolean {
  if (issue.metadata.prIsDraft !== false) return false;
  const text = `${result.taskId} ${result.summary} ${result.nextPickup ?? ""} ${result.handoffPrompt ?? ""}`.toLowerCase();
  return text.includes("undraft") || text.includes("ready-for-review") || text.includes("ready for review");
}

function liveWorkerAdoptionSummary(adopter?: string): string {
  return adopter ? `Live agent thread adopted execution handoff (${adopter}).` : "Live agent thread adopted execution handoff.";
}

function isExecutionHandoffAction(action: string | undefined): boolean {
  return action === "request_execution";
}

function branchKindFromJiraIssueType(issueType: unknown): BranchKind | undefined {
  const normalized = String(issueType ?? "").toLowerCase();
  if (normalized === "bug") return "bug";
  if (normalized === "story" || normalized === "task") return "feature";
  return undefined;
}

function branchKindFromBranch(branch: string): BranchKind {
  return /^bug(?:\/|-)/i.test(branch) ? "bug" : "feature";
}

function existingBranchKind(issue?: WorkItem): BranchKind | undefined {
  const normalized = String(issue?.metadata.branchKind ?? "").toLowerCase();
  if (normalized === "bug" || normalized === "feature") return normalized;
  return undefined;
}

function titleFromBranch(branch: string): string {
  const leaf = branch.split("/").filter(Boolean).at(-1) ?? branch;
  return leaf.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || branch;
}

function localIssueUrl(ref: string): string {
  return `flow://local/issues/${encodeURIComponent(ref)}`;
}

function normalizeLocalRefPrefix(prefix: string): string {
  const normalized = prefix.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "FLOW";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

function buildWorkerPrompt(issue: WorkItem, repoKey: string): string {
  const workspacePath = worktreePathForRepo(issue, repoKey);
  const branch = branchForRepo(issue, repoKey);
  return [
    "Use Flow to work this prompt.",
    "",
    `Issue: ${issue.ref}`,
    `Title: ${issue.title}`,
    `Repo key: ${repoKey}`,
    issue.summary ? `Context: ${issue.summary}` : undefined,
    workspacePath ? `Prepared workspace: ${workspacePath}` : undefined,
    branch ? `Branch: ${branch}` : undefined,
    "",
    "Instructions: Make the code changes, run tests, commit with a descriptive message, and push the branch.",
  ].filter(Boolean).join("\n");
}

function buildReviewRemediationWorkerPrompt(
  issue: WorkItem,
  repoKey: string,
  findings: ReadinessFinding[],
): string {
  return [
    "Use Flow to work this prompt.",
    "",
    `Issue: ${issue.ref}`,
    `Title: ${issue.title}`,
    `Repo key: ${repoKey}`,
    worktreePathForRepo(issue, repoKey) ? `Prepared workspace: ${worktreePathForRepo(issue, repoKey)}` : undefined,
    branchForRepo(issue, repoKey) ? `Branch: ${branchForRepo(issue, repoKey)}` : undefined,
    "",
    "Prompt: address these review findings.",
    ...findings.map((finding, index) =>
      [
        `${index + 1}. ${finding.summary}`,
        finding.detail ? finding.detail : undefined,
      ].filter(Boolean).join("\n")
    ),
  ].filter(Boolean).join("\n");
}

function buildLegacyLiveWorkerHandoffPrompt(
  sessionId: string,
  issue: WorkItem,
  result: WorkerTaskResult,
): string | undefined {
  const repoKey = result.repoKey || issue.repoKeys[0];
  if (!repoKey) return undefined;
  const request: WorkerTaskRequest = {
    id: result.taskId,
    issueRef: result.issueRef,
    repoKey,
    prompt: buildWorkerPrompt(issue, repoKey),
    workspacePath: worktreePathForRepo(issue, repoKey),
    createdAt: result.completedAt,
  };
  return buildLiveWorkerHandoffPrompt(sessionId, request, result);
}

function buildLiveWorkerHandoffPrompt(
  sessionId: string,
  request: WorkerTaskRequest,
  result: Pick<WorkerTaskResult, "status" | "summary" | "blockers">,
): string {
  const blockers = result.blockers.length ? result.blockers.map((blocker) => `- ${blocker}`).join("\n") : "- No structured blocker was recorded.";
  return [
    "Use Flow to work this prompt.",
    "",
    "Flow context:",
    `- Flow session: ${sessionId}`,
    `- Handoff: ${request.id}`,
    `- Repo key: ${request.repoKey}`,
    request.workspacePath ? `- Last known worktree: ${request.workspacePath}` : "- Last known worktree: missing",
    `- Prior status: ${result.status}`,
    `- Prior summary: ${result.summary}`,
    "- Prior blockers:",
    blockers,
    "",
    "Requested work:",
    "```text",
    request.prompt,
    "```",
  ].join("\n");
}

function threadTitleForHandoff(request: Pick<WorkerTaskRequest, "issueRef" | "prompt">): string {
  const title = request.prompt.match(/^Title:\s*(.+)$/m)?.[1] ?? request.issueRef;
  const shortDescription = title
    .replace(/\b[A-Z]+-\d+\b/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
  return `${shortDescription || "Flow work"} ${request.issueRef}`.trim();
}

function worktreePathForRepo(issue: WorkItem, repoKey: string): string | undefined {
  const normalized = normalizeRepoKey(repoKey);
  return existingString(issue.metadata[`workflow.repos.${normalized}.worktree_path`]) ??
    existingString(issue.metadata.work_dir) ??
    existingString(issue.metadata.worktree_path);
}

function branchForRepo(issue: WorkItem, repoKey: string): string | undefined {
  const normalized = normalizeRepoKey(repoKey);
  return existingString(issue.metadata[`workflow.repos.${normalized}.branch`]) ??
    existingString(issue.metadata.branch);
}

function isJiraDone(issue: JiraIssue): boolean {
  const category = issue.statusCategory?.toLowerCase();
  const status = issue.status?.toLowerCase();
  const resolution = issue.resolution?.toLowerCase();
  return category === "done" || status === "closed" || status === "done" || resolution === "done";
}

function workJobResultFromWorkerResult(job: WorkJob, result: WorkerTaskResult): WorkJobResult {
  return workJobResultSchema.parse({
    jobId: job.id,
    issueRef: result.issueRef,
    repoKey: result.repoKey,
    workType: job.workType,
    status: result.status,
    summary: result.summary,
    evidence: [...result.changedFiles, ...result.testsRun],
    workerResult: result,
    completedAt: result.completedAt,
  });
}

function isTerminalWorkJobStatus(status: WorkJob["status"]): boolean {
  return (terminalWorkJobStatusValues as readonly string[]).includes(status);
}

function stringFromRecord(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
