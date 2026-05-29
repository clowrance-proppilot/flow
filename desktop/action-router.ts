import {
  createId,
  nowIso,
  type AcceptanceCriterionEvidence,
  type FlowArtifactContextRecord,
  type FlowContextProjection,
  type WorkItem,
  type WorkerTaskResult,
  WorkerExecutorValue,
  WorkerStatusValue,
  workerTaskResultSchema,
  type WorkflowLedger,
} from "../src/index.js";
import type { AutoFlowIssueResult, FlowDoctorResult, FlowWorkRuntime } from "../src/work-runtime.js";
import type { DesktopProjectRecord, DesktopProjectRegistry } from "./project-registry.js";

type DesktopActionRuntime = Pick<
  FlowWorkRuntime,
  "createSession" | "selectIssue" | "summarizeHandoff" | "inspectIssue" | "recordEvidence" | "recordWorkerResult" | "recordDocumentation" | "diagnoseIssue" | "autoFlowIssue" | "advanceIssue"
>;

export const desktopActionValues = ["autoflow", "approve_confirmation", "record_evidence", "record_result", "record_documentation", "run_doctor"] as const;
export type DesktopAction = typeof desktopActionValues[number];

export interface DesktopActionInput {
  action: DesktopAction;
  projectId?: string;
  issueRef?: string;
  payload?: Record<string, unknown>;
}

export interface DesktopActionResult {
  ok: true;
  action: DesktopAction;
  project: DesktopProjectRecord;
  issueRef: string;
  summary: string;
  result: unknown;
  projection?: FlowContextProjection;
}

export interface DesktopActionRouterOptions {
  projects: DesktopProjectRegistry;
  runtimeForProject: (project: DesktopProjectRecord) => DesktopActionRuntime | Promise<DesktopActionRuntime>;
  ledgerForProject: (project: DesktopProjectRecord) => WorkflowLedger | Promise<WorkflowLedger>;
}

export class DesktopActionRouter {
  private readonly projects: DesktopProjectRegistry;
  private readonly runtimeForProject: (project: DesktopProjectRecord) => DesktopActionRuntime | Promise<DesktopActionRuntime>;
  private readonly ledgerForProject: (project: DesktopProjectRecord) => WorkflowLedger | Promise<WorkflowLedger>;

  constructor(options: DesktopActionRouterOptions) {
    this.projects = options.projects;
    this.runtimeForProject = options.runtimeForProject;
    this.ledgerForProject = options.ledgerForProject;
  }

  async invoke(input: DesktopActionInput): Promise<DesktopActionResult> {
    const project = input.projectId
      ? await this.projects.setActiveProject(input.projectId)
      : await this.projects.activeProject();
    if (!project) throw new Error("No active Flow project.");

    const ledger = await this.ledgerForProject(project);
    const context = ledger.readContext ? await ledger.readContext({ projectId: project.id }) : undefined;
    const issueRef = input.issueRef || context?.active.issueRef;
    if (!issueRef) throw new Error("No issue selected for desktop action.");

    const runtime = await this.runtimeForProject(project);
    const sessionId = `desktop-${project.id}`;
    const issue = await ensureSelectedIssue(runtime, sessionId, issueRef);
    const payload = input.payload ?? {};
    let result: unknown;
    let summary: string;

    if (input.action === "autoflow") {
      result = await runtime.autoFlowIssue(sessionId, { autoPrepareWorkspace: true, maxSteps: 20 });
      const autoflow = result as AutoFlowIssueResult;
      summary = `Autoflow ${autoflow.status} for ${issue.ref}. ${autoflow.message}`;
    } else if (input.action === "approve_confirmation") {
      const confirmationId = stringValue(payload.confirmationId);
      if (!confirmationId) throw new Error("No pending confirmation id was provided.");
      result = await runtime.advanceIssue(sessionId, confirmationId);
      summary = `Confirmation approved for ${issue.ref}.`;
    } else if (input.action === "record_evidence") {
      const record = evidencePayload(issue.ref, payload);
      result = await runtime.recordEvidence(sessionId, record);
      summary = `Evidence recorded for ${issue.ref}.`;
    } else if (input.action === "record_documentation") {
      const record = documentationPayload(issue.ref, payload);
      result = await runtime.recordDocumentation(sessionId, record);
      summary = `Documentation status recorded for ${issue.ref}.`;
    } else if (input.action === "record_result") {
      const record = resultPayload(issue, payload);
      result = await runtime.recordWorkerResult(sessionId, record);
      summary = `Result recorded for ${issue.ref}.`;
    } else {
      result = await runtime.diagnoseIssue(sessionId, issue.ref);
      const doctor = result as FlowDoctorResult;
      summary = `Doctor ${doctor.status} for ${issue.ref}.`;
    }

    if (ledger.recordContext && ledger.readContext) {
      await ledger.recordContext(actionArtifactRecord(project.id, issue.ref, input.action, summary, result));
      return {
        ok: true,
        action: input.action,
        project,
        issueRef: issue.ref,
        summary,
        result,
        projection: await ledger.readContext({ projectId: project.id }),
      };
    }

    return { ok: true, action: input.action, project, issueRef: issue.ref, summary, result };
  }
}

export function isDesktopAction(value: unknown): value is DesktopAction {
  return typeof value === "string" && desktopActionValues.includes(value as DesktopAction);
}

async function ensureSelectedIssue(runtime: DesktopActionRuntime, sessionId: string, issueRef: string): Promise<WorkItem> {
  try {
    await runtime.summarizeHandoff(sessionId);
  } catch {
    await runtime.createSession(sessionId);
  }
  const issue = await runtime.inspectIssue(issueRef);
  await runtime.selectIssue(sessionId, issue);
  return issue;
}

function evidencePayload(issueRef: string, payload: Record<string, unknown>) {
  const summary = stringValue(payload.summary) || "Evidence recorded from Flow Desktop.";
  const source = stringValue(payload.source) || "Flow Desktop conversation";
  return {
    issueRef,
    summary,
    source,
    criteria: criteriaValue(payload.criteria),
  };
}

function documentationPayload(issueRef: string, payload: Record<string, unknown>) {
  const disposition: "not_needed" | "updated" | "needed" = payload.disposition === "updated" || payload.disposition === "needed"
    ? payload.disposition
    : "not_needed";
  return {
    issueRef,
    disposition,
    summary: stringValue(payload.summary) || "Documentation reviewed from Flow Desktop.",
  };
}

function resultPayload(issue: WorkItem, payload: Record<string, unknown>): WorkerTaskResult {
  const repoKey = stringValue(payload.repoKey) || issue.repoKeys[0];
  if (!repoKey) throw new Error(`Repo routing is missing for ${issue.ref}.`);
  const status = payload.status === WorkerStatusValue.Blocked || payload.status === WorkerStatusValue.Failed
    ? payload.status
    : WorkerStatusValue.Succeeded;
  return workerTaskResultSchema.parse({
    taskId: stringValue(payload.taskId) || createId("worker-desktop"),
    issueRef: issue.ref,
    repoKey,
    executor: WorkerExecutorValue.LiveAgentThread,
    status,
    summary: stringValue(payload.summary) || "Desktop conversation result recorded.",
    changedFiles: stringArray(payload.changedFiles),
    testsRun: stringArray(payload.testsRun),
    blockers: stringArray(payload.blockers),
    nextPickup: stringValue(payload.nextPickup),
    handoffPrompt: stringValue(payload.handoffPrompt),
    evidenceCandidate: stringValue(payload.evidenceCandidate),
    completedAt: stringValue(payload.completedAt) || nowIso(),
  });
}

function actionArtifactRecord(
  projectId: string,
  issueRef: string,
  action: DesktopAction,
  summary: string,
  result: unknown,
): FlowArtifactContextRecord {
  const now = nowIso();
  return {
    kind: "artifact",
    id: createId("artifact"),
    projectId,
    issueRef,
    artifactRefs: [],
    artifactType: action === "run_doctor" || action === "autoflow" ? "test_output" : "other",
    title: actionLabel(action),
    summary: `${summary}\n${compactJson(result)}`,
    createdAt: now,
    updatedAt: now,
    metadata: { action },
  };
}

function actionLabel(action: DesktopAction): string {
  if (action === "autoflow") return "Autoflow output";
  if (action === "approve_confirmation") return "Confirmation approval";
  if (action === "record_evidence") return "Evidence writeback";
  if (action === "record_documentation") return "Documentation writeback";
  if (action === "record_result") return "Result writeback";
  return "Doctor output";
}

function criteriaValue(value: unknown): AcceptanceCriterionEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const label = stringValue(record.label);
    const evidence = stringValue(record.evidence);
    if (!label || !evidence) return [];
    return [{
      label,
      evidence,
      status: record.status === "failed" || record.status === "not_applicable" ? record.status : "passed",
      source: stringValue(record.source),
    }];
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function compactJson(value: unknown): string {
  const raw = JSON.stringify(value);
  return raw.length > 480 ? `${raw.slice(0, 477)}...` : raw;
}
