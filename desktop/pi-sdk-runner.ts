import { existsSync } from "node:fs";

import type { PiAgentPromptInput, PiAgentPromptResult, PiAgentRunner, PiTimelineItem } from "./pi-session-driver.js";

type PiSdkModule = {
  createAgentSession?: (options?: Record<string, unknown>) => Promise<{
    session: PiSdkSession;
    modelFallbackMessage?: string;
  }>;
  SessionManager?: {
    create: (cwd: string, sessionDir?: string) => unknown;
    open: (path: string, sessionDir?: string, cwdOverride?: string) => unknown;
  };
};

type PiSdkSession = {
  sessionId: string;
  sessionFile?: string;
  prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
  subscribe?: (listener: (event: Record<string, unknown>) => void) => () => void;
  dispose?: () => void | Promise<void>;
};

export interface PiSdkSessionRunnerOptions {
  loadModule?: () => Promise<PiSdkModule>;
}

export class PiSdkSessionRunner implements PiAgentRunner {
  private readonly loadModule: () => Promise<PiSdkModule>;

  constructor(options: PiSdkSessionRunnerOptions = {}) {
    this.loadModule = options.loadModule ?? loadPiSdkModule;
  }

  async prompt(input: PiAgentPromptInput): Promise<PiAgentPromptResult> {
    const pi = await this.loadModule();
    if (!pi.createAgentSession || !pi.SessionManager) {
      throw new Error("The installed @earendil-works/pi-coding-agent package does not expose the SDK session API.");
    }

    const cwd = input.workspacePath || input.repoRoot;
    const sessionManager = input.sessionFile && existsSync(input.sessionFile)
      ? pi.SessionManager.open(input.sessionFile, undefined, cwd)
      : pi.SessionManager.create(cwd);
    const { session, modelFallbackMessage } = await pi.createAgentSession({ cwd, sessionManager });
    const timeline: PiTimelineItem[] = [];
    let assistantText = "";
    const unsubscribe = session.subscribe?.((event) => {
      const item = timelineItemFromPiEvent(event);
      if (item) timeline.push(item);
      if (event.type === "message_update") {
        const update = recordAt(event, "assistantMessageEvent");
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          assistantText += update.delta;
        }
      }
      if (event.type === "message_end") {
        const text = messageText(recordAt(event, "message"));
        if (text) assistantText = text;
      }
    });

    try {
      await session.prompt(input.prompt);
    } finally {
      unsubscribe?.();
      await session.dispose?.();
    }

    const summary = assistantText.trim() || modelFallbackMessage || "Pi prompt completed.";
    timeline.push({
      id: timelineId("assistant"),
      role: "assistant",
      content: summary,
      createdAt: new Date().toISOString(),
    });

    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      workspacePath: cwd,
      status: "active",
      summary,
      timeline,
    };
  }
}

async function loadPiSdkModule(): Promise<PiSdkModule> {
  const packageName = "@earendil-works/pi-coding-agent";
  try {
    return await import(packageName) as PiSdkModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Pi SDK is not installed. Install optional dependency @earendil-works/pi-coding-agent to run real pi sessions. ${message}`,
    );
  }
}

function timelineItemFromPiEvent(event: Record<string, unknown>): PiTimelineItem | undefined {
  const now = new Date().toISOString();
  if (event.type === "tool_execution_start") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    return {
      id: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      role: "tool",
      toolName,
      content: `${toolName} started.`,
      createdAt: now,
    };
  }
  if (event.type === "tool_execution_end") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const isError = event.isError === true;
    return {
      id: typeof event.toolCallId === "string" ? `${event.toolCallId}-end` : timelineId("tool"),
      role: "tool",
      toolName,
      content: `${toolName} ${isError ? "failed" : "completed"}. ${compactText(event.result)}`,
      createdAt: now,
    };
  }
  return undefined;
}

function messageText(value: unknown): string {
  const message = record(value);
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map(contentPartText).filter(Boolean).join("\n").trim();
}

function contentPartText(value: unknown): string {
  if (typeof value === "string") return value;
  const part = record(value);
  if (!part) return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return "";
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return record(value[key]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function compactText(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > 240 ? `${raw.slice(0, 237)}...` : raw;
}

function timelineId(role: string): string {
  return `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
