import { nowIso, WorkerStatusValue, type WorkerTaskRequest } from "../src/contracts.js";
import type { AutoFlowIssueResult, FlowDoctorResult, FlowWorkRuntime, LocalThreadResultInput } from "../src/work-runtime.js";
import type { PiSessionDriver, PiSessionSnapshot } from "./pi-session-driver.js";

type OrchestratorRuntime = Pick<
  FlowWorkRuntime,
  | "createSession"
  | "summarizeHandoff"
  | "inspectIssue"
  | "inspectQueue"
  | "selectIssue"
  | "autoFlowIssue"
  | "adoptPendingLiveWorker"
  | "diagnoseIssue"
  | "recordLocalThreadResult"
>;

export type PiAgentOrchestratorPhase = "paused" | "idle" | "starting" | "running" | "needs_input" | "failed";

export interface PiAgentOrchestratorIssueStatus {
  phase: PiAgentOrchestratorPhase;
  sessionId?: string;
  workspacePath?: string;
  summary?: string;
  updatedAt: string;
}

export interface PiAgentOrchestratorStatus {
  enabled: boolean;
  maxConcurrency: number;
  activeCount: number;
  issues: Record<string, PiAgentOrchestratorIssueStatus>;
  summary: string;
  updatedAt: string;
}

export interface PiAgentOrchestratorOptions {
  projectId: string;
  runtime: OrchestratorRuntime;
  piSessionDriver: PiSessionDriver;
  enabled?: () => boolean;
  maxConcurrency?: number;
  gitInspect?: (path: string) => Promise<{ dirty: boolean; entries: string[] }>;
}

interface ActiveRun {
  promise: Promise<void>;
  status: PiAgentOrchestratorPhase;
  sessionId?: string;
  workspacePath?: string;
  summary?: string;
  updatedAt: string;
}

export class PiAgentOrchestrator {
  private readonly projectId: string;
  private readonly runtime: OrchestratorRuntime;
  private readonly piSessionDriver: PiSessionDriver;
  private readonly enabled: () => boolean;
  private readonly maxConcurrency: number;
  private readonly gitInspect?: (path: string) => Promise<{ dirty: boolean; entries: string[] }>;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly issueStatuses = new Map<string, PiAgentOrchestratorIssueStatus>();
  private reconciling = false;

  constructor(options: PiAgentOrchestratorOptions) {
    this.projectId = options.projectId;
    this.runtime = options.runtime;
    this.piSessionDriver = options.piSessionDriver;
    this.enabled = options.enabled ?? (() => true);
    this.maxConcurrency = options.maxConcurrency ?? 5;
    this.gitInspect = options.gitInspect;
  }

  getStatus(): PiAgentOrchestratorStatus {
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

    const issues: Record<string, PiAgentOrchestratorIssueStatus> = {};
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
      summary = `${blockedCount} issue${blockedCount === 1 ? "" : "s"} need${blockedCount === 1 ? "" : ""} input.`;
    } else {
      summary = `Working ${activeCount} issue${activeCount === 1 ? "" : "s"}.`;
      if (blockedCount > 0) summary += ` ${blockedCount} need${blockedCount === 1 ? "" : ""} input.`;
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

  getStatusForIssue(issueRef: string): PiAgentOrchestratorIssueStatus | undefined {
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

  async reconcile(): Promise<PiAgentOrchestratorStatus> {
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

      const candidates = await this.nextCandidates(availableSlots);
      for (const candidate of candidates) {
        this.spawnRun(candidate.ref, candidate.repoKeys, candidate.title, candidate.metadata);
      }
    } finally {
      this.reconciling = false;
    }

    return this.getStatus();
  }

  async sendUserMessage(input: { issueRef: string; sessionId?: string; text: string }): Promise<PiSessionSnapshot> {
    const session = input.sessionId
      ? await this.piSessionDriver.getSession(input.sessionId).catch(() => undefined)
      : undefined;
    const target = session ?? await this.piSessionDriver.openOrCreateIssueSession(input.issueRef);
    const mode = target.status === "running" ? "followUp" : "prompt";
    return this.piSessionDriver.sendUserMessage(target.id, { text: input.text, mode });
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
        void this.reconcile();
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
      this.updateIssueStatus(issueRef, {
        phase: autoflow.status === "needs_confirmation" ? "needs_input" : "idle",
        summary: autoflow.message,
      });
      this.activeRuns.delete(issueRef);
      return;
    }

    const handoff = await this.runtime.adoptPendingLiveWorker(flowSessionId, {
      adopter: "Flow Desktop Autoflow",
      summary: `Flow Desktop Autoflow started ${issueRef}.`,
    });
    const piSession = await this.piSessionDriver.openOrCreateIssueSession(issueRef);

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

    const completed = await this.piSessionDriver.postPrompt(piSession.id, handoff.prompt);
    const resultStatus = await this.recordResult(flowSessionId, handoff, completed);

    const finalPhase = completed.status === "failed" ? "failed" : resultStatus === "blocked" ? "needs_input" : "idle";
    const finalSummary = completed.error ?? latestAssistantText(completed) ?? `Autoflow finished ${issueRef}.`;

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

  private updateIssueStatus(issueRef: string, input: Partial<PiAgentOrchestratorIssueStatus> & { phase: PiAgentOrchestratorPhase }): void {
    this.issueStatuses.set(issueRef, {
      ...input,
      updatedAt: nowIso(),
    });
  }

  private async recordResult(flowSessionId: string, handoff: WorkerTaskRequest & { workJobId: string }, session: PiSessionSnapshot): Promise<"succeeded" | "blocked" | "failed"> {
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

  private async nextCandidates(limit: number): Promise<Array<{ ref: string; repoKeys: string[]; title: string; metadata: Record<string, unknown> }>> {
    const queue = await this.runtime.inspectQueue(50);
    const candidates: Array<{ ref: string; repoKeys: string[]; title: string; metadata: Record<string, unknown> }> = [];

    for (const issue of queue) {
      if (candidates.length >= limit) break;
      // Only pick up queued or selected issues (not done, blocked, awaiting_review, etc.)
      if (issue.state !== "queued" && issue.state !== "selected") continue;
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

function isKnownStaleIssue(issue: Record<string, unknown>): boolean {
  const detail = [issue.workStatusDetail, issue.nextPickup, ...(Array.isArray(issue.blockerLabels) ? issue.blockerLabels : [])]
    .map(String)
    .join(" ")
    .toLowerCase();
  return detail.includes("stale external issue") || detail.includes("external issue") && detail.includes("missing");
}

function isMissingExternalIssueText(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("could not resolve to an issue") || lower.includes("repository.issue");
}

function latestAssistantText(session: PiSessionSnapshot): string | undefined {
  return [...session.timeline].reverse().find((item) => item.role === "assistant")?.content.trim() || undefined;
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
  ]);
  return blockerSummaries.some((summary) => !autoflowCanAdvance.has(summary));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractChangedFilesFromTimeline(timeline: PiSessionSnapshot["timeline"]): string[] {
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

function extractTestsRunFromTimeline(timeline: PiSessionSnapshot["timeline"]): string[] {
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

function checkCommitEvidence(timeline: PiSessionSnapshot["timeline"]): boolean {
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
