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
import { join } from "pathe";
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
} from "./adapters/provider-contracts.js";
import { assessIssue } from "./readiness.js";
import type { WorkflowLedger } from "./ledger.js";
import { FlowStore } from "./store.js";
import type { WorkerSpawner } from "./worker.js";
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
  store: FlowStore;
  ledger: WorkflowLedger;
  topology?: ProjectTopology;
  sourceControl?: SourceControlIntegration | SourceControlProvider;
  collaboration?: CodeCollaborationIntegration | CodeCollaborationProvider;
  issueTracker?: IssueTrackerIntegration | IssueTrackerProvider;
  workTypes?: WorkTypeRegistry;
  executors?: ExecutorAdapter[];
  /** @deprecated Use sourceControl. */
  git?: GitInspector;
  /** @deprecated Use collaboration. */
  github?: GitHubInspector;
  /** @deprecated Use issueTracker. */
  jira?: JiraInspector;
  projectRoot?: string;
  defaultJiraProjectKey?: string;
  autoflowBlockedThreshold?: number;
  workerTimeoutMs?: number;
  debugEnabled?: boolean;
  readiness?: ReadinessEvaluator;
}
export interface ReadinessEvaluator {
  assess(input: Parameters<typeof assessIssue>[0]): ReturnType<typeof assessIssue> | Promise<ReturnType<typeof assessIssue>>;
}

export interface DashboardQueueIssue {
  ref: string;
  title: string;
  workflowState: WorkItem["state"];
  issueStatus?: string;
  issueUrl: string;
  repoKeys: string[];
  branch?: string;
  headSha?: string;
  worktreePath?: string;
  prUrl?: string;
  prIsDraft?: boolean;
  prChecksPassing?: boolean;
  prReviewDecision?: string;
  humanReviewRequired?: boolean;
  evidenceRecorded: boolean;
  documentationRecorded: boolean;
  autoflowAttempts: number;
  autoflowAttemptLimit: number;
  autoflowLastAttemptedAt?: string;
  autoflowExhausted: boolean;
  updatedAt?: string;
  blockers: string[];
}

export interface GitInspector {
  inspect(repoPath: string): Promise<GitRepoStatus>;
  prepareWorktree?(plan: WorktreePlan): Promise<GitRepoStatus>;
}

export type SourceControlIntegration = GitInspector & Partial<SourceControlProvider>;

export interface GitHubInspector {
  findPullRequests(repo: string, headRefName?: string): Promise<PullRequestStatus[]>;
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
    summary: string;
    description?: string;
  }): Promise<JiraIssue>;
}

export type IssueTrackerIntegration = JiraInspector & Omit<Partial<IssueTrackerProvider>, "createIssue">;

type EvidenceRecordInput = Omit<EvidenceRecord, "recordedAt" | "criteria"> & {
  criteria?: AcceptanceCriterionEvidence[];
};

export interface AdvanceIssueResult {
  status: "needs_issue" | "needs_confirmation" | "blocked" | "worker_requested" | "awaiting_review";
  session: WorkRuntimeSession;
  issue?: WorkItem;
  message: string;
  workerRequest?: {
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
  autoApproveWorker?: boolean;
  runWorker?: boolean;
  runBackgroundExecutor?: boolean;
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

export interface CreateJiraIssueOptions {
  projectKey?: string;
  issueType?: "Bug" | "Task" | "Story";
  branchKind?: BranchKind;
  summary: string;
  description?: string;
  repoKeys?: string[];
  select?: boolean;
}

export type CreateIssueOptions = CreateJiraIssueOptions;

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
}

export interface FlowDoctorResult {
  issueRef: string;
  status: "ok" | "blocked" | "degraded";
  issue: {
    ref: string;
    title: string;
    state: WorkItem["state"];
    repoKeys: string[];
    jiraStatus?: string;
  };
  visibility: {
    ledger: boolean;
    jira: boolean;
    repoRouting: boolean;
    preparedWorktree: boolean;
    pullRequest: boolean;
  };
  review?: ReturnType<typeof reviewMetadata>;
  findings: ReadinessFinding[];
  nextAction: {
    type: string;
    command?: string;
    summary: string;
  };
}

export class FlowWorkRuntime {
  private readonly store: FlowStore;
  private readonly ledger: WorkflowLedger;
  readonly topology: ProjectTopology;
  private readonly sourceControl: SourceControlIntegration;
  private readonly collaboration?: CodeCollaborationIntegration;
  private readonly issueTracker?: IssueTrackerIntegration;
  private readonly workTypes: WorkTypeRegistry;
  private readonly projectRoot: string;
  private readonly defaultJiraProjectKey?: string;
  private readonly autoflowBlockedThreshold: number;
  private readonly workerTimeoutMs: number;
  private readonly debugEnabled: boolean;
  private readonly readiness: ReadinessEvaluator;
  private readonly reconciliation: ReconciliationEngine;
  private readonly issueMutationQueues = new Map<string, Promise<unknown>>();

  constructor(options: WorkRuntimeOptions) {
    this.store = options.store;
    this.ledger = options.ledger;
    this.topology = options.topology ?? new DefaultProjectTopology();
    this.sourceControl = normalizeSourceControlIntegration(options.sourceControl ?? options.git ?? new GitAdapter());
    this.collaboration = normalizeCodeCollaborationIntegration(options.collaboration ?? options.github);
    this.issueTracker = normalizeIssueTrackerIntegration(options.issueTracker ?? options.jira);
    this.workTypes = options.workTypes ?? createDefaultFlowWorkTypeRegistry();
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.defaultJiraProjectKey = options.defaultJiraProjectKey;
    this.autoflowBlockedThreshold = positiveNumber(options.autoflowBlockedThreshold, 3);
    this.workerTimeoutMs = positiveNumber(options.workerTimeoutMs, 20 * 60 * 1000);
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
      state: "selected",
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
    const session = await this.requireSession(sessionId);
    if (!this.issueTracker?.createIssue) {
      throw new Error("Issue creation is not available in this runtime.");
    }
    if (!options.summary?.trim()) throw new Error("Issue summary is required.");
    const issueType = options.issueType ?? "Bug";
    const createdIssue = await this.issueTracker.createIssue({
      projectKey: options.projectKey ?? this.defaultJiraProjectKey,
      issueType,
      summary: options.summary.trim(),
      description: options.description?.trim(),
    });
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
        jiraIssueType: createdIssue.issueType ?? issueType,
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

  async inspectDashboardQueue(limit = 10): Promise<DashboardQueueIssue[]> {
    const issues = await this.inspectQueue(limit);
    return mapWithConcurrency(issues, workRuntimeQueueConcurrency(), async (issue) => {
      const repoKey = issue.repoKeys[0] ?? "";
      const review = reviewMetadata(issue);
      const workerResults = await this.ledger.listWorkerResults(issue.ref);
      const assessment = await this.readiness.assess({
        issue,
        workerResults,
        evidenceRecorded: hasRecordedEvidence(issue),
        documentationRecorded: hasRecordedDocumentation(issue),
        review,
      });
      const blockers = assessment.findings
        .filter((finding) => finding.severity === "blocker" || finding.severity === "warning")
        .map((finding) => finding.summary);
      const autoflowAttempts = metadataNumber(issue.metadata["workflow.autoflow.attempts"]) ?? 0;
      const autoflowAttemptLimit = this.autoflowBlockedThreshold;
      const activeWorkerRun = await this.latestActiveWorkerRun(issue.ref);
      const workflowState = activeWorkerRun ? "running" : issue.state;
      const autoflowExhausted = blockers.length > 0 && (hasHardAutoflowBlocker(blockers) || autoflowAttempts >= autoflowAttemptLimit);
      return {
        ref: issue.ref,
        title: issue.title,
        workflowState,
        issueStatus: existingString(issue.metadata.jiraStatus),
        issueUrl: existingString(issue.metadata.jiraUrl) ?? "",
        repoKeys: issue.repoKeys,
        branch: repoKey ? branchForRepo(issue, repoKey) : undefined,
        headSha: repoKey ? existingString(issue.metadata[`workflow.repos.${normalizeRepoKey(repoKey)}.head_sha`]) : undefined,
        worktreePath: repoKey ? worktreePathForRepo(issue, repoKey) : undefined,
        prUrl: review?.prUrl,
        prIsDraft: review?.isDraft,
        prChecksPassing: review?.checksPassing,
        prReviewDecision: existingString(issue.metadata.prReviewDecision),
        humanReviewRequired: review?.humanReviewRequired,
        evidenceRecorded: hasRecordedEvidence(issue),
        documentationRecorded: hasRecordedDocumentation(issue),
        autoflowAttempts,
        autoflowAttemptLimit,
        autoflowLastAttemptedAt: existingString(issue.metadata["workflow.autoflow.last_attempted_at"]),
        autoflowExhausted,
        updatedAt: issue.updatedAt,
        blockers,
      };
    });
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
    });
    const preparedWorktree = issue.repoKeys.some((repoKey) => Boolean(worktreePathForRepo(issue, repoKey)));
    const visibility = {
      ledger: true,
      jira: typeof issue.metadata.jiraStatus === "string" || typeof issue.metadata.jiraUpdated === "string",
      repoRouting: issue.repoKeys.length > 0,
      preparedWorktree,
      pullRequest: Boolean(review?.prUrl),
    };
    const blockingFindings = assessment.findings.filter((finding) => finding.severity === "blocker");
    const status = blockingFindings.length > 0 ? "blocked" : visibility.repoRouting && visibility.pullRequest ? "ok" : "degraded";
    return {
      issueRef: issue.ref,
      status,
      issue: {
        ref: issue.ref,
        title: issue.title,
        state: issue.state,
        repoKeys: issue.repoKeys,
        jiraStatus: existingString(issue.metadata.jiraStatus),
      },
      visibility,
      review,
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
      return {
        status: "awaiting_review",
        session: sessionWithFindings,
        issue,
        message: `${issue.ref} is review-ready in Readiness assessment.`,
      };
    }

    const activeWorkerRun = await this.latestActiveWorkerRun(issue.ref);
    if (activeWorkerRun) {
      return {
        status: "blocked",
        session: sessionWithFindings,
        issue,
        message: `Worker is already running for ${issue.ref} (${activeWorkerRun.taskId}).`,
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
      action: "spawn_worker",
      summary: `Spawn a Worker for ${issue.ref} in ${repoKey}.`,
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
    spawner: WorkerSpawner,
    options: AutoFlowIssueOptions = {},
  ): Promise<AutoFlowIssueResult> {
    const maxSteps = options.maxSteps ?? 8;
    const runWorker = options.runWorker ?? options.runBackgroundExecutor ?? false;
    const steps: AdvanceIssueResult[] = [];
    const workerResults: WorkerTaskResult[] = [];
    let last = await this.advanceIssue(sessionId);
    await this.recordAutoflowAttempt(sessionId);
    this.debug("autoflow.start", {
      sessionId,
      maxSteps,
      options: {
        autoPrepareWorkspace: options.autoPrepareWorkspace !== false,
        autoApproveWorker: options.autoApproveWorker === true,
        runWorker,
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
        if (!options.autoApproveWorker) return this.autoFlowResult(last, steps, workerResults);
        this.debug("autoflow.confirmation.approve", { sessionId, step, action, confirmationId });
        last = await this.advanceIssue(sessionId, confirmationId);
        continue;
      }

      if (last.status === "worker_requested") {
        if (!runWorker || !last.workerRequest) return this.autoFlowResult(last, steps, workerResults);
        const workspacePath = (last.issue ? worktreePathForRepo(last.issue, last.workerRequest.repoKey) : undefined) ??
          last.workerRequest.workspacePath;
        if (!workspacePath) {
          const missingWorkspaceResult: WorkerTaskResult = {
            taskId: last.workerRequest.id,
            issueRef: last.workerRequest.issueRef,
            repoKey: last.workerRequest.repoKey,
            status: "blocked",
            summary: `Worker workspace path is missing for ${last.workerRequest.repoKey}.`,
            changedFiles: [],
            testsRun: [],
            blockers: ["Worker workspace path is missing."],
            nextPickup: "Run prepare workspace for the routed repo, then retry advance/autoflow.",
            completedAt: nowIso(),
          };
          await this.recordWorkerResult(sessionId, missingWorkspaceResult);
          workerResults.push(missingWorkspaceResult);
          this.debug("autoflow.worker.blocked_missing_workspace", {
            sessionId,
            step,
            issueRef: missingWorkspaceResult.issueRef,
            repoKey: missingWorkspaceResult.repoKey,
          });
          last = await this.advanceIssue(sessionId);
          continue;
        }
        this.debug("autoflow.worker.run", {
          sessionId,
          step,
          issueRef: last.workerRequest.issueRef,
          repoKey: last.workerRequest.repoKey,
          workspacePath,
        });
        const workerResult = await this.runWorker(
          sessionId,
          {
            ...last.workerRequest,
            workspacePath,
            createdAt: nowIso(),
          },
          spawner,
        );
        workerResults.push(workerResult);
        this.debug("autoflow.worker.result", {
          sessionId,
          step,
          issueRef: workerResult.issueRef,
          repoKey: workerResult.repoKey,
          status: workerResult.status,
          summary: workerResult.summary,
          blockers: workerResult.blockers,
          nextPickup: workerResult.nextPickup,
        });
        last = await this.advanceIssue(sessionId);
        continue;
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
      stringFromRecord(targetJob?.input, "workerTaskId") ??
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
        summary: `Local thread took over Worker ${taskId}.`,
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

  async runBackgroundExecutor(
    sessionId: string,
    request: WorkerTaskRequest,
    spawner: WorkerSpawner,
  ): Promise<WorkerTaskResult> {
    return this.runWorker(sessionId, request, spawner);
  }

  async runWorker(sessionId: string, request: WorkerTaskRequest, spawner: WorkerSpawner): Promise<WorkerTaskResult> {
    await this.requireSession(sessionId);
    const executor = request.executor ?? WorkerExecutorValue.Pi;
    const workExecutor = workerExecutorToWorkExecutor(executor);
    const requestWithJob = await this.ensureWorkerWorkJob(sessionId, request);
    const claimedJob = await this.claimWorkJob(sessionId, requestWithJob.workJobId, workExecutor);
    if (!request.workspacePath) {
      const blockedResult: WorkerTaskResult = {
        taskId: request.id,
        issueRef: request.issueRef,
        repoKey: request.repoKey,
        workJobId: requestWithJob.workJobId,
        executor,
        status: WorkerStatusValue.Blocked,
        summary: `Worker workspace path is missing for ${request.repoKey}.`,
        changedFiles: [],
        testsRun: [],
        blockers: ["Worker workspace path is missing."],
        nextPickup: "Run prepare workspace for the routed repo, then retry advance/autoflow.",
        handoffPrompt: buildLiveWorkerHandoffPrompt(sessionId, request, {
          status: WorkerStatusValue.Blocked,
          summary: "Worker workspace path is missing.",
          blockers: ["Worker workspace path is missing."],
        }),
        completedAt: nowIso(),
      };
      await this.recordWorkerResult(sessionId, blockedResult);
      return blockedResult;
    }
    const startedAt = nowIso();
    await this.markWorkJobRunning(sessionId, claimedJob, workExecutor, startedAt);
    await this.ledger.recordWorkerRun({
      taskId: request.id,
      issueRef: request.issueRef,
      repoKey: request.repoKey,
      workJobId: requestWithJob.workJobId,
      executor,
      status: WorkerStatusValue.Running,
      workspacePath: request.workspacePath,
      summary: "Worker started.",
      blockers: [],
      startedAt,
      updatedAt: startedAt,
    });
    this.debug("worker.started", {
      sessionId,
      issueRef: request.issueRef,
      repoKey: request.repoKey,
      workspacePath: request.workspacePath,
      taskId: request.id,
    });
    const workerTimeoutMs = this.workerTimeoutMs;
    const result = await withPromiseTimeout(
      spawner.run(requestWithJob, async (event) => {
        if (!this.shouldRecordProgress(request.id, event.summary)) return;
        await this.ledger.recordWorkerRun({
          taskId: event.taskId,
          issueRef: event.issueRef,
          repoKey: event.repoKey,
          executor,
          status: WorkerStatusValue.Running,
          workspacePath: request.workspacePath,
          summary: event.summary,
          blockers: [],
          startedAt,
          updatedAt: event.updatedAt,
        });
      }),
      workerTimeoutMs,
      (): WorkerTaskResult => ({
        taskId: request.id,
        issueRef: request.issueRef,
        repoKey: request.repoKey,
        executor,
        status: WorkerStatusValue.Blocked,
        summary: `Background worker timed out or was interrupted before returning a structured result (${Math.round(workerTimeoutMs / 1000)}s workRuntime timeout).`,
        changedFiles: [],
        testsRun: [],
        blockers: ["Background worker timed out or was interrupted before returning a structured result."],
        nextPickup: "Retry worker run. If this repeats, inspect worker runtime/debug logs.",
        handoffPrompt: buildLiveWorkerHandoffPrompt(sessionId, request, {
          status: WorkerStatusValue.Blocked,
          summary: "Background worker timed out or was interrupted before returning a structured result.",
          blockers: ["Background worker timed out or was interrupted before returning a structured result."],
        }),
        completedAt: nowIso(),
      }),
    );
    const resultWithHandoff = withLiveWorkerHandoffPrompt(sessionId, requestWithJob, {
      ...result,
      workJobId: requestWithJob.workJobId,
    });
    await this.recordWorkerResult(sessionId, resultWithHandoff);
    this.debug("worker.completed", {
      sessionId,
      issueRef: resultWithHandoff.issueRef,
      repoKey: resultWithHandoff.repoKey,
      taskId: resultWithHandoff.taskId,
      status: resultWithHandoff.status,
      blockers: resultWithHandoff.blockers,
    });
    return resultWithHandoff;
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
      throw new Error(`Live Worker workspace path is missing for ${adopted.repoKey}. Run prepare workspace first.`);
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
      message: `Live agent thread adopted Worker ${adoptedWithJob.id}.`,
      payload: { workerRequest: adoptedWithJob, adopter: options.adopter },
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

    if (session.pendingConfirmation?.action === "spawn_worker") {
      advanced = await this.advanceIssue(sessionId, session.pendingConfirmation.id);
    } else {
      advanced = await this.advanceIssue(sessionId);
    }

    session = advanced.session;
    if (advanced.status === "needs_confirmation" && session.pendingConfirmation?.action === "spawn_worker") {
      advanced = await this.advanceIssue(sessionId, session.pendingConfirmation.id);
    }

    if (advanced.status !== "worker_requested" || !advanced.workerRequest) {
      throw new Error(`No Work Runtime-created Worker request is available to adopt. Current state: ${advanced.status}.`);
    }

    return this.adoptLiveWorker(
      sessionId,
      {
        id: advanced.workerRequest.id,
        issueRef: advanced.workerRequest.issueRef,
        repoKey: advanced.workerRequest.repoKey,
        workJobId: advanced.workerRequest.workJobId,
        prompt: advanced.workerRequest.prompt,
        workspacePath: advanced.workerRequest.workspacePath,
        createdAt: advanced.workerRequest.createdAt ?? nowIso(),
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
    const executionMode = request.executor === WorkerExecutorValue.LiveAgentThread ? ExecutionModeValue.LocalThread : ExecutionModeValue.Background;
    const job = await this.submitWorkEnvelope(sessionId, [
      "---",
      `workType: ${this.workTypeForCategory("implement")}`,
      `issueRef: ${request.issueRef}`,
      `repoKey: ${request.repoKey}`,
      `executionMode: ${executionMode}`,
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
        (job.input as { workerTaskId?: unknown }).workerTaskId === result.taskId
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
          headRefName: "",
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
    const metadata = {
      ...(existing?.metadata ?? {}),
      jiraStatus: jiraIssue.status,
      jiraIssueType: jiraIssue.issueType,
      branchKind: existingBranchKind(existing) ?? branchKindFromJiraIssueType(jiraIssue.issueType) ?? "",
      jiraLabels: jiraIssue.labels ?? [],
      jiraStatusCategory: jiraIssue.statusCategory,
      jiraResolution: jiraIssue.resolution,
      jiraUpdated: jiraIssue.updated,
      jiraUrl: existingString((jiraIssue as { url?: unknown }).url),
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
      executionMode: "background",
      idempotencyKey: `${issue.ref}:${repoKey}:${workerId}`,
      body: prompt,
      metadata: {
        workspacePath: worktreePathForRepo(issue, repoKey),
        workerTaskId: workerId,
      },
      requiredCapabilities: [],
    });
    const workerRequest = {
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
      type: "worker.requested",
      issueRef: issue.ref,
      message: `Worker requested for ${issue.ref} in ${repoKey}.`,
      payload: { workerRequest },
    });
    return {
      status: "worker_requested",
      session: updatedSession,
      issue,
      message: `Spawn Worker ${workerRequest.id}.`,
      workerRequest,
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
      action: "spawn_worker",
      summary: `Resolve PR merge conflicts for ${issue.ref} in ${repoKey}.`,
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
      action: "spawn_worker",
      summary: `Remediate PR review feedback for ${issue.ref} in ${repoKey}.`,
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

  private readonly progressCache = new Map<string, { summary: string; updatedAtMs: number }>();

  private shouldRecordProgress(taskId: string, summary: string): boolean {
    const now = Date.now();
    const previous = this.progressCache.get(taskId);
    if (previous?.summary === summary && now - previous.updatedAtMs < 5000) return false;
    this.progressCache.set(taskId, { summary, updatedAtMs: now });
    return true;
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
  };
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
      summary: "The issue is complete: the pull request is merged and Jira is Done.",
    };
  }
  const blockerSummaries = findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => finding.summary);
  if (!visibility.repoRouting) {
    return {
      type: "route_issue",
      command: `flow call routeIssue '{"issueRef":"${issue.ref}","repoKeys":["<repo_key>"]}'`,
      summary: "Route the issue to a component repo, then rerun Flow.",
    };
  }
  if (blockerSummaries.includes("Prepared worktree is missing.")) {
    if (visibility.pullRequest) {
      const repoKey = issue.repoKeys[0] ?? "<repo_key>";
      const branch = existingString(issue.metadata[`workflow.repos.${repoKey}.branch`]) ??
        existingString(issue.metadata.prHeadRefName) ??
        existingString(issue.metadata.branch);
      const pathHint = branch ? `<path-to-worktree-for-${branch.replace(/\//g, "-")}>` : "<worktree_path>";
      return {
        type: "adopt_workspace",
        command: `flow adopt-workspace ${issue.ref} --repo ${repoKey} --path ${pathHint}`,
        summary: "Adopt the existing PR worktree into Flow, or let Flow prepare a new routed workspace.",
      };
    }
    return {
      type: "prepare_workspace",
      command: `flow advance ${issue.ref}`,
      summary: "Let Flow prepare the routed workspace or approve the prepare-workspace confirmation.",
    };
  }
  if (
    blockerSummaries.includes("Auto review has must-fix feedback.") ||
    blockerSummaries.includes("Auto review checks failed.")
  ) {
    return {
      type: "remediate_review",
      command: `flow advance ${issue.ref}`,
      summary: "Remediate PR review feedback through the normal Flow advance path.",
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
      summary: "Inspect failing GitHub checks and remediate through the PR worktree.",
    };
  }
  if (findings.some((finding) => finding.summary === "Approval review is required.")) {
    if (findings.some((finding) => finding.summary === "Review comments are present.")) {
      return {
        type: "address_review_comments",
        summary: "Inspect and address any actionable PR review comments, then request an approval review.",
      };
    }
    return {
      type: "wait_for_approval_review",
      summary: "The PR is waiting for an approval review; review comments alone do not satisfy approval-required review policy.",
    };
  }
  if (visibility.pullRequest) {
    return {
      type: "advance",
      command: `flow advance ${issue.ref}`,
      summary: "Flow can continue from the reconciled pull-request state.",
    };
  }
  return {
    type: "advance",
    command: `flow advance ${issue.ref}`,
    summary: "Run Flow advance to choose the next valid orchestration action.",
  };
}

function isFlowTerminal(issue: WorkItem): boolean {
  const review = reviewMetadata(issue);
  const pullRequestMerged = !review?.prUrl || isPullRequestMetadataMerged(review);
  return isWorkItemJiraDone(issue) && pullRequestMerged;
}

function isWorkItemJiraDone(issue: WorkItem): boolean {
  return isJiraDone({
    key: issue.ref,
    summary: issue.title,
    issueType: "Task",
    status: existingString(issue.metadata.jiraStatus),
    statusCategory: existingString(issue.metadata.jiraStatusCategory),
    resolution: existingString(issue.metadata.jiraResolution),
    labels: [],
  });
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

function hasHardAutoflowBlocker(blockers: string[]): boolean {
  return blockers.some((blocker) => /credential|provider/i.test(blocker));
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
    if (handoffPrompt) parts.push(`Paste-ready local-thread executor prompt:\n${handoffPrompt}`);
  }
  return parts.join("\n\n");
}

function isObsoleteSatisfiedPrWorkerResult(result: WorkerTaskResult, issue: WorkItem): boolean {
  if (issue.metadata.prIsDraft !== false) return false;
  const text = `${result.taskId} ${result.summary} ${result.nextPickup ?? ""} ${result.handoffPrompt ?? ""}`.toLowerCase();
  return text.includes("undraft") || text.includes("ready-for-review") || text.includes("ready for review");
}

function liveWorkerAdoptionSummary(adopter?: string): string {
  return adopter ? `Live agent thread adopted Worker (${adopter}).` : "Live agent thread adopted Worker.";
}

function branchKindFromJiraIssueType(issueType: unknown): BranchKind | undefined {
  const normalized = String(issueType ?? "").toLowerCase();
  if (normalized === "bug") return "bug";
  if (normalized === "story" || normalized === "task") return "feature";
  return undefined;
}

function existingBranchKind(issue?: WorkItem): BranchKind | undefined {
  const normalized = String(issue?.metadata.branchKind ?? "").toLowerCase();
  if (normalized === "bug" || normalized === "feature") return normalized;
  return undefined;
}

function buildWorkerPrompt(issue: WorkItem, repoKey: string): string {
  const workspacePath = worktreePathForRepo(issue, repoKey);
  const branch = branchForRepo(issue, repoKey);
  return [
    `Work ${issue.ref} in ${repoKey}.`,
    `Title: ${issue.title}`,
    issue.summary ? `Issue context:\n${issue.summary}` : undefined,
    workspacePath ? `Prepared workspace: ${workspacePath}` : undefined,
    branch ? `Branch: ${branch}` : undefined,
    "Use only the prepared workspace.",
    "Read AGENTS.md before editing.",
    `You may call flow_record_worker_progress for task-scoped progress only. Do not write issue phase or review readiness directly.`,
    "Implement the smallest correct change for this issue. Do not commit.",
    "Run the smallest useful verification command you can.",
    'Return only a JSON object: {"status":"succeeded|blocked|failed","summary":"...","changedFiles":[],"testsRun":[],"blockers":[],"nextPickup":"...","handoffPrompt":"...","evidenceCandidate":"..."}',
  ].filter(Boolean).join("\n");
}

function buildReviewRemediationWorkerPrompt(
  issue: WorkItem,
  repoKey: string,
  findings: ReadinessFinding[],
): string {
  return [
    buildWorkerPrompt(issue, repoKey),
    "",
    "Review remediation target:",
    "Address only the PR review blockers listed below. Keep the change narrow and do not resolve needs-confirmation items unless the fix is directly required by a must-fix.",
    ...findings.map((finding, index) =>
      [
        `${index + 1}. ${finding.summary}`,
        finding.detail ? finding.detail : undefined,
      ].filter(Boolean).join("\n")
    ),
    "After editing, run the smallest verification command that covers the remediated review feedback.",
  ].join("\n");
}

function withLiveWorkerHandoffPrompt(
  sessionId: string,
  request: WorkerTaskRequest,
  result: WorkerTaskResult,
): WorkerTaskResult {
  if (result.status !== "blocked" && result.status !== "failed") return result;
  if (result.handoffPrompt?.trim()) return result;
  return {
    ...result,
    handoffPrompt: buildLiveWorkerHandoffPrompt(sessionId, request, result),
  };
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
    `You are a local-thread executor for Flow issue ${request.issueRef}.`,
    `Name this thread "${threadTitleForHandoff(request)}".`,
    "",
    "Work through Flow. First reconcile/adopt this executor task using the metadata below, then keep going until Flow reports a real blocker or the work is review-ready.",
    "",
    "Flow context:",
    `- Flow session: ${sessionId}`,
    `- Executor task: ${request.id}`,
    `- Repo key: ${request.repoKey}`,
    request.workspacePath ? `- Last known worktree: ${request.workspacePath}` : "- Last known worktree: missing",
    `- Prior executor status: ${result.status}`,
    `- Prior executor summary: ${result.summary}`,
    "- Prior blockers:",
    blockers,
    "",
    "If Flow asks for an adoption payload:",
    "```json",
    JSON.stringify({
      sessionId,
      id: request.id,
      issueRef: request.issueRef,
      repoKey: request.repoKey,
      workJobId: request.workJobId,
      prompt: request.prompt,
      workspacePath: request.workspacePath,
      createdAt: request.createdAt,
      adopter: "local_agent_thread",
      summary: `Local agent thread took over after ${result.status} background executor result.`,
    }, null, 2),
    "```",
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

async function withPromiseTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
