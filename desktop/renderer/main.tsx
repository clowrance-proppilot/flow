import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type DashboardIssue = {
  ref: string;
  title?: string;
  workStatus?: string;
  statusLabel?: string;
};

type PiTimelineItem = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolName?: string;
  diff?: {
    path: string;
    before?: string;
    after?: string;
  };
};

type PiSession = {
  id: string;
  issueRef: string;
  startedAt: string;
  updatedAt: string;
  timeline: PiTimelineItem[];
};

function App() {
  const [issues, setIssues] = useState<DashboardIssue[]>([]);
  const [activeIssueRef, setActiveIssueRef] = useState("");
  const [activeSession, setActiveSession] = useState<PiSession | undefined>(undefined);
  const [loadingIssues, setLoadingIssues] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const timelineEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadIssues();
  }, []);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeSession?.timeline.length]);

  const activeIssue = useMemo(
    () => issues.find((issue) => issue.ref === activeIssueRef),
    [issues, activeIssueRef],
  );

  async function loadIssues(): Promise<void> {
    setLoadingIssues(true);
    setError("");
    try {
      const response = await fetch("/api/pi/issues", { cache: "no-store" });
      const payload = await response.json() as { ok?: boolean; issues?: unknown[]; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const next = (payload.issues ?? [])
        .map((item) => normalizeIssue(item))
        .filter(Boolean) as DashboardIssue[];
      setIssues(next);
      if (!activeIssueRef && next.length) {
        await selectIssue(next[0].ref);
      }
    } catch (cause) {
      setError("Unable to load issues.");
    } finally {
      setLoadingIssues(false);
    }
  }

  async function selectIssue(issueRef: string): Promise<void> {
    setActiveIssueRef(issueRef);
    setLoadingSession(true);
    setError("");
    try {
      const response = await fetch(`/api/pi/issues/${encodeURIComponent(issueRef)}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await response.json() as { ok?: boolean; session?: unknown; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const session = normalizeSession(payload.session);
      if (!session) throw new Error("Malformed session payload.");
      setActiveSession(session);
    } catch (cause) {
      setError("Unable to start pi session.");
    } finally {
      setLoadingSession(false);
    }
  }

  async function sendPrompt(): Promise<void> {
    const text = prompt.trim();
    if (!text || !activeSession) return;
    setSendingPrompt(true);
    setError("");
    try {
      const response = await fetch(`/api/pi/sessions/${encodeURIComponent(activeSession.id)}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const payload = await response.json() as { ok?: boolean; session?: unknown; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const session = normalizeSession(payload.session);
      if (!session) throw new Error("Malformed session payload.");
      setActiveSession(session);
      setPrompt("");
    } catch (cause) {
      setError("Unable to send prompt.");
    } finally {
      setSendingPrompt(false);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <header className="sidebar-head">
          <h1>Flow Desktop</h1>
          <button type="button" onClick={() => void loadIssues()} disabled={loadingIssues}>
            Refresh
          </button>
        </header>
        {loadingIssues ? <div className="muted">Loading issues...</div> : null}
        <div className="issue-list">
          {issues.map((issue) => (
            <button
              key={issue.ref}
              type="button"
              className={issue.ref === activeIssueRef ? "issue active" : "issue"}
              onClick={() => void selectIssue(issue.ref)}
            >
              <div className="issue-ref">{issue.ref}</div>
              <div className="issue-title">{issue.title || "Untitled issue"}</div>
              <div className="issue-status">{issue.workStatus || issue.statusLabel || "Queued"}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        <header className="main-head">
          <h2>{activeIssue?.title || "Pi Session"}</h2>
          <div className="muted">{activeIssueRef || "No issue selected"}</div>
        </header>

        <section className="timeline">
          {loadingSession ? <div className="muted">Starting pi session...</div> : null}
          {!loadingSession && activeSession?.timeline.length
            ? activeSession.timeline.map((item) => (
              <article key={item.id} className={`item role-${item.role}`}>
                <div className="item-head">
                  <span className="role">{item.role}</span>
                  <span className="time">{formatRelativeTime(item.createdAt)}</span>
                  {item.toolName ? <span className="tool">{item.toolName}</span> : null}
                </div>
                <div className="item-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.content) }} />
                {item.diff ? <DiffView diff={item.diff} /> : null}
              </article>
            ))
            : null}
          {!loadingSession && !activeSession?.timeline.length ? <div className="muted">No session events yet.</div> : null}
          <div ref={timelineEndRef} />
        </section>

        <section className="composer">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendPrompt();
              }
            }}
            placeholder="Send prompt to pi session..."
          />
          <div className="composer-row">
            <span className="muted">Enter to send, Shift+Enter for newline</span>
            <button type="button" onClick={() => void sendPrompt()} disabled={sendingPrompt || !prompt.trim() || !activeSession}>
              {sendingPrompt ? "Sending..." : "Send"}
            </button>
          </div>
        </section>

        {error ? <div className="error">{error}</div> : null}
      </main>
    </div>
  );
}

function DiffView({ diff }: { diff: { path: string; before?: string; after?: string } }) {
  return (
    <div className="diff">
      <div className="path">{diff.path}</div>
      {diff.before ? <pre className="before">{diff.before}</pre> : null}
      {diff.after ? <pre className="after">{diff.after}</pre> : null}
    </div>
  );
}

function normalizeIssue(value: unknown): DashboardIssue | undefined {
  if (!isRecord(value)) return undefined;
  const ref = asString(value.ref);
  if (!ref) return undefined;
  return {
    ref,
    title: asString(value.title),
    workStatus: asString(value.workStatus),
    statusLabel: asString(value.statusLabel),
  };
}

function normalizeSession(value: unknown): PiSession | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const issueRef = asString(value.issueRef);
  if (!id || !issueRef) return undefined;
  const timeline = (Array.isArray(value.timeline) ? value.timeline : [])
    .map((item) => normalizeTimelineItem(item))
    .filter(Boolean) as PiTimelineItem[];
  return {
    id,
    issueRef,
    startedAt: asString(value.startedAt) || new Date().toISOString(),
    updatedAt: asString(value.updatedAt) || new Date().toISOString(),
    timeline,
  };
}

function normalizeTimelineItem(value: unknown): PiTimelineItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const role = asString(value.role) as PiTimelineItem["role"];
  const content = typeof value.content === "string" ? value.content : "";
  if (!id || !content || !["system", "user", "assistant", "tool"].includes(role)) return undefined;
  let diff: PiTimelineItem["diff"];
  if (isRecord(value.diff)) {
    const path = asString(value.diff.path);
    if (path) {
      diff = {
        path,
        before: asString(value.diff.before),
        after: asString(value.diff.after),
      };
    }
  }
  return {
    id,
    role,
    content,
    createdAt: asString(value.createdAt) || new Date().toISOString(),
    toolName: asString(value.toolName),
    diff,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderMarkdown(value: string): string {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^\n*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^\n*]+)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br />");
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);

