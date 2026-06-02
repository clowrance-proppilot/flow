import { Send, Stethoscope, Waypoints } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import type { ConversationItem, PiActivityState } from "../types";
import { MessageMarkdown } from "./MessageMarkdown";

export function AssistantChatSurface({
  conversation,
  disabled,
  loading,
  running,
  activity,
  notice,
  onSubmit,
  prompt,
  onPromptChange,
  issueRef,
  showDoctor,
  doctorBusy,
  onDoctor,
  autoflowBusy,
  onAutoflow,
  chatViewportRef,
}: {
  conversation: ConversationItem[];
  disabled: boolean;
  loading: boolean;
  running: boolean;
  activity: PiActivityState | null;
  notice?: React.ReactNode;
  onSubmit: (text: string) => Promise<void>;
  prompt: string;
  onPromptChange: (value: string) => void;
  issueRef?: string;
  showDoctor: boolean;
  doctorBusy: boolean;
  onDoctor: () => void;
  autoflowBusy: boolean;
  onAutoflow: () => void;
  chatViewportRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const visibleMessages = useMemo(
    () => conversation.filter((item) => item.role === "user" || item.role === "assistant"),
    [conversation],
  );
  const canSubmit = prompt.trim().length > 0 && !disabled;
  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    await onSubmit(prompt);
  }, [canSubmit, onSubmit, prompt]);

  return (
    <section className="assistant-thread" aria-label="Issue conversation">
      <div className="timeline assistant-viewport" ref={chatViewportRef}>
        {loading && !visibleMessages.length ? (
          <div className="assistant-loading">
            <div className="accent-spinner" />
            <span>Loading conversation...</span>
          </div>
        ) : visibleMessages.length ? visibleMessages.map((item) => (
          <article key={item.id} className={`message ${item.role}`}>
            <div className="message-role">{item.role}</div>
            <MessageMarkdown text={item.text} />
          </article>
        )) : <div className="assistant-empty-state" aria-hidden="true" />}
        {activity && activity.phase !== "idle" ? (
          <div className={`status-message ${activity.phase}`}>
            <span className="status-message-dot" aria-hidden="true" />
            <span className="status-message-label">{activity.label}</span>
            {activity.toolName ? <span className="status-message-tool">{activity.toolName}</span> : null}
            {activity.detail ? <span className="status-message-detail">{activity.detail}</span> : null}
          </div>
        ) : null}
        {running && (!activity || activity.phase === "idle") ? (
          <div className="status-message thinking">
            <span className="status-message-dot" aria-hidden="true" />
            <span className="status-message-label">Agent is working...</span>
          </div>
        ) : null}
      </div>
      {notice}
      <div className="composer assistant-composer">
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={issueRef ? `Work on ${issueRef}...` : "Work with Flow..."}
          rows={1}
          disabled={disabled}
        />
        {showDoctor ? (
          <button type="button" title="Run doctor" className="composer-tool-button" onClick={onDoctor} disabled={disabled || doctorBusy}>
            <Stethoscope size={17} />
          </button>
        ) : null}
        <button type="button" title="Run Autoflow" className="composer-tool-button" onClick={onAutoflow} disabled={disabled || autoflowBusy}>
          <Waypoints size={17} />
        </button>
        <button type="button" title="Send prompt" className="assistant-send-button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          <Send size={17} />
        </button>
      </div>
    </section>
  );
}
