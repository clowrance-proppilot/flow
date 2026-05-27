import { createId, createWorkflowLedger, nowIso, type FlowArtifactContextRecord, type FlowContextProjection, type FlowContextTarget, type WorkflowLedger } from "../src/index.js";
import type { DesktopProjectRecord, DesktopProjectRegistry } from "./project-registry.js";

export interface DesktopPromptRouterOptions {
  projects: DesktopProjectRegistry;
  ledgerForProject?: (project: DesktopProjectRecord) => WorkflowLedger | Promise<WorkflowLedger>;
  agent?: DesktopAgentSessionAdapter;
}

export interface DesktopPromptSubmitInput {
  prompt: string;
  projectId?: string;
  issueRef?: string;
  threadId?: string;
  sessionId?: string;
  target?: FlowContextTarget;
  artifactRefs?: string[];
}

export interface DesktopAgentPromptInput {
  prompt: string;
  project: DesktopProjectRecord;
  issueRef?: string;
  threadId: string;
  sessionId?: string;
  artifactRefs: string[];
}

export interface DesktopAgentArtifactResult {
  id?: string;
  artifactType: FlowArtifactContextRecord["artifactType"];
  title: string;
  uri?: string;
  path?: string;
  mimeType?: string;
  contentHash?: string;
  summary?: string;
}

export interface DesktopAgentPromptResult {
  session?: {
    id: string;
    provider?: string;
    externalSessionId?: string;
    workspacePath?: string;
    status?: "active" | "paused" | "done" | "failed";
    summary?: string;
  };
  artifacts?: DesktopAgentArtifactResult[];
  summary?: string;
  error?: string;
}

export interface DesktopAgentSessionAdapter {
  sendPrompt(input: DesktopAgentPromptInput): Promise<DesktopAgentPromptResult>;
}

export interface DesktopPromptRouteResult {
  ok: true;
  project: DesktopProjectRecord;
  threadId: string;
  sessionId?: string;
  artifactRefs: string[];
  summary?: string;
  error?: string;
  projection: FlowContextProjection;
}

export class DesktopPromptRouter {
  private readonly projects: DesktopProjectRegistry;
  private readonly ledgerForProject: (project: DesktopProjectRecord) => WorkflowLedger | Promise<WorkflowLedger>;
  private readonly agent?: DesktopAgentSessionAdapter;

  constructor(options: DesktopPromptRouterOptions) {
    this.projects = options.projects;
    this.ledgerForProject = options.ledgerForProject ?? ((project) => createWorkflowLedger({ cwd: project.root }));
    this.agent = options.agent;
  }

  async submit(input: DesktopPromptSubmitInput): Promise<DesktopPromptRouteResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Prompt is required.");

    const project = input.projectId
      ? await this.projects.setActiveProject(input.projectId)
      : await this.projects.activeProject();
    if (!project) throw new Error("No active Flow project.");

    const ledger = await this.ledgerForProject(project);
    if (!ledger.recordContext || !ledger.readContext) {
      throw new Error("The active Flow ledger does not support prompt context records.");
    }

    const current = await ledger.readContext({ projectId: project.id });
    const threadId = input.threadId || current.active.threadId || createId("thread");
    const artifactRefs = [...new Set(input.artifactRefs ?? [])];
    const now = nowIso();

    if (!current.threads.some((thread) => thread.id === threadId)) {
      await ledger.recordContext({
        kind: "thread",
        id: threadId,
        projectId: project.id,
        issueRef: input.issueRef,
        title: input.issueRef ? `${input.issueRef} conversation` : `${project.name} conversation`,
        createdAt: now,
        updatedAt: now,
      });
    }

    let agentResult: DesktopAgentPromptResult | undefined;
    if (this.agent) {
      try {
        agentResult = await this.agent.sendPrompt({
          prompt,
          project,
          issueRef: input.issueRef,
          threadId,
          sessionId: input.sessionId || current.active.sessionId,
          artifactRefs,
        });
      } catch (error) {
        agentResult = {
          error: message(error),
          summary: `Prompt routing failed: ${message(error)}`,
        };
      }
    }

    const sessionId = agentResult?.session?.id || input.sessionId || current.active.sessionId;
    if (agentResult?.session) {
      await ledger.recordContext({
        kind: "session",
        id: agentResult.session.id,
        projectId: project.id,
        issueRef: input.issueRef,
        threadId,
        provider: agentResult.session.provider ?? "local",
        externalSessionId: agentResult.session.externalSessionId,
        workspacePath: agentResult.session.workspacePath,
        status: agentResult.session.status ?? "active",
        summary: agentResult.session.summary,
        createdAt: now,
        updatedAt: nowIso(),
      });
    }

    const producedArtifactRefs = [...artifactRefs];
    for (const artifact of agentResult?.artifacts ?? []) {
      const artifactId = artifact.id ?? createId("artifact");
      producedArtifactRefs.push(artifactId);
      await ledger.recordContext({
        kind: "artifact",
        id: artifactId,
        projectId: project.id,
        issueRef: input.issueRef,
        threadId,
        sessionId,
        artifactType: artifact.artifactType,
        title: artifact.title,
        uri: artifact.uri,
        path: artifact.path,
        mimeType: artifact.mimeType,
        contentHash: artifact.contentHash,
        summary: artifact.summary,
        createdAt: now,
        updatedAt: nowIso(),
      });
    }

    await ledger.recordContext({
      kind: "prompt",
      id: createId("prompt"),
      projectId: project.id,
      issueRef: input.issueRef,
      threadId,
      sessionId,
      artifactRefs: [...new Set(producedArtifactRefs)],
      prompt,
      target: input.target ?? inferPromptTarget(input.issueRef, sessionId, producedArtifactRefs),
      summary: agentResult?.summary ?? agentResult?.error,
      metadata: agentResult?.error ? { error: agentResult.error } : {},
      createdAt: now,
      updatedAt: nowIso(),
    });

    return {
      ok: true,
      project,
      threadId,
      sessionId,
      artifactRefs: [...new Set(producedArtifactRefs)],
      summary: agentResult?.summary,
      error: agentResult?.error,
      projection: await ledger.readContext({ projectId: project.id }),
    };
  }
}

function inferPromptTarget(issueRef: string | undefined, sessionId: string | undefined, artifactRefs: string[]): FlowContextTarget {
  if (artifactRefs.length) return "artifact";
  if (sessionId) return "session";
  if (issueRef) return "issue";
  return "project";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
