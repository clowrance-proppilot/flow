import type { AgentPromptInput, AgentPromptResult, AgentRunner, AgentTimelineItem } from "./agent-session-driver.js";
import type { SessionDriverEvent } from "./session-driver.js";

type ClaudeAgentSdkModule = {
  query: (params: { prompt: string; options?: ClaudeQueryOptions }) => AsyncIterable<ClaudeSdkMessage>;
};

type ClaudeQueryOptions = {
  allowedTools?: string[];
  cwd?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
  resume?: string;
  sessionId?: string;
  settingSources?: Array<"user" | "project" | "local">;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  tools?: string[] | { type: "preset"; preset: "claude_code" };
};

type ClaudeSdkMessage = Record<string, unknown> & {
  session_id?: string;
  type?: string;
  subtype?: string;
  uuid?: string;
};

export const FLOW_CLAUDE_AGENT_TOOLS = Object.freeze(["Read", "Bash", "Edit", "Write", "Glob", "Grep"]);

export interface ClaudeAgentRunnerOptions {
  allowedTools?: readonly string[];
  loadModule?: () => Promise<ClaudeAgentSdkModule>;
  permissionMode?: ClaudeQueryOptions["permissionMode"];
  settingSources?: ClaudeQueryOptions["settingSources"];
  systemPromptAppend?: string;
  tools?: ClaudeQueryOptions["tools"];
}

export class ClaudeAgentRunner implements AgentRunner {
  private readonly allowedTools: readonly string[];
  private readonly loadModule: () => Promise<ClaudeAgentSdkModule>;
  private readonly permissionMode: ClaudeQueryOptions["permissionMode"];
  private readonly settingSources: ClaudeQueryOptions["settingSources"];
  private readonly systemPromptAppend?: string;
  private readonly tools: ClaudeQueryOptions["tools"];

  constructor(options: ClaudeAgentRunnerOptions = {}) {
    this.allowedTools = options.allowedTools ?? FLOW_CLAUDE_AGENT_TOOLS;
    this.loadModule = options.loadModule ?? loadClaudeAgentSdkModule;
    this.permissionMode = options.permissionMode ?? "dontAsk";
    this.settingSources = options.settingSources ?? ["project"];
    this.systemPromptAppend = options.systemPromptAppend;
    this.tools = options.tools ?? [...this.allowedTools];
  }

  async prompt(input: AgentPromptInput): Promise<AgentPromptResult> {
    const sdk = await this.loadModule();
    const cwd = input.workspacePath || input.repoRoot;
    const timeline: AgentTimelineItem[] = [];
    let assistantText = "";
    let resultText = "";
    let sessionId = input.sessionId;
    let failed = false;

    const options: ClaudeQueryOptions = {
      allowedTools: [...this.allowedTools],
      cwd,
      permissionMode: this.permissionMode,
      settingSources: this.settingSources,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(this.systemPromptAppend ? { append: this.systemPromptAppend } : {}),
      },
      tools: this.tools,
      ...(input.mode === "followUp" || input.mode === "steer" ? { resume: input.sessionId } : { sessionId: input.sessionId }),
    };

    for await (const message of sdk.query({ prompt: input.prompt, options })) {
      sessionId = typeof message.session_id === "string" ? message.session_id : sessionId;
      const item = timelineItemFromClaudeMessage(message);
      if (item) timeline.push(item);
      const driverEvent = driverEventFromClaudeMessage(message, input, sessionId);
      if (driverEvent) void input.onEvent?.(driverEvent);

      if (message.type === "assistant") {
        const text = messageText(recordAt(message, "message"));
        if (text) assistantText = appendText(assistantText, text);
      }
      if (message.type === "result") {
        if (typeof message.result === "string") resultText = message.result.trim();
        failed = message.is_error === true || String(message.subtype ?? "").startsWith("error");
      }
    }

    const summary = resultText || assistantText.trim() || "Claude prompt completed.";
    if (!timeline.some((item) => item.role === "assistant" && item.content === summary)) {
      timeline.push({
        id: timelineId("assistant"),
        role: "assistant",
        content: summary,
        createdAt: new Date().toISOString(),
      });
    }

    return {
      sessionId,
      workspacePath: cwd,
      status: failed ? "failed" : "active",
      summary,
      timeline,
    };
  }
}

async function loadClaudeAgentSdkModule(): Promise<ClaudeAgentSdkModule> {
  const packageName = "@anthropic-ai/claude-agent-sdk";
  try {
    return await import(packageName) as ClaudeAgentSdkModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ERR_MODULE_NOT_FOUND" || message.includes(`Cannot find package '${packageName}'`)) {
      throw new Error(`Claude Agent SDK is not installed. Install dependency ${packageName} to run Claude sessions. ${message}`);
    }
    throw new Error(`Claude Agent SDK failed to load. ${message}`);
  }
}

function timelineItemFromClaudeMessage(message: ClaudeSdkMessage): AgentTimelineItem | undefined {
  const now = new Date().toISOString();
  const id = typeof message.uuid === "string" ? message.uuid : timelineId("claude");
  if (message.type === "assistant") {
    const content = messageText(recordAt(message, "message"));
    if (!content) return undefined;
    return { id, role: "assistant", content, createdAt: now };
  }
  if (message.type === "tool_progress") {
    const toolName = stringAt(message, "tool_name") ?? "tool";
    return {
      id: stringAt(message, "tool_use_id") ?? id,
      role: "tool",
      toolName,
      content: `${toolName} running for ${Number(message.elapsed_time_seconds ?? 0).toFixed(1)}s.`,
      createdAt: now,
    };
  }
  if (message.type === "tool_use_summary") {
    return {
      id,
      role: "tool",
      content: stringAt(message, "summary") ?? "Claude tool use completed.",
      createdAt: now,
    };
  }
  if (message.type === "system" && message.subtype === "task_started") {
    return {
      id,
      role: "tool",
      toolName: "Agent",
      content: stringAt(message, "description") ?? "Claude task started.",
      createdAt: now,
    };
  }
  if (message.type === "system" && message.subtype === "task_progress") {
    return {
      id,
      role: "tool",
      toolName: stringAt(message, "last_tool_name") ?? "Agent",
      content: stringAt(message, "summary") ?? stringAt(message, "description") ?? "Claude task progressed.",
      createdAt: now,
    };
  }
  return undefined;
}

function driverEventFromClaudeMessage(
  message: ClaudeSdkMessage,
  input: Pick<AgentPromptInput, "sessionId" | "repoRoot" | "workspacePath">,
  sessionId: string,
): SessionDriverEvent | undefined {
  const timestamp = new Date().toISOString();
  const sessionRef = {
    workspaceId: input.workspacePath || input.repoRoot,
    sessionId,
  };
  if (message.type === "assistant") {
    const text = messageText(recordAt(message, "message"));
    if (text) return { type: "assistantDelta", sessionRef, timestamp, text };
  }
  if (message.type === "tool_progress") {
    return {
      type: "toolUpdated",
      sessionRef,
      timestamp,
      callId: stringAt(message, "tool_use_id") ?? timelineId("tool"),
      text: stringAt(message, "tool_name"),
    };
  }
  if (message.type === "tool_use_summary") {
    return {
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId: stringAt(message, "preceding_tool_use_ids") ?? timelineId("tool"),
      success: true,
      output: stringAt(message, "summary"),
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
  if (part.type === "tool_use" && typeof part.name === "string") return `[tool:${part.name}]`;
  return "";
}

function appendText(existing: string, next: string): string {
  if (!existing) return next;
  if (existing.includes(next)) return existing;
  return `${existing}\n${next}`;
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return record(value[key]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (typeof field === "string") return field;
  if (Array.isArray(field)) return field.filter((item): item is string => typeof item === "string").join(",");
  return undefined;
}

function timelineId(role: string): string {
  return `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
