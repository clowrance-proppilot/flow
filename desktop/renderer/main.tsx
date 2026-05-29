import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type AppendMessage,
  useExternalStoreRuntime,
  useMessage,
} from "@assistant-ui/react";
import {
  Activity,
  CircleCheck,
  ClipboardList,
  FileText,
  Folder,
  RefreshCw,
  Search,
  Send,
  Stethoscope,
  Waypoints,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { projectThemeFor } from "../../src/theme/project-theme";
import { actionPayload, formatActionSummary, pendingConfirmationFromActionResult } from "./action-format";
import { errorMessage, fetchJson } from "./api";
import { activityFromPiEvent, activityFromPiSession, conversationFromPiSession, conversationItemToThreadMessage, extractAppendMessageText, seedConversation } from "./conversation";
import {
  contextLine,
  isExceptionalStatus,
  isActiveWorkStatus,
  isManualActionIssue,
  issueAttentionRank,
  issueDetail,
  recordStatusClass,
  recordStatusLabel,
  sessionStatusForUi,
  statusFilterThemeClass,
  statusRank,
  statusThemeClass,
  workflowSteps,
  workStatusLabel,
} from "./status";
import type {
  ContextProjection,
  ConversationItem,
  DashboardIssue,
  DashboardPayload,
  DesktopAction,
  PendingConfirmationState,
  PiActivityState,
  PiSessionEvent,
  PiSessionSnapshot,
  ProjectRecord,
  StatusKind,
  WorkStatusFilter,
} from "./types";
import "./styles.css";

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [issues, setIssues] = useState<DashboardIssue[]>([]);
  const [snapshotLabel, setSnapshotLabel] = useState("Snapshot not loaded");
  const [context, setContext] = useState<ContextProjection>({});
  const [selectedIssueRef, setSelectedIssueRef] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionIdByIssueRef, setSessionIdByIssueRef] = useState<Record<string, string>>({});
  const [expandedIssueRef, setExpandedIssueRef] = useState("");
  const [activeSessionStatus, setActiveSessionStatus] = useState<"idle" | "running" | "failed">("idle");
  const [piActivity, setPiActivity] = useState<PiActivityState | null>(null);
  const [activeStatus, setActiveStatus] = useState<WorkStatusFilter>("active");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [systemNotice, setSystemNotice] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusKind>("loading");
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [error, setError] = useState("");
  const refreshInFlight = useRef(false);
  const hasLoaded = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const subscribedSessionId = useRef("");
  const sendingRef = useRef(false);
  const issueSelectionRequest = useRef(0);

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const selectedIssue = issues.find((issue) => issue.ref === selectedIssueRef);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of issues) {
      const label = workStatusLabel(issue);
      counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
  }, [issues]);

  const statusFilters = useMemo(() => {
    const labels = Object.keys(statusCounts).sort((left, right) => statusRank(left) - statusRank(right) || left.localeCompare(right));
    const activeCount = issues.filter((issue) => isActiveWorkStatus(workStatusLabel(issue))).length;
    return [
      { id: "active" as const, label: "Active", count: activeCount },
      { id: "all" as const, label: "All", count: issues.length },
      ...labels.map((label) => ({ id: label, label, count: statusCounts[label] || 0 })),
    ];
  }, [issues.length, statusCounts]);

  const filteredIssues = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (activeStatus === "active" && !isActiveWorkStatus(workStatusLabel(issue))) return false;
      if (activeStatus !== "active" && activeStatus !== "all" && workStatusLabel(issue) !== activeStatus) return false;
      if (!needle) return true;
      return [
        issue.ref,
        issue.title,
        workStatusLabel(issue),
        issue.workStatusDetail,
        issue.prStatus,
        issue.reviewStatus,
        issue.nextPickup,
        ...(issue.blockerLabels ?? []),
        ...(issue.repositories ?? []),
      ].join(" ").toLowerCase().includes(needle);
    }).sort((left, right) => issueAttentionRank(left) - issueAttentionRank(right) || left.ref.localeCompare(right.ref));
  }, [activeStatus, issues, query]);

  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => void refresh(false), 5000);
    return () => {
      window.clearInterval(interval);
      eventSourceRef.current?.close();
    };
  }, []);

  async function refresh(initial = false): Promise<void> {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (initial || !hasLoaded.current) {
      setLoading(true);
      setStatus("loading");
    }
    try {
      const [projectsPayload, contextPayload] = await Promise.all([
        fetchJson<{ ok?: boolean; activeProjectId?: string; projects?: ProjectRecord[] }>("/api/projects"),
        fetchJson<{
          ok?: boolean;
          project?: ProjectRecord;
          dashboard?: DashboardPayload;
          context?: ContextProjection;
        }>("/api/context"),
      ]);
      const nextProjects = projectsPayload.projects ?? [];
      const nextProjectId = projectsPayload.activeProjectId || contextPayload.project?.id || nextProjects[0]?.id || "";
      const nextIssues = contextPayload.dashboard?.issues ?? [];
      const activeFromContext = contextPayload.context?.active?.issueRef;

      setProjects(nextProjects);
      setActiveProjectId(nextProjectId);
      setIssues(nextIssues);
      setSnapshotLabel(contextPayload.dashboard?.snapshot?.freshnessLabel || "Snapshot not loaded");
      setContext(contextPayload.context ?? {});
      if (!sendingRef.current && (initial || !hasLoaded.current)) {
        setConversation(seedConversation(contextPayload.context, nextProjectId, activeFromContext));
      }
      setSelectedIssueRef((current) => {
        if (current && nextIssues.some((issue) => issue.ref === current)) return current;
        if (activeFromContext && nextIssues.some((issue) => issue.ref === activeFromContext)) return activeFromContext;
        return nextIssues[0]?.ref ?? "";
      });
      setExpandedIssueRef((current) => current && nextIssues.some((issue) => issue.ref === current) ? current : "");
      setStatus("ok");
      hasLoaded.current = true;
    } catch {
      setStatus("error");
      if (!hasLoaded.current) setError("Unable to load Flow desktop context.");
    } finally {
      setLoading(false);
      refreshInFlight.current = false;
    }
  }

  async function activateProject(projectId: string): Promise<void> {
    setError("");
    try {
      await fetchJson(`/api/projects/${encodeURIComponent(projectId)}/active`, { method: "POST" });
      setSelectedIssueRef("");
      setSelectedSessionId("");
      setSessionIdByIssueRef({});
      setExpandedIssueRef("");
      setSystemNotice("");
      setPendingConfirmation(null);
      setActiveSessionStatus("idle");
      setPiActivity(null);
      await refresh(true);
    } catch {
      setError("Unable to switch project.");
    }
  }

  async function submitPrompt(textOverride?: string): Promise<void> {
    const text = (textOverride ?? prompt).trim();
    if (!text) return;
    if (activeSessionStatus === "running") {
      setError("Pi is still running. Wait for this turn to finish before sending another prompt.");
      return;
    }
    setSending(true);
    sendingRef.current = true;
    setError("");
    setPiActivity({ phase: "starting", label: "Starting Pi", detail: text, updatedAt: new Date().toISOString() });
    const userItem: ConversationItem = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setConversation((items) => [...items, userItem]);
    if (!textOverride) setPrompt("");
    try {
      let sessionId = selectedIssueRef ? sessionIdByIssueRef[selectedIssueRef] || selectedSessionId : undefined;
      if (selectedIssueRef) {
        const started = await fetchIssueSession(selectedIssueRef);
        applyIssueSession(started);
        sessionId = started.id;
        setConversation((items) => items.length ? items : conversationFromPiSession(started));
      }
      const result = await fetchJson<{
        ok?: boolean;
        threadId?: string;
        sessionId?: string;
        artifactRefs?: string[];
        summary?: string;
        error?: string;
        projection?: ContextProjection;
      }>("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          projectId: activeProjectId || undefined,
          issueRef: selectedIssueRef || undefined,
          sessionId,
          artifactRefs: [],
        }),
      });
      setContext(result.projection ?? context);
      setConversation((items) => {
        const text = result.error || result.summary || (result.sessionId
          ? `Prompt routed to session ${result.sessionId}.`
          : `Prompt recorded for ${activeProject?.name ?? "active project"}.`);
        if (items.some((item) => item.role === "assistant" && item.text.trim() === text.trim())) return items;
        return [
          ...items,
          {
            id: `local-assistant-${Date.now()}`,
            role: "assistant",
            text,
            createdAt: new Date().toISOString(),
          },
        ];
      });
      await refresh(false);
    } catch {
      setError("Unable to route prompt.");
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }

  function subscribeToSessionEvents(sessionId: string): void {
    if (!sessionId || subscribedSessionId.current === sessionId) return;
    eventSourceRef.current?.close();
    subscribedSessionId.current = sessionId;
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
    eventSourceRef.current = source;
    const apply = (event: MessageEvent<string>) => {
      const parsed = JSON.parse(event.data) as PiSessionEvent;
      applyPiSessionEvent(sessionId, parsed);
    };
    source.addEventListener("sessionUpdated", apply);
    source.addEventListener("runCompleted", apply);
    for (const name of ["assistantDelta", "toolStarted", "toolUpdated", "toolFinished", "runFailed"] as const) {
      source.addEventListener(name, apply);
    }
    source.onerror = () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
      if (subscribedSessionId.current === sessionId) subscribedSessionId.current = "";
    };
  }

  function applyPiSessionEvent(sessionId: string, event: PiSessionEvent): void {
    if (event.type === "sessionUpdated") {
      const status = event.snapshot?.status;
      if (status) setActiveSessionStatus(status);
      const nextActivity = activityFromPiEvent(event);
      if (nextActivity) setPiActivity(nextActivity);
      return;
    }
    if (event.type === "runCompleted") {
      setActiveSessionStatus("idle");
      setPiActivity(activityFromPiEvent(event) ?? { phase: "done", label: "Pi finished", updatedAt: event.timestamp });
      return;
    }
    if (event.type === "assistantDelta" && event.text) {
      const nextActivity = activityFromPiEvent(event);
      if (nextActivity) setPiActivity(nextActivity);
      const id = `stream-${sessionId}`;
      setConversation((items) => {
        const existing = items.find((item) => item.id === id);
        if (existing) {
          return items.map((item) => item.id === id ? { ...item, text: item.text + event.text } : item);
        }
        return [...items, {
          id,
          role: "assistant",
          text: event.text ?? "",
          createdAt: event.timestamp,
        }];
      });
      return;
    }
    if (event.type === "toolStarted" || event.type === "toolUpdated" || event.type === "toolFinished") {
      const nextActivity = activityFromPiEvent(event);
      if (nextActivity) setPiActivity(nextActivity);
      return;
    }
    if (event.type === "runFailed") {
      setActiveSessionStatus("failed");
      setPiActivity(activityFromPiEvent(event) ?? { phase: "failed", label: "Pi failed", updatedAt: event.timestamp });
      setConversation((items) => [...items, {
        id: `failed-${sessionId}-${Date.now()}`,
        role: "assistant",
        text: event.error?.message || "Pi session failed.",
        createdAt: event.timestamp,
      }]);
    }
  }

  async function selectIssueThread(issueRef: string): Promise<void> {
    const requestId = issueSelectionRequest.current + 1;
    issueSelectionRequest.current = requestId;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    subscribedSessionId.current = "";
    setSelectedIssueRef(issueRef);
    setSelectedSessionId("");
    setExpandedIssueRef((current) => current === issueRef ? "" : issueRef);
    setActiveSessionStatus("idle");
    setPiActivity(null);
    setConversation(seedConversation(context, activeProjectId, issueRef));
    setSystemNotice("");
    setPendingConfirmation(null);
    setError("");
    try {
      const started = await fetchIssueSession(issueRef);
      if (issueSelectionRequest.current !== requestId) return;
      applyIssueSession(started);
      setConversation(conversationFromPiSession(started));
    } catch {
      if (issueSelectionRequest.current === requestId) setError("Unable to open issue thread.");
    }
  }

  async function fetchIssueSession(issueRef: string): Promise<PiSessionSnapshot> {
    const started = await fetchJson<{ ok?: boolean; session: PiSessionSnapshot }>(`/api/issues/${encodeURIComponent(issueRef)}/session`, {
      method: "POST",
    });
    return started.session;
  }

  function applyIssueSession(session: PiSessionSnapshot): void {
    setSessionIdByIssueRef((current) => ({ ...current, [session.issueRef]: session.id }));
    setSelectedSessionId(session.id);
    setActiveSessionStatus(sessionStatusForUi(session.status));
    setPiActivity(activityFromPiSession(session));
    subscribeToSessionEvents(session.id);
  }

  async function invokeAction(action: DesktopAction): Promise<void> {
    if (!selectedIssueRef) {
      setError("Select an issue before running Autoflow.");
      return;
    }
    setActionBusy(action);
    setError("");
    try {
      const result = await fetchJson<{
        ok?: boolean;
        summary: string;
        result?: unknown;
        projection?: ContextProjection;
      }>(`/api/actions/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId || undefined,
          issueRef: selectedIssueRef,
          payload: actionPayload(action, prompt, selectedIssue, pendingConfirmation),
        }),
      });
      setContext(result.projection ?? context);
      const actionSummary = formatActionSummary(action, result.summary);
      setPendingConfirmation(pendingConfirmationFromActionResult(result.result));
      if (action === "autoflow" || action === "approve_confirmation") {
        setSystemNotice(actionSummary);
      } else {
        setConversation((items) => [
          ...items,
          {
            id: `local-action-${Date.now()}`,
            role: "system",
            text: actionSummary,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      await refresh(false);
    } catch (caught) {
      setError(errorMessage(caught, "Unable to run workflow action."));
    } finally {
      setActionBusy("");
    }
  }

  const snapshotStatusLabel = status === "error" ? "Snapshot unavailable" : snapshotLabel;
  const showManualActions = selectedIssue ? isManualActionIssue(selectedIssue) : false;

  return (
    <div className="desktop-shell">
      <aside className="project-panel" aria-label="Projects">
        <header className="project-header">
          <span className="brand"><Waypoints size={16} /></span>
        </header>
        <div className="project-list">
          {projects.map((project) => {
            const theme = projectThemeFor(project);
            return (
              <button
                key={project.id}
                type="button"
                className={project.id === activeProjectId ? "project-card active" : "project-card"}
                onClick={() => void activateProject(project.id)}
                aria-label={`${project.name}. ${project.attentionCount || 0} attention items. ${project.statusCounts?.total ?? 0} issues.`}
                title={`${project.name}\n${project.root}`}
                style={{
                  "--project-color": theme.color,
                  "--project-color-soft": theme.colorSoft,
                  "--project-color-text": theme.colorText,
                } as React.CSSProperties}
              >
                <span className="project-avatar" aria-hidden="true">
                  {theme.iconUrl ? <img src={theme.iconUrl} alt="" /> : theme.initials}
                </span>
                <span className="project-card-text">
                  <span className="project-name">{project.name}</span>
                  <span className="project-card-meta"><Folder size={11} />{project.statusCounts?.total ?? 0}</span>
                </span>
                {project.attentionCount ? <span className="project-badge danger">{project.attentionCount}</span> : null}
              </button>
            );
          })}
        </div>
      </aside>

      <aside className="issue-panel">
        <header className="issue-header">
          <div>
            <div className="eyebrow">Project</div>
            <h1>{activeProject?.name || "Flow"}</h1>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Refresh snapshot"
            onClick={() => void refresh(false)}
            disabled={status === "loading"}
          >
            <RefreshCw size={15} />
          </button>
        </header>

        <label className="search-box">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search issues" />
        </label>

        <div className="status-row">
          {statusFilters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={`status-chip ${statusFilterThemeClass(filter.label)} ${filter.id === activeStatus ? "active" : ""}`.trim()}
              onClick={() => setActiveStatus(filter.id)}
              title={filter.label}
            >
              <span>{filter.label}</span>
              <span className="status-count">{filter.count}</span>
            </button>
          ))}
        </div>

        <section className="issue-stack">
          {filteredIssues.map((issue) => (
            <article
              key={issue.ref}
              className={`${issue.ref === selectedIssueRef ? "issue-card active" : "issue-card"} ${statusFilterThemeClass(workStatusLabel(issue))}`.trim()}
            >
              <button type="button" className="issue-summary" onClick={() => void selectIssueThread(issue.ref)}>
                <div className="issue-row">
                  <span className="issue-ref">{issue.ref}</span>
                  <span className={statusThemeClass(workStatusLabel(issue))}>{workStatusLabel(issue)}</span>
                </div>
                <div className="issue-title">{issue.title || "Untitled issue"}</div>
                <WorkflowTrack status={workStatusLabel(issue)} />
                {issueDetail(issue) ? <div className="issue-note">{issueDetail(issue)}</div> : null}
                <div className="issue-actions-preview">
                  {issue.prStatus ? <span>Open PR</span> : null}
                  {isManualActionIssue(issue) && issue.evidenceStatus !== "Present" ? <span>Evidence</span> : null}
                  {isManualActionIssue(issue) ? <span>Doctor</span> : null}
                </div>
              </button>
              {expandedIssueRef === issue.ref ? <IssueDetails issue={issue} /> : null}
            </article>
          ))}
          {!filteredIssues.length ? <div className="empty-state">No matching issues</div> : null}
        </section>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div>
            <div className="eyebrow">Issue</div>
            <h2>{selectedIssue?.title || "Select an issue"}</h2>
            <p>{contextLine(activeProject, selectedIssue, context, selectedSessionId)}</p>
          </div>
          <div className="chat-header-actions">
            <button type="button" className="system-autoflow-button" title="Autoflow issue" onClick={() => void invokeAction("autoflow")} disabled={!selectedIssueRef || Boolean(actionBusy)}>
              <Activity size={15} />
              <span>{actionBusy === "autoflow" ? "Autoflowing..." : "Autoflow"}</span>
            </button>
            <div className="snapshot-pill" title={snapshotStatusLabel}>
              <span className={status === "error" ? "status-dot error" : status === "loading" ? "status-dot loading" : "status-dot ok"} />
              <span className="snapshot-text">{snapshotStatusLabel}</span>
            </div>
          </div>
        </header>

        <AssistantChatSurface
          conversation={conversation}
          disabled={sending || activeSessionStatus === "running"}
          running={activeSessionStatus === "running"}
          notice={systemNotice ? (
            <PendingActionNotice
              text={systemNotice}
              pendingConfirmation={pendingConfirmation}
              approving={actionBusy === "approve_confirmation"}
              onApprove={pendingConfirmation ? () => void invokeAction("approve_confirmation") : undefined}
            />
          ) : null}
          onSubmit={(text) => submitPrompt(text)}
        />

        {showManualActions ? (
          <div className="action-strip" aria-label="Manual closeout actions">
            <div className="manual-action-group">
              <button type="button" title="Run doctor" onClick={() => void invokeAction("run_doctor")} disabled={!selectedIssueRef || Boolean(actionBusy)}>
                <Stethoscope size={15} />
              </button>
            </div>
          </div>
        ) : null}

        {activeSessionStatus === "running" || piActivity ? <PiActivityStrip activity={piActivity} status={activeSessionStatus} /> : null}

        {error ? <div className="error-line">{error}</div> : null}
      </main>
    </div>
  );
}

function AssistantChatSurface({
  conversation,
  disabled,
  running,
  notice,
  onSubmit,
}: {
  conversation: ConversationItem[];
  disabled: boolean;
  running: boolean;
  notice?: React.ReactNode;
  onSubmit: (text: string) => Promise<void>;
}) {
  const visibleMessages = useMemo(
    () => conversation.filter((item) => item.role === "user" || item.role === "assistant"),
    [conversation],
  );
  const handleNew = useCallback(async (message: AppendMessage) => {
    const text = extractAppendMessageText(message);
    if (text) await onSubmit(text);
  }, [onSubmit]);
  const runtime = useExternalStoreRuntime<ConversationItem>({
    messages: visibleMessages,
    isRunning: running,
    isSendDisabled: disabled,
    convertMessage: conversationItemToThreadMessage,
    onNew: handleNew,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="assistant-thread">
        <ThreadPrimitive.Viewport className="timeline assistant-viewport" autoScroll>
          <ThreadPrimitive.Empty>
            <div className="assistant-empty-state" aria-hidden="true" />
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ Message: AssistantMessage }} />
          <ThreadPrimitive.ViewportFooter />
        </ThreadPrimitive.Viewport>
        {notice}
        <ComposerPrimitive.Root className="composer assistant-composer">
          <ComposerPrimitive.Input placeholder="Work with Flow on this issue..." submitMode="enter" minRows={1} maxRows={6} />
          <ComposerPrimitive.Send title="Send prompt" className="assistant-send-button">
            <Send size={17} />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function AssistantMessage() {
  const role = useMessage((message) => message.role);
  const text = useMessage((message) => message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n"));
  return (
    <MessagePrimitive.Root className={`message ${role}`}>
      <div className="message-role">{role}</div>
      <div className="message-text">{text}</div>
    </MessagePrimitive.Root>
  );
}

function conversationItemToThreadMessage(item: ConversationItem): ThreadMessageLike {
  return {
    id: item.id,
    role: item.role === "user" ? "user" : "assistant",
    content: [{ type: "text", text: item.text }],
    createdAt: new Date(item.createdAt),
    status: item.role === "assistant" ? { type: "complete", reason: "stop" } : undefined,
  };
}

function extractAppendMessageText(message: AppendMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function PendingActionNotice({
  text,
  pendingConfirmation,
  approving,
  onApprove,
}: {
  text: string;
  pendingConfirmation?: PendingConfirmationState | null;
  approving?: boolean;
  onApprove?: () => void;
}) {
  const isConfirmation = text.toLowerCase().startsWith("needs confirmation:");
  const body = pendingConfirmation?.summary || (isConfirmation ? text.replace(/^needs confirmation:\s*/i, "").trim() : text);
  return (
    <div className={isConfirmation ? "pending-action-notice needs-confirmation" : "pending-action-notice"} aria-label="Workflow notice">
      <span className="pending-action-label">{isConfirmation ? "Needs confirmation" : "Workflow"}</span>
      <span className="pending-action-text">{body}</span>
      {pendingConfirmation && onApprove ? (
        <button type="button" className="pending-action-button" onClick={onApprove} disabled={approving}>
          {approving ? "Approving..." : "Approve"}
        </button>
      ) : null}
    </div>
  );
}

function PiActivityStrip({ activity, status }: { activity: PiActivityState | null; status: "idle" | "running" | "failed" }) {
  const fallback: PiActivityState = status === "failed"
    ? { phase: "failed", label: "Pi failed" }
    : status === "running"
      ? { phase: "thinking", label: "Pi is working" }
      : { phase: "idle", label: "Pi ready" };
  const current = activity ?? fallback;
  return (
    <div className={`pi-activity-strip ${current.phase}`} aria-label="Pi activity">
      <span className="pi-activity-pulse" aria-hidden="true" />
      <span className="pi-activity-label">{current.label}</span>
      {current.toolName ? <span className="pi-activity-tool">{current.toolName}</span> : null}
      {current.detail ? <span className="pi-activity-detail">{current.detail}</span> : null}
    </div>
  );
}

function IssueDetails({
  issue,
}: {
  issue: DashboardIssue;
}) {
  const blockers = issue.blockerLabels ?? [];
  const repos = issue.repositories ?? [];
  return (
    <section className="issue-detail">
      <div className="detail-section">
        <div className="eyebrow">Details</div>
        <div className="detail-grid">
          <span className="detail-label">Ref</span>
          <span className="detail-value mono">{issue.ref}</span>

          <span className="detail-label">Status</span>
          <span className="detail-value">{workStatusLabel(issue)}</span>

          {issue.workStatusDetail ? (
            <>
              <span className="detail-label">Source</span>
              <span className="detail-value">{issue.workStatusDetail}</span>
            </>
          ) : null}

          {repos.length ? (
            <>
              <span className="detail-label">Repos</span>
              <span className="detail-value mono">{repos.join(", ")}</span>
            </>
          ) : null}

          {issue.prStatus ? (
            <>
              <span className="detail-label">PR</span>
              <span className="detail-value">{issue.prStatus}</span>
              <span className="detail-label">Review</span>
              <span className="detail-value">{issue.reviewStatus || "Pending"}</span>
            </>
          ) : null}

          <span className="detail-label">Evidence</span>
          <span className={recordStatusClass(issue.evidenceStatus)}>{recordStatusLabel(issue.evidenceStatus)}</span>

          <span className="detail-label">Docs</span>
          <span className={recordStatusClass(issue.documentationStatus)}>{recordStatusLabel(issue.documentationStatus)}</span>
        </div>
      </div>

      {blockers.length ? (
        <div className="detail-section">
          <div className="eyebrow">{workStatusLabel(issue) === "Blocked" ? "Blockers" : "Readiness Notes"}</div>
          <div className="blocker-list">
            {blockers.map((label) => (
              <div key={label} className={workStatusLabel(issue) === "Blocked" ? "blocker-note blocked" : "blocker-note"}>
                {label}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WorkflowTrack({ status }: { status?: string }) {
  if (!status || isExceptionalStatus(status)) {
    return <span className={statusThemeClass(status || "Unknown")}>{status || "Unknown"}</span>;
  }
  const currentIndex = workflowSteps.indexOf(status as typeof workflowSteps[number]);
  return (
    <div className="workflow-track" title={status}>
      {workflowSteps.map((step, index) => (
        <React.Fragment key={step}>
          {index > 0 ? <span className={index <= currentIndex ? "track-line active" : "track-line"} /> : null}
          <span className={index <= currentIndex ? "track-dot active" : "track-dot"} />
        </React.Fragment>
      ))}
    </div>
  );
}

function actionPayload(
  action: DesktopAction,
  prompt: string,
  issue: DashboardIssue | undefined,
  pendingConfirmation?: PendingConfirmationState | null,
): Record<string, unknown> {
  const summary = prompt.trim() || issue?.title || issue?.ref || "Flow Desktop action";
  if (action === "approve_confirmation") return { confirmationId: pendingConfirmation?.id };
  if (action === "record_evidence") return { summary, source: "Flow Desktop conversation" };
  if (action === "record_documentation") return { summary, disposition: "not_needed" };
  if (action === "record_result") return { summary, status: "succeeded" };
  return {};
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
