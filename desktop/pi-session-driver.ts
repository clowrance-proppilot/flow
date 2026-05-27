import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IssueStateValue, type WorkItem } from "../src/contracts.js";
import type { FlowWorkRuntime } from "../src/work-runtime.js";

type RuntimeIssueSurface = Pick<FlowWorkRuntime, "createSession" | "inspectIssue" | "inspectQueue" | "inspectBacklog" | "selectIssue" | "summarizeHandoff">;

export interface FlowSessionLink {
  issueRef: string;
  flowSessionId: string;
  piSessionId: string;
  workspacePath?: string;
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
  workspacePath?: string;
  startedAt: string;
  updatedAt: string;
  timeline: PiTimelineItem[];
}

export interface PiSessionDriverOptions {
  runtime: RuntimeIssueSurface;
  repoRoot: string;
  flowSessionId?: string;
}

export class PiSessionDriver {
  private readonly runtime: RuntimeIssueSurface;
  private readonly flowSessionId: string;
  private readonly linksPath: string;
  private readonly sessionsById = new Map<string, PiSessionSnapshot>();
  private readonly sessionIdByIssueRef = new Map<string, string>();
  private readonly linksByIssueRef = new Map<string, FlowSessionLink>();
  private linksLoaded = false;

  constructor(options: PiSessionDriverOptions) {
    this.runtime = options.runtime;
    this.flowSessionId = options.flowSessionId ?? "desktop";
    this.linksPath = join(options.repoRoot, ".flow", "runtime", "pi-session-links.json");
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
      workspacePath,
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
      workspacePath,
      createdAt: link?.createdAt ?? now,
      updatedAt: now,
    });
    await this.persistLinks();
    return snapshot;
  }

  async getSession(sessionId: string): Promise<PiSessionSnapshot> {
    const session = this.sessionsById.get(sessionId);
    if (!session) throw new Error(`Unknown pi session ${sessionId}.`);
    return session;
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

    const handoff = await this.runtime.summarizeHandoff(session.flowSessionId).catch(() => "");
    session.timeline.push({
      id: timelineId("assistant"),
      role: "assistant",
      content: handoff
        ? `Queued prompt for ${session.issueRef}.\n\n${handoff}`
        : `Queued prompt for ${session.issueRef}.`,
      createdAt: nowIso(),
    });

    session.updatedAt = nowIso();
    const link = this.linksByIssueRef.get(session.issueRef);
    if (link) {
      link.updatedAt = session.updatedAt;
      await this.persistLinks();
    }
    return session;
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
    if (!existsSync(this.linksPath)) return;

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

  private systemMessage(input: { id: string; issueRef: string; workspacePath?: string; createdAt: string }): PiTimelineItem {
    const workspaceLine = input.workspacePath ? `Workspace: ${input.workspacePath}` : "Workspace: pending routing";
    return {
      id: input.id,
      role: "system",
      content: `Pi session started for ${input.issueRef}.\n${workspaceLine}`,
      createdAt: input.createdAt,
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
