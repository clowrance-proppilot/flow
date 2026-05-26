import {
  Check,
  Copy,
  RefreshCw,
  Search,
  Waypoints,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  isExceptionalWorkStatusLabel,
  normalizeRecordStatusLabel,
  normalizeWorkStatusLabel,
  workStatusSteps,
} from "../dashboard-labels";
import "./styles.css";

// ---- Types ----

type WorkStatusFilter = "all" | string;
type StatusKind = "loading" | "ok" | "error";

type DashboardIssue = {
  ref: string;
  title?: string;
  workStatus?: string;
  statusLabel?: string;
  repositories?: string[];
  blockerLabels?: string[];
  prStatus?: string;
  reviewStatus?: string;
  evidenceStatus?: string;
  documentationStatus?: string;
  updatedLabel?: string;
  nextPickup?: string;
  handoffPrompt?: string;
};

type DashboardIssueStringField =
  | "title"
  | "workStatus"
  | "statusLabel"
  | "prStatus"
  | "reviewStatus"
  | "evidenceStatus"
  | "documentationStatus"
  | "updatedLabel"
  | "nextPickup"
  | "handoffPrompt";

type DashboardPayload = {
  ok: boolean;
  snapshot?: {
    freshnessLabel?: string;
  };
  issues?: DashboardIssue[];
};

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
          <div className="grid min-h-0 place-items-center bg-[var(--th-app)] px-6 text-center">
            <div>
              <div className="accent-spinner mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2" />
              <div className="text-sm font-semibold text-[var(--th-fg)]">Loading issues</div>
              <div className="mt-1 text-xs text-[var(--th-fg-muted)]">Waiting for latest snapshot</div>
            </div>
          </div>
        ) : (
          <div className="relative grid min-h-0 grid-cols-1 lg:grid-cols-[13.75rem_minmax(0,1fr)] xl:grid-cols-[14.75rem_minmax(0,1fr)]">
            <Sidebar
              activeStatus={activeStatus}
              issues={issues}
              query={query}
              statusCounts={statusCounts}
              onStatusChange={setActiveStatus}
              onQueryChange={setQuery}
            />
            <main className="grid min-h-0 min-w-0 grid-rows-[auto_1fr_auto] bg-[var(--th-app)]">
              <header className="border-b border-[var(--th-border)] bg-[var(--th-surface)] px-4 py-4 lg:px-6">
                <div className="min-w-0">
                  <h1 className="m-0 text-[1.25rem] font-semibold leading-tight text-[var(--th-fg)]">Issues</h1>
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
              <div className="border-t border-[var(--th-border)] px-6 py-3 text-center text-[0.72rem] tabular-nums text-[var(--th-fg-muted)]">
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

// ---- TopBar ----

function TopBar() {
  return (
    <header className="grid grid-cols-[auto_1fr] items-center gap-4 border-b border-[var(--th-border)] bg-[var(--th-surface)] px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <BrandMark className="h-8 w-8 rounded-md" iconClassName="h-4 w-4" />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-[var(--th-fg)]">Flow</div>
        </div>
      </div>
      <div />
    </header>
  );
}

// ---- Sidebar ----

function Sidebar(props: {
  activeStatus: WorkStatusFilter;
  issues: DashboardIssue[];
  query: string;
  statusCounts: Record<string, number>;
  onStatusChange: (status: WorkStatusFilter) => void;
  onQueryChange: (query: string) => void;
}) {
  const statusFilters: Array<{ id: WorkStatusFilter; label: string; count: number }> = [
    { id: "all", label: "All Flow Items", count: props.issues.length },
    ...Object.keys(props.statusCounts).sort().map((label) => ({
      id: label,
      label,
      count: props.statusCounts[label] || 0,
    })),
  ];

  return (
    <aside className="flex min-h-0 flex-col border-b border-[var(--th-border)] bg-[var(--th-surface)] p-3 lg:border-b-0 lg:border-r lg:p-4">
      <label className="relative mb-3 lg:mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--th-fg-muted)]" />
        <input
          type="search"
          data-mirror-control="search-filter"
          placeholder="Search issues..."
          autoComplete="off"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          className="accent-ring-focus h-9 w-full rounded-md border border-[var(--th-border)] bg-[var(--th-input)] px-3 pl-9 text-[0.8rem] text-[var(--th-fg)] outline-none"
        />
      </label>

      <SectionLabel>Work Status</SectionLabel>
      <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] lg:mb-4 lg:grid-cols-1">
        {statusFilters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            data-mirror-control="status-filter"
            onClick={() => props.onStatusChange(filter.id)}
            className={cx(
              "status-filter grid min-h-9 min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-1.5 overflow-hidden rounded-md border px-1.5 text-left text-[0.74rem] font-semibold sm:gap-2 sm:px-2 sm:text-[0.8rem]",
              workStatusThemeClass(filter.id === "all" ? "all" : filter.label),
              props.activeStatus === filter.id && "is-active",
            )}
          >
            <span className="status-dot h-2 w-2 rounded-full" />
            <span className="min-w-0 truncate">{filter.label}</span>
            <span className="shrink-0 font-mono text-xs font-bold text-[var(--th-fg-muted)]">{filter.count}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// ---- Issue List ----

function IssueList(props: {
  issues: DashboardIssue[];
  activeRef: string;
  expandedRef: string;
  onActivate: (ref: string) => void;
}) {
  return (
    <div className="mirror-scroll min-h-0 overflow-auto p-3.5 lg:p-4">
      <div className="grid gap-2.5">
        {props.issues.length ? props.issues.map((issue) => {
          const isExpanded = issue.ref === props.expandedRef;
          const statusLabel = workStatusLabel(issue);
          const detailsId = `detail-panel-${issue.ref}`;
          return (
            <div key={issue.ref} className="grid min-w-0">
              <button
                type="button"
                data-mirror-control="issue-focus"
                aria-controls={detailsId}
                aria-expanded={isExpanded}
                onClick={() => props.onActivate(issue.ref)}
                className={cx(
                  "grid w-full min-w-0 gap-2 rounded-md border border-l-4 border-[var(--th-border)] bg-[var(--th-card)] p-3.5 text-left shadow-sm transition-colors hover:bg-[var(--th-card-hover)]",
                  "border-l-[var(--th-primary)]",
                  issue.ref === props.activeRef && "accent-active",
                  isExpanded && "rounded-b-none",
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="whitespace-nowrap font-mono text-[0.8rem] font-extrabold accent-text">
                      {issue.ref}
                    </span>
                  </div>
                </div>
                <div className="line-clamp-2 break-words text-[0.86rem] font-semibold leading-snug text-[var(--th-fg)]">
                  {issue.title || "Untitled issue"}
                </div>
                <div className="flex items-center gap-3">
                  <WorkflowTrack status={statusLabel} />
                  {!isExceptionalWorkStatusLabel(statusLabel) && (
                    <span className="min-w-0 truncate text-[0.75rem] text-[var(--th-fg-muted)]">
                      {statusLabel}
                    </span>
                  )}
                </div>
              </button>
              {isExpanded ? <IssueDetails id={detailsId} issue={issue} /> : null}
            </div>
          );
        }) : (
          <div className="rounded-md border border-dashed border-[var(--th-border)] p-6 text-center text-xs text-[var(--th-fg-faint)]">
            No matching issues
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Issue Details ----

function IssueDetails({
  id,
  issue,
}: {
  id: string;
  issue: DashboardIssue;
}) {
  const [copied, setCopied] = useState(false);
  const blockerLabels = Array.isArray(issue.blockerLabels) ? issue.blockerLabels : [];
  const repositories = Array.isArray(issue.repositories) ? issue.repositories : [];
  const statusLabel = workStatusLabel(issue);
  const handoffPrompt = (issue.handoffPrompt || issue.nextPickup || "").trim();
  const attentionTitle = statusLabel === "Blocked" ? "Blockers" : "Readiness Notes";
  const copyHandoffPrompt = () => {
    if (!handoffPrompt) return;
    void copyText(handoffPrompt).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <section id={id} className="min-w-0 rounded-b-md border border-t-0 border-l-4 border-[var(--th-border)] border-l-[var(--th-primary)] bg-[var(--th-surface)] shadow-sm">
      <DetailSection title="Issue Details">
        <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[0.8rem]">
          <dt className="text-[var(--th-fg-muted)]">Status</dt>
          <dd className="m-0 break-words text-[var(--th-fg)]">{statusLabel}</dd>
          {repositories.length > 0 && <>
            <dt className="text-[var(--th-fg-muted)]">Repos</dt>
            <dd className="m-0 break-words font-mono text-[var(--th-fg)] [overflow-wrap:anywhere]">{repositories.join(", ")}</dd>
          </>}
          {issue.prStatus && <>
            <dt className="text-[var(--th-fg-muted)]">PR</dt>
            <dd className="m-0 break-words text-[var(--th-fg)]">
              {issue.prStatus}
            </dd>
            <dt className="text-[var(--th-fg-muted)]">Review</dt>
            <dd className="m-0 break-words text-[var(--th-fg)]">{issue.reviewStatus || "Pending"}</dd>
          </>}
          <dt className="text-[var(--th-fg-muted)]">Evidence</dt>
          <dd className={cx("m-0", recordStatusClass(issue.evidenceStatus))}>
            {recordStatusLabel(issue.evidenceStatus)}
          </dd>
          <dt className="text-[var(--th-fg-muted)]">Docs</dt>
          <dd className={cx("m-0", recordStatusClass(issue.documentationStatus))}>
            {recordStatusLabel(issue.documentationStatus)}
          </dd>
          {issue.updatedLabel && <>
            <dt className="text-[var(--th-fg-muted)]">Updated</dt>
            <dd className="m-0 font-mono text-[var(--th-fg)]">{issue.updatedLabel}</dd>
          </>}
        </dl>
      </DetailSection>

      {blockerLabels.length ? (
        <DetailSection title={attentionTitle}>
          <div className="grid gap-2">
            {blockerLabels.map((label, index) => (
              <div key={`${index}-${label}`} className={cx(
                "rounded-md border p-2 text-xs leading-relaxed [overflow-wrap:anywhere]",
                statusLabel === "Blocked"
                  ? "border-flow-red/40 bg-flow-red/10 text-red-300"
                  : "border-[var(--th-border)] bg-[var(--th-card)] text-[var(--th-fg-soft)]",
              )}>
                {label}
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}

      {handoffPrompt ? (
        <DetailSection title="Handoff Prompt">
          <div className="grid gap-3">
            <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--th-border)] bg-[var(--th-input)] p-3 text-[0.74rem] leading-relaxed text-[var(--th-fg-soft)] [overflow-wrap:anywhere]">{handoffPrompt}</pre>
            <button
              type="button"
              data-mirror-control="copy-handoff-prompt"
              onClick={copyHandoffPrompt}
              className="status-filter status-theme-active inline-flex min-h-8 w-fit items-center gap-2 rounded-md border px-2.5 text-[0.76rem] font-semibold"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </DetailSection>
      ) : null}
    </section>
  );
}

// ---- Workflow Track ----

function WorkflowTrack({ status, size = "sm" }: { status?: string; size?: "sm" | "md" }) {
  const themeClass = workStatusThemeClass(status || "Unknown");
  if (status && isExceptionalWorkStatusLabel(status)) {
    return (
      <span
        className={cx(
          "status-pill inline-flex items-center rounded-full border px-2 py-0.5 text-[0.66rem] font-semibold",
          themeClass,
        )}
        title={status}
      >
        {status}
      </span>
    );
  }

  const currentIndex = workStatusSteps.indexOf(status as typeof workStatusSteps[number]);
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";
  const gap = size === "sm" ? "gap-1" : "gap-1.5";
  const barH = size === "sm" ? "h-px" : "h-[1.5px]";

  return (
    <div className={cx("workflow-track flex items-center", gap, themeClass)} title={status ? `Work status: ${status}` : "Work status unknown"}>
      {workStatusSteps.map((step, i) => {
        const isPast = currentIndex >= 0 && i < currentIndex;
        const isCurrent = i === currentIndex;
        const isFuture = currentIndex < 0 || i > currentIndex;
        return (
          <React.Fragment key={step}>
            {i > 0 && (
              <span className={cx(barH, "w-2 rounded-full", isPast || isCurrent ? "status-track-fill opacity-50" : "bg-[var(--th-fg-faint)] opacity-30")} />
            )}
            <span
              className={cx(
                "rounded-full transition-colors",
                dotSize,
                isCurrent && "status-dot",
                isPast && "status-dot opacity-50",
                isFuture && "bg-[var(--th-fg-faint)] opacity-30",
              )}
            />
          </React.Fragment>
        );
      })}
      {size === "md" && status && (
        <span className="ml-1.5 text-[0.68rem] font-semibold text-[var(--th-fg-muted)]">
          {status}
        </span>
      )}
    </div>
  );
}

// ---- Shared Components ----

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border-b border-[var(--th-border)] p-5 text-[0.8rem] text-[var(--th-fg-soft)] [overflow-wrap:anywhere]">
      <h2 className="mb-2.5 text-[0.8rem] font-bold text-[var(--th-fg)]">{title}</h2>
      {children}
    </section>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("mx-0.5 mb-2 text-[0.66rem] font-bold uppercase tracking-wide text-[var(--th-fg-muted)]", className)}>{children}</div>;
}

function BrandMark({ className, iconClassName }: { className: string; iconClassName: string }) {
  return (
    <span className={cx("brand-mark accent-bg grid place-items-center shadow-sm", className)} aria-hidden="true">
      <Waypoints className={cx("brand-mark-icon", iconClassName)} />
    </span>
  );
}

// ---- Utility Functions ----

function normalizeDashboardIssue(input: DashboardIssue): DashboardIssue {
  const issue: DashboardIssue = {
    ref: input.ref ? String(input.ref) : "",
    repositories: stringArray(input.repositories),
    blockerLabels: stringArray(input.blockerLabels),
  };
  assignDisplayString(issue, "title", input.title);
  issue.workStatus = normalizeWorkStatus(input.workStatus);
  assignDisplayString(issue, "statusLabel", input.statusLabel);
  assignDisplayString(issue, "prStatus", input.prStatus);
  assignDisplayString(issue, "reviewStatus", input.reviewStatus);
  issue.evidenceStatus = normalizeRecordStatus(input.evidenceStatus);
  issue.documentationStatus = normalizeRecordStatus(input.documentationStatus);
  assignDisplayString(issue, "updatedLabel", input.updatedLabel);
  assignDisplayString(issue, "nextPickup", input.nextPickup);
  assignDisplayString(issue, "handoffPrompt", input.handoffPrompt);
  return issue;
}

function assignDisplayString(issue: DashboardIssue, field: DashboardIssueStringField, value: unknown): void {
  if (typeof value === "string" && value) {
    issue[field] = value;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeWorkStatus(value: unknown): string {
  return normalizeWorkStatusLabel(value);
}

function normalizeRecordStatus(value: unknown): string {
  return normalizeRecordStatusLabel(value);
}

function workStatusLabel(issue: DashboardIssue): string {
  return normalizeWorkStatus(issue.workStatus);
}

function recordStatusLabel(status?: string): string {
  return normalizeRecordStatus(status);
}

function recordStatusClass(status?: string): string {
  return status === "Present"
    ? "text-lime-300"
    : "text-red-300";
}

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to the older user-gesture copy path below.
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

function workStatusThemeClass(label: string): string {
  if (label === "Blocked") return "status-theme-blocked";
  if (label === "Needs Input") return "status-theme-needs-input";
  if (label === "In Review") return "status-theme-review";
  if (label === "Running") return "status-theme-running";
  if (label === "Done") return "status-theme-done";
  if (label === "Ready") return "status-theme-ready";
  if (label === "Active") return "status-theme-active";
  if (label === "Queued") return "status-theme-queued";
  if (label === "all") return "status-theme-all";
  return "status-theme-unknown";
}

function matchesQuery(issue: DashboardIssue, query: string): boolean {
  return [
    issue.ref,
    issue.title,
    workStatusLabel(issue),
    ...(Array.isArray(issue.repositories) ? issue.repositories : []),
    ...(Array.isArray(issue.blockerLabels) ? issue.blockerLabels : []),
  ].join(" ").toLowerCase().includes(query);
}

function statusDotClass(kind: StatusKind): string {
  if (kind === "error") return "bg-flow-red";
  if (kind === "loading") return "bg-flow-yellow";
  return "accent-dot";
}

function formatSnapshotTime(snapshot: DashboardPayload["snapshot"]): string {
  return snapshot?.freshnessLabel || "Snapshot not loaded";
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
