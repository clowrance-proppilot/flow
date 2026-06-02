import { createId, nowIso, WorkerStatusValue, type WorkerTaskRequest } from "./contracts.js";
import type { DurableAgentSessionHandle, HatchetAutoflowPayload, HatchetAutoflowRunResult } from "./execution-plane.js";
import type { AdvanceIssueResult, AutoFlowIssueResult, FlowDoctorResult, FlowWorkRuntime, LocalThreadResultInput } from "./work-runtime.js";

export type AutoflowServiceRuntime = Pick<
  FlowWorkRuntime,
  | "createSession"
  | "summarizeHandoff"
  | "inspectIssue"
  | "inspectQueue"
  | "selectIssue"
  | "autoFlowIssue"
  | "adoptPendingLiveWorker"
  | "diagnoseIssue"
  | "listWorkerResults"
  | "recordLocalThreadResult"
  | "recordEvidence"
  | "recordDocumentation"
  | "recordPullRequest"
  | "advanceIssue"
>;

export interface AutoflowAgentTimelineItem {
  id?: string;
  role: string;
  content: string;
  toolName?: string;
  diff?: {
    path?: string;
  };
  createdAt?: string;
}

export interface AutoflowAgentSessionSnapshot {
  id: string;
  workspacePath?: string;
  status: string;
  summary?: string;
  error?: string;
  timeline: AutoflowAgentTimelineItem[];
}

export interface AutoflowAgentSessionDriver {
  getSession(sessionId: string): Promise<AutoflowAgentSessionSnapshot>;
  openOrCreateIssueSession(issueRef: string): Promise<AutoflowAgentSessionSnapshot>;
  sendUserMessage(sessionId: string, input: { text: string; mode?: string }): Promise<AutoflowAgentSessionSnapshot>;
  postPrompt(sessionId: string, prompt: string): Promise<AutoflowAgentSessionSnapshot>;
}

export type AutoflowServicePhase = "paused" | "idle" | "starting" | "running" | "recovering" | "needs_input" | "failed";

export interface AutoflowServiceIssueStatus {
  phase: AutoflowServicePhase;
  sessionId?: string;
  workspacePath?: string;
  summary?: string;
  updatedAt: string;
}

export interface AutoflowServiceStatus {
  enabled: boolean;
  maxConcurrency: number;
  activeCount: number;
  issues: Record<string, AutoflowServiceIssueStatus>;
  summary: string;
  updatedAt: string;
}

export interface AutoflowServiceOptions {
  projectId: string;
  runtime: AutoflowServiceRuntime;
  agentSessionDriver: AutoflowAgentSessionDriver;
  codeReviewCreator?: AutoflowCodeReviewCreator;
  enabled?: () => boolean;
  maxConcurrency?: number;
  postPromptTimeoutMs?: number;
  recoveryPollAttempts?: number;
  recoveryPollIntervalMs?: number;
  pendingCheckPollAttempts?: number;
  pendingCheckPollIntervalMs?: number;
  gitInspect?: (path: string) => Promise<{ dirty: boolean; entries: string[] }>;
  autoReconcileOnSlotAvailable?: boolean;
  onStatusChange?: (status: AutoflowServiceStatus) => void | Promise<void>;
}

export interface AutoflowCodeReviewCreator {
  createPullRequest(input: {
    issueRef: string;
    title: string;
    repo: string;
    baseRefName: string;
    headRefName: string;
    body: string;
  }): Promise<{
    repo: string;
    number: number;
    url: string;
    headRefName?: string;
    isDraft?: boolean;
    checksPassing?: boolean;
    checksPending?: boolean;
    reviewDecision?: string;
  }>;
}

const COMMIT_FOLLOW_UP_PROMPT = "You have uncommitted changes. Commit them with a descriptive message and push to the branch.";
const DEFAULT_PENDING_CHECK_POLL_ATTEMPTS = 30;
const DEFAULT_PENDING_CHECK_POLL_INTERVAL_MS = 10_000;
const DEFAULT_RECOVERY_POLL_ATTEMPTS = 12;
const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 5_000;

interface ActiveRun {
  promise: Promise<void>;
  status: AutoflowServicePhase;
  sessionId?: string;
  workspacePath?: string;
  summary?: string;
  updatedAt: string;
}

export class AutoflowService {
  private readonly projectId: string;
  private readonly runtime: AutoflowServiceRuntime;
  private readonly agentSessionDriver: AutoflowAgentSessionDriver;
  private readonly codeReviewCreator?: AutoflowCodeReviewCreator;
  private readonly enabled: () => boolean;
  private readonly maxConcurrency: number;
  private readonly postPromptTimeoutMs: number;
  private readonly recoveryPollAttempts: number;
  private readonly recoveryPollIntervalMs: number;
  private readonly pendingCheckPollAttempts: number;
  private readonly pendingCheckPollIntervalMs: number;
  private readonly autoReconcileOnSlotAvailable: boolean;
  private readonly gitInspect?: (path: string) => Promise<{ dirty: boolean; entries: string[] }>;
  private readonly onStatusChange?: (status: AutoflowServiceStatus) => void | Promise<void>;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly issueStatuses = new Map<string, AutoflowServiceIssueStatus>();
  private reconciling = false;

  constructor(options: AutoflowServiceOptions) {
    this.projectId = options.projectId;
    this.runtime = options.runtime;
    this.agentSessionDriver = options.agentSessionDriver;
    this.codeReviewCreator = options.codeReviewCreator;
    this.enabled = options.enabled ?? (() => true);
    this.maxConcurrency = options.maxConcurrency ?? 5;
    this.postPromptTimeoutMs = options.postPromptTimeoutMs ?? 10 * 60 * 1000;
    this.recoveryPollAttempts = options.recoveryPollAttempts ?? DEFAULT_RECOVERY_POLL_ATTEMPTS;
    this.recoveryPollIntervalMs = options.recoveryPollIntervalMs ?? DEFAULT_RECOVERY_POLL_INTERVAL_MS;
    this.pendingCheckPollAttempts = options.pendingCheckPollAttempts ?? DEFAULT_PENDING_CHECK_POLL_ATTEMPTS;
    this.pendingCheckPollIntervalMs = options.pendingCheckPollIntervalMs ?? DEFAULT_PENDING_CHECK_POLL_INTERVAL_MS;
    this.autoReconcileOnSlotAvailable = options.autoReconcileOnSlotAvailable ?? true;
    this.gitInspect = options.gitInspect;
    this.onStatusChange = options.onStatusChange;
  }

  getStatus(): AutoflowServiceStatus {
    const enabled = this.enabled();
    if (!enabled) {
      return {
        enabled: false,
        maxConcurrency: this.maxConcurrency,
        activeCount: 0,
        issues: {},
        summary: "Autoflow is paused.",
        updatedAt: nowIso(),
      };
    }

    const issues: Record<string, AutoflowServiceIssueStatus> = {};
    for (const [ref, status] of this.issueStatuses) {
      issues[ref] = { ...status };
    }
    // Merge in active runs that might not have explicit statuses yet
    for (const [ref, run] of this.activeRuns) {
      if (!issues[ref]) {
        issues[ref] = {
          phase: run.status,
          sessionId: run.sessionId,
          workspacePath: run.workspacePath,
          summary: run.summary,
          updatedAt: run.updatedAt,
        };
      }
    }

    const activeCount = [...this.activeRuns.values()].filter((run) => isActivePhase(run.status)).length;
    const blockedCount = [...this.issueStatuses.values()].filter((s) => s.phase === "needs_input").length;
    let summary: string;
    if (activeCount === 0 && blockedCount === 0) {
      summary = "Autoflow idle.";
    } else if (activeCount === 0 && blockedCount > 0) {
      summary = `${blockedCount} issue${blockedCount === 1 ? "" : "s"} need${blockedCount === 1 ? "s" : ""} input.`;
    } else {
      summary = `Working ${activeCount} issue${activeCount === 1 ? "" : "s"}.`;
      if (blockedCount > 0) summary += ` ${blockedCount} need${blockedCount === 1 ? "s" : ""} input.`;
    }

    return {
      enabled: true,
      maxConcurrency: this.maxConcurrency,
      activeCount,
      issues,
      summary,
      updatedAt: nowIso(),
    };
  }

  getStatusForIssue(issueRef: string): AutoflowServiceIssueStatus | undefined {
    const normalized = issueRef.toUpperCase();
    const explicit = this.issueStatuses.get(normalized);
    if (explicit) return explicit;
    const run = this.activeRuns.get(normalized);
    if (run) {
      return {
        phase: run.status,
        sessionId: run.sessionId,
        workspacePath: run.workspacePath,
        summary: run.summary,
        updatedAt: run.updatedAt,
      };
    }
    return undefined;
  }

  async reconcile(options: { issueRefs?: string[] } = {}): Promise<AutoflowServiceStatus> {
    if (!this.enabled()) return this.getStatus();
    if (this.reconciling) return this.getStatus();
    this.reconciling = true;

    try {
      // Clean up completed runs
      for (const [ref, run] of this.activeRuns) {
        if (!isActivePhase(run.status)) {
          this.activeRuns.delete(ref);
        }
      }

      const availableSlots = this.maxConcurrency - this.activeRuns.size;
      if (availableSlots <= 0) return this.getStatus();

      const candidates = await this.nextCandidates(availableSlots, options.issueRefs);
      for (const candidate of candidates) {
        this.spawnRun(candidate.ref, candidate.repoKeys, candidate.title, candidate.metadata);
      }
    } finally {
      this.reconciling = false;
    }

    return this.getStatus();
  }

  async waitForIdle(): Promise<AutoflowServiceStatus> {
    while (this.activeRuns.size > 0) {
      const runs = [...this.activeRuns.values()].map((run) => run.promise.catch(() => undefined));
      await Promise.all(runs);
      for (const [ref, run] of this.activeRuns) {
        if (!isActivePhase(run.status)) {
          this.activeRuns.delete(ref);
        }
      }
    }
    return this.getStatus();
  }

  async sendUserMessage(input: { issueRef: string; sessionId?: string; text: string }): Promise<AutoflowAgentSessionSnapshot> {
    const session = input.sessionId
      ? await this.agentSessionDriver.getSession(input.sessionId).catch(() => undefined)
      : undefined;
    const target = session ?? await this.agentSessionDriver.openOrCreateIssueSession(input.issueRef);
    const mode = target.status === "running" ? "followUp" : "prompt";
    return this.agentSessionDriver.sendUserMessage(target.id, { text: input.text, mode });
  }

  async runExecutionPlanePayload(input: HatchetAutoflowPayload): Promise<HatchetAutoflowRunResult> {
    this.spawnRun(input.issueRef, input.repoKeys, input.issueRef, {
      "flow.execution.run_id": input.runId,
      "flow.execution.requested_by": input.requestedBy,
      ...(input.reason ? { "flow.execution.reason": input.reason } : {}),
    }, input.durableSession);
    await this.activeRuns.get(input.issueRef)?.promise;
    const status = this.issueStatuses.get(input.issueRef);
    return {
      issueRef: input.issueRef,
      runId: input.runId,
      status: hatchetResultStatus(status?.phase),
      summary: status?.summary ?? `Autoflow finished ${input.issueRef}.`,
      changedFiles: [],
      testsRun: [],
      completedAt: nowIso(),
    };
  }

  private spawnRun(issueRef: string, repoKeys: string[] = [], title?: string, metadata: Record<string, unknown> = {}, durableSession?: DurableAgentSessionHandle): void {
    const run: ActiveRun = {
      promise: Promise.resolve(),
      status: "starting",
      updatedAt: nowIso(),
    };
    this.activeRuns.set(issueRef, run);
    this.issueStatuses.set(issueRef, {
      phase: "starting",
      summary: `Autoflow starting ${issueRef}.`,
      updatedAt: nowIso(),
    });

    run.promise = this.runCandidate(issueRef, repoKeys, title, metadata, durableSession)
      .catch((error) => {
        const summary = errorMessage(error);
        run.status = "failed";
        run.summary = summary;
        run.updatedAt = nowIso();
        this.issueStatuses.set(issueRef, {
          phase: "failed",
          summary,
          updatedAt: nowIso(),
        });
      })
      .finally(() => {
        run.status = run.status === "starting" ? "idle" : run.status;
        if (!isActivePhase(run.status)) {
          this.activeRuns.delete(issueRef);
          this.emitStatusChange();
        }
        if (this.autoReconcileOnSlotAvailable) void this.reconcile();
      });
  }

  private async runCandidate(issueRef: string, repoKeys: string[] = [], title?: string, metadata: Record<string, unknown> = {}, durableSession?: DurableAgentSessionHandle): Promise<void> {
    // Each issue gets its own session to avoid Windows EPERM on concurrent session file writes
    const flowSessionId = durableSession?.flowSessionId ?? `desktop-${this.projectId}-${issueRef.toLowerCase()}`;
    await this.ensureFlowSession(flowSessionId);
    // selectIssue writes the issue to the ledger — must happen before doctor/autoflow
    // which call reconcileIssue (reads from ledger)
    await this.runtime.selectIssue(flowSessionId, {
      ref: issueRef,
      title: title ?? issueRef,
      repoKeys,
      state: "selected",
      metadata: metadata as Record<string, string>,
    });
    const doctor = await this.runDoctor(flowSessionId, issueRef);
    if (doctorBlocksAutoflow(doctor)) {
      this.updateIssueStatus(issueRef, {
        phase: "needs_input",
        summary: doctorSummary(doctor),
      });
      // Remove from activeRuns so it doesn't block a slot
      this.activeRuns.delete(issueRef);
      return;
    }
    const autoflow = await this.runtime.autoFlowIssue(flowSessionId, { autoPrepareWorkspace: true, maxSteps: 20 });
    if (!isExecutionReady(autoflow)) {
      if (canCloseoutBlockedAutoflow(autoflow)) {
        const closed = await this.recordCloseoutInputsFromExistingResult(flowSessionId, issueRef);
        if (closed) {
          const advanced = await this.runtime.advanceIssue(flowSessionId);
          this.updateIssueStatus(issueRef, {
            phase: phaseAfterWorkerAdvance(advanced),
            summary: advanced.message || autoflow.message,
          });
          this.activeRuns.delete(issueRef);
          return;
        }
      }
      this.updateIssueStatus(issueRef, {
        phase: autoflow.status === "needs_confirmation" ? "needs_input" : "idle",
        summary: autoflow.message,
      });
      this.activeRuns.delete(issueRef);
      return;
    }

    const handoff = await this.runtime.adoptPendingLiveWorker(flowSessionId, {
      adopter: "Flow Autoflow",
      summary: `Flow Autoflow started ${issueRef}.`,
    });
    const agentSession = durableSession?.sessionId
      ? await this.agentSessionDriver.getSession(durableSession.sessionId).catch(() => this.agentSessionDriver.openOrCreateIssueSession(issueRef))
      : await this.agentSessionDriver.openOrCreateIssueSession(issueRef);

    const run = this.activeRuns.get(issueRef);
    if (run) {
      run.status = "running";
      run.sessionId = agentSession.id;
      run.workspacePath = handoff.workspacePath;
      run.summary = `Autoflow working ${issueRef}.`;
      run.updatedAt = nowIso();
    }
    this.updateIssueStatus(issueRef, {
      phase: "running",
      sessionId: agentSession.id,
      workspacePath: handoff.workspacePath,
      summary: `Autoflow working ${issueRef}.`,
    });

    let completed: AutoflowAgentSessionSnapshot;
    try {
      completed = await this.completeAgentPrompt(agentSession.id, handoff);
    } catch (error) {
      if (error instanceof PostPromptTimeoutError) {
        completed = await this.recoverFromTimeout(agentSession, handoff);
      } else {
        completed = failedAgentSession(agentSession, handoff, error);
      }
    }
    const resultStatus = await this.recordResult(flowSessionId, handoff, completed);

    let finalPhase: AutoflowServicePhase = completed.status === "failed" ? "failed" : resultStatus === "blocked" ? "needs_input" : "idle";
    let finalSummary = agentSessionSummary(completed) ?? `Autoflow finished ${issueRef}.`;
    if (completed.status !== "failed" && resultStatus === "succeeded") {
      await this.recordCloseoutInputs(flowSessionId, handoff, {
        summary: agentSessionSummary(completed) ?? `Autoflow completed ${handoff.issueRef}.`,
        changedFiles: extractChangedFilesFromTimeline(completed.timeline),
        testsRun: extractTestsRunFromTimeline(completed.timeline),
      });
      const advanced = await this.advanceIssueThroughPendingChecks(flowSessionId);
      finalPhase = phaseAfterWorkerAdvance(advanced);
      finalSummary = advanced.message || finalSummary;
    }

    const activeRun = this.activeRuns.get(issueRef);
    if (activeRun) {
      activeRun.status = finalPhase;
      activeRun.summary = finalSummary;
      activeRun.updatedAt = nowIso();
    }
    this.updateIssueStatus(issueRef, {
      phase: finalPhase,
      sessionId: completed.id,
      workspacePath: completed.workspacePath,
      summary: finalSummary,
    });
  }

  private updateIssueStatus(issueRef: string, input: Partial<AutoflowServiceIssueStatus> & { phase: AutoflowServicePhase }): void {
    this.issueStatuses.set(issueRef, {
      ...input,
      updatedAt: nowIso(),
    });
    this.emitStatusChange();
  }

  private emitStatusChange(): void {
    if (!this.onStatusChange) return;
    void Promise.resolve(this.onStatusChange(this.getStatus())).catch(() => undefined);
  }

  private async advanceIssueThroughPendingChecks(flowSessionId: string): Promise<AdvanceIssueResult> {
    let advanced = await this.runtime.advanceIssue(flowSessionId);
    for (let attempt = 0; attempt < this.pendingCheckPollAttempts && isPendingCheckAdvance(advanced); attempt += 1) {
      if (this.pendingCheckPollIntervalMs > 0) await sleep(this.pendingCheckPollIntervalMs);
      advanced = await this.runtime.advanceIssue(flowSessionId);
    }
    return advanced;
  }

  private async postPromptWithTimeout(sessionId: string, prompt: string): Promise<AutoflowAgentSessionSnapshot> {
    const timeoutMs = this.postPromptTimeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<AutoflowAgentSessionSnapshot>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new PostPromptTimeoutError(timeoutMs));
      }, timeoutMs);
      timeout.unref?.();
    });
    try {
      return await Promise.race([
        this.agentSessionDriver.postPrompt(sessionId, prompt),
        timeoutPromise,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async completeAgentPrompt(
    sessionId: string,
    handoff: WorkerTaskRequest & { workJobId: string },
  ): Promise<AutoflowAgentSessionSnapshot> {
    const completed = await this.postPromptWithTimeout(sessionId, handoff.prompt);
    if (!this.gitInspect || completed.status === "failed") return completed;
    const workspacePath = completed.workspacePath ?? handoff.workspacePath;
    if (!workspacePath) return completed;
    let status: { dirty: boolean; entries: string[] };
    try {
      status = await this.gitInspect(workspacePath);
    } catch {
      return completed;
    }
    if (!status.dirty) return completed;
    return this.agentSessionDriver.sendUserMessage(sessionId, {
      text: COMMIT_FOLLOW_UP_PROMPT,
      mode: "followUp",
    });
  }

  private async recoverFromTimeout(
    session: AutoflowAgentSessionSnapshot,
    handoff: WorkerTaskRequest & { workJobId: string },
  ): Promise<AutoflowAgentSessionSnapshot> {
    const issueRef = handoff.issueRef;
    this.updateIssueStatus(issueRef, {
      phase: "recovering",
      sessionId: session.id,
      workspacePath: session.workspacePath ?? handoff.workspacePath,
      summary: `Post-prompt timeout for ${issueRef}. Checking if agent completed work...`,
    });

    const run = this.activeRuns.get(issueRef);
    if (run) {
      run.status = "recovering";
      run.summary = `Post-prompt timeout for ${issueRef}. Checking if agent completed work...`;
      run.updatedAt = nowIso();
    }

    for (let attempt = 0; attempt < this.recoveryPollAttempts; attempt += 1) {
      if (this.recoveryPollIntervalMs > 0) await sleep(this.recoveryPollIntervalMs);

      // Check if the session completed on its own
      try {
        const currentSession = await this.agentSessionDriver.getSession(session.id);
        if (currentSession.status === "done" || currentSession.status === "completed") {
          return currentSession;
        }
      } catch {
        // Session may no longer exist; continue checking git state
      }

      // Check if workspace has commits (work completed after timeout)
      const workspacePath = session.workspacePath ?? handoff.workspacePath;
      if (workspacePath && this.gitInspect) {
        try {
          const gitStatus = await this.gitInspect(workspacePath);
          // If workspace is clean, work may have been committed
          if (!gitStatus.dirty) {
            // Try to get the session one more time to see if it completed
            try {
              const finalSession = await this.agentSessionDriver.getSession(session.id);
              if (finalSession.status === "done" || finalSession.status === "completed") {
                return finalSession;
              }
            } catch {
              // Fall through to construct recovery session
            }
            // Workspace is clean - work likely committed even if session didn't report
            return {
              ...session,
              status: "done",
              summary: `Agent work completed after post-prompt timeout. Workspace is clean.`,
              timeline: [
                ...session.timeline,
                {
                  id: createId("assistant"),
                  role: "assistant",
                  content: "Agent work completed after post-prompt timeout. Changes have been committed.",
                  createdAt: nowIso(),
                },
              ],
            };
          }
        } catch {
          // Git inspect failed; continue polling
        }
      }
    }

    // Recovery failed - mark as truly failed
    return failedAgentSession(session, handoff, new Error(`Post-prompt timeout for ${issueRef}. Agent did not complete work within recovery window.`));
  }

  private async recordResult(flowSessionId: string, handoff: WorkerTaskRequest & { workJobId: string }, session: AutoflowAgentSessionSnapshot): Promise<"succeeded" | "blocked" | "failed"> {
    const changedFiles = extractChangedFilesFromTimeline(session.timeline);
    const testsRun = extractTestsRunFromTimeline(session.timeline);
    const hasCommitEvidence = checkCommitEvidence(session.timeline);

    let status: "succeeded" | "blocked" | "failed";
    const blockers: string[] = [];

    if (session.status === "failed") {
      status = "failed";
      if (session.error) blockers.push(session.error);
    } else if (changedFiles.length > 0 && !hasCommitEvidence && this.gitInspect) {
      try {
        const workspacePath = session.workspacePath ?? handoff.workspacePath;
        if (workspacePath) {
          const gitStatus = await this.gitInspect(workspacePath);
          if (gitStatus.dirty) {
            status = "blocked";
            blockers.push("Changes not committed");
          } else {
            status = WorkerStatusValue.Succeeded;
          }
        } else {
          status = WorkerStatusValue.Succeeded;
        }
      } catch {
        status = WorkerStatusValue.Succeeded;
      }
    } else {
      status = WorkerStatusValue.Succeeded;
    }

    const result: LocalThreadResultInput = {
      issueRef: handoff.issueRef,
      repoKey: handoff.repoKey,
      taskId: handoff.id,
      workJobId: handoff.workJobId,
      status,
      summary: agentSessionSummary(session) ?? `Agent session completed ${handoff.issueRef}.`,
      changedFiles,
      testsRun,
      blockers,
      nextPickup: status === "blocked" ? "Commit and push the changes to the prepared branch." : undefined,
      handoffPrompt: handoff.prompt,
    };
    await this.runtime.recordLocalThreadResult(flowSessionId, result);
    return status;
  }

  private async recordCloseoutInputsFromExistingResult(flowSessionId: string, issueRef: string): Promise<boolean> {
    const results = await this.runtime.listWorkerResults(issueRef);
    const latest = [...results].reverse().find((result) => result.status === "succeeded" && result.blockers.length === 0);
    if (!latest) return false;
    await this.recordCloseoutInputs(flowSessionId, {
      issueRef: latest.issueRef,
      repoKey: latest.repoKey,
      id: latest.taskId,
      workJobId: latest.workJobId ?? latest.taskId,
      prompt: latest.handoffPrompt ?? "",
      createdAt: latest.completedAt,
    }, {
      summary: latest.summary,
      changedFiles: latest.changedFiles,
      testsRun: latest.testsRun,
    });
    return true;
  }

  private async recordCloseoutInputs(
    flowSessionId: string,
    handoff: WorkerTaskRequest & { workJobId: string },
    result: { summary: string; changedFiles: string[]; testsRun: string[] },
  ): Promise<void> {
    const criteria = result.testsRun.length
      ? result.testsRun.map((test) => ({ label: test, status: "passed" as const, evidence: result.summary, source: "autoflow" }))
      : [{ label: "Autoflow worker completed", status: "passed" as const, evidence: result.summary, source: "autoflow" }];
    await this.runtime.recordEvidence(flowSessionId, {
      issueRef: handoff.issueRef,
      summary: result.summary,
      source: "autoflow",
      criteria,
    });
    const documentationUpdated = result.changedFiles.some(isDocumentationFile);
    await this.runtime.recordDocumentation(flowSessionId, {
      issueRef: handoff.issueRef,
      disposition: documentationUpdated ? "updated" : "not_needed",
      summary: documentationUpdated
        ? "Documentation was updated by Autoflow."
        : "No separate documentation update was needed.",
    });
    await this.ensurePullRequest(flowSessionId, handoff, result.summary);
  }

  private async ensurePullRequest(
    flowSessionId: string,
    handoff: WorkerTaskRequest & { workJobId: string },
    summary: string,
  ): Promise<void> {
    if (!this.codeReviewCreator) return;
    const issue = await this.runtime.inspectIssue(handoff.issueRef);
    if (!issue) return;
    if (metadataString(issue.metadata.prUrl)) return;
    const repoKey = handoff.repoKey || issue.repoKeys[0] || "flow";
    const branch = metadataString(issue.metadata[`workflow.repos.${repoKey}.branch`]) ?? metadataString(issue.metadata.branch);
    if (!branch) return;
    const baseRefName = metadataString(issue.metadata[`workflow.repos.${repoKey}.base_branch`]) ?? "main";
    if (branch === baseRefName) return;
    const pr = await this.codeReviewCreator.createPullRequest({
      issueRef: issue.ref,
      title: `${issue.ref}: ${issue.title}`,
      repo: repoKey,
      baseRefName,
      headRefName: branch,
      body: autoflowPullRequestBody(issue.ref, summary),
    });
    await this.runtime.recordPullRequest(flowSessionId, {
      issueRef: issue.ref,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      headRefName: pr.headRefName ?? branch,
      isDraft: pr.isDraft === true,
      checksPassing: pr.checksPassing,
      checksPending: pr.checksPending,
      reviewDecision: pr.reviewDecision,
    });
  }

  private async nextCandidates(limit: number, issueRefs?: string[]): Promise<Array<{ ref: string; repoKeys: string[]; title: string; metadata: Record<string, unknown> }>> {
    const explicitTargets = Boolean(issueRefs?.length);
    const queue = issueRefs?.length
      ? await Promise.all(issueRefs.map((ref) => this.runtime.inspectIssue(ref).then((issue) => issue ?? undefined)))
      : await this.runtime.inspectQueue(50);
    const candidates: Array<{ ref: string; repoKeys: string[]; title: string; metadata: Record<string, unknown> }> = [];

    for (const issue of queue) {
      if (!issue) continue;
      if (candidates.length >= limit) break;
      // Only pick up issues that can still advance automatically.
      if (
        issue.state !== "queued" &&
        issue.state !== "selected" &&
        issue.state !== "ready_to_run" &&
        !(explicitTargets && (issue.state === "blocked" || issue.state === "awaiting_review"))
      ) continue;
      if (this.activeRuns.has(issue.ref)) continue;
      const issueStatus = this.issueStatuses.get(issue.ref);
      if (issueStatus && !explicitTargets) continue;
      candidates.push({
        ref: issue.ref,
        repoKeys: issue.repoKeys.length ? issue.repoKeys : ["flow"],
        title: issue.title,
        metadata: issue.metadata,
      });
    }
    return candidates;
  }

  private async ensureFlowSession(sessionId: string): Promise<void> {
    try {
      await this.runtime.summarizeHandoff(sessionId);
    } catch {
      await this.runtime.createSession(sessionId);
    }
  }

  private async runDoctor(sessionId: string, issueRef: string): Promise<FlowDoctorResult> {
    try {
      return await this.runtime.diagnoseIssue(sessionId, issueRef);
    } catch (error) {
      if (isMissingExternalIssueText(errorMessage(error))) {
        return {
          issueRef,
          status: "blocked",
          issue: {
            ref: issueRef,
            title: issueRef,
            state: "blocked",
            repoKeys: [],
          },
          visibility: {
            ledger: true,
            issueTracker: false,
            repoRouting: false,
            preparedWorktree: false,
            codeReview: false,
            codeReviewRequired: false,
          },
          findings: [{
            id: `doctor-stale-${issueRef}`,
            severity: "blocker",
            summary: `External issue ${issueRef} is missing or stale.`,
            detail: errorMessage(error),
            issueRef,
            source: "doctor",
            createdAt: nowIso(),
          }],
          nextAction: {
            type: "cleanup_stale_issue",
            summary: `Clean up or recreate stale ledger issue ${issueRef}.`,
          },
        };
      }
      throw error;
    }
  }
}

function isExecutionReady(result: AutoFlowIssueResult): boolean {
  return result.status === "needs_confirmation" || result.status === "execution_handoff";
}

function canCloseoutBlockedAutoflow(result: AutoFlowIssueResult): boolean {
  if (result.status !== "blocked") return false;
  return result.message.includes("Acceptance evidence is missing.") ||
    result.message.includes("Documentation disposition is missing.") ||
    result.message.includes("Pull request is missing.");
}

function phaseAfterWorkerAdvance(result: AdvanceIssueResult): AutoflowServicePhase {
  if (result.status === "awaiting_review") return "idle";
  return "needs_input";
}

function hatchetResultStatus(phase: AutoflowServicePhase | undefined): HatchetAutoflowRunResult["status"] {
  if (phase === "failed") return "failed";
  if (phase === "needs_input") return "blocked";
  return "succeeded";
}

function isPendingCheckAdvance(result: AdvanceIssueResult): boolean {
  return result.status === "blocked" && result.message.includes("Pull request checks are still running.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class PostPromptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Autoflow agent postPrompt timed out after ${timeoutMs}ms.`);
    this.name = "PostPromptTimeoutError";
  }
}

function isActivePhase(phase: AutoflowServicePhase): boolean {
  return phase === "starting" || phase === "running" || phase === "recovering";
}

function isMissingExternalIssueText(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("could not resolve to an issue") || lower.includes("repository.issue");
}

function latestAssistantText(session: AutoflowAgentSessionSnapshot): string | undefined {
  return [...session.timeline].reverse().find((item) => item.role === "assistant")?.content.trim() || undefined;
}

function agentSessionSummary(session: AutoflowAgentSessionSnapshot): string | undefined {
  return session.error?.trim() || session.summary?.trim() || latestAssistantText(session);
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isDocumentationFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("docs/") || normalized.endsWith(".md") || normalized.endsWith(".mdx");
}

function autoflowPullRequestBody(issueRef: string, summary: string): string {
  return [
    "## Summary",
    `- Autoflow completed ${issueRef}`,
    "",
    "## Verification",
    `- ${summary.replace(/\s+/g, " ").trim() || "Autoflow worker completed."}`,
    "",
    `Closes #${issueRef.replace(/^GH-/i, "")}`,
  ].join("\n");
}

function doctorSummary(doctor: FlowDoctorResult): string {
  const finding = doctor.findings.find((item) => item.severity === "blocker") ?? doctor.findings[0];
  return finding?.summary ?? doctor.nextAction.summary;
}

function doctorBlocksAutoflow(doctor: FlowDoctorResult): boolean {
  const blockerSummaries = doctor.findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => finding.summary);
  const autoflowCanAdvance = new Set([
    "Prepared worktree is missing.",
    "Acceptance evidence is missing.",
    "Documentation disposition is missing.",
    "Pull request is missing.",
    "Pull request has merge conflicts.",
    "Pull request checks are not passing.",
    "Pull request does not follow the repo template.",
    "Auto review has must-fix feedback.",
    "Auto review checks failed.",
  ]);
  return blockerSummaries.some((summary) => !autoflowCanAdvance.has(summary));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedAgentSession(
  session: AutoflowAgentSessionSnapshot,
  handoff: WorkerTaskRequest,
  error: unknown,
): AutoflowAgentSessionSnapshot {
  const message = errorMessage(error);
  return {
    ...session,
    workspacePath: session.workspacePath ?? handoff.workspacePath,
    status: "failed",
    error: message,
    summary: message,
    timeline: [
      ...session.timeline,
      {
        id: createId("assistant"),
        role: "assistant",
        content: `Autoflow failed: ${message}`,
        createdAt: nowIso(),
      },
    ],
  };
}

function extractChangedFilesFromTimeline(timeline: AutoflowAgentSessionSnapshot["timeline"]): string[] {
  const files = new Set<string>();
  for (const item of timeline) {
    if (item.role !== "tool") continue;
    const name = (item.toolName ?? "").toLowerCase();
    if (name.includes("edit") || name.includes("write") || name.includes("create") || name.includes("notebookedit")) {
      const path = item.diff?.path;
      if (path) files.add(path);
    }
  }
  return [...files];
}

function extractTestsRunFromTimeline(timeline: AutoflowAgentSessionSnapshot["timeline"]): string[] {
  const tests: string[] = [];
  for (const item of timeline) {
    if (item.role !== "tool") continue;
    const name = (item.toolName ?? "").toLowerCase();
    if (name.includes("test") || name.includes("check") || name.includes("lint") || name.includes("build")) {
      tests.push(item.toolName ?? name);
    }
  }
  return [...new Set(tests)];
}

function checkCommitEvidence(timeline: AutoflowAgentSessionSnapshot["timeline"]): boolean {
  for (const item of timeline) {
    if (item.role === "tool" && item.toolName && item.toolName.toLowerCase().includes("git")) {
      if (item.content.toLowerCase().includes("commit")) return true;
    }
    if (item.role === "assistant" && item.content.toLowerCase().includes("commit")) {
      return true;
    }
  }
  return false;
}
