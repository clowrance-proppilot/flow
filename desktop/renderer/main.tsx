import {
  ArrowLeft,
  CircleCheck,
  ClipboardList,
  FileText,
  Folder,
  Plus,
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
import { activityFromPiEvent, activityFromPiSession, conversationFromPiSession, seedConversation } from "./conversation";
import { desktopRefreshIntervalsFromSettings } from "./refresh-settings";
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
  CreatedIssue,
  DashboardIssue,
  DashboardPayload,
  DesktopAction,
  PendingConfirmationState,
  PiAgentOrchestratorStatus,
  PiActivityState,
  PiSessionEvent,
  PiSessionSnapshot,
  ProjectRecord,
  StatusKind,
  WorkStatusFilter,
} from "./types";
import "./styles.css";

type AutoflowActivityState = PiActivityState & { issueRef?: string };

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [issues, setIssues] = useState<DashboardIssue[]>([]);
  const [snapshotLabel, setSnapshotLabel] = useState("not loaded");
  const [context, setContext] = useState<ContextProjection>({});
  const [selectedIssueRef, setSelectedIssueRef] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionIdByIssueRef, setSessionIdByIssueRef] = useState<Record<string, string>>({});
  const [expandedIssueRef, setExpandedIssueRef] = useState("");
  const [activeSessionStatus, setActiveSessionStatus] = useState<"idle" | "running" | "failed">("idle");
  const [piActivity, setPiActivity] = useState<PiActivityState | null>(null);
  const [autoflowActivity, setAutoflowActivity] = useState<AutoflowActivityState | null>(null);
  const [autoflowStatus, setAutoflowStatus] = useState<PiAgentOrchestratorStatus | null>(null);
  const [activeStatus, setActiveStatus] = useState<WorkStatusFilter>("active");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectRoot, setNewProjectRoot] = useState("");
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueDescription, setNewIssueDescription] = useState("");
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [systemNotice, setSystemNotice] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusKind>("loading");
  const [sending, setSending] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [error, setError] = useState("");
  const refreshInFlight = useRef(false);
  const localIssueByRefRef = useRef<Record<string, DashboardIssue>>({});
  const hasLoaded = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const subscribedSessionId = useRef("");
  const sendingRef = useRef(false);
  const issueSelectionRequest = useRef(0);
  const pendingSelectionRef = useRef<string | null>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const selectedIssue = issues.find((issue) => issue.ref === selectedIssueRef);
  const refreshIntervals = useMemo(() => desktopRefreshIntervalsFromSettings(context.desktop), [
    context.desktop?.autoflowStatusRefreshIntervalMs,
    context.desktop?.dashboardRefreshIntervalMs,
    context.desktop?.refreshIntervalMs,
  ]);

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
      { id: "active" as const, label: "Attention", count: activeCount },
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
    const interval = window.setInterval(() => void refresh(false), refreshIntervals.dashboardMs);
    return () => {
      window.clearInterval(interval);
      eventSourceRef.current?.close();
    };
  }, [refreshIntervals.dashboardMs]);

  useEffect(() => {
    if (!selectedIssueRef || selectedSessionId) return;
    void loadIssueThread(selectedIssueRef);
  }, [selectedIssueRef, selectedSessionId]);

  useEffect(() => {
    if (!activeProjectId) return;
    void refreshAutoflowStatus();
    const interval = window.setInterval(() => void refreshAutoflowStatus(), refreshIntervals.autoflowStatusMs);
    return () => {
      window.clearInterval(interval);
    };
  }, [activeProjectId, refreshIntervals.autoflowStatusMs]);

  useEffect(() => {
    if (!selectedIssueRef) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") returnToMonitor();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIssueRef]);

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
      const dashboardIssues = contextPayload.dashboard?.issues ?? [];
      const stickyIssues = Object.values(localIssueByRefRef.current).filter((issue) => !dashboardIssues.some((candidate) => candidate.ref === issue.ref));
      const nextIssues = [...stickyIssues, ...dashboardIssues];
      setProjects(nextProjects);
      setActiveProjectId(nextProjectId);
      setIssues(nextIssues);
      setSnapshotLabel((contextPayload.dashboard?.snapshot?.freshnessLabel || "not loaded").replace(/^Snapshot\s+/i, ""));
      setContext(contextPayload.context ?? {});
      if (!sendingRef.current && (initial || !hasLoaded.current)) {
        setConversation(seedConversation(contextPayload.context, nextProjectId));
      }
      setSelectedIssueRef((current) => {
        if (pendingSelectionRef.current) return pendingSelectionRef.current;
        if (current && nextIssues.some((issue) => issue.ref === current)) return current;
        return "";
      });
      setExpandedIssueRef((current) => {
        if (pendingSelectionRef.current) return pendingSelectionRef.current;
        return current && nextIssues.some((issue) => issue.ref === current) ? current : "";
      });
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
      pendingSelectionRef.current = null;
      setSelectedIssueRef("");
      setSelectedSessionId("");
      setSessionIdByIssueRef({});
      setExpandedIssueRef("");
      setSystemNotice("");
      setPendingConfirmation(null);
      setActiveSessionStatus("idle");
      setPiActivity(null);
      setAutoflowActivity(null);
      await refresh(true);
    } catch {
      setError("Unable to switch project.");
    }
  }

  async function toggleProjectAutoflow(): Promise<void> {
    if (!activeProject) return;
    setError("");
    const enabled = activeProject.autoflowEnabled === false;
    setProjects((items) => items.map((project) => project.id === activeProject.id ? { ...project, autoflowEnabled: enabled } : project));
    try {
      const result = await fetchJson<{ ok?: boolean; project: ProjectRecord }>(`/api/projects/${encodeURIComponent(activeProject.id)}/autoflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setProjects((items) => items.map((project) => project.id === result.project.id ? { ...project, ...result.project } : project));
      if (enabled) void fetchJson("/api/autoflow/tick", { method: "POST" }).then(() => refreshAutoflowStatus()).catch(() => undefined);
    } catch {
      setProjects((items) => items.map((project) => project.id === activeProject.id ? { ...project, autoflowEnabled: !enabled } : project));
      setError("Unable to update Autoflow for this project.");
    }
  }

  async function addProjectFromDesktop(): Promise<void> {
    const root = newProjectRoot.trim();
    if (!root) {
      setError("Project root is required.");
      return;
    }
    setAddingProject(true);
    setError("");
    try {
      const result = await fetchJson<{ ok?: boolean; activeProjectId?: string; project: ProjectRecord; projects: ProjectRecord[] }>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      localIssueByRefRef.current = {};
      setProjects(result.projects ?? [result.project]);
      setActiveProjectId(result.activeProjectId || result.project.id);
      setNewProjectRoot("");
      setNewProjectOpen(false);
      pendingSelectionRef.current = null;
      setSelectedIssueRef("");
      setSelectedSessionId("");
      setSessionIdByIssueRef({});
      setExpandedIssueRef("");
      setSystemNotice("");
      setPendingConfirmation(null);
      setActiveSessionStatus("idle");
      setPiActivity(null);
      setAutoflowActivity(null);
      await refresh(true);
    } catch (caught) {
      setError(errorMessage(caught, "Unable to add Flow project."));
    } finally {
      setAddingProject(false);
    }
  }

  async function refreshAutoflowStatus(): Promise<void> {
    try {
      const result = await fetchJson<{ ok?: boolean; status: PiAgentOrchestratorStatus }>("/api/autoflow/status");
      setAutoflowStatus(result.status);
      setAutoflowActivity(activityFromAutoflowStatus(result.status));
    } catch {
      setAutoflowStatus(null);
      setAutoflowActivity(null);
    }
  }

  async function createIssueFromDesktop(): Promise<void> {
    const title = newIssueTitle.trim();
    if (!title) {
      setError("Issue title is required.");
      return;
    }
    setCreatingIssue(true);
    setError("");
    try {
      const result = await fetchJson<{ ok?: boolean; issue: CreatedIssue }>("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueType: "Bug",
          title,
          summary: title,
          description: newIssueDescription.trim() || undefined,
          repoKeys: ["flow"],
          branchKind: "bug",
          select: true,
        }),
      });
      setNewIssueTitle("");
      setNewIssueDescription("");
      setNewIssueOpen(false);
      if (result.issue?.ref) {
        const created: DashboardIssue = {
          ref: result.issue.ref,
          title: result.issue.title || title,
          workStatus: "Queued",
          statusLabel: "Open",
          repositories: ["flow"],
          evidenceStatus: "Needed",
          documentationStatus: "Needed",
          updatedLabel: "now",
        };
        localIssueByRefRef.current = { ...localIssueByRefRef.current, [created.ref]: created };
        setIssues((current) => [created, ...current.filter((issue) => issue.ref !== created.ref)]);
        setActiveStatus("all");
        await selectIssueThread(created.ref);
      }
    } catch (caught) {
      setError(errorMessage(caught, "Unable to create issue."));
    } finally {
      setCreatingIssue(false);
    }
  }

  async function submitPrompt(textOverride?: string): Promise<void> {
    const text = (textOverride ?? prompt).trim();
    if (!text) return;
    setSending(true);
    sendingRef.current = true;
    setError("");
    setPiActivity({ phase: "starting", label: "Starting agent", detail: text, updatedAt: new Date().toISOString() });
    const userItem: ConversationItem = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setConversation((items) => [...items, userItem]);
    setPrompt("");
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
      setActiveSessionStatus(result.error ? "failed" : "idle");
      setPiActivity({
        phase: result.error ? "failed" : "done",
        label: result.error ? "Agent failed" : "Agent finished",
        detail: result.error || result.summary,
        updatedAt: new Date().toISOString(),
      });
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
      setPiActivity(activityFromPiEvent(event) ?? { phase: "done", label: "Agent finished", updatedAt: event.timestamp });
      return;
    }
    if (event.type === "assistantDelta" && event.text) {
      const nextActivity = activityFromPiEvent(event);
      if (nextActivity) setPiActivity(nextActivity);
      return;
    }
    if (event.type === "toolStarted" || event.type === "toolUpdated" || event.type === "toolFinished") {
      const nextActivity = activityFromPiEvent(event);
      if (nextActivity) setPiActivity(nextActivity);
      return;
    }
    if (event.type === "runFailed") {
      setActiveSessionStatus("failed");
      setPiActivity(activityFromPiEvent(event) ?? { phase: "failed", label: "Agent failed", updatedAt: event.timestamp });
      setConversation((items) => [...items, {
        id: `failed-${sessionId}-${Date.now()}`,
        role: "assistant",
        text: event.error?.message || "Agent session failed.",
        createdAt: event.timestamp,
      }]);
    }
  }

  async function selectIssueThread(issueRef: string): Promise<void> {
    const requestId = issueSelectionRequest.current + 1;
    issueSelectionRequest.current = requestId;
    pendingSelectionRef.current = issueRef;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    subscribedSessionId.current = "";
    setSelectedIssueRef(issueRef);
    setSelectedSessionId("");
    setExpandedIssueRef((current) => current === issueRef ? "" : issueRef);
    setActiveSessionStatus("idle");
    setPiActivity(null);
    setConversation([]);
    setConversationLoading(true);
    setSystemNotice("");
    setPendingConfirmation(null);
    setError("");
    void loadIssueThread(issueRef, requestId);
  }

  function returnToMonitor(): void {
    issueSelectionRequest.current += 1;
    pendingSelectionRef.current = null;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    subscribedSessionId.current = "";
    setSelectedIssueRef("");
    setSelectedSessionId("");
    setExpandedIssueRef("");
    setActiveSessionStatus("idle");
    setPiActivity(null);
    setConversation([]);
    setConversationLoading(false);
    setSystemNotice("");
    setPendingConfirmation(null);
    setError("");
  }

  async function loadIssueThread(issueRef: string, requestId = issueSelectionRequest.current): Promise<void> {
    setConversationLoading(true);
    try {
      const started = await fetchIssueSession(issueRef);
      if (issueSelectionRequest.current !== requestId) return;
      applyIssueSession(started);
      setConversation(conversationFromPiSession(started));
    } catch {
      if (issueSelectionRequest.current === requestId) setError("Unable to open issue thread.");
    } finally {
      if (issueSelectionRequest.current === requestId) {
        pendingSelectionRef.current = null;
        setConversationLoading(false);
      }
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
    if (action === "autoflow") {
      setAutoflowActivity({
        phase: "starting",
        label: "Autoflow starting",
        detail: `Working ${selectedIssueRef}`,
        issueRef: selectedIssueRef,
        updatedAt: new Date().toISOString(),
      });
    }
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
      const nextConfirmation = pendingConfirmationFromActionResult(result.result);
      setPendingConfirmation(nextConfirmation);
      if (action === "autoflow" || action === "approve_confirmation") {
        setSystemNotice(actionSummary);
        setAutoflowActivity({
          phase: nextConfirmation ? "failed" : "done",
          label: nextConfirmation ? "Autoflow needs input" : "Autoflow updated",
          detail: actionSummary,
          issueRef: selectedIssueRef,
          updatedAt: new Date().toISOString(),
        });
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
      if (action === "autoflow") {
        setAutoflowActivity({
          phase: "failed",
          label: "Autoflow failed",
          detail: errorMessage(caught, "Unable to run Autoflow."),
          issueRef: selectedIssueRef,
          updatedAt: new Date().toISOString(),
        });
      }
      setError(errorMessage(caught, "Unable to run workflow action."));
    } finally {
      setActionBusy("");
    }
  }

  const snapshotStatusLabel = status === "error" ? "Issues unavailable" : `Issues updated ${snapshotLabel}`;
  const showManualActions = selectedIssue ? isManualActionIssue(selectedIssue) : false;
  const autoflowEnabled = activeProject?.autoflowEnabled !== false;
  const activeProjectTheme = activeProject ? projectThemeFor(activeProject) : undefined;
  const headerActivity = piActivity ?? (selectedSessionId ? {
    phase: activeSessionStatus === "failed" ? "failed" : activeSessionStatus === "running" ? "thinking" : "idle",
    label: activeSessionStatus === "failed" ? "Agent failed" : activeSessionStatus === "running" ? "Agent is working" : "Agent ready",
  } satisfies PiActivityState : null);

  return (
    <div className={selectedIssue ? "flow-desktop desktop-shell issue-selected" : "flow-desktop desktop-shell"}>
      <aside className="project-panel" aria-label="Projects">
        <header className="project-header">
          <span className="brand"><Waypoints size={16} /></span>
          <span className="brand-title">Flow</span>
        </header>
        <div className="project-active-block">
          <div className="eyebrow">Project</div>
          <button
            type="button"
            className="project-active-name"
            title={activeProject?.root}
            style={activeProjectTheme ? {
              "--project-color": activeProjectTheme.color,
              "--project-color-soft": activeProjectTheme.colorSoft,
              "--project-color-text": activeProjectTheme.colorText,
            } as React.CSSProperties : undefined}
          >
            <span className="project-active-avatar" aria-hidden="true">
              {activeProjectTheme?.iconUrl ? <img src={activeProjectTheme.iconUrl} alt="" /> : activeProjectTheme?.initials ?? "FL"}
            </span>
            <span className="project-active-copy">
              <span>{activeProject?.name || "Flow"}</span>
              <span>{activeProject?.statusCounts?.total ?? issues.length} issues</span>
            </span>
            <span className="project-chevron" aria-hidden="true">v</span>
          </button>
        </div>
        <button type="button" className="project-add-button" onClick={() => setNewProjectOpen((open) => !open)}>
          <Plus size={14} />
          <span>Add project</span>
        </button>
        {newProjectOpen ? (
          <form
            className="project-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              void addProjectFromDesktop();
            }}
          >
            <input
              value={newProjectRoot}
              onChange={(event) => setNewProjectRoot(event.target.value)}
              placeholder="Project root path"
              disabled={addingProject}
            />
            <div className="project-add-actions">
              <button type="button" onClick={() => setNewProjectOpen(false)} disabled={addingProject}>Cancel</button>
              <button type="submit" disabled={addingProject || !newProjectRoot.trim()}>
                {addingProject ? "Adding..." : "Add"}
              </button>
            </div>
          </form>
        ) : null}
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
                {project.attentionCount ? <span className="project-badge danger">{project.attentionCount}</span> : null}
              </button>
            );
          })}
        </div>
      </aside>

      <aside className="issue-panel">
        <header className="issue-header">
          <div>
            <div className="eyebrow">Issues</div>
            <div className="issue-updated-label">{snapshotStatusLabel}</div>
            <AutoflowHealth enabled={autoflowEnabled} activity={autoflowActivity} autoflowStatus={autoflowStatus} />
          </div>
          <div className="issue-header-actions">
            <button
              type="button"
              className="new-issue-button"
              title="Create issue"
              onClick={() => setNewIssueOpen(true)}
            >
              <Plus size={15} />
              <span>New</span>
            </button>
            <button
              type="button"
              className={autoflowEnabled ? "autoflow-switch enabled" : "autoflow-switch"}
              onClick={() => void toggleProjectAutoflow()}
              aria-pressed={autoflowEnabled}
              title="Toggle project Autoflow"
            >
              <span>Autoflow</span>
              <span className="switch-track" aria-hidden="true"><span /></span>
            </button>
            <button
              type="button"
              className="icon-button"
              title="Refresh snapshot"
              onClick={() => void refresh(false)}
              disabled={status === "loading"}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </header>

        {newIssueOpen ? (
          <form
            className="new-issue-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createIssueFromDesktop();
            }}
          >
            <input
              value={newIssueTitle}
              onChange={(event) => setNewIssueTitle(event.target.value)}
              placeholder="Issue title"
              disabled={creatingIssue}
              autoFocus
            />
            <textarea
              value={newIssueDescription}
              onChange={(event) => setNewIssueDescription(event.target.value)}
              placeholder="Details"
              rows={3}
              disabled={creatingIssue}
            />
            <div className="new-issue-actions">
              <button type="button" onClick={() => setNewIssueOpen(false)} disabled={creatingIssue}>Cancel</button>
              <button type="submit" disabled={creatingIssue || !newIssueTitle.trim()}>
                {creatingIssue ? "Creating..." : "Create issue"}
              </button>
            </div>
          </form>
        ) : null}

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
                {!isExceptionalStatus(workStatusLabel(issue)) ? <WorkflowTrack status={workStatusLabel(issue)} /> : null}
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

      {selectedIssue ? (
        <div className="chat-popover-layer" role="presentation" onClick={returnToMonitor}>
          <main
            className="chat-panel"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedIssue.ref} chat`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="chat-header">
              <button type="button" className="monitor-back-button" onClick={returnToMonitor} title="Back to issues">
                <ArrowLeft size={15} />
                <span>Back</span>
              </button>
              <div className="chat-title-block">
                <div className="chat-title-row">
                  <h2>{selectedIssue.ref}</h2>
                  <span className={statusThemeClass(workStatusLabel(selectedIssue))}>{workStatusLabel(selectedIssue)}</span>
                </div>
                <p>{selectedIssue.title || "Untitled issue"}</p>
              </div>
            </header>

            <AssistantChatSurface
              conversation={conversation}
              disabled={sending}
              loading={conversationLoading}
              running={activeSessionStatus === "running"}
              activity={headerActivity}
              issueRef={selectedIssueRef}
              notice={systemNotice ? (
                <PendingActionNotice
                  text={systemNotice}
                  pendingConfirmation={pendingConfirmation}
                  approving={actionBusy === "approve_confirmation"}
                  onApprove={pendingConfirmation ? () => void invokeAction("approve_confirmation") : undefined}
                />
              ) : null}
              onSubmit={(text) => submitPrompt(text)}
              prompt={prompt}
              onPromptChange={setPrompt}
              showDoctor={showManualActions}
              doctorBusy={actionBusy === "run_doctor"}
              onDoctor={() => void invokeAction("run_doctor")}
              autoflowBusy={actionBusy === "autoflow"}
              onAutoflow={() => void invokeAction("autoflow")}
            />

            {error ? <div className="error-line">{error}</div> : null}
          </main>
        </div>
      ) : error ? <div className="error-line shell-error">{error}</div> : null}
    </div>
  );
}

function AssistantChatSurface({
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
      <div className="timeline assistant-viewport">
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

function MessageMarkdown({ text }: { text: string }) {
  return <div className="message-text markdown-message">{renderMarkdownBlocks(text)}</div>;
}

function renderMarkdownBlocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | "" = "";

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const content = paragraph.join(" ").trim();
    if (content) blocks.push(<p key={`p-${blocks.length}`}>{renderInlineMarkdown(content, `p-${blocks.length}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    const items = listItems.map((item, index) => <li key={`${listType}-${blocks.length}-${index}`}>{renderInlineMarkdown(item, `${listType}-${blocks.length}-${index}`)}</li>);
    blocks.push(listType === "ol" ? <ol key={`ol-${blocks.length}`}>{items}</ol> : <ul key={`ul-${blocks.length}`}>{items}</ul>);
    listItems = [];
    listType = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], `h-${blocks.length}`);
      blocks.push(level === 1 ? <h3 key={`h-${blocks.length}`}>{content}</h3> : <h4 key={`h-${blocks.length}`}>{content}</h4>);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(bullet[1]);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(ordered[1]);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks.length ? blocks : [<p key="empty" />];
}

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      nodes.push(link ? <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a> : token);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
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

function StatusSummary({
  activity,
}: {
  activity: PiActivityState | null;
}) {
  const showDetail = activity?.phase === "tool" || activity?.phase === "responding" || activity?.phase === "failed";
  return (
    <div className={`status-summary ${activity?.phase ?? "idle"}`} aria-label="Flow status">
      <span className="pi-activity-pulse" aria-hidden="true" />
      <span className="pi-activity-label">{activity?.label ?? "Agent not started"}</span>
      {activity?.toolName ? <span className="pi-activity-tool">{activity.toolName}</span> : null}
      {showDetail && activity?.detail ? <span className="pi-activity-detail">{activity.detail}</span> : null}
    </div>
  );
}

function activityFromAutoflowStatus(status: PiAgentOrchestratorStatus): AutoflowActivityState {
  if (!status.enabled) {
    return { phase: "idle", label: "Autoflow paused", detail: "Project automation is off.", updatedAt: status.updatedAt };
  }

  const issues = status.issues ?? {};
  const entries = Object.entries(issues);
  const running = entries.filter(([, s]) => s.phase === "running");
  const starting = entries.filter(([, s]) => s.phase === "starting");
  const needsInput = entries.filter(([, s]) => s.phase === "needs_input");
  const failed = entries.filter(([, s]) => s.phase === "failed");

  if (running.length > 0) {
    const refs = running.map(([ref]) => ref).slice(0, 3).join(", ");
    return {
      phase: "thinking",
      label: `Working ${running.length} issue${running.length === 1 ? "" : "s"}`,
      detail: running.length <= 3 ? refs : `${refs} +${running.length - 3} more`,
      updatedAt: status.updatedAt,
    };
  }
  if (starting.length > 0) {
    return {
      phase: "starting",
      label: `Starting ${starting.length} issue${starting.length === 1 ? "" : "s"}`,
      updatedAt: status.updatedAt,
    };
  }
  if (needsInput.length > 0) {
    const refs = needsInput.map(([ref]) => ref).slice(0, 2).join(", ");
    return {
      phase: "failed",
      label: `${needsInput.length} need${needsInput.length === 1 ? "s" : ""} input`,
      detail: needsInput.length <= 2 ? refs : `${refs} +${needsInput.length - 2} more`,
      updatedAt: status.updatedAt,
    };
  }
  if (failed.length > 0) {
    return {
      phase: "failed",
      label: `${failed.length} failed`,
      detail: failed.map(([ref]) => ref).slice(0, 2).join(", "),
      updatedAt: status.updatedAt,
    };
  }
  return {
    phase: "idle",
    label: "Autoflow watching",
    detail: status.activeCount > 0 ? `${status.activeCount} active` : "No active runs",
    updatedAt: status.updatedAt,
  };
}

function AutoflowHealth({
  enabled,
  activity,
  autoflowStatus,
}: {
  enabled: boolean;
  activity: AutoflowActivityState | null;
  autoflowStatus?: PiAgentOrchestratorStatus | null;
}) {
  const stateClass = enabled ? activity?.phase ?? "idle" : "paused";
  const label = activity?.label ?? (enabled ? "Autoflow watching" : "Autoflow paused");
  const detail = activity?.detail ?? (enabled ? "No active runs" : "Project automation is off");
  const concurrency = autoflowStatus?.maxConcurrency;
  return (
    <div className={`autoflow-health ${stateClass}`} aria-label="Autoflow health">
      <span className="autoflow-health-dot" aria-hidden="true" />
      <span className="autoflow-health-label">{label}</span>
      {concurrency ? <span className="autoflow-health-concurrency">/{concurrency}</span> : null}
      <span className="autoflow-health-detail">{detail}</span>
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

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
