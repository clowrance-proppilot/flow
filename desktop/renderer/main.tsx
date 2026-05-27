import { Activity, CircleCheck, ClipboardList, FileCode, FileText, Folder, RefreshCw, Search, Send, Waypoints } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ProjectRecord = {
  id: string;
  name: string;
  root: string;
  valid: boolean;
  error?: string;
};

type DashboardIssue = {
  ref: string;
  title?: string;
  workStatus?: string;
  statusLabel?: string;
  blockerLabels?: string[];
  repositories?: string[];
  evidenceStatus?: string;
  documentationStatus?: string;
  reviewStatus?: string;
  handoffPrompt?: string;
};

type ContextProjection = {
  active?: {
    projectId?: string;
    issueRef?: string;
    threadId?: string;
    sessionId?: string;
    artifactId?: string;
  };
  prompts?: Array<{ id: string; prompt: string; issueRef?: string; threadId?: string; sessionId?: string; artifactRefs?: string[]; summary?: string; updatedAt: string }>;
  artifacts?: Array<{ id: string; artifactType: string; title: string; uri?: string; path?: string; summary?: string; updatedAt?: string }>;
};

type ConversationItem = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
};

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [issues, setIssues] = useState<DashboardIssue[]>([]);
  const [context, setContext] = useState<ContextProjection>({});
  const [selectedIssueRef, setSelectedIssueRef] = useState("");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [error, setError] = useState("");
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.length]);

  const activeProject = projects.find((project) => project.id === activeProjectId);
  const selectedIssue = issues.find((issue) => issue.ref === selectedIssueRef);
  const activeArtifact = context.artifacts?.find((artifact) => artifact.id === context.active?.artifactId) ?? context.artifacts?.at(-1);

  const filteredIssues = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (!needle) return true;
      return [
        issue.ref,
        issue.title,
        issue.workStatus,
        issue.statusLabel,
        ...(issue.blockerLabels ?? []),
        ...(issue.repositories ?? []),
      ].join(" ").toLowerCase().includes(needle);
    });
  }, [issues, query]);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const [projectsPayload, contextPayload] = await Promise.all([
        fetchJson<{ ok?: boolean; activeProjectId?: string; projects?: ProjectRecord[] }>("/api/projects"),
        fetchJson<{ ok?: boolean; project?: ProjectRecord; dashboard?: { issues?: DashboardIssue[] }; context?: ContextProjection }>("/api/context"),
      ]);
      const nextProjects = projectsPayload.projects ?? [];
      const nextProjectId = projectsPayload.activeProjectId || contextPayload.project?.id || nextProjects[0]?.id || "";
      setProjects(nextProjects);
      setActiveProjectId(nextProjectId);
      setIssues(contextPayload.dashboard?.issues ?? []);
      setContext(contextPayload.context ?? {});
      setSelectedIssueRef((current) => current || contextPayload.context?.active?.issueRef || "");
      setConversation(seedConversation(contextPayload.context));
    } catch (cause) {
      setError("Unable to load Flow desktop context.");
    } finally {
      setLoading(false);
    }
  }

  async function activateProject(projectId: string): Promise<void> {
    setError("");
    try {
      await fetchJson(`/api/projects/${encodeURIComponent(projectId)}/active`, { method: "POST" });
      setSelectedIssueRef("");
      await refresh();
    } catch {
      setError("Unable to switch project.");
    }
  }

  async function submitPrompt(): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    setSending(true);
    setError("");
    const userItem: ConversationItem = {
      id: `local-user-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setConversation((items) => [...items, userItem]);
    try {
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
          threadId: context.active?.threadId,
          sessionId: context.active?.sessionId,
          artifactRefs: activeArtifact ? [activeArtifact.id] : [],
        }),
      });
      setPrompt("");
      setContext(result.projection ?? context);
      setConversation((items) => [
        ...items,
        {
          id: `local-assistant-${Date.now()}`,
          role: "assistant",
          text: result.error || result.summary || (result.sessionId
            ? `Prompt routed to session ${result.sessionId}.`
            : `Prompt recorded for ${activeProject?.name ?? "active project"}.`),
          createdAt: new Date().toISOString(),
        },
      ]);
      await refresh();
    } catch {
      setError("Unable to route prompt.");
    } finally {
      setSending(false);
    }
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
      await refresh();
      setConversation((items) => [
        ...items,
        {
          id: `local-action-${Date.now()}`,
          role: "system",
          text: result.summary,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch {
      setError("Unable to record workflow action.");
    } finally {
      setActionBusy("");
    }
  }

  return (
    <div className="desktop-shell">
      <aside className="project-rail">
        <div className="brand">
          <Waypoints size={18} />
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              title={project.name}
              className={project.id === activeProjectId ? "project-button active" : "project-button"}
              onClick={() => void activateProject(project.id)}
            >
              <Folder size={17} />
            </button>
          ))}
        </div>
      </aside>

      <aside className="context-panel">
        <header className="context-header">
          <div>
            <div className="eyebrow">Project</div>
            <h1>{activeProject?.name || "Flow"}</h1>
          </div>
          <button type="button" className="icon-button" title="Refresh" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={15} />
          </button>
        </header>

        <label className="search-box">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search issues" />
        </label>

        <section className="issue-stack">
          {filteredIssues.map((issue) => (
            <button
              key={issue.ref}
              type="button"
              className={issue.ref === selectedIssueRef ? "issue-context active" : "issue-context"}
              onClick={() => setSelectedIssueRef(issue.ref)}
            >
              <div className="issue-row">
                <span className="issue-ref">{issue.ref}</span>
                <span className="issue-state">{issue.workStatus || issue.statusLabel || "Queued"}</span>
              </div>
              <div className="issue-title">{issue.title || "Untitled issue"}</div>
              <div className="issue-meta">
                {(issue.repositories ?? []).slice(0, 2).map((repo) => <span key={repo}>{repo}</span>)}
                {issue.reviewStatus ? <span>{issue.reviewStatus}</span> : null}
              </div>
              <div className="issue-records">
                <span>{issue.evidenceStatus || "Evidence missing"}</span>
                <span>{issue.documentationStatus || "Docs missing"}</span>
              </div>
              {issue.blockerLabels?.length ? <div className="issue-note">{issue.blockerLabels[0]}</div> : null}
            </button>
          ))}
          {!filteredIssues.length ? <div className="empty-state">No issues</div> : null}
        </section>
      </aside>

      <main className="workbench">
        <section className="conversation">
          <header className="conversation-header">
            <div>
              <div className="eyebrow">Prompt Context</div>
              <h2>{selectedIssue?.title || activeProject?.name || "Project conversation"}</h2>
              <p>{contextLine(activeProject, selectedIssue, context)}</p>
            </div>
          </header>

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

          <div className="timeline">
            {conversation.map((item) => (
              <article key={item.id} className={`message ${item.role}`}>
                <div className="message-role">{item.role}</div>
                <div className="message-text">{item.text}</div>
              </article>
            ))}
            <div ref={conversationEndRef} />
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
              placeholder="Prompt Flow..."
            />
            <button type="button" title="Send prompt" onClick={() => void submitPrompt()} disabled={sending || !prompt.trim()}>
              <Send size={17} />
            </button>
          </section>
          {error ? <div className="error-line">{error}</div> : null}
        </section>

        <aside className="canvas">
          <header>
            <div className="eyebrow">Canvas</div>
            <h2>{activeArtifact?.title || "Artifacts"}</h2>
          </header>
          {activeArtifact ? (
            <div className="artifact-card">
              <FileCode size={18} />
              <div>
                <div className="artifact-type">{activeArtifact.artifactType}</div>
                <div className="artifact-title">{activeArtifact.title}</div>
                {activeArtifact.summary ? <div className="artifact-summary">{activeArtifact.summary}</div> : null}
                {activeArtifact.uri || activeArtifact.path ? (
                  <div className="artifact-uri">{activeArtifact.uri || activeArtifact.path}</div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="canvas-empty">
              <FileCode size={22} />
              <span>Artifacts from the conversation will appear here.</span>
            </div>
          )}
        </aside>
      </main>
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

function seedConversation(context?: ContextProjection): ConversationItem[] {
  const prompts = context?.prompts ?? [];
  const artifacts = context?.artifacts ?? [];
  if (!prompts.length && !artifacts.length) {
    return [{
      id: "system-empty",
      role: "system",
      text: "Ask Flow what to work on, or select an issue for narrower context.",
      createdAt: new Date().toISOString(),
    }];
  }
  return [
    ...prompts.slice(-6).flatMap((prompt) => [
      {
        id: prompt.id,
        role: "user" as const,
        text: prompt.prompt,
        createdAt: prompt.updatedAt,
      },
      ...(prompt.summary ? [{
        id: `${prompt.id}-summary`,
        role: "assistant" as const,
        text: prompt.summary,
        createdAt: prompt.updatedAt,
      }] : []),
    ]),
    ...artifacts.slice(-3).map((artifact) => ({
      id: `artifact-message-${artifact.id}`,
      role: "system" as const,
      text: artifact.summary || artifact.title,
      createdAt: artifact.updatedAt || new Date().toISOString(),
    })),
  ];
}

function contextLine(project: ProjectRecord | undefined, issue: DashboardIssue | undefined, context: ContextProjection): string {
  const parts = [
    project?.name,
    issue?.ref,
    context.active?.threadId ? `thread ${context.active.threadId}` : undefined,
    context.active?.sessionId ? `session ${context.active.sessionId}` : undefined,
  ].filter(Boolean);
  return parts.join(" / ") || "No active context";
}

function actionPayload(action: DesktopAction, prompt: string, issue: DashboardIssue | undefined): Record<string, unknown> {
  const summary = prompt.trim() || issue?.title || issue?.ref || "Flow Desktop action";
  if (action === "record_evidence") return { summary, source: "Flow Desktop conversation" };
  if (action === "record_documentation") return { summary, disposition: "not_needed" };
  if (action === "record_result") return { summary, status: "succeeded" };
  return {};
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
