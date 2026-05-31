import { RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { DashboardIssue, DashboardPayload, StatusKind, WorkStatusFilter } from "./types.js";
import { cx, formatSnapshotTime, matchesQuery, normalizeDashboardIssue, statusDotClass, workStatusLabel } from "./utils.js";
import { TopBar } from "./components/TopBar.js";
import { Sidebar } from "./components/Sidebar.js";
import { IssueList } from "./components/IssueList.js";

// ---- App ----

function App() {
  const [issues, setIssues] = useState<DashboardIssue[]>([]);
  const [activeRef, setActiveRef] = useState("");
  const [expandedRef, setExpandedRef] = useState("");
  const [activeStatus, setActiveStatus] = useState<WorkStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusKind>("loading");
  const [lastUpdated, setLastUpdated] = useState("Last updated -");
  const [loaded, setLoaded] = useState(false);
  const refreshInFlight = useRef(false);
  const hasLoaded = useRef(false);
  const hasUserFocusedIssue = useRef(false);

  const applyDashboardPayload = useCallback((payload: DashboardPayload) => {
    if (!payload.ok) throw new Error("Dashboard failed");
    const nextIssues = Array.isArray(payload.issues) ? payload.issues.map(normalizeDashboardIssue) : [];
    setIssues(nextIssues);
    setActiveRef((current) => {
      if (hasUserFocusedIssue.current && current && nextIssues.some((issue) => issue.ref === current)) return current;
      return "";
    });
    setExpandedRef((current) => {
      if (current && nextIssues.some((issue) => issue.ref === current)) return current;
      return "";
    });
    setLastUpdated(formatSnapshotTime(payload.snapshot));
    hasLoaded.current = true;
    setLoaded(true);
    setStatus("ok");
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!hasLoaded.current) {
      setStatus("loading");
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as DashboardPayload;
      applyDashboardPayload(payload);
    } catch (error) {
      setStatus("error");
    } finally {
      window.clearTimeout(timeout);
      refreshInFlight.current = false;
    }
  }, [applyDashboardPayload]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const filteredIssues = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (activeStatus !== "all" && workStatusLabel(issue) !== activeStatus) return false;
      return !trimmedQuery || matchesQuery(issue, trimmedQuery);
    });
  }, [activeStatus, issues, query]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of issues) {
      const label = workStatusLabel(issue);
      counts[label] = (counts[label] || 0) + 1;
    }
    return counts;
  }, [issues]);

  const snapshotStatusLabel = status === "error" ? "Snapshot unavailable" : lastUpdated;

  return (
    <div className="min-h-dvh bg-[var(--th-app)] text-[var(--th-fg)]">
      <div className="grid h-dvh w-full grid-rows-[3.5rem_1fr] overflow-hidden">
        <TopBar />
        {!loaded ? (
          <div className="grid min-h-0 place-items-center bg-[var(--th-app)] px-4 text-center sm:px-6">
            <div>
              <div className="accent-spinner mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2" />
              <div className="text-sm font-semibold text-[var(--th-fg)]">Loading issues</div>
              <div className="mt-1 text-xs text-[var(--th-fg-muted)]">Waiting for latest snapshot</div>
            </div>
          </div>
        ) : (
          <div className="relative grid min-h-0 grid-cols-1 md:grid-cols-[14rem_minmax(0,1fr)] lg:grid-cols-[14.5rem_minmax(0,1fr)]">
            <Sidebar
              activeStatus={activeStatus}
              issues={issues}
              query={query}
              statusCounts={statusCounts}
              onStatusChange={setActiveStatus}
              onQueryChange={setQuery}
            />
            <main className="grid min-h-0 min-w-0 grid-rows-[auto_1fr_auto] bg-[var(--th-app)]">
              <header className="border-b border-[var(--th-border)] bg-[var(--th-surface)] px-4 py-4 sm:px-5 lg:px-6">
                <div className="min-w-0">
                  <h1 className="m-0 text-lg font-semibold leading-tight text-[var(--th-fg)] sm:text-xl">Issues</h1>
                  <p className="m-0 mt-1 break-words text-[0.8rem] text-[var(--th-fg-muted)]">
                    {filteredIssues.length} of {issues.length} issue{issues.length === 1 ? "" : "s"}
                  </p>
                </div>
              </header>
              <IssueList
                issues={filteredIssues}
                activeRef={activeRef}
                expandedRef={expandedRef}
                onActivate={(ref) => {
                  hasUserFocusedIssue.current = true;
                  setActiveRef(ref);
                  setExpandedRef((current) => current === ref ? "" : ref);
                }}
              />
              <div className="border-t border-[var(--th-border)] px-4 py-3 text-center text-[0.72rem] tabular-nums text-[var(--th-fg-muted)] sm:px-5 lg:px-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{filteredIssues.length} of {issues.length} issues</span>
                  <div className="flex items-center gap-2">
                    <span className={cx("h-2 w-2 rounded-full", statusDotClass(status))} />
                    <span>{snapshotStatusLabel}</span>
                    <button
                      type="button"
                      data-mirror-control="refresh-snapshot"
                      title="Refresh snapshot"
                      aria-label="Refresh snapshot"
                      disabled={status === "loading"}
                      onClick={() => void refresh()}
                      className="accent-ring-focus grid h-7 w-7 place-items-center rounded-md border border-[var(--th-border)] bg-[var(--th-card)] text-[var(--th-fg-muted)] outline-none hover:border-[var(--th-primary)] hover:bg-[var(--th-hover)] hover:text-[var(--th-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
