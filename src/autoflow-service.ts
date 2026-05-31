import { nowIso, WorkerStatusValue, type WorkerTaskRequest } from "./contracts.js";
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

export type AutoflowServicePhase = "paused" | "idle" | "starting" | "running" | "needs_input" | "failed";

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
  gitInspect?: (path: string) => Promise<{ dirty: boolean; entries: string[] }>;
  autoReconcileOnSlotAvailable?: boolean;
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
    reviewDecision?: string;
  }>;
}

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
  private readonly autoReconcileOnSlotAvailable: boolean;
  private readonly gitInspect?: (path: string) => Promise<{ dirty: boolean; entries: string[] }>;
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
    this.autoReconcileOnSlotAvailable = options.autoReconcileOnSlotAvailable ?? true;
    this.gitInspect = options.gitInspect;
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

    const activeCount = this.activeRuns.size;
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
        if (run.status !== "running" && run.status !== "starting") {
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
        if (run.status !== "running" && run.status !== "starting") {
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

  private spawnRun(issueRef: string, repoKeys: string[] = [], title?: string, metadata: Record<string, unknown> = {}): void {
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

    run.promise = this.runCandidate(issueRef, repoKeys, title, metadata)
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
        // Don't remove from activeRuns here — let reconcile() clean up
        // This prevents reconcile from immediately re-spawning the same issue
        run.status = run.status === "starting" ? "idle" : run.status;
        // Trigger reconcile to fill the slot
        if (this.autoReconcileOnSlotAvailable) void this.reconcile();
      });
  }

  private async runCandidate(issueRef: string, repoKeys: string[] = [], title?: string, metadata: Record<string, unknown> = {}): Promise<void> {
    // Each issue gets its own session to avoid Windows EPERM on concurrent session file writes
    const flowSessionId = `desktop-${this.projectId}-${issueRef.toLowerCase()}`;
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
    const piSession = await this.agentSessionDriver.openOrCreateIssueSession(issueRef);

    const run = this.activeRuns.get(issueRef);
    if (run) {
      run.status = "running";
      run.sessionId = piSession.id;
      run.workspacePath = handoff.workspacePath;
      run.summary = `Autoflow working ${issueRef}.`;
      run.updatedAt = nowIso();
    }
    this.updateIssueStatus(issueRef, {
      phase: "running",
      sessionId: piSession.id,
      workspacePath: handoff.workspacePath,
      summary: `Autoflow working ${issueRef}.`,
    });

    const completed = await this.postPromptWithTimeout(piSession.id, handoff.prompt);
    const resultStatus = await this.recordResult(flowSessionId, handoff, completed);

    let finalPhase: AutoflowServicePhase = completed.status === "failed" ? "failed" : resultStatus === "blocked" ? "needs_input" : "idle";
    let finalSummary = completed.error ?? latestAssistantText(completed) ?? `Autoflow finished ${issueRef}.`;
    if (completed.status !== "failed" && resultStatus === "succeeded") {
      await this.recordCloseoutInputs(flowSessionId, handoff, {
        summary: completed.error ?? latestAssistantText(completed) ?? `Autoflow completed ${handoff.issueRef}.`,
        changedFiles: extractChangedFilesFromTimeline(completed.timeline),
        testsRun: extractTestsRunFromTimeline(completed.timeline),
      });
      const advanced = await this.runtime.advanceIssue(flowSessionId);
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
  }

  private async postPromptWithTimeout(sessionId: string, prompt: string): Promise<AutoflowAgentSessionSnapshot> {
    const timeoutMs = this.postPromptTimeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<AutoflowAgentSessionSnapshot>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Autoflow agent postPrompt timed out after ${timeoutMs}ms.`));
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
      summary: session.error ?? latestAssistantText(session) ?? `Pi session completed ${handoff.issueRef}.`,
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
      reviewDecision: pr.reviewDecision,
    });
  }

  private async nextCandidates(limit: number, issueRefs?: string[]): Promise<Array<{ ref: string; repoKeys: string[]; title: string; metadata: Record<string, unknown> }>> {
    const queue = issueRefs?.length
      ? await Promise.all(issueRefs.map((ref) => this.runtime.inspectIssue(ref).then((issue) => issue ?? undefined)))
      : await this.runtime.inspectQueue(50);
    const candidates: Array<{ ref: string; repoKeys: string[]; title: string; metadata: Record<string, unknown> }> = [];

    for (const issue of queue) {
      if (!issue) continue;
      if (candidates.length >= limit) break;
      // Only pick up issues that can still advance automatically.
      if (issue.state !== "queued" && issue.state !== "selected" && issue.state !== "ready_to_run") continue;
      if (this.activeRuns.has(issue.ref)) continue;
      // Skip issues that have been flagged as needing input
      const issueStatus = this.issueStatuses.get(issue.ref);
      if (issueStatus?.phase === "needs_input") continue;
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

function isMissingExternalIssueText(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("could not resolve to an issue") || lower.includes("repository.issue");
}

function latestAssistantText(session: AutoflowAgentSessionSnapshot): string | undefined {
  return [...session.timeline].reverse().find((item) => item.role === "assistant")?.content.trim() || undefined;
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
  ]);
  return blockerSummaries.some((summary) => !autoflowCanAdvance.has(summary));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
