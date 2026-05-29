import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { ContextProjection, ConversationItem, PiActivityState, PiSessionSnapshot, PiTimelineItem } from "./types";

export function conversationItemToThreadMessage(item: ConversationItem): ThreadMessageLike {
  return {
    id: item.id,
    role: item.role === "user" ? "user" : "assistant",
    content: [{ type: "text", text: item.text }],
    createdAt: new Date(item.createdAt),
    status: item.role === "assistant" ? { type: "complete", reason: "stop" } : undefined,
  };
}

export function extractAppendMessageText(message: AppendMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

export function seedConversation(context?: ContextProjection, projectId?: string, issueRef?: string): ConversationItem[] {
  const target = issueRef || context?.active?.issueRef;
  const label = target ? `Selected ${target}.` : projectId ? "Project loaded." : "Flow desktop is ready.";
  return [{
    id: "system-empty",
    role: "system",
    text: `${label} Use the composer for the current turn; older prompt history stays out of the default view.`,
    createdAt: new Date().toISOString(),
  }];
}

export function conversationFromPiSession(session: PiSessionSnapshot): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const item of session.timeline) {
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = item.content.trim();
    if (!text) continue;
    const previous = items.at(-1);
    if (previous?.role === item.role && previous.text.trim() === text) continue;
    items.push({
      id: `pi-${session.id}-${item.id}`,
      role: item.role,
      text,
      createdAt: item.createdAt,
    });
  }
  return items.length ? items : seedConversation(undefined, undefined, session.issueRef);
}

export function activityFromPiSession(session: PiSessionSnapshot): PiActivityState {
  const latest = [...session.timeline].reverse().find((item) => item.content.trim());
  if (session.status === "failed") {
    return {
      phase: "failed",
      label: "Pi failed",
      detail: compactActivityText(latest?.content || "Check the latest response for details."),
      updatedAt: latest?.createdAt,
    };
  }
  if (session.status === "running") {
    return activityFromTimelineItem(latest, "Pi is working");
  }
  if (session.status === "done") {
    return {
      phase: "done",
      label: "Pi finished",
      detail: latest ? compactActivityText(latest.content) : undefined,
      updatedAt: latest?.createdAt,
    };
  }
  return {
    phase: "idle",
    label: "Pi ready",
    detail: latest ? compactActivityText(latest.content) : undefined,
    updatedAt: latest?.createdAt,
  };
}

export function activityFromPiEvent(event: { type: string; timestamp: string; text?: string; toolName?: string; success?: boolean; error?: { message?: string } }): PiActivityState | undefined {
  if (event.type === "assistantDelta" && event.text) {
    return {
      phase: "responding",
      label: "Pi is answering",
      detail: compactActivityText(event.text),
      updatedAt: event.timestamp,
    };
  }
  if (event.type === "toolStarted" || event.type === "toolUpdated") {
    return {
      phase: "tool",
      label: event.toolName ? `Using ${event.toolName}` : "Using a tool",
      toolName: event.toolName,
      updatedAt: event.timestamp,
    };
  }
  if (event.type === "toolFinished") {
    return {
      phase: "thinking",
      label: event.success === false ? "Tool failed" : "Tool finished",
      detail: event.toolName,
      toolName: event.toolName,
      updatedAt: event.timestamp,
    };
  }
  if (event.type === "runFailed") {
    return {
      phase: "failed",
      label: "Pi failed",
      detail: compactActivityText(event.error?.message || "Run failed."),
      updatedAt: event.timestamp,
    };
  }
  if (event.type === "runCompleted") {
    return {
      phase: "done",
      label: "Pi finished",
      updatedAt: event.timestamp,
    };
  }
  if (event.type === "sessionUpdated") {
    return {
      phase: "thinking",
      label: "Pi is working",
      updatedAt: event.timestamp,
    };
  }
  return undefined;
}

function activityFromTimelineItem(item: PiTimelineItem | undefined, fallback: string): PiActivityState {
  if (!item) return { phase: "thinking", label: fallback };
  if (item.role === "tool") {
    return {
      phase: "tool",
      label: item.toolName ? `Using ${item.toolName}` : "Using a tool",
      detail: compactActivityText(item.content),
      toolName: item.toolName,
      updatedAt: item.createdAt,
    };
  }
  if (item.role === "assistant") {
    return {
      phase: "responding",
      label: "Pi is answering",
      detail: compactActivityText(item.content),
      updatedAt: item.createdAt,
    };
  }
  return {
    phase: "thinking",
    label: fallback,
    detail: compactActivityText(item.content),
    updatedAt: item.createdAt,
  };
}

function compactActivityText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}
