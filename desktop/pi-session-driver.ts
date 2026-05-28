import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IssueStateValue, type WorkItem } from "../src/contracts.js";
import type { FlowWorkRuntime } from "../src/work-runtime.js";
import { PiSdkSessionRunner } from "./pi-sdk-runner.js";
import type { SessionDriverEvent, SessionEventListener, SessionRef, SessionSnapshot, Unsubscribe, WorkspaceRef } from "./session-driver.js";

type RuntimeIssueSurface = Pick<FlowWorkRuntime, "createSession" | "inspectIssue" | "inspectQueue" | "inspectBacklog" | "selectIssue" | "summarizeHandoff">;

export interface FlowSessionLink {
  issueRef: string;
  flowSessionId: string;
  piSessionId: string;
  piSessionFile?: string;
  workspacePath?: string;
  provider?: string;
  status?: PiSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PiTimelineItem {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolName?: string;
  diff?: {
    path: string;
    before?: string;
    after?: string;
  };
}

export interface PiSessionSnapshot {
  id: string;
  issueRef: string;
  flowSessionId: string;
  sessionFile?: string;
  workspacePath?: string;
  status: PiSessionStatus;
  error?: string;
  startedAt: string;
  updatedAt: string;
  timeline: PiTimelineItem[];
}

export interface PiSessionDriverOptions {
  runtime: RuntimeIssueSurface;
  repoRoot: string;
  flowSessionId?: string;
  agent?: PiAgentRunner | false;
}

export interface PiAgentPromptInput {
  sessionId: string;
  sessionFile?: string;
  issueRef: string;
  prompt: string;
  repoRoot: string;
  workspacePath?: string;
  onEvent?: SessionEventListener;
}

export interface PiAgentPromptResult {
  sessionId: string;
  sessionFile?: string;
  workspacePath?: string;
  status?: PiSessionStatus;
  summary?: string;
  timeline?: PiTimelineItem[];
}

export interface PiAgentRunner {
  prompt(input: PiAgentPromptInput): Promise<PiAgentPromptResult>;
}

export type PiSessionStatus = "active" | "running" | "paused" | "done" | "failed";

export class PiSessionDriver {
  private readonly runtime: RuntimeIssueSurface;
  private readonly flowSessionId: string;
  private readonly repoRoot: string;
  private readonly agent?: PiAgentRunner;
  private readonly linksPath: string;
  private readonly sessionsPath: string;
  private readonly sessionsById = new Map<string, PiSessionSnapshot>();
  private readonly sessionIdByIssueRef = new Map<string, string>();
  private readonly linksByIssueRef = new Map<string, FlowSessionLink>();
  private readonly listenersBySessionId = new Map<string, Set<SessionEventListener>>();
  private linksLoaded = false;

  constructor(options: PiSessionDriverOptions) {
    this.runtime = options.runtime;
    this.flowSessionId = options.flowSessionId ?? "desktop";
    this.repoRoot = options.repoRoot;
    this.agent = options.agent === false ? undefined : options.agent ?? new PiSdkSessionRunner();
    this.linksPath = join(options.repoRoot, ".flow", "runtime", "pi-session-links.json");
    this.sessionsPath = join(options.repoRoot, ".flow", "runtime", "pi-session-state.json");
  }

  async startSession(issueRef: string): Promise<PiSessionSnapshot> {
    const normalizedRef = normalizeIssueRef(issueRef);
    await this.ensureFlowSession();
    const issue = await this.resolveIssue(normalizedRef);
    await this.runtime.selectIssue(this.flowSessionId, issue);
    await this.ensureLoadedLinks();

    const existingId = this.sessionIdByIssueRef.get(normalizedRef);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing) return existing;
    }

    const now = nowIso();
    const link = this.linksByIssueRef.get(normalizedRef);
    const sessionId = link?.piSessionId ?? `pi-${normalizedRef.toLowerCase()}-${Date.now().toString(36)}`;
    const workspacePath = workspacePathFromIssue(issue);

    const snapshot: PiSessionSnapshot = {
      id: sessionId,
      issueRef: normalizedRef,
      flowSessionId: this.flowSessionId,
      sessionFile: link?.piSessionFile,
      workspacePath,
      status: link?.status ?? "active",
      startedAt: link?.createdAt ?? now,
      updatedAt: now,
      timeline: [this.systemMessage({
        id: timelineId("system"),
        issueRef: normalizedRef,
        workspacePath,
        createdAt: now,
      })],
    };

    this.sessionsById.set(sessionId, snapshot);
    this.sessionIdByIssueRef.set(normalizedRef, sessionId);
    this.linksByIssueRef.set(normalizedRef, {
      issueRef: normalizedRef,
      flowSessionId: this.flowSessionId,
      piSessionId: sessionId,
      piSessionFile: snapshot.sessionFile,
      workspacePath,
      provider: "pi",
      status: snapshot.status,
      createdAt: link?.createdAt ?? now,
      updatedAt: now,
    });
    await this.persistLinks();
    await this.persistSessionState();
    return snapshot;
  }

  async getSession(sessionId: string): Promise<PiSessionSnapshot> {
    await this.ensureLoadedLinks();
    const session = this.sessionsById.get(sessionId);
    if (!session) throw new Error(`Unknown pi session ${sessionId}.`);
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

  async postPrompt(sessionId: string, prompt: string): Promise<PiSessionSnapshot> {
    const session = await this.getSession(sessionId);
    const text = prompt.trim();
    if (!text) throw new Error("Prompt is required.");

    const createdAt = nowIso();
    session.timeline.push({
      id: timelineId("user"),
      role: "user",
      content: text,
      createdAt,
    });
    session.status = "running";
    session.updatedAt = nowIso();
    this.emit(session, {
      type: "sessionUpdated",
      sessionRef: this.sessionRef(session),
      timestamp: nowIso(),
      snapshot: this.driverSnapshot(session),
    });

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
          prompt: text,
          repoRoot: this.repoRoot,
          workspacePath: session.workspacePath,
          onEvent: (event) => this.applyDriverEvent(session, event),
        });
        if (result.sessionId && result.sessionId !== session.id) {
          this.sessionsById.delete(session.id);
          session.id = result.sessionId;
          this.sessionsById.set(session.id, session);
          this.sessionIdByIssueRef.set(session.issueRef, session.id);
        }
        session.sessionFile = result.sessionFile ?? session.sessionFile;
        session.workspacePath = result.workspacePath ?? session.workspacePath;
        session.status = result.status ?? "active";
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
        session.status = "failed";
        session.error = errorMessage(error);
        const content = `Pi session failed: ${session.error}`;
        session.timeline.push({
          id: timelineId("assistant"),
          role: "assistant",
          content,
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
    const link = this.linksByIssueRef.get(session.issueRef);
    if (link) {
      link.piSessionId = session.id;
      link.piSessionFile = session.sessionFile;
      link.workspacePath = session.workspacePath;
      link.provider = "pi";
      link.status = session.status;
      link.updatedAt = session.updatedAt;
      await this.persistLinks();
      await this.persistSessionState();
    }
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
    return session;
  }

  async sendUserMessage(sessionId: string, input: { text: string }): Promise<PiSessionSnapshot> {
    return this.postPrompt(sessionId, input.text);
  }

  async openOrCreateIssueSession(issueRef: string): Promise<PiSessionSnapshot> {
    return this.startSession(issueRef);
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

  private async ensureLoadedLinks(): Promise<void> {
    if (this.linksLoaded) return;
    this.linksLoaded = true;

    if (existsSync(this.linksPath)) {
      try {
        const raw = await readFile(this.linksPath, "utf8");
        const parsed = JSON.parse(raw) as { links?: FlowSessionLink[] };
        for (const link of parsed.links ?? []) {
          const ref = normalizeIssueRef(link.issueRef);
          this.linksByIssueRef.set(ref, { ...link, issueRef: ref });
          this.sessionIdByIssueRef.set(ref, link.piSessionId);
        }
      } catch {
        // Ignore malformed state and overwrite on next write.
      }
    }
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      const parsed = JSON.parse(raw) as { sessions?: PiSessionSnapshot[] };
      for (const session of parsed.sessions ?? []) {
        const ref = normalizeIssueRef(session.issueRef);
        const normalized = { ...session, issueRef: ref };
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

  private systemMessage(input: { id: string; issueRef: string; workspacePath?: string; createdAt: string }): PiTimelineItem {
    const workspaceLine = input.workspacePath ? `Workspace: ${input.workspacePath}` : "Workspace: pending routing";
    return {
      id: input.id,
      role: "system",
      content: `Pi session started for ${input.issueRef}.\n${workspaceLine}`,
      createdAt: input.createdAt,
    };
  }

  private applyDriverEvent(session: PiSessionSnapshot, event: SessionDriverEvent): void {
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
      session.timeline.push({
        id: event.callId,
        role: "tool",
        toolName: event.toolName,
        content: `${event.toolName} started.`,
        createdAt: event.timestamp,
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

  private emit(session: PiSessionSnapshot, event: SessionDriverEvent): void {
    const listeners = this.listenersBySessionId.get(session.id);
    if (!listeners) return;
    for (const listener of listeners) {
      void listener(event);
    }
  }

  private sessionRef(session: PiSessionSnapshot): SessionRef {
    return { workspaceId: this.flowSessionId, sessionId: session.id };
  }

  private workspaceRef(session: PiSessionSnapshot): WorkspaceRef {
    return {
      workspaceId: this.flowSessionId,
      path: session.workspacePath ?? this.repoRoot,
      displayName: session.issueRef,
    };
  }

  private driverSnapshot(session: PiSessionSnapshot): SessionSnapshot {
    return {
      ref: this.sessionRef(session),
      workspace: this.workspaceRef(session),
      title: session.issueRef,
      status: session.status === "running" ? "running" : session.status === "failed" ? "failed" : "idle",
      updatedAt: session.updatedAt,
      preview: latestText(session),
    };
  }
}

function workspacePathFromIssue(issue: WorkItem): string | undefined {
  for (const repoKey of issue.repoKeys ?? []) {
    const key = `workflow.repos.${repoKey}.worktree_path`;
    const value = issue.metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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

function latestText(session: PiSessionSnapshot): string | undefined {
  return [...session.timeline].reverse().find((item) => item.role === "assistant" || item.role === "user")?.content;
}

function compactText(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
}
