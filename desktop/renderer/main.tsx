import {
  Activity,
  Check,
  CircleCheck,
  ClipboardList,
  Copy,
  FileText,
  Folder,
  RefreshCw,
  Search,
  Send,
  Waypoints,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { projectThemeFor } from "../../src/theme/project-theme";
import "./styles.css";

type StatusKind = "loading" | "ok" | "error";
type WorkStatusFilter = "all" | string;

type ProjectStatusCounts = {
  blocked: number;
  needsInput: number;
  inReview: number;
  running: number;
  ready: number;
  queued: number;
  done: number;
  total: number;
};

type ProjectRecord = {
  id: string;
  name: string;
  root: string;
  valid: boolean;
  icon?: string;
  error?: string;
  attentionCount?: number;
  statusCounts?: ProjectStatusCounts;
};

type DashboardIssue = {
  ref: string;
  title?: string;
  workStatus?: string;
  workStatusDetail?: string;
  statusLabel?: string;
  blockerLabels?: string[];
  repositories?: string[];
  prStatus?: string;
  reviewStatus?: string;
  evidenceStatus?: string;
  documentationStatus?: string;
  updatedLabel?: string;
  nextPickup?: string;
  handoffPrompt?: string;
};

type DashboardPayload = {
  snapshot?: {
    freshnessLabel?: string;
  };
  issues?: DashboardIssue[];
};

type ContextProjection = {
  active?: {
    projectId?: string;
    issueRef?: string;
    threadId?: string;
    sessionId?: string;
    artifactId?: string;
  };
  prompts?: Array<{
    id: string;
    prompt: string;
    issueRef?: string;
    threadId?: string;
    sessionId?: string;
    artifactRefs?: string[];
    summary?: string;
    updatedAt: string;
  }>;
  artifacts?: Array<{
    id: string;
    artifactType: string;
    title: string;
    uri?: string;
    path?: string;
    summary?: string;
    updatedAt?: string;
  }>;
};

type ConversationItem = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
};

type PiSessionSnapshot = {
  id: string;
};

type PiSessionEvent = {
  type: "assistantDelta" | "toolStarted" | "toolUpdated" | "toolFinished" | "runFailed" | "runCompleted" | "sessionUpdated";
  timestamp: string;
  text?: string;
  toolName?: string;
  callId?: string;
  success?: boolean;
  error?: { message?: string };
  snapshot?: { status?: "idle" | "running" | "failed" };
};

const workflowSteps = ["Queued", "Ready", "Running", "In Review", "Done"] as const;

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [issues, setIssues] = useState<DashboardIssue[]>([]);
  const [snapshotLabel, setSnapshotLabel] = useState("Snapshot not loaded");
  const [context, setContext] = useState<ContextProjection>({});
  const [selectedIssueRef, setSelectedIssueRef] = useState("");
  const [expandedIssueRef, setExpandedIssueRef] = useState("");
  const [activeSessionStatus, setActiveSessionStatus] = useState<"idle" | "running" | "failed">("idle");
  const [activeStatus, setActiveStatus] = useState<WorkStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusKind>("loading");
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [copiedHandoff, setCopiedHandoff] = useState(false);
  const [error, setError] = useState("");
  const refreshInFlight = useRef(false);
  const hasLoaded = useRef(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const subscribedSessionId = useRef("");
  const sendingRef = useRef(false);

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
    return [
      { id: "all" as const, label: "All", count: issues.length },
      ...labels.map((label) => ({ id: label, label, count: statusCounts[label] || 0 })),
    ];
  }, [issues.length, statusCounts]);

  const filteredIssues = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (activeStatus !== "all" && workStatusLabel(issue) !== activeStatus) return false;
      if (!needle) return true;
      return [
        issue.ref,
        issue.title,
        workStatusLabel(issue),
        issue.workStatusDetail,
        issue.prStatus,
        issue.reviewStatus,
        issue.nextPickup,
        issue.handoffPrompt,
        ...(issue.blockerLabels ?? []),
        ...(issue.repositories ?? []),
      ].join(" ").toLowerCase().includes(needle);
    }).sort((left, right) => issueAttentionRank(left) - issueAttentionRank(right) || left.ref.localeCompare(right.ref));
  }, [activeStatus, issues, query]);

  useEffect(() => {
    setCopiedHandoff(false);
  }, [selectedIssueRef]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.length]);

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
      setExpandedIssueRef("");
      setActiveSessionStatus("idle");
      await refresh(true);
    } catch {
      setError("Unable to switch project.");
    }
  }

  async function submitPrompt(): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    if (activeSessionStatus === "running") {
      setError("Pi is still running. Wait for this turn to finish before sending another prompt.");
      return;
    }
    setSending(true);
    sendingRef.current = true;
    setError("");
    const userItem: ConversationItem = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setConversation((items) => [...items, userItem]);
    setPrompt("");
    try {
      const activeMatchesSelection = Boolean(selectedIssueRef && context.active?.issueRef === selectedIssueRef);
      let sessionId = activeMatchesSelection ? context.active?.sessionId : undefined;
      const threadId = activeMatchesSelection ? context.active?.threadId : undefined;
      if (selectedIssueRef && !sessionId) {
        const started = await fetchJson<{ ok?: boolean; session: PiSessionSnapshot }>(`/api/issues/${encodeURIComponent(selectedIssueRef)}/session`, {
          method: "POST",
        });
        sessionId = started.session.id;
        subscribeToSessionEvents(sessionId);
      } else if (sessionId) {
        subscribeToSessionEvents(sessionId);
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
          threadId,
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
      return;
    }
    if (event.type === "runCompleted") {
      setActiveSessionStatus("idle");
      return;
    }
    if (event.type === "assistantDelta" && event.text) {
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
    if (event.type === "toolStarted") {
      const id = `tool-${event.callId || Date.now()}`;
      setConversation((items) => items.some((item) => item.id === id) ? items : [...items, {
        id,
        role: "system",
        text: `${event.toolName || "Tool"} started.`,
        createdAt: event.timestamp,
      }]);
    }
    if (event.type === "toolFinished") {
      const id = `tool-${event.callId || Date.now()}-done`;
      setConversation((items) => items.some((item) => item.id === id) ? items : [...items, {
        id,
        role: "system",
        text: `Tool ${event.success === false ? "failed" : "completed"}.`,
        createdAt: event.timestamp,
      }]);
    }
    if (event.type === "runFailed") {
      setActiveSessionStatus("failed");
      setConversation((items) => [...items, {
        id: `failed-${sessionId}-${Date.now()}`,
        role: "assistant",
        text: event.error?.message || "Pi session failed.",
        createdAt: event.timestamp,
      }]);
    }
  }

  function toggleIssue(issueRef: string): void {
    if (issueRef !== selectedIssueRef) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      subscribedSessionId.current = "";
      setActiveSessionStatus("idle");
      setConversation(seedConversation(context, activeProjectId, issueRef));
    }
    setSelectedIssueRef(issueRef);
    setExpandedIssueRef((current) => current === issueRef ? "" : issueRef);
  }

  async function invokeAction(action: DesktopAction): Promise<void> {
    if (!selectedIssueRef) {
      setError("Select an issue before recording workflow state.");
      return;
    }
    setActionBusy(action);
    setError("");
    try {
      const result = await fetchJson<{
        ok?: boolean;
        summary: string;
        projection?: ContextProjection;
      }>(`/api/actions/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId || undefined,
          issueRef: selectedIssueRef,
          payload: actionPayload(action, prompt, selectedIssue),
        }),
      });
      setContext(result.projection ?? context);
      setConversation((items) => [
        ...items,
        {
          id: `local-action-${Date.now()}`,
          role: "system",
          text: formatActionSummary(action, result.summary),
          createdAt: new Date().toISOString(),
        },
      ]);
      await refresh(false);
    } catch {
      setError("Unable to record workflow action.");
    } finally {
      setActionBusy("");
    }
  }

  async function copyHandoffPrompt(issue = selectedIssue): Promise<void> {
    const text = (issue?.handoffPrompt || issue?.nextPickup || "").trim();
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    setCopiedHandoff(true);
    window.setTimeout(() => setCopiedHandoff(false), 1200);
  }

  const snapshotStatusLabel = status === "error" ? "Snapshot unavailable" : snapshotLabel;

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
              <button type="button" className="issue-summary" onClick={() => toggleIssue(issue.ref)}>
                <div className="issue-row">
                  <span className="issue-ref">{issue.ref}</span>
                  <span className={statusThemeClass(workStatusLabel(issue))}>{workStatusLabel(issue)}</span>
                </div>
                <div className="issue-title">{issue.title || "Untitled issue"}</div>
                <WorkflowTrack status={workStatusLabel(issue)} />
                {issueDetail(issue) ? <div className="issue-note">{issueDetail(issue)}</div> : null}
                <div className="issue-actions-preview">
                  {issue.prStatus ? <span>Open PR</span> : null}
                  {issue.evidenceStatus === "Present" ? null : <span>Evidence</span>}
                  <span>Doctor</span>
                </div>
              </button>
              {expandedIssueRef === issue.ref ? (
                <IssueDetails issue={issue} copied={copiedHandoff && selectedIssueRef === issue.ref} onCopyHandoff={() => {
                  setSelectedIssueRef(issue.ref);
                  void copyHandoffPrompt(issue);
                }} />
              ) : null}
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
            <p>{contextLine(activeProject, selectedIssue, context)}</p>
          </div>
          <div className="snapshot-pill">
            <span className={status === "error" ? "status-dot error" : status === "loading" ? "status-dot loading" : "status-dot ok"} />
            <span>{snapshotStatusLabel}</span>
          </div>
        </header>

        <section className="timeline">
          {conversation.map((item) => (
            <article key={item.id} className={`message ${item.role}`}>
              <div className="message-role">{item.role}</div>
              <div className="message-text">{item.text}</div>
            </article>
          ))}
          <div ref={conversationEndRef} />
        </section>

        <div className="action-strip" aria-label="Workflow actions">
          <button type="button" title="Record evidence" onClick={() => void invokeAction("record_evidence")} disabled={!selectedIssueRef || Boolean(actionBusy)}>
            <ClipboardList size={15} />
          </button>
          <button type="button" title="Record result" onClick={() => void invokeAction("record_result")} disabled={!selectedIssueRef || Boolean(actionBusy)}>
            <CircleCheck size={15} />
          </button>
          <button type="button" title="Record documentation" onClick={() => void invokeAction("record_documentation")} disabled={!selectedIssueRef || Boolean(actionBusy)}>
            <FileText size={15} />
          </button>
          <button type="button" title="Run doctor" onClick={() => void invokeAction("run_doctor")} disabled={!selectedIssueRef || Boolean(actionBusy)}>
            <Activity size={15} />
          </button>
        </div>

        <section className="composer">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitPrompt();
              }
            }}
            placeholder="Work with Flow on this issue..."
          />
          <button type="button" title="Send prompt" onClick={() => void submitPrompt()} disabled={sending || activeSessionStatus === "running" || !prompt.trim()}>
            <Send size={17} />
          </button>
        </section>
        {activeSessionStatus === "running" ? <div className="session-line">Pi is running. Follow-up queueing is next.</div> : null}

        {error ? <div className="error-line">{error}</div> : null}
      </main>
    </div>
  );
}

function IssueDetails({
  issue,
  copied,
  onCopyHandoff,
}: {
  issue: DashboardIssue;
  copied: boolean;
  onCopyHandoff: () => void;
}) {
  const blockers = issue.blockerLabels ?? [];
  const repos = issue.repositories ?? [];
  const handoffPrompt = (issue.handoffPrompt || issue.nextPickup || "").trim();
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

      {handoffPrompt ? (
        <div className="detail-section">
          <div className="eyebrow">Handoff Prompt</div>
          <pre className="handoff-box">{handoffPrompt}</pre>
          <button type="button" className="copy-button" onClick={onCopyHandoff}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
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

type DesktopAction = "record_evidence" | "record_result" | "record_documentation" | "run_doctor";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function formatActionSummary(action: DesktopAction, summary: string): string {
  if (action === "run_doctor") {
    const match = summary.match(/^Doctor (\w+) for ([^.]+)\.\s*(\{.*\})$/s);
    if (match) {
      const [, status, issueRef, raw] = match;
      try {
        const payload = JSON.parse(raw) as {
          blockers?: string[];
          readiness?: { nextActions?: Array<{ summary?: string }> };
          codeReview?: { prUrl?: string; state?: string; mergeStateStatus?: string };
        };
        const blockers = (payload.blockers ?? []).slice(0, 3);
        const nextActions = (payload.readiness?.nextActions ?? [])
          .map((item) => item.summary)
          .filter(Boolean)
          .slice(0, 2);
        return [
          `Doctor ${status} for ${issueRef}.`,
          payload.codeReview?.prUrl ? `PR: ${payload.codeReview.prUrl} (${payload.codeReview.state ?? "unknown"} / ${payload.codeReview.mergeStateStatus ?? "unknown"})` : "",
          blockers.length ? `Blockers: ${blockers.join("; ")}` : "",
          nextActions.length ? `Next: ${nextActions.join("; ")}` : "",
        ].filter(Boolean).join("\n");
      } catch {
        return `Doctor ${status} for ${issueRef}.`;
      }
    }
  }
  return compactChatText(summary);
}

function compactChatText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 700) return trimmed;
  return `${trimmed.slice(0, 680).trimEnd()}...`;
}

function seedConversation(context?: ContextProjection, projectId?: string, issueRef?: string): ConversationItem[] {
  const target = issueRef || context?.active?.issueRef;
  const label = target ? `Selected ${target}.` : projectId ? "Project loaded." : "Flow desktop is ready.";
  return [{
    id: "system-empty",
    role: "system",
    text: `${label} Use the composer for the current turn; older prompt history stays out of the default view.`,
    createdAt: new Date().toISOString(),
  }];
}

function contextLine(project: ProjectRecord | undefined, issue: DashboardIssue | undefined, context: ContextProjection): string {
  const contextMatchesIssue = Boolean(issue?.ref && context.active?.issueRef === issue.ref);
  const parts = [
    project?.name,
    issue?.ref,
    contextMatchesIssue && context.active?.threadId ? `thread ${context.active.threadId}` : undefined,
    contextMatchesIssue && context.active?.sessionId ? `session ${context.active.sessionId}` : undefined,
  ].filter(Boolean);
  return parts.join(" / ") || "No active context";
}

function workStatusLabel(issue: DashboardIssue): string {
  return (issue.workStatus || issue.statusLabel || "Queued").trim() || "Queued";
}

function issueDetail(issue: DashboardIssue): string {
  const primary = issue.blockerLabels?.[0]
    || issue.reviewStatus
    || issue.evidenceStatus
    || issue.documentationStatus
    || issue.updatedLabel
    || issue.repositories?.[0]
    || "";
  return primary === workStatusLabel(issue) ? "" : primary;
}

function recordStatusLabel(status?: string): string {
  return status === "Present" ? "Present" : "Needed";
}

function recordStatusClass(status?: string): string {
  return status === "Present" ? "record-present" : "record-needed";
}

function statusThemeClass(label: string): string {
  if (label === "Blocked") return "issue-state blocked";
  if (label === "Needs Input") return "issue-state needs-input";
  if (label === "In Review") return "issue-state in-review";
  if (label === "Running") return "issue-state running";
  if (label === "Done") return "issue-state done";
  if (label === "Ready") return "issue-state ready";
  return "issue-state queued";
}

function statusFilterThemeClass(label: string): string {
  if (label === "Blocked") return "status-theme-blocked";
  if (label === "Needs Input") return "status-theme-needs-input";
  if (label === "In Review") return "status-theme-review";
  if (label === "Running") return "status-theme-running";
  if (label === "Done") return "status-theme-done";
  if (label === "Ready") return "status-theme-ready";
  if (label === "Queued") return "status-theme-queued";
  if (label === "All") return "status-theme-all";
  return "status-theme-unknown";
}

function isExceptionalStatus(status: string): boolean {
  return status === "Blocked" || status === "Needs Input";
}

function statusRank(status: string): number {
  if (status === "Blocked") return 0;
  if (status === "Needs Input") return 1;
  if (status === "In Review") return 2;
  if (status === "Running") return 3;
  if (status === "Ready") return 4;
  if (status === "Queued") return 5;
  if (status === "Done") return 6;
  return 7;
}

function issueAttentionRank(issue: DashboardIssue): number {
  const status = workStatusLabel(issue);
  const missingEvidence = issue.evidenceStatus !== "Present";
  const missingDocs = issue.documentationStatus !== "Present";
  return statusRank(status) * 10
    + (missingEvidence ? 0 : 2)
    + (missingDocs ? 0 : 1);
}

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back.
    }
  }
  const target = document.createElement("textarea");
  target.value = value;
  target.setAttribute("readonly", "true");
  target.style.position = "fixed";
  target.style.left = "-9999px";
  target.style.top = "0";
  document.body.append(target);
  target.select();
  try {
    document.execCommand("copy");
    return true;
  } finally {
    target.remove();
  }
}

function actionPayload(action: DesktopAction, prompt: string, issue: DashboardIssue | undefined): Record<string, unknown> {
  const summary = prompt.trim() || issue?.title || issue?.ref || "Flow Desktop action";
  if (action === "record_evidence") return { summary, source: "Flow Desktop conversation" };
  if (action === "record_documentation") return { summary, disposition: "not_needed" };
  if (action === "record_result") return { summary, status: "succeeded" };
  return {};
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
