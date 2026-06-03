import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import type { PiAgentPromptInput, PiAgentPromptResult, PiAgentRunner, PiTimelineItem } from "./pi-session-driver.js";
import type { SessionDriverEvent } from "../session-driver.js";

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
  followUp?: (text: string, options?: Record<string, unknown>) => Promise<void>;
  steer?: (text: string, options?: Record<string, unknown>) => Promise<void>;
  subscribe?: (listener: (event: Record<string, unknown>) => void) => () => void;
  dispose?: () => void | Promise<void>;
};

export const FLOW_PI_AGENT_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface PiSdkSessionRunnerOptions {
  loadModule?: () => Promise<PiSdkModule>;
  tools?: readonly string[];
}

export class PiSdkSessionRunner implements PiAgentRunner {
  private readonly loadModule: () => Promise<PiSdkModule>;
  private readonly useChildProcess: boolean;
  private readonly tools: readonly string[];

  constructor(options: PiSdkSessionRunnerOptions = {}) {
    this.loadModule = options.loadModule ?? loadPiSdkModule;
    this.useChildProcess = !options.loadModule && typeof process.versions.electron === "string";
    this.tools = options.tools ?? FLOW_PI_AGENT_TOOLS;
  }

  async prompt(input: PiAgentPromptInput): Promise<PiAgentPromptResult> {
    if (this.useChildProcess) return promptWithNodeChild(input, this.tools);

    const pi = await this.loadModule();
    if (!pi.createAgentSession || !pi.SessionManager) {
      throw new Error("The installed @earendil-works/pi-coding-agent package does not expose the SDK session API.");
    }

    const cwd = input.workspacePath || input.repoRoot;
    const sessionManager = input.sessionFile && existsSync(input.sessionFile)
      ? pi.SessionManager.open(input.sessionFile, undefined, cwd)
      : pi.SessionManager.create(cwd);
    const { session, modelFallbackMessage } = await pi.createAgentSession({
      cwd,
      sessionManager,
      tools: [...this.tools],
    });
    const timeline: PiTimelineItem[] = [];
    let assistantText = "";
    const unsubscribe = session.subscribe?.((event) => {
      const item = timelineItemFromPiEvent(event);
      if (item) timeline.push(item);
      const driverEvent = driverEventFromPiEvent(event, input, session.sessionId);
      if (driverEvent) void input.onEvent?.(driverEvent);
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
      await sendPiMessage(session, input.prompt, input.mode);
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

async function sendPiMessage(session: PiSdkSession, prompt: string, mode: PiAgentPromptInput["mode"]): Promise<void> {
  if (mode === "followUp" && session.followUp) return await session.followUp(prompt);
  if (mode === "steer" && session.steer) return await session.steer(prompt);
  return await session.prompt(prompt);
}

async function loadPiSdkModule(): Promise<PiSdkModule> {
  const packageName = "@earendil-works/pi-coding-agent";
  try {
    return await import(packageName) as PiSdkModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ERR_MODULE_NOT_FOUND" || message.includes(`Cannot find package '${packageName}'`)) {
      throw new Error(`Pi SDK is not installed. Install dependency ${packageName} to run real pi sessions. ${message}`);
    }
    throw new Error(`Pi SDK failed to load. ${message}`);
  }
}

function resolveNodeBinary(): string {
  if (process.env.FLOW_NODE_BIN) return process.env.FLOW_NODE_BIN;
  // In packaged Electron builds, process.execPath points to the Electron binary
  // which includes Node.js. In dev, use the system node.
  if (typeof process.versions.electron === "string") return process.execPath;
  return "node";
}

async function promptWithNodeChild(input: PiAgentPromptInput, tools: readonly string[]): Promise<PiAgentPromptResult> {
  const cwd = input.workspacePath || input.repoRoot;
  const nodeBin = resolveNodeBinary();
  const child = spawn(nodeBin, ["--input-type=module", "--eval", childRunnerSource()], {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let pendingStdout = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    pendingStdout += chunk;
    const lines = pendingStdout.split(/\r?\n/);
    pendingStdout = lines.pop() ?? "";
    for (const line of lines) handleChildEventLine(line, input);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ ...input, tools: [...tools] })}\n`, "utf8");

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const marker = "__FLOW_PI_RESULT__";
  if (pendingStdout) handleChildEventLine(pendingStdout, input);
  const resultLine = stdout.split(/\r?\n/).reverse().find((line) => line.startsWith(marker));
  if (!resultLine) {
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").trim();
    throw new Error(`Pi SDK worker failed${exit.signal ? ` (${exit.signal})` : ""}${detail ? `: ${compactText(detail)}` : "."}`);
  }
  const parsed = JSON.parse(resultLine.slice(marker.length)) as PiAgentPromptResult & { error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

export function childRunnerSource(): string {
  return String.raw`
import { existsSync } from "node:fs";

const input = JSON.parse(await readStdin());
const eventMarker = "__FLOW_PI_EVENT__";
try {
  const pi = await import("@earendil-works/pi-coding-agent");
  if (!pi.createAgentSession || !pi.SessionManager) {
    throw new Error("The installed @earendil-works/pi-coding-agent package does not expose the SDK session API.");
  }
  const cwd = input.workspacePath || input.repoRoot;
  const sessionManager = input.sessionFile && existsSync(input.sessionFile)
    ? pi.SessionManager.open(input.sessionFile, undefined, cwd)
    : pi.SessionManager.create(cwd);
  const tools = Array.isArray(input.tools) ? input.tools.filter((tool) => typeof tool === "string") : undefined;
  const { session, modelFallbackMessage } = await pi.createAgentSession({ cwd, sessionManager, tools });
  const timeline = [];
  let assistantText = "";
  const unsubscribe = session.subscribe?.((event) => {
    const item = timelineItemFromPiEvent(event);
    if (item) timeline.push(item);
    const driverEvent = driverEventFromPiEvent(event, input, session.sessionId);
    if (driverEvent) console.log(eventMarker + JSON.stringify(driverEvent));
    if (event.type === "message_update") {
      const update = recordAt(event, "assistantMessageEvent");
      if (update?.type === "text_delta" && typeof update.delta === "string") assistantText += update.delta;
    }
    if (event.type === "message_end") {
      const text = messageText(recordAt(event, "message"));
      if (text) assistantText = text;
    }
  });
  try {
    await sendPiMessage(session, input.prompt, input.mode);
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
  writeResult({
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    workspacePath: cwd,
    status: "active",
    summary,
    timeline,
  });
} catch (error) {
  writeResult({ error: error instanceof Error ? error.message : String(error) });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

function writeResult(value) {
  console.log("__FLOW_PI_RESULT__" + JSON.stringify(value));
}

async function sendPiMessage(session, prompt, mode) {
  if (mode === "followUp" && typeof session.followUp === "function") return await session.followUp(prompt);
  if (mode === "steer" && typeof session.steer === "function") return await session.steer(prompt);
  return await session.prompt(prompt);
}

function timelineItemFromPiEvent(event) {
  const now = new Date().toISOString();
  if (event.type === "tool_execution_start") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    return {
      id: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      role: "tool",
      toolName,
      content: toolName + " started.",
      createdAt: now,
    };
  }
  if (event.type === "tool_execution_end") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const isError = event.isError === true;
    return {
      id: typeof event.toolCallId === "string" ? event.toolCallId + "-end" : timelineId("tool"),
      role: "tool",
      toolName,
      content: toolName + " " + (isError ? "failed" : "completed") + ". " + compactText(event.result),
      createdAt: now,
    };
  }
  return undefined;
}

function driverEventFromPiEvent(event, input, sessionId) {
  const timestamp = new Date().toISOString();
  const sessionRef = {
    workspaceId: input.workspacePath || input.repoRoot,
    sessionId: sessionId || input.sessionId,
  };
  if (event.type === "message_update") {
    const update = recordAt(event, "assistantMessageEvent");
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      return {
        type: "assistantDelta",
        sessionRef,
        timestamp,
        text: update.delta,
      };
    }
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: typeof event.toolName === "string" ? event.toolName : "tool",
      callId: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      input: event.args,
    };
  }
  if (event.type === "tool_execution_update") {
    const partial = event.partialResult;
    return {
      type: "toolUpdated",
      sessionRef,
      timestamp,
      callId: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      ...(typeof partial === "string" ? { text: partial } : {}),
      ...(typeof partial === "number" ? { progress: partial } : {}),
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      success: event.isError !== true,
      output: event.result,
    };
  }
  return undefined;
}

function messageText(value) {
  const message = record(value);
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map(contentPartText).filter(Boolean).join("\n").trim();
}

function contentPartText(value) {
  if (typeof value === "string") return value;
  const part = record(value);
  if (!part) return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return "";
}

function recordAt(value, key) {
  return record(value[key]);
}

function record(value) {
  return typeof value === "object" && value !== null ? value : undefined;
}

function compactText(value) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > 240 ? raw.slice(0, 237) + "..." : raw;
}

function timelineId(role) {
  return role + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
`;
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

function handleChildEventLine(line: string, input: PiAgentPromptInput): void {
  const marker = "__FLOW_PI_EVENT__";
  if (!line.startsWith(marker)) return;
  try {
    void input.onEvent?.(JSON.parse(line.slice(marker.length)) as SessionDriverEvent);
  } catch {
    // Ignore malformed worker event frames; final result still reports failures.
  }
}

function driverEventFromPiEvent(
  event: Record<string, unknown>,
  input: Pick<PiAgentPromptInput, "sessionId" | "repoRoot" | "workspacePath">,
  sessionId: string,
): SessionDriverEvent | undefined {
  const timestamp = new Date().toISOString();
  const sessionRef = {
    workspaceId: input.workspacePath || input.repoRoot,
    sessionId: sessionId || input.sessionId,
  };
  if (event.type === "message_update") {
    const update = recordAt(event, "assistantMessageEvent");
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      return {
        type: "assistantDelta",
        sessionRef,
        timestamp,
        text: update.delta,
      };
    }
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: typeof event.toolName === "string" ? event.toolName : "tool",
      callId: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      input: event.args,
    };
  }
  if (event.type === "tool_execution_update") {
    const partial = event.partialResult;
    return {
      type: "toolUpdated",
      sessionRef,
      timestamp,
      callId: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      ...(typeof partial === "string" ? { text: partial } : {}),
      ...(typeof partial === "number" ? { progress: partial } : {}),
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId: typeof event.toolCallId === "string" ? event.toolCallId : timelineId("tool"),
      success: event.isError !== true,
      output: event.result,
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
