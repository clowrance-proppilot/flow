import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IssueStateValue, type WorkItem } from "../contracts.js";
import type { SessionDriverEvent, SessionEventListener, SessionRef, SessionSnapshot, Unsubscribe, WorkspaceRef } from "../session-driver.js";
import type { FlowWorkRuntime } from "../work-runtime.js";

type RuntimeIssueSurface = Pick<FlowWorkRuntime, "createSession" | "inspectIssue" | "inspectQueue" | "inspectBacklog" | "selectIssue" | "summarizeHandoff">;

export interface AgentSessionProvider {
  id: string;
  displayName: string;
  stateFilePrefix: string;
  defaultSessionId(issueRef: string): string;
  failureMessage(error: string): string;
}

export interface AgentSessionLink {
  issueRef: string;
  flowSessionId: string;
  provider: string;
  sessionId: string;
  sessionFile?: string;
  workspacePath?: string;
  status?: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTimelineItem {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolName?: string;
  input?: Record<string, unknown>;
  diff?: {
    path: string;
    before?: string;
    after?: string;
  };
}

export interface AgentSessionSnapshot {
  id: string;
  issueRef: string;
  flowSessionId: string;
  provider: string;
  sessionFile?: string;
  workspacePath?: string;
  status: AgentSessionStatus;
  summary?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  timeline: AgentTimelineItem[];
}

export interface AgentSessionDriverOptions {
  runtime: RuntimeIssueSurface;
  repoRoot: string;
  provider: AgentSessionProvider;
  flowSessionId?: string;
  agent?: AgentRunner | false;
}

export interface AgentPromptInput {
  sessionId: string;
  sessionFile?: string;
  issueRef: string;
  prompt: string;
  mode?: AgentMessageMode;
  repoRoot: string;
  workspacePath?: string;
  onEvent?: SessionEventListener;
}

export interface AgentPromptResult {
  sessionId: string;
  sessionFile?: string;
  workspacePath?: string;
  status?: AgentSessionStatus;
  summary?: string;
  timeline?: AgentTimelineItem[];
}

export interface AgentRunner {
  prompt(input: AgentPromptInput): Promise<AgentPromptResult>;
}

export type AgentSessionStatus = "active" | "running" | "paused" | "done" | "failed";
export type AgentMessageMode = "prompt" | "followUp" | "steer";

export class AgentSessionDriver {
  private readonly runtime: RuntimeIssueSurface;
  private readonly flowSessionId: string;
  private readonly repoRoot: string;
  private readonly provider: AgentSessionProvider;
  private readonly agent?: AgentRunner;
  private readonly linksPath: string;
  private readonly sessionsPath: string;
  private readonly sessionsById = new Map<string, AgentSessionSnapshot>();
  private readonly sessionIdByIssueRef = new Map<string, string>();
  private readonly linksByIssueRef = new Map<string, AgentSessionLink>();
  private readonly listenersBySessionId = new Map<string, Set<SessionEventListener>>();
  private readonly promptQueueBySessionId = new Map<string, Promise<void>>();
  private linksLoaded = false;

  constructor(options: AgentSessionDriverOptions) {
    this.runtime = options.runtime;
    this.flowSessionId = options.flowSessionId ?? "desktop";
    this.repoRoot = options.repoRoot;
    this.provider = options.provider;
    this.agent = options.agent === false ? undefined : options.agent;
    this.linksPath = join(options.repoRoot, ".flow", "runtime", `${this.provider.stateFilePrefix}-session-links.json`);
    this.sessionsPath = join(options.repoRoot, ".flow", "runtime", `${this.provider.stateFilePrefix}-session-state.json`);
  }

  async startSession(issueRef: string): Promise<AgentSessionSnapshot> {
    const normalizedRef = normalizeIssueRef(issueRef);
    await this.ensureFlowSession();
    const issue = await this.resolveIssue(normalizedRef);
    await this.runtime.selectIssue(this.flowSessionId, issue);
    await this.ensureLoadedLinks();

    const existingId = this.sessionIdByIssueRef.get(normalizedRef);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing) {
        this.refreshIssueContext(existing, issue, workspacePathFromIssue(issue));
        await this.persistSessionState();
        return existing;
      }
    }

    const now = nowIso();
    const link = this.linksByIssueRef.get(normalizedRef);
    const sessionId = link?.sessionId ?? this.provider.defaultSessionId(normalizedRef);
    const workspacePath = workspacePathFromIssue(issue);

    const snapshot: AgentSessionSnapshot = {
      id: sessionId,
      issueRef: normalizedRef,
      flowSessionId: this.flowSessionId,
      provider: this.provider.id,
      sessionFile: link?.sessionFile,
      workspacePath,
      status: link?.status ?? "active",
      startedAt: link?.createdAt ?? now,
      updatedAt: now,
      timeline: [this.systemMessage({
        id: timelineId("system"),
        issue,
        workspacePath,
        createdAt: now,
      })],
    };

    this.sessionsById.set(sessionId, snapshot);
    this.sessionIdByIssueRef.set(normalizedRef, sessionId);
    this.linksByIssueRef.set(normalizedRef, {
      issueRef: normalizedRef,
      flowSessionId: this.flowSessionId,
      provider: this.provider.id,
      sessionId,
      sessionFile: snapshot.sessionFile,
      workspacePath,
      status: snapshot.status,
      createdAt: link?.createdAt ?? now,
      updatedAt: now,
    });
    await this.persistLinks();
    await this.persistSessionState();
    return snapshot;
  }

  async getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    await this.ensureLoadedLinks();
    const session = this.sessionsById.get(sessionId);
    if (!session) throw new Error(`Unknown ${this.provider.displayName} session ${sessionId}.`);
    return session;
  }

  subscribe(sessionId: string, listener: SessionEventListener): Unsubscribe {
    const listeners = this.listenersBySessionId.get(sessionId) ?? new Set<SessionEventListener>();
    listeners.add(listener);
    this.listenersBySessionId.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersBySessionId.delete(sessionId);
    };
  }

  async postPrompt(sessionId: string, prompt: string, mode: AgentMessageMode = "prompt"): Promise<AgentSessionSnapshot> {
    const { session, contextualPrompt } = await this.appendUserPrompt(sessionId, prompt);
    await this.runPrompt(session, contextualPrompt, mode);
    return session;
  }

  async sendUserMessage(sessionId: string, input: { text: string; mode?: AgentMessageMode }): Promise<AgentSessionSnapshot> {
    const { session, contextualPrompt } = await this.appendUserPrompt(sessionId, input.text);
    const previous = this.promptQueueBySessionId.get(session.id) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.runPrompt(session, contextualPrompt, input.mode ?? "followUp"));
    this.promptQueueBySessionId.set(session.id, queued);
    void queued.finally(() => {
      if (this.promptQueueBySessionId.get(session.id) === queued) this.promptQueueBySessionId.delete(session.id);
    });
    return session;
  }

  async openOrCreateIssueSession(issueRef: string): Promise<AgentSessionSnapshot> {
    return this.startSession(issueRef);
  }

  async persistState(): Promise<void> {
    await this.ensureLoadedLinks();
    await this.persistLinks();
    await this.persistSessionState();
  }

  private async resolveIssue(issueRef: string): Promise<WorkItem> {
    const view = await this.runtime.inspectIssue(issueRef);
    if (view) return view;

    const key = issueRef.toUpperCase();
    const queue = await this.runtime.inspectQueue(100);
    const queueMatch = queue.find((item) => item.ref.toUpperCase() === key);
    if (queueMatch) return queueMatch;

    const backlog = await this.runtime.inspectBacklog(100);
    const backlogMatch = backlog.find((item) => item.ref.toUpperCase() === key);
    if (backlogMatch) return backlogMatch;

    return {
      ref: key,
      title: key,
      repoKeys: [],
      state: IssueStateValue.Queued,
      metadata: {},
    };
  }

  private async appendUserPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{ session: AgentSessionSnapshot; contextualPrompt: string }> {
    const session = await this.getSession(sessionId);
    const text = prompt.trim();
    if (!text) throw new Error("Prompt is required.");
    const issue = await this.resolveIssue(session.issueRef);
    const contextualPrompt = issuePrompt(issue, {
      prompt: text,
      workspacePath: session.workspacePath,
    });

    const createdAt = nowIso();
    session.timeline.push({
      id: timelineId("user"),
      role: "user",
      content: text,
      createdAt,
    });
    session.status = "running";
    session.updatedAt = nowIso();
    await this.persistActiveSession(session);
    this.emit(session, {
      type: "sessionUpdated",
      sessionRef: this.sessionRef(session),
      timestamp: nowIso(),
      snapshot: this.driverSnapshot(session),
    });
    return { session, contextualPrompt };
  }

  private async runPrompt(session: AgentSessionSnapshot, contextualPrompt: string, mode: AgentMessageMode = "prompt"): Promise<void> {
    if (!this.agent) {
      const handoff = await this.runtime.summarizeHandoff(session.flowSessionId).catch(() => "");
      session.timeline.push({
        id: timelineId("assistant"),
        role: "assistant",
        content: handoff
          ? `Queued prompt for ${session.issueRef}.\n\n${handoff}`
          : `Queued prompt for ${session.issueRef}.`,
        createdAt: nowIso(),
      });
      session.status = "active";
    } else {
      try {
        const result = await this.agent.prompt({
          sessionId: session.id,
          sessionFile: session.sessionFile,
          issueRef: session.issueRef,
          prompt: contextualPrompt,
          mode,
          repoRoot: this.repoRoot,
          workspacePath: session.workspacePath,
          onEvent: (event) => this.applyDriverEvent(session, event),
        });
        if (result.sessionId && result.sessionId !== session.id) {
          const previousId = session.id;
          this.sessionsById.delete(session.id);
          session.id = result.sessionId;
          this.sessionsById.set(session.id, session);
          this.sessionIdByIssueRef.set(session.issueRef, session.id);
          const listeners = this.listenersBySessionId.get(previousId);
          if (listeners) {
            this.listenersBySessionId.delete(previousId);
            this.listenersBySessionId.set(session.id, listeners);
          }
        }
        session.sessionFile = result.sessionFile ?? session.sessionFile;
        session.workspacePath = result.workspacePath ?? session.workspacePath;
        session.status = result.status ?? "active";
        session.summary = result.summary ?? session.summary;
        session.error = undefined;
        session.timeline.push(...result.timeline ?? []);
        if (result.summary && !session.timeline.some((item) => item.role === "assistant" && item.content === result.summary)) {
          session.timeline.push({
            id: timelineId("assistant"),
            role: "assistant",
            content: result.summary,
            createdAt: nowIso(),
          });
        }
      } catch (error) {
        console.error(`[flow-desktop] ${this.provider.displayName} session ${session.id} failed:`, error);
        session.status = "failed";
        session.error = errorMessage(error);
        session.summary = session.error;
        session.timeline.push({
          id: timelineId("assistant"),
          role: "assistant",
          content: this.provider.failureMessage(session.error),
          createdAt: nowIso(),
        });
        this.emit(session, {
          type: "runFailed",
          sessionRef: this.sessionRef(session),
          timestamp: nowIso(),
          error: { message: session.error },
        });
      }
    }

    session.updatedAt = nowIso();
    await this.persistActiveSession(session);
    if (session.status !== "failed") {
      this.emit(session, {
        type: "runCompleted",
        sessionRef: this.sessionRef(session),
        timestamp: nowIso(),
        snapshot: this.driverSnapshot(session),
      });
    }
    this.emit(session, {
      type: "sessionUpdated",
      sessionRef: this.sessionRef(session),
      timestamp: nowIso(),
      snapshot: this.driverSnapshot(session),
    });
  }

  private async persistActiveSession(session: AgentSessionSnapshot): Promise<void> {
    const link = this.linksByIssueRef.get(session.issueRef);
    if (link) {
      link.sessionId = session.id;
      link.sessionFile = session.sessionFile;
      link.workspacePath = session.workspacePath;
      link.provider = this.provider.id;
      link.status = session.status;
      link.updatedAt = session.updatedAt;
      await this.persistLinks();
    }
    await this.persistSessionState();
  }

  private async ensureLoadedLinks(): Promise<void> {
    if (this.linksLoaded) return;
    this.linksLoaded = true;

    if (existsSync(this.linksPath)) {
      try {
        const raw = await readFile(this.linksPath, "utf8");
        const parsed = JSON.parse(raw) as { links?: AgentSessionLink[] };
        for (const link of parsed.links ?? []) {
          const ref = normalizeIssueRef(link.issueRef);
          const normalized = { ...link, issueRef: ref, provider: link.provider ?? this.provider.id };
          this.linksByIssueRef.set(ref, normalized);
          this.sessionIdByIssueRef.set(ref, normalized.sessionId);
        }
      } catch {
        // Ignore malformed state and overwrite on next write.
      }
    }
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      const parsed = JSON.parse(raw) as { sessions?: AgentSessionSnapshot[] };
      for (const session of parsed.sessions ?? []) {
        const ref = normalizeIssueRef(session.issueRef);
        const normalized = { ...session, issueRef: ref, provider: session.provider ?? this.provider.id };
        this.sessionsById.set(normalized.id, normalized);
        this.sessionIdByIssueRef.set(ref, normalized.id);
      }
    } catch {
      // Ignore malformed state and overwrite on next write.
    }
  }

  private async ensureFlowSession(): Promise<void> {
    try {
      await this.runtime.summarizeHandoff(this.flowSessionId);
    } catch {
      await this.runtime.createSession(this.flowSessionId);
    }
  }

  private async persistLinks(): Promise<void> {
    await mkdir(dirname(this.linksPath), { recursive: true });
    const links = [...this.linksByIssueRef.values()]
      .sort((a, b) => a.issueRef.localeCompare(b.issueRef))
      .map((link) => ({ ...link }));
    await writeFile(this.linksPath, `${JSON.stringify({ links }, null, 2)}\n`, "utf8");
  }

  private async persistSessionState(): Promise<void> {
    await mkdir(dirname(this.sessionsPath), { recursive: true });
    const sessions = [...this.sessionsById.values()]
      .sort((a, b) => a.issueRef.localeCompare(b.issueRef))
      .map((session) => ({ ...session, timeline: [...session.timeline] }));
    await writeFile(this.sessionsPath, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
  }

  private systemMessage(input: { id: string; issue: WorkItem; workspacePath?: string; createdAt: string }): AgentTimelineItem {
    const workspaceLine = input.workspacePath ? `Workspace: ${input.workspacePath}` : "Workspace: pending routing";
    return {
      id: input.id,
      role: "system",
      content: `Agent session started.\n${issueContext(input.issue)}\n${workspaceLine}`,
      createdAt: input.createdAt,
    };
  }

  private refreshIssueContext(session: AgentSessionSnapshot, issue: WorkItem, workspacePath?: string): void {
    session.workspacePath = workspacePath ?? session.workspacePath;
    const system = this.systemMessage({
      id: session.timeline.find((item) => item.role === "system")?.id ?? timelineId("system"),
      issue,
      workspacePath: session.workspacePath,
      createdAt: session.timeline.find((item) => item.role === "system")?.createdAt ?? nowIso(),
    });
    const systemIndex = session.timeline.findIndex((item) => item.role === "system");
    if (systemIndex >= 0) {
      session.timeline[systemIndex] = system;
    } else {
      session.timeline.unshift(system);
    }
    session.updatedAt = nowIso();
  }

  private applyDriverEvent(session: AgentSessionSnapshot, event: SessionDriverEvent): void {
    if (event.type === "assistantDelta") {
      const last = session.timeline.at(-1);
      if (last?.role === "assistant") {
        last.content += event.text;
      } else {
        session.timeline.push({
          id: timelineId("assistant"),
          role: "assistant",
          content: event.text,
          createdAt: event.timestamp,
        });
      }
    }
    if (event.type === "toolStarted") {
      const filePath = extractFilePathFromToolInput(event.toolName, event.input);
      const toolInput = typeof event.input === "object" && event.input !== null ? event.input as Record<string, unknown> : undefined;
      session.timeline.push({
        id: event.callId,
        role: "tool",
        toolName: event.toolName,
        content: `${event.toolName} started.`,
        createdAt: event.timestamp,
        ...(toolInput ? { input: toolInput } : {}),
        ...(filePath ? { diff: { path: filePath } } : {}),
      });
    }
    if (event.type === "toolFinished") {
      session.timeline.push({
        id: `${event.callId}-end`,
        role: "tool",
        content: `Tool ${event.success ? "completed" : "failed"}. ${compactText(event.output)}`,
        createdAt: event.timestamp,
      });
    }
    this.emit(session, event);
  }

  private emit(session: AgentSessionSnapshot, event: SessionDriverEvent): void {
    const listeners = this.listenersBySessionId.get(session.id);
    if (!listeners) return;
    for (const listener of listeners) {
      void listener(event);
    }
  }

  private sessionRef(session: AgentSessionSnapshot): SessionRef {
    return { workspaceId: this.flowSessionId, sessionId: session.id };
  }

  private workspaceRef(session: AgentSessionSnapshot): WorkspaceRef {
    return {
      workspaceId: this.flowSessionId,
      path: session.workspacePath ?? this.repoRoot,
      displayName: session.issueRef,
    };
  }

  private driverSnapshot(session: AgentSessionSnapshot): SessionSnapshot {
    return {
      ref: this.sessionRef(session),
      workspace: this.workspaceRef(session),
      title: session.issueRef,
      status: session.status === "running" ? "running" : session.status === "failed" ? "failed" : "idle",
      updatedAt: session.updatedAt,
      preview: session.summary ?? latestText(session),
    };
  }
}

export function workspacePathFromIssue(issue: WorkItem): string | undefined {
  for (const repoKey of issue.repoKeys ?? []) {
    const key = `workflow.repos.${repoKey}.worktree_path`;
    const value = issue.metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function issuePrompt(issue: WorkItem, input: { prompt: string; workspacePath?: string }): string {
  return [
    "You are working in Flow Desktop on the selected issue below.",
    "Use this issue context as the source of truth for the current turn.",
    "",
    input.workspacePath ? `Workspace: ${input.workspacePath}` : "Workspace: pending routing",
    "",
    "User request:",
    input.prompt,
  ].join("\n");
}

function issueContext(issue: WorkItem): string {
  const lines = [
    `Issue: ${issue.ref}`,
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
  ];
  if (issue.repoKeys?.length) lines.push(`Repos: ${issue.repoKeys.join(", ")}`);
  if (issue.summary?.trim()) lines.push(`Summary: ${issue.summary.trim()}`);

  const metadata = issue.metadata ?? {};
  for (const [label, key] of [
    ["Work status", "workflow.status"],
    ["Status detail", "workflow.status.detail"],
    ["Next pickup", "workflow.next_pickup"],
    ["Evidence", "workflow.acceptance.status"],
    ["PR", "workflow.repos.flow.pr_url"],
    ["Blocker", "workflow.blocker.summary"],
    ["Handoff", "workflow.handoff.summary"],
  ] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) lines.push(`${label}: ${value.trim()}`);
  }
  return lines.join("\n");
}

function normalizeIssueRef(value: string): string {
  return value.trim().toUpperCase();
}

function timelineId(role: string): string {
  return `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestText(session: AgentSessionSnapshot): string | undefined {
  return [...session.timeline].reverse().find((item) => item.role === "assistant" || item.role === "user")?.content;
}

function compactText(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
}

function extractFilePathFromToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const name = toolName.toLowerCase();
  const isFileTool = name.includes("edit") || name.includes("write") || name.includes("create") || name.includes("notebookedit");
  if (!isFileTool) return undefined;
  const args = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return undefined;
}
