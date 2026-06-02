import {
  ArrowLeft,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Waypoints,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { projectThemeFor } from "../../src/theme/project-theme";
import { actionPayload, formatActionSummary, pendingConfirmationFromActionResult } from "./action-format";
import { errorMessage, fetchJson } from "./api";
import { activityFromPiEvent, activityFromPiSession, conversationFromPiSession, seedConversation } from "./conversation";
import { desktopRefreshIntervalsFromSettings } from "./refresh-settings";
import {
  autoflowPhaseLabel,
  autoflowPhaseThemeClass,
  isExceptionalStatus,
  isActiveWorkStatus,
  isManualActionIssue,
  issueAttentionRank,
  issueDetail,
  sessionStatusForUi,
  statusFilterThemeClass,
  statusRank,
  statusThemeClass,
  workStatusLabel,
} from "./status";
import type {
  AutoflowActivityState,
  AutoflowRunnerStatus,
  ConfirmDialogState,
  ContextProjection,
  ConversationItem,
  CreatedIssue,
  DashboardIssue,
  DashboardPayload,
  DesktopAction,
  IssueType,
  PendingConfirmationState,
  PiActivityState,
  PiSessionEvent,
  PiSessionSnapshot,
  ProjectRecord,
  StatusKind,
  WorkStatusFilter,
} from "./types";
import { ISSUE_TYPES } from "./types";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AssistantChatSurface } from "./components/AssistantChatSurface";
import { PendingActionNotice } from "./components/PendingActionNotice";
import { AutoflowHealth, activityFromAutoflowStatus } from "./components/AutoflowHealth";
import { IssueDetails } from "./components/IssueDetails";
import { WorkflowTrack } from "./components/WorkflowTrack";
import { useToast } from "./hooks/useToast";
import "./styles.css";

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
  const [autoflowStatus, setAutoflowStatus] = useState<AutoflowRunnerStatus | null>(null);
  const [activeStatus, setActiveStatus] = useState<WorkStatusFilter>("active");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectRoot, setNewProjectRoot] = useState("");
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueDescription, setNewIssueDescription] = useState("");
  const [newIssueType, setNewIssueType] = useState<IssueType>("Bug");
  const [newIssueRepoKeys, setNewIssueRepoKeys] = useState<string[]>([]);
  const [availableRepoKeys, setAvailableRepoKeys] = useState<string[]>([]);
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
  const [refreshBackoff, setRefreshBackoff] = useState({ consecutiveFailures: 0, lastFailureTime: 0 });
  const pendingSelectionRef = useRef<string | null>(null);
  const { toasts, showToast, dismissToast } = useToast();
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [draftByIssueRef, setDraftByIssueRef] = useState<Record<string, string>>({});
  const documentVisibleRef = useRef(true);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const issueListRef = useRef<HTMLDivElement>(null);
  const [focusedIssueIndex, setFocusedIssueIndex] = useState(-1);

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

  const autoflowByIssueRef = useMemo(() => {
    const map = new Map<string, { phase: string; summary?: string }>();
    if (autoflowStatus?.issues) {
      for (const [ref, status] of Object.entries(autoflowStatus.issues)) {
        if (status.phase !== "idle" && status.phase !== "paused") {
          map.set(ref, { phase: status.phase, summary: status.summary });
        }
      }
    }
    return map;
  }, [autoflowStatus]);

  useEffect(() => {
    void refresh(true);

    // Calculate interval based on backoff state
    const baseDelay = refreshIntervals.dashboardMs;
    const maxDelay = 60000; // 1 minute max
    const delay = refreshBackoff.consecutiveFailures > 0
      ? Math.min(baseDelay * Math.pow(2, refreshBackoff.consecutiveFailures - 1), maxDelay)
      : baseDelay;

    // If we're in backoff, calculate remaining delay from last failure
    let actualDelay = delay;
    if (refreshBackoff.consecutiveFailures > 0 && refreshBackoff.lastFailureTime > 0) {
      const elapsed = Date.now() - refreshBackoff.lastFailureTime;
      actualDelay = Math.max(0, delay - elapsed);
    }

    const interval = window.setTimeout(() => void refresh(false), actualDelay);
    return () => {
      window.clearTimeout(interval);
      eventSourceRef.current?.close();
    };
  }, [refreshBackoff.consecutiveFailures, refreshBackoff.lastFailureTime, refreshIntervals.dashboardMs]);

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

  // Visibility-based polling optimization
  useEffect(() => {
    const handleVisibilityChange = () => {
      documentVisibleRef.current = !document.hidden;
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    documentVisibleRef.current = !document.hidden;
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Chat auto-scroll: scroll to bottom when conversation updates
  useEffect(() => {
    if (!selectedIssueRef) return;
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    const raf = window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [conversation, selectedIssueRef]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Escape: close confirm dialog, clear search, or return to monitor
      if (event.key === "Escape") {
        if (confirmDialog) {
          setConfirmDialog(null);
          return;
        }
        if (query) {
          setQuery("");
          setFocusedIssueIndex(-1);
          return;
        }
        if (selectedIssueRef) {
          returnToMonitor();
          return;
        }
      }

      // Slash: focus search (when not in an input)
      if (event.key === "/" && !isInput) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // Ctrl/Cmd+N: new issue form
      if ((event.metaKey || event.ctrlKey) && event.key === "n") {
        event.preventDefault();
        setNewIssueOpen(true);
        return;
      }

      // j/k navigation in issue list (when not in an input)
      if (!isInput && !selectedIssueRef && filteredIssues.length > 0) {
        if (event.key === "j") {
          event.preventDefault();
          setFocusedIssueIndex((prev) => Math.min(prev + 1, filteredIssues.length - 1));
          return;
        }
        if (event.key === "k") {
          event.preventDefault();
          setFocusedIssueIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (event.key === "Enter" && focusedIssueIndex >= 0 && focusedIssueIndex < filteredIssues.length) {
          event.preventDefault();
          void selectIssueThread(filteredIssues[focusedIssueIndex].ref);
          return;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIssueRef, query, filteredIssues, focusedIssueIndex, confirmDialog]);

  async function refresh(initial = false): Promise<void> {
    if (refreshInFlight.current) return;
    // Skip non-initial refreshes when the document is hidden
    if (!initial && !documentVisibleRef.current) return;
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
          repoKeys?: string[];
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
      if (contextPayload.repoKeys?.length) {
        setAvailableRepoKeys(contextPayload.repoKeys);
        if (newIssueRepoKeys.length === 0) {
          setNewIssueRepoKeys(contextPayload.repoKeys);
        }
      }
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
      // Reset backoff on success
      setRefreshBackoff({ consecutiveFailures: 0, lastFailureTime: 0 });
    } catch {
      // Increment backoff on failure
      setRefreshBackoff((prev) => ({
        consecutiveFailures: prev.consecutiveFailures + 1,
        lastFailureTime: Date.now(),
      }));
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

  async function removeProject(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    setConfirmDialog({
      title: "Remove project",
      message: `Remove "${project.name}" from Flow Desktop? This will not delete any files on disk.`,
      confirmLabel: "Remove",
      onConfirm: async () => {
        setConfirmDialog(null);
        setError("");
        try {
          const result = await fetchJson<{ ok?: boolean; activeProjectId?: string; projects: ProjectRecord[] }>(
            `/api/projects/${encodeURIComponent(projectId)}`,
            { method: "DELETE" },
          );
          setProjects(result.projects ?? []);
          setActiveProjectId(result.activeProjectId || result.projects[0]?.id || "");
          if (projectId === activeProjectId) {
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
          }
          showToast(`Removed "${project.name}".`, "success");
          await refresh(true);
        } catch (caught) {
          setError(errorMessage(caught, "Unable to remove project."));
        }
      },
    });
  }

  async function refreshAutoflowStatus(): Promise<void> {
    try {
      const result = await fetchJson<{ ok?: boolean; status: AutoflowRunnerStatus }>("/api/autoflow/status");
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
      const selectedRepoKeys = newIssueRepoKeys.length > 0 ? newIssueRepoKeys : availableRepoKeys;
      const branchKind = newIssueType.toLowerCase();
      const result = await fetchJson<{ ok?: boolean; issue: CreatedIssue }>("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueType: newIssueType,
          title,
          summary: title,
          description: newIssueDescription.trim() || undefined,
          repoKeys: selectedRepoKeys,
          branchKind,
          select: true,
        }),
      });
      setNewIssueTitle("");
      setNewIssueDescription("");
      setNewIssueType("Bug");
      setNewIssueOpen(false);
      if (result.issue?.ref) {
        const created: DashboardIssue = {
          ref: result.issue.ref,
          title: result.issue.title || title,
          workStatus: "Queued",
          statusLabel: "Open",
          repositories: selectedRepoKeys,
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
    const token = new URLSearchParams(window.location.search).get("_token") ?? "";
    const eventUrl = `/api/sessions/${encodeURIComponent(sessionId)}/events${token ? `?_token=${token}` : ""}`;
    const source = new EventSource(eventUrl);
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
    // On error, close and clear; do not auto-reconnect to avoid duplicate listeners
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
    // Preserve current prompt as a draft for the outgoing issue
    if (selectedIssueRef && prompt.trim()) {
      setDraftByIssueRef((current) => ({ ...current, [selectedIssueRef]: prompt }));
    }
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
    // Restore draft for the incoming issue
    setPrompt(draftByIssueRef[issueRef] ?? "");
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
          {loading && !projects.length ? (
            <div className="project-list-loading" aria-label="Loading projects">
              <span className="project-skeleton" />
              <span className="project-skeleton" />
              <span className="project-skeleton" />
            </div>
          ) : projects.length ? projects.map((project) => {
            const theme = projectThemeFor(project);
            return (
              <div key={project.id} className="project-card-wrapper">
                <button
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
                {projects.length > 1 ? (
                  <button
                    type="button"
                    className="project-remove-button"
                    title={`Remove ${project.name}`}
                    aria-label={`Remove ${project.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeProject(project.id);
                    }}
                  >
                    <Trash2 size={10} />
                  </button>
                ) : null}
              </div>
            );
          }) : (
            <div className="project-list-empty" aria-label="No projects">
              <span className="project-list-empty-text">No projects</span>
            </div>
          )}
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
            <div className="new-issue-selects">
              <label className="new-issue-select-label">
                <span>Type</span>
                <select
                  value={newIssueType}
                  onChange={(event) => setNewIssueType(event.target.value as IssueType)}
                  disabled={creatingIssue}
                >
                  {ISSUE_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
              {availableRepoKeys.length > 1 ? (
                <label className="new-issue-select-label">
                  <span>Repos</span>
                  <div className="new-issue-repo-checkboxes">
                    {availableRepoKeys.map((repoKey) => (
                      <label key={repoKey} className="new-issue-repo-checkbox">
                        <input
                          type="checkbox"
                          checked={newIssueRepoKeys.includes(repoKey)}
                          onChange={(event) => {
                            if (event.target.checked) {
                              setNewIssueRepoKeys((current) => [...current, repoKey]);
                            } else {
                              setNewIssueRepoKeys((current) => current.filter((key) => key !== repoKey));
                            }
                          }}
                          disabled={creatingIssue}
                        />
                        <span>{repoKey}</span>
                      </label>
                    ))}
                  </div>
                </label>
              ) : null}
            </div>
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
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFocusedIssueIndex(-1);
            }}
            placeholder="Search issues  (press / to focus)"
            aria-label="Search issues"
          />
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

        <section className="issue-stack" ref={issueListRef}>
          {filteredIssues.map((issue, issueIndex) => {
            const autoflow = autoflowByIssueRef.get(issue.ref);
            return (
              <article
                key={issue.ref}
                className={`${issue.ref === selectedIssueRef ? "issue-card active" : "issue-card"} ${statusFilterThemeClass(workStatusLabel(issue))} ${focusedIssueIndex === issueIndex ? "issue-card-focused" : ""}`.trim()}
                aria-selected={focusedIssueIndex === issueIndex}
              >
                <button type="button" className="issue-summary" onClick={() => void selectIssueThread(issue.ref)}>
                  <div className="issue-row">
                    <span className="issue-ref">{issue.ref}</span>
                    <span className={statusThemeClass(workStatusLabel(issue))}>{workStatusLabel(issue)}</span>
                  </div>
                  <div className="issue-title">{issue.title || "Untitled issue"}</div>
                  {autoflow ? (
                    <div className={`issue-autoflow-indicator ${autoflowPhaseThemeClass(autoflow.phase)}`}>
                      <span className="issue-autoflow-dot" aria-hidden="true" />
                      <span>{autoflowPhaseLabel(autoflow.phase)}</span>
                    </div>
                  ) : null}
                  {autoflow?.phase === "needs_input" ? (
                    <div className="issue-intervention-note">
                      {autoflow.summary || "Autoflow needs your input to continue."}
                    </div>
                  ) : null}
                  {!isExceptionalStatus(workStatusLabel(issue)) && !autoflow ? <WorkflowTrack status={workStatusLabel(issue)} /> : null}
                  {!autoflow && issueDetail(issue) ? <div className="issue-note">{issueDetail(issue)}</div> : null}
                  <div className="issue-actions-preview">
                    {issue.prStatus ? <span>Open PR</span> : null}
                    {isManualActionIssue(issue) && issue.evidenceStatus !== "Present" ? <span>Evidence</span> : null}
                    {isManualActionIssue(issue) ? <span>Doctor</span> : null}
                  </div>
                </button>
                {expandedIssueRef === issue.ref ? <IssueDetails issue={issue} autoflowStatus={autoflow} /> : null}
              </article>
            );
          })}
          {!filteredIssues.length ? (
            <div className="empty-state" role="status">
              {loading ? (
                <div className="empty-state-loading">
                  <div className="accent-spinner" />
                  <span>Loading issues...</span>
                </div>
              ) : query ? (
                <span>No issues match &ldquo;{query}&rdquo;</span>
              ) : activeStatus === "active" ? (
                <span>No active issues. <button type="button" className="empty-state-link" onClick={() => setActiveStatus("all")}>Show all</button></span>
              ) : (
                <span>No issues in this project.</span>
              )}
            </div>
          ) : null}
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
              chatViewportRef={chatViewportRef}
            />

            {error ? <div className="error-line">{error}</div> : null}
          </main>
        </div>
      ) : error ? <div className="error-line shell-error">{error}</div> : null}

      {toasts.length ? (
        <div className="toast-container" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.kind}`}>
              <span className="toast-message">{toast.message}</span>
              <button
                type="button"
                className="toast-dismiss"
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {confirmDialog ? (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label={confirmDialog.title}>
          <div className="confirm-dialog">
            <h3 className="confirm-title">{confirmDialog.title}</h3>
            <p className="confirm-message">{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-cancel" onClick={() => setConfirmDialog(null)}>Cancel</button>
              <button type="button" className="confirm-ok" onClick={() => void confirmDialog.onConfirm()}>
                {confirmDialog.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
