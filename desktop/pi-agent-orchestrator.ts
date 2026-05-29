import { nowIso, WorkerStatusValue, type WorkerTaskRequest } from "../src/contracts.js";
import type { AutoFlowIssueResult, FlowDoctorResult, FlowWorkRuntime, LocalThreadResultInput } from "../src/work-runtime.js";
import type { DashboardState } from "../src/dashboard-state.js";
import type { PiSessionDriver, PiSessionSnapshot } from "./pi-session-driver.js";

type OrchestratorRuntime = Pick<
  FlowWorkRuntime,
  | "createSession"
  | "summarizeHandoff"
  | "inspectIssue"
  | "selectIssue"
  | "autoFlowIssue"
  | "adoptPendingLiveWorker"
  | "diagnoseIssue"
  | "recordLocalThreadResult"
>;

export type PiAgentOrchestratorPhase = "paused" | "idle" | "starting" | "running" | "needs_input" | "failed";

export interface PiAgentOrchestratorStatus {
  enabled: boolean;
  phase: PiAgentOrchestratorPhase;
  issueRef?: string;
  sessionId?: string;
  workspacePath?: string;
  summary?: string;
  updatedAt: string;
}

export interface PiAgentOrchestratorOptions {
  projectId: string;
  runtime: OrchestratorRuntime;
  dashboardState: DashboardState;
  piSessionDriver: PiSessionDriver;
  enabled?: () => boolean;
}

export class PiAgentOrchestrator {
  private readonly projectId: string;
  private readonly runtime: OrchestratorRuntime;
  private readonly dashboardState: DashboardState;
  private readonly piSessionDriver: PiSessionDriver;
  private readonly enabled: () => boolean;
  private activeRun: Promise<void> | undefined;
  private status: PiAgentOrchestratorStatus;

  constructor(options: PiAgentOrchestratorOptions) {
    this.projectId = options.projectId;
    this.runtime = options.runtime;
    this.dashboardState = options.dashboardState;
    this.piSessionDriver = options.piSessionDriver;
    this.enabled = options.enabled ?? (() => true);
    this.status = {
      enabled: this.enabled(),
      phase: this.enabled() ? "idle" : "paused",
      summary: this.enabled() ? "Autoflow idle." : "Autoflow is paused.",
      updatedAt: nowIso(),
    };
  }

  getStatus(): PiAgentOrchestratorStatus {
    const enabled = this.enabled();
    if (!enabled && this.status.phase !== "running" && this.status.phase !== "starting") {
      return { ...this.status, enabled, phase: "paused", summary: "Autoflow is paused." };
    }
    return { ...this.status, enabled };
  }

  async tick(): Promise<PiAgentOrchestratorStatus> {
    if (!this.enabled()) return this.setStatus({ phase: "paused", summary: "Autoflow is paused." });
    if (this.activeRun) return this.getStatus();

    const candidate = await this.nextCandidate();
    if (!candidate) return this.setStatus({ phase: "idle", summary: "No Autoflow-ready issues." });

    this.setStatus({
      phase: "starting",
      issueRef: candidate.ref,
      summary: `Autoflow starting ${candidate.ref}.`,
    });
    this.activeRun = this.runCandidate(candidate.ref)
      .catch((error) => {
        const summary = errorMessage(error);
        this.setStatus({
          phase: "failed",
          issueRef: candidate.ref,
          summary,
        });
      })
      .finally(() => {
        this.activeRun = undefined;
      });
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

  private async runCandidate(issueRef: string): Promise<void> {
    const flowSessionId = `desktop-${this.projectId}`;
    await this.ensureFlowSession(flowSessionId);
    const doctor = await this.runDoctor(flowSessionId, issueRef);
    if (doctorBlocksAutoflow(doctor)) {
      this.setStatus({
        phase: "needs_input",
        issueRef,
        summary: doctorSummary(doctor),
      });
      return;
    }
    const issue = await this.runtime.inspectIssue(issueRef);
    await this.runtime.selectIssue(flowSessionId, issue);
    const autoflow = await this.runtime.autoFlowIssue(flowSessionId, { autoPrepareWorkspace: true, maxSteps: 20 });
    if (!isExecutionReady(autoflow)) {
      this.setStatus({
        phase: autoflow.status === "needs_confirmation" ? "needs_input" : "idle",
        issueRef,
        summary: autoflow.message,
      });
      return;
    }

    const handoff = await this.runtime.adoptPendingLiveWorker(flowSessionId, {
      adopter: "Flow Desktop Autoflow",
      summary: `Flow Desktop Autoflow started ${issueRef}.`,
    });
    const piSession = await this.piSessionDriver.openOrCreateIssueSession(issueRef);
    this.setStatus({
      phase: "running",
      issueRef,
      sessionId: piSession.id,
      workspacePath: handoff.workspacePath,
      summary: `Autoflow working ${issueRef}.`,
    });

    const completed = await this.piSessionDriver.postPrompt(piSession.id, handoff.prompt);
    await this.recordResult(flowSessionId, handoff, completed);
    this.setStatus({
      phase: completed.status === "failed" ? "failed" : "idle",
      issueRef,
      sessionId: completed.id,
      workspacePath: completed.workspacePath,
      summary: completed.error ?? latestAssistantText(completed) ?? `Autoflow finished ${issueRef}.`,
    });
  }

  private async recordResult(flowSessionId: string, handoff: WorkerTaskRequest & { workJobId: string }, session: PiSessionSnapshot): Promise<void> {
    const result: LocalThreadResultInput = {
      issueRef: handoff.issueRef,
      repoKey: handoff.repoKey,
      taskId: handoff.id,
      workJobId: handoff.workJobId,
      status: session.status === "failed" ? WorkerStatusValue.Failed : WorkerStatusValue.Succeeded,
      summary: session.error ?? latestAssistantText(session) ?? `Pi session completed ${handoff.issueRef}.`,
      blockers: session.status === "failed" && session.error ? [session.error] : [],
      handoffPrompt: handoff.prompt,
    };
    await this.runtime.recordLocalThreadResult(flowSessionId, result);
  }

  private async nextCandidate(): Promise<{ ref: string } | undefined> {
    const payload = await this.dashboardState.payload({ limit: 50 });
    const issues = Array.isArray(payload.issues) ? payload.issues : [];
    for (const status of ["Ready", "Queued"]) {
      const match = issues.find((issue) => {
        if (!issue || typeof issue !== "object") return false;
        const record = issue as Record<string, unknown>;
        return typeof record.ref === "string"
          && record.workStatus === status
          && !isKnownStaleIssue(record);
      }) as { ref?: unknown } | undefined;
      if (typeof match?.ref === "string") return { ref: match.ref };
    }
    return undefined;
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

  private setStatus(input: Omit<Partial<PiAgentOrchestratorStatus>, "enabled" | "updatedAt"> & { phase: PiAgentOrchestratorPhase }): PiAgentOrchestratorStatus {
    this.status = {
      enabled: this.enabled(),
      updatedAt: nowIso(),
      ...input,
    };
    return this.getStatus();
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
