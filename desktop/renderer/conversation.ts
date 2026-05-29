import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { ContextProjection, ConversationItem, PiSessionSnapshot } from "./types";

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
