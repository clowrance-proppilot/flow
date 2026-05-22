import {
  Check,
  ExternalLink,
  Leaf,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Settings2,
  Sun,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  type ColorMode,
  type FlowTheme,
  applyThemeToDOM,
  defaultThemes,
  getStoredMode,
  getStoredThemeId,
  resolveTheme,
} from "./themes";

// ---- Types ----

type StateFilter = "all" | string;
type StatusKind = "loading" | "stale" | "ok" | "error";

type DashboardIssue = {
  ref: string;
  title?: string;
  workflowState?: string;
  issueStatus?: string;
  repoKeys?: string[];
  blockers?: string[];
  issueUrl?: string;
  branch?: string;
  headSha?: string;
  worktreePath?: string;
  prUrl?: string;
  prIsDraft?: boolean;
  prChecksPassing?: boolean;
  prReviewDecision?: string;
  humanReviewRequired?: boolean;
  evidenceRecorded?: boolean;
  documentationRecorded?: boolean;
  autoflowAttempts?: number;
  autoflowAttemptLimit?: number;
  autoflowExhausted?: boolean;
  autoflowLastAttemptedAt?: string;
  updatedAt?: string;
};

type DashboardPayload = {
  ok: boolean;
  degraded?: boolean;
  degradedError?: string;
  error?: string;
  refreshing?: boolean;
  stale?: boolean;
  snapshot?: {
    source?: string;
    refreshedAt?: string;
    ageSeconds?: number;
    stale?: boolean;
  };
  health?: {
    pid?: number;
    uptimeSeconds?: number;
    queue?: {
      active?: number;
      pending?: number;
    };
  };
  issues?: DashboardIssue[];
  ui?: {
    themes?: FlowTheme[];
    defaultThemeId?: string;
    defaultMode?: ColorMode;
  };
};

type FlowEvent = {
  id: string;
  time: Date;
  issueRef: string;
  message: string;
};

// ---- Constants ----

const desktopQuery = "(min-width: 1280px)";
const MAX_EVENTS = 50;

// ---- App ----

function App() {
  const [issues, setIssues] = useState<DashboardIssue[]>([]);
  const [selectedRef, setSelectedRef] = useState("");
  const [activeState, setActiveState] = useState<StateFilter>("all");
  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(() => matchDesktop());
  const [status, setStatus] = useState<{ kind: StatusKind; message: string }>({ kind: "loading", message: "Loading" });
  const [lastUpdated, setLastUpdated] = useState("Last updated -");
  const [loaded, setLoaded] = useState(false);
  const [latestEvents, setLatestEvents] = useState<FlowEvent[]>([]);
  const [availableThemes, setAvailableThemes] = useState<FlowTheme[]>(defaultThemes);
  const [themeId, setThemeId] = useState(getStoredThemeId);
  const [mode, setMode] = useState<ColorMode>(getStoredMode);
  const refreshInFlight = useRef(false);
  const hasLoaded = useRef(false);

  const theme = useMemo(() => resolveTheme(themeId, availableThemes), [themeId, availableThemes]);

  useEffect(() => {
    applyThemeToDOM(theme, mode);
  }, [theme, mode]);

  useEffect(() => {
    const media = window.matchMedia(desktopQuery);
    const onChange = (event: MediaQueryListEvent) => setDetailOpen(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const pushEvent = useCallback((event: FlowEvent) => {
    setLatestEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  const applyDashboardPayload = useCallback((payload: DashboardPayload) => {
    if (!payload.ok) throw new Error(payload.error || "Dashboard failed");
    const configuredThemes = Array.isArray(payload.ui?.themes)
      ? payload.ui!.themes!.filter((theme) => Boolean(theme?.id && theme?.name))
      : [];
    const themesToUse = configuredThemes.length > 0 ? configuredThemes : defaultThemes;
    setAvailableThemes(themesToUse);
    if (!hasLoaded.current && payload.ui?.defaultThemeId) {
      setThemeId(payload.ui.defaultThemeId);
    }
    if (!hasLoaded.current && payload.ui?.defaultMode) {
      setMode(payload.ui.defaultMode);
    }
    const nextIssues = Array.isArray(payload.issues) ? payload.issues : [];
    setIssues(nextIssues);
    setSelectedRef((current) => current && nextIssues.some((issue) => issue.ref === current) ? current : nextIssues[0]?.ref || "");
    setLastUpdated(formatSnapshotTime(payload.snapshot));
    hasLoaded.current = true;
    setLoaded(true);
    const stale = payload.degraded || payload.stale || payload.snapshot?.stale;
    setStatus({
      kind: stale ? "stale" : "ok",
      message: statusMessage(payload),
    });
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (force || !hasLoaded.current) {
      setStatus({ kind: "loading", message: hasLoaded.current ? "Refreshing state" : "Loading state" });
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), force ? 40000 : 15000);
    try {
      const response = await fetch(`/api/dashboard${force ? "?force=1" : ""}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as DashboardPayload;
      applyDashboardPayload(payload);
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error && error.name === "AbortError"
          ? "Refresh timed out"
          : error instanceof Error
            ? error.message
            : "Refresh failed",
      });
    } finally {
      window.clearTimeout(timeout);
      refreshInFlight.current = false;
    }
  }, [applyDashboardPayload]);

  useEffect(() => {
    ensureCustomStylesheet();
    void refresh(false);
    const interval = window.setInterval(() => void refresh(false), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    const onEvent = (event: MessageEvent<string>) => {
      const payload = parseEventPayload(event.data);
      const type = String(payload.type ?? "");
      const issueRef = typeof payload.issueRef === "string" ? payload.issueRef : "";

      let message = "";
      if (type.endsWith(".started")) {
        message = issueRef ? `Flow running ${issueRef}` : "Flow event received";
        setStatus({ kind: "loading", message });
      } else if (type.endsWith(".failed")) {
        message = typeof payload.error === "string" ? payload.error : "Flow action failed";
        setStatus({ kind: "error", message });
      } else if (type.endsWith(".completed")) {
        message = issueRef ? `Flow updated ${issueRef}` : "Flow updated";
        setStatus({ kind: "ok", message });
      }

      if (message && issueRef) {
        pushEvent({
          id: `${Date.now()}-${Math.random()}`,
          time: new Date(),
          issueRef,
          message,
        });
      }

      if (type !== "connected") void refresh(false);
    };
    source.addEventListener("dashboard.action.started", onEvent);
    source.addEventListener("dashboard.action.completed", onEvent);
    source.addEventListener("dashboard.action.failed", onEvent);
    source.onerror = () => setStatus((current) => current.kind === "error" ? current : { kind: "stale", message: "Event stream reconnecting" });
    return () => source.close();
  }, [refresh, issues, pushEvent]);

  const filteredIssues = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (activeState !== "all" && flowState(issue) !== activeState) return false;
      return !trimmedQuery || matchesQuery(issue, trimmedQuery);
    });
  }, [activeState, issues, query]);

  const stateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const issue of issues) {
      const state = flowState(issue);
      counts[state] = (counts[state] || 0) + 1;
    }
    return counts;
  }, [issues]);

  const selectedIssue = issues.find((issue) => issue.ref === selectedRef) || issues[0];
  const detailButtonLabel = detailOpen ? "Hide details" : "Show details";
  const connectionLabel = status.kind === "error" ? "Down" : status.kind === "loading" || status.kind === "stale" ? status.kind === "stale" ? "Degraded" : "Refreshing" : "Live";

  return (
    <div className="min-h-dvh bg-[var(--th-app)] text-[var(--th-fg)]">
      <div className="grid h-dvh w-full grid-rows-[3.5rem_1fr] overflow-hidden">
        <TopBar themes={availableThemes} theme={theme} mode={mode} onThemeChange={(id) => setThemeId(id)} onModeChange={setMode} />
        {!loaded ? (
          <div className="grid min-h-0 place-items-center bg-[var(--th-app)] px-6 text-center">
            <div>
              <div className="accent-spinner mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2" />
              <div className="text-sm font-semibold text-[var(--th-fg)]">Loading Flow state</div>
              <div className="mt-1 text-xs text-[var(--th-fg-muted)]">Waiting for Flow CLI reconciliation</div>
            </div>
          </div>
        ) : (
          <div
            className={cx(
              "relative grid min-h-0 grid-cols-1 lg:grid-cols-[13.75rem_minmax(0,1fr)]",
              detailOpen
                ? "xl:grid-cols-[14.75rem_minmax(0,1fr)_minmax(18rem,21rem)]"
                : "xl:grid-cols-[14.75rem_minmax(0,1fr)]",
            )}
          >
            <Sidebar
              activeState={activeState}
              issues={issues}
              lastUpdated={lastUpdated}
              query={query}
              stateCounts={stateCounts}
              statusKind={status.kind}
              connectionLabel={connectionLabel}
              onStateChange={setActiveState}
              onQueryChange={setQuery}
              onRefresh={() => void refresh(true)}
            />
            <main className="grid min-h-0 min-w-0 grid-rows-[auto_auto_1fr_auto] bg-[var(--th-app)]">
              <header className="grid grid-cols-1 gap-3 border-b border-[var(--th-border)] bg-[var(--th-surface)] px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center lg:px-6">
                <div className="min-w-0">
                  <h1 className="m-0 text-[1.25rem] font-semibold leading-tight text-[var(--th-fg)]">Flow Mirror</h1>
                  <p className="m-0 mt-1 break-words text-[0.8rem] text-[var(--th-fg-muted)]">
                    {filteredIssues.length} of {issues.length} issue{issues.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    title={detailButtonLabel}
                    aria-label={detailButtonLabel}
                    aria-controls="detail-panel"
                    aria-expanded={detailOpen}
                    aria-pressed={detailOpen}
                    onClick={() => setDetailOpen((open) => !open)}
                    className={cx(
                      "grid h-8 w-8 place-items-center rounded-md border border-[var(--th-border)] bg-[var(--th-app)] text-[var(--th-fg-muted)] hover:border-[var(--th-border-strong)] hover:bg-[var(--th-card-hover)] hover:text-[var(--th-fg)]",
                      detailOpen && "accent-border accent-bg-tint text-[var(--th-fg)]",
                      detailOpen && "fixed right-3 top-3 z-30 lg:top-[3.125rem] xl:static",
                    )}
                  >
                    {detailOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                  </button>
                </div>
              </header>
              <LatestEventStrip events={latestEvents} />
              <IssueList
                issues={filteredIssues}
                selectedRef={selectedIssue?.ref || ""}
                onSelect={(ref) => {
                  setSelectedRef(ref);
                  setDetailOpen(true);
                }}
              />
              <div className="border-t border-[var(--th-border)] px-6 py-3 text-center text-[0.72rem] tabular-nums text-[var(--th-fg-muted)]">
                {filteredIssues.length} of {issues.length} issues
              </div>
            </main>
            {detailOpen ? (
              <DetailPanel
                issue={selectedIssue}
                events={latestEvents.filter((e) => e.issueRef === selectedIssue?.ref)}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- TopBar ----

function TopBar({
  themes,
  theme,
  mode,
  onThemeChange,
  onModeChange,
}: {
  themes: FlowTheme[];
  theme: FlowTheme;
  mode: ColorMode;
  onThemeChange: (id: string) => void;
  onModeChange: (mode: ColorMode) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || gearRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("click", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("click", onClickOutside); document.removeEventListener("keydown", onEsc); };
  }, [menuOpen]);

  return (
    <header className="grid grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-[var(--th-border)] bg-[var(--th-surface)] px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <BrandMark className="h-8 w-8 rounded-md" iconClassName="h-4 w-4" />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-[var(--th-fg)]">{theme.name}</div>
          <div className="hidden truncate text-xs text-[var(--th-fg-muted)] sm:block">Flow runtime</div>
        </div>
      </div>
      <div />
      <div className="relative">
        <button
          ref={gearRef}
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Settings"
          aria-label="Settings"
          className="grid h-8 w-8 place-items-center rounded-md text-[var(--th-fg-muted)] hover:bg-[var(--th-hover)] hover:text-[var(--th-fg)]"
        >
          <Settings2 size={16} />
        </button>
        <div
          ref={menuRef}
          className="settings-menu absolute right-0 top-10 z-50 min-w-[240px] rounded-md border border-[var(--th-border)] bg-[var(--th-surface)] p-2 shadow-lg"
          data-open={menuOpen}
          role="menu"
        >
          <div className="px-2.5 pb-1.5 pt-2 text-[0.62rem] font-bold uppercase tracking-widest text-[var(--th-fg-muted)]">
            Appearance
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "light"}
            onClick={() => { onModeChange("light"); }}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[0.8rem] text-[var(--th-fg)] hover:bg-[var(--th-hover)]",
              mode === "light" && "accent-bg-tint",
            )}
          >
            <Sun size={15} className="text-[var(--th-fg-muted)]" />
            Light
            {mode === "light" && <Check size={14} className="ml-auto accent-text" />}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={mode === "dark"}
            onClick={() => { onModeChange("dark"); }}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[0.8rem] text-[var(--th-fg)] hover:bg-[var(--th-hover)]",
              mode === "dark" && "accent-bg-tint",
            )}
          >
            <Moon size={15} className="text-[var(--th-fg-muted)]" />
            Dark
            {mode === "dark" && <Check size={14} className="ml-auto accent-text" />}
          </button>

          <div className="my-1.5 border-t border-[var(--th-border)]" />
          <div className="px-2.5 pb-1.5 pt-2 text-[0.62rem] font-bold uppercase tracking-widest text-[var(--th-fg-muted)]">
            Theme
          </div>
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={theme.id === t.id}
              onClick={() => { onThemeChange(t.id); }}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[0.8rem] text-[var(--th-fg)] hover:bg-[var(--th-hover)]",
                theme.id === t.id && "accent-bg-tint",
              )}
            >
              <span className="h-3.5 w-3.5 rounded-full" style={{ background: t.primary }} />
              {t.name}
              {theme.id === t.id && <Check size={14} className="ml-auto accent-text" />}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

// ---- Sidebar ----

function Sidebar(props: {
  activeState: StateFilter;
  issues: DashboardIssue[];
  lastUpdated: string;
  query: string;
  stateCounts: Record<string, number>;
  statusKind: StatusKind;
  connectionLabel: string;
  onStateChange: (state: StateFilter) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}) {
  const stateFilters: Array<{ id: StateFilter; label: string; count: number }> = [
    { id: "all", label: "All Flow Items", count: props.issues.length },
    ...Object.keys(props.stateCounts).sort().map((state) => ({
      id: state,
      label: flowStateLabel(state),
      count: props.stateCounts[state] || 0,
    })),
  ];

  return (
    <aside className="flex min-h-0 flex-col border-b border-[var(--th-border)] bg-[var(--th-surface)] p-3 lg:border-b-0 lg:border-r lg:p-4">
      <label className="relative mb-3 lg:mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--th-fg-muted)]" />
        <input
          type="search"
          placeholder="Search issues..."
          autoComplete="off"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          className="accent-ring-focus h-9 w-full rounded-md border border-[var(--th-border)] bg-[var(--th-input)] px-3 pl-9 text-[0.8rem] text-[var(--th-fg)] outline-none"
        />
      </label>

      <SectionLabel>Flow State</SectionLabel>
      <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] lg:mb-4 lg:grid-cols-1">
        {stateFilters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => props.onStateChange(filter.id)}
            className={cx(
              "grid min-h-9 grid-cols-[0.625rem_1fr_auto] items-center gap-2 rounded-md border px-2 text-left text-[0.8rem] font-semibold",
              props.activeState === filter.id
                ? "accent-border-soft accent-bg-tint text-[var(--th-fg)]"
                : "border-transparent text-[var(--th-fg-soft)] hover:bg-[var(--th-hover)]",
            )}
          >
            <span className={cx("h-2 w-2 rounded-full", filter.id === "all" ? "accent-dot" : stateDotClass(filter.id))} />
            <span className="truncate">{filter.label}</span>
            <span className="font-mono text-xs font-bold text-[var(--th-fg-muted)]">{filter.count}</span>
          </button>
        ))}
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-[var(--th-border)] pt-3 lg:block">
        <button
          type="button"
          onClick={props.onRefresh}
          className="inline-flex h-9 min-w-32 items-center justify-center gap-2 rounded-md border border-[var(--th-border)] bg-[var(--th-app)] px-3 text-[0.8rem] font-semibold text-[var(--th-fg)] hover:border-[var(--th-border-strong)] hover:bg-[var(--th-card-hover)] lg:w-full"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
        <div className="flex items-center gap-2 text-xs text-[var(--th-fg-muted)] lg:mt-3">
          <span className={cx("h-2 w-2 rounded-full", statusDotClass(props.statusKind), props.statusKind === "ok" && "animate-pulse")} />
          <div>
            <div>{props.connectionLabel}</div>
            <div className="text-[var(--th-fg-faint)]">{props.lastUpdated}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ---- Latest Event Strip ----

function LatestEventStrip({ events }: { events: FlowEvent[] }) {
  const latest = events[0];
  return (
    <div className="flex items-center gap-3 border-b border-[var(--th-border)] bg-[var(--th-surface)] px-4 py-2 text-xs lg:px-6">
      <span className="flex items-center gap-2 text-[0.62rem] font-bold uppercase tracking-widest text-[var(--th-fg-muted)]">
        <span className="h-1.5 w-1.5 rounded-full accent-dot animate-pulse" />
        Latest
      </span>
      {latest ? (
        <span key={latest.id} className="fade-in flex min-w-0 items-center gap-2.5">
          <span className="font-mono text-[0.68rem] text-[var(--th-fg-faint)]">
            {latest.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <span className="font-mono text-[0.72rem] font-semibold text-[var(--th-fg)]">{latest.issueRef}</span>
          <span className="truncate text-[var(--th-fg-muted)]">{latest.message}</span>
        </span>
      ) : (
        <span className="text-[var(--th-fg-faint)]">Listening for events&hellip;</span>
      )}
    </div>
  );
}

// ---- Issue List ----

function IssueList(props: {
  issues: DashboardIssue[];
  selectedRef: string;
  onSelect: (ref: string) => void;
}) {
  return (
    <div className="themed-scroll min-h-0 overflow-auto p-3.5 lg:p-4">
      <div className="grid gap-2.5">
        {props.issues.length ? props.issues.map((issue) => (
          <button
            key={issue.ref}
            type="button"
            onClick={() => props.onSelect(issue.ref)}
            className={cx(
              "grid w-full min-w-0 gap-2 rounded-md border border-l-4 border-[var(--th-border)] bg-[var(--th-card)] p-3.5 text-left shadow-sm transition-colors hover:bg-[var(--th-card-hover)]",
              "border-l-[var(--th-primary)]",
              issue.ref === props.selectedRef && "accent-selected",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="whitespace-nowrap font-mono text-[0.8rem] font-extrabold accent-text">
                  {issue.ref}
                </span>
              </div>
              <span className="flex-shrink-0 rounded-full border border-[var(--th-border)] bg-[var(--th-app)] px-2 py-0.5 text-[0.68rem] font-bold text-[var(--th-fg-muted)]">
                {flowStateLabel(flowState(issue))}
              </span>
            </div>
            <div className="line-clamp-2 break-words text-[0.86rem] font-semibold leading-snug text-[var(--th-fg)]">
              {issue.title || "Untitled issue"}
            </div>
            <div className="flex items-center gap-3">
              <WorkflowTrack state={issue.workflowState} />
              <span className="min-w-0 truncate text-[0.75rem] text-[var(--th-fg-muted)]">
                {issue.issueStatus || "No issue tracker status"}
              </span>
            </div>
          </button>
        )) : (
          <div className="rounded-md border border-dashed border-[var(--th-border)] p-6 text-center text-xs text-[var(--th-fg-faint)]">
            No matching issues
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Detail Panel ----

function DetailPanel({
  issue,
  events,
}: {
  issue?: DashboardIssue;
  events: FlowEvent[];
}) {
  if (!issue) {
    return (
      <aside id="detail-panel" className="fixed inset-0 z-20 min-w-0 overflow-auto bg-[var(--th-surface)] lg:absolute lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[min(25rem,calc(100%-13.75rem))] xl:static xl:w-auto xl:border-l xl:border-[var(--th-border)]">
        <div className="border-b border-[var(--th-border)] p-5 pr-16 xl:pr-5">
          <div className="break-words text-lg font-semibold text-[var(--th-fg)]">No issue selected</div>
        </div>
      </aside>
    );
  }
  const blockers = Array.isArray(issue.blockers) ? issue.blockers : [];
  const repos = Array.isArray(issue.repoKeys) ? issue.repoKeys : [];
  return (
    <aside id="detail-panel" className="themed-scroll fixed inset-0 z-20 min-w-0 overflow-auto bg-[var(--th-surface)] lg:absolute lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[min(25rem,calc(100%-13.75rem))] xl:static xl:w-auto xl:border-l xl:border-[var(--th-border)]">
      <div className="border-b border-[var(--th-border)] p-5 pr-16 xl:pr-5">
        <div className="font-mono text-xs font-extrabold tracking-wide accent-text">{issue.ref}</div>
        <div className="mb-3 mt-2 break-words text-[1.05rem] font-semibold leading-snug text-[var(--th-fg)]">
          {issue.title || "Untitled issue"}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {issue.issueUrl ? <ExternalButton primary href={issue.issueUrl} label="Open Issue" /> : <DisabledButton label="No Issue Link" />}
          {issue.prUrl ? <ExternalButton href={issue.prUrl} label="Open PR" /> : <DisabledButton label="No PR" />}
        </div>
      </div>

      <DetailSection title="Flow State">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-[var(--th-border)] bg-[var(--th-app)] px-2 py-0.5 text-[0.68rem] font-extrabold text-[var(--th-fg)]">
            {flowStateLabel(flowState(issue))}
          </span>
        </div>
        <div className="mt-3">
          <WorkflowTrack state={issue.workflowState} size="md" />
        </div>
      </DetailSection>

      <DetailSection title="Issue Details">
        <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[0.8rem]">
          {issue.issueStatus && <>
            <dt className="text-[var(--th-fg-muted)]">Status</dt>
            <dd className="m-0 break-words text-[var(--th-fg)]">{issue.issueStatus}</dd>
          </>}
          {repos.length > 0 && <>
            <dt className="text-[var(--th-fg-muted)]">Repos</dt>
            <dd className="m-0 break-words font-mono text-[var(--th-fg)] [overflow-wrap:anywhere]">{repos.join(", ")}</dd>
          </>}
          {issue.prUrl && <>
            <dt className="text-[var(--th-fg-muted)]">PR</dt>
            <dd className="m-0 break-words text-[var(--th-fg)]">
              {issue.prIsDraft ? "Draft" : "Ready"}
              {issue.prChecksPassing === true && " · checks passing"}
              {issue.prChecksPassing === false && " · checks failing"}
            </dd>
            <dt className="text-[var(--th-fg-muted)]">Review</dt>
            <dd className="m-0 break-words text-[var(--th-fg)]">{issue.prReviewDecision || (issue.humanReviewRequired ? "review required" : "pending")}</dd>
          </>}
          <dt className="text-[var(--th-fg-muted)]">Evidence</dt>
          <dd className={cx("m-0", issue.evidenceRecorded ? "text-lime-300 [data-theme=light]:text-green-700" : "text-red-300 [data-theme=light]:text-red-700")}>
            {issue.evidenceRecorded ? "recorded" : "missing"}
          </dd>
          <dt className="text-[var(--th-fg-muted)]">Docs</dt>
          <dd className={cx("m-0", issue.documentationRecorded ? "text-lime-300 [data-theme=light]:text-green-700" : "text-red-300 [data-theme=light]:text-red-700")}>
            {issue.documentationRecorded ? "recorded" : "missing"}
          </dd>
          {issue.updatedAt && <>
            <dt className="text-[var(--th-fg-muted)]">Updated</dt>
            <dd className="m-0 font-mono text-[var(--th-fg)]">{relativeTime(issue.updatedAt)}</dd>
          </>}
        </dl>
      </DetailSection>

      {(issue.worktreePath || issue.branch || issue.headSha) && (
        <DetailSection title="Workspace">
          <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[0.8rem]">
            {issue.worktreePath && <>
              <dt className="text-[var(--th-fg-muted)]">Worktree</dt>
              <dd className="m-0 break-words font-mono text-[0.72rem] text-[var(--th-fg)] [overflow-wrap:anywhere]">{issue.worktreePath}</dd>
            </>}
            {issue.branch && <>
              <dt className="text-[var(--th-fg-muted)]">Branch</dt>
              <dd className="m-0 break-words font-mono text-[0.72rem] text-[var(--th-fg)] [overflow-wrap:anywhere]">{issue.branch}</dd>
            </>}
            {issue.headSha && <>
              <dt className="text-[var(--th-fg-muted)]">Head</dt>
              <dd className="m-0 break-words font-mono text-[0.72rem] text-[var(--th-fg)] [overflow-wrap:anywhere]">{shortSha(issue.headSha)}</dd>
            </>}
          </dl>
        </DetailSection>
      )}

      <DetailSection title="Blockers">
        {blockers.length ? (
          <div className="grid gap-2">
            {blockers.map((blocker) => (
              <div key={blocker} className="rounded-md border border-flow-red/40 bg-flow-red/10 p-2 text-xs leading-relaxed text-red-300 [data-theme=light]:text-red-700 [overflow-wrap:anywhere]">
                {blocker}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[var(--th-fg-faint)]">No blockers recorded.</p>
        )}
      </DetailSection>

      {events.length > 0 && (
        <DetailSection title="Recent Events">
          <div className="grid gap-2">
            {events.slice(0, 10).map((evt) => (
              <div key={evt.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 text-[0.78rem]">
                <span className="h-[7px] w-[7px] rounded-full accent-dot" />
                <span className="truncate text-[var(--th-fg-soft)]">{evt.message}</span>
                <span className="font-mono text-[0.68rem] text-[var(--th-fg-faint)]">
                  {evt.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}
    </aside>
  );
}

// ---- Workflow Track ----

const workflowSteps = ["queued", "selected", "ready_to_run", "running", "awaiting_review", "done"] as const;
const exceptionalStates = new Set(["blocked", "awaiting_human"]);
const stateLabelLookup: Record<string, string> = {
  queued: "Queued",
  selected: "Selected",
  ready_to_run: "Ready To Run",
  running: "Running",
  blocked: "Blocked",
  awaiting_review: "Awaiting Review",
  awaiting_human: "Awaiting Human",
  done: "Done",
  unknown: "Unknown",
};

function WorkflowTrack({ state, size = "sm" }: { state?: string; size?: "sm" | "md" }) {
  if (state && exceptionalStates.has(state)) {
    const isBlocked = state === "blocked";
    return (
      <span
        className={cx(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-[0.66rem] font-semibold",
          isBlocked
            ? "border-flow-red/60 bg-flow-red/15 text-red-300 [data-theme=light]:text-red-700"
            : "border-flow-yellow/60 bg-flow-yellow/15 text-amber-200 [data-theme=light]:text-amber-700",
        )}
        title={flowStateLabel(state)}
      >
        {flowStateLabel(state)}
      </span>
    );
  }

  const currentIndex = workflowSteps.indexOf(state as typeof workflowSteps[number]);
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";
  const gap = size === "sm" ? "gap-1" : "gap-1.5";
  const barH = size === "sm" ? "h-px" : "h-[1.5px]";

  return (
    <div className={cx("flex items-center", gap)} title={state ? `Workflow: ${flowStateLabel(state)}` : "Workflow state unknown"}>
      {workflowSteps.map((step, i) => {
        const isPast = currentIndex >= 0 && i < currentIndex;
        const isCurrent = i === currentIndex;
        const isFuture = currentIndex < 0 || i > currentIndex;
        return (
          <React.Fragment key={step}>
            {i > 0 && (
              <span className={cx(barH, "w-2 rounded-full", isPast || isCurrent ? "accent-dot opacity-40" : "bg-[var(--th-fg-faint)] opacity-30")} />
            )}
            <span
              className={cx(
                "rounded-full transition-colors",
                dotSize,
                isCurrent && "accent-dot",
                isPast && "accent-dot opacity-40",
                isFuture && "bg-[var(--th-fg-faint)] opacity-30",
              )}
            />
          </React.Fragment>
        );
      })}
      {size === "md" && state && (
        <span className="ml-1.5 text-[0.68rem] font-semibold text-[var(--th-fg-muted)]">
          {flowStateLabel(state)}
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

function ExternalButton({ href, label, primary = false }: { href: string; label: string; primary?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx(
        "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-2 text-center text-[0.78rem] font-semibold",
        primary
          ? "accent-bg border-transparent"
          : "border-[var(--th-border)] bg-[var(--th-app)] text-[var(--th-fg)] hover:border-[var(--th-border-strong)] hover:bg-[var(--th-card-hover)]",
      )}
    >
      {label}
      <ExternalLink size={13} />
    </a>
  );
}

function DisabledButton({ label }: { label: string }) {
  return (
    <span className="inline-flex min-h-9 items-center justify-center rounded-md border border-[var(--th-border)] bg-[var(--th-app)] px-2 text-center text-[0.78rem] font-semibold text-[var(--th-fg-faint)]">
      {label}
    </span>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("mx-0.5 mb-2 text-[0.66rem] font-bold uppercase tracking-wide text-[var(--th-fg-muted)]", className)}>{children}</div>;
}

function BrandMark({ className, iconClassName }: { className: string; iconClassName: string }) {
  return (
    <span className={cx("brand-mark accent-bg grid place-items-center shadow-sm", className)} aria-hidden="true">
      <Leaf className={cx("brand-mark-icon", iconClassName)} />
    </span>
  );
}

// ---- Utility Functions ----

function flowState(issue: DashboardIssue): string {
  return issue.workflowState || "unknown";
}

function flowStateLabel(state: string): string {
  if (stateLabelLookup[state]) return stateLabelLookup[state];
  return state
    .split("_")
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

function stateDotClass(state: string): string {
  if (state === "running") return "bg-flow-green";
  if (state === "awaiting_review") return "bg-flow-yellow";
  if (state === "awaiting_human") return "bg-flow-yellow";
  if (state === "done") return "bg-flow-blue";
  if (state === "unknown") return "bg-[var(--th-fg-faint)]";
  return "accent-dot";
}

function matchesQuery(issue: DashboardIssue, query: string): boolean {
  return [
    issue.ref,
    issue.title,
    issue.workflowState,
    issue.issueStatus,
    issue.branch,
    issue.headSha,
    issue.worktreePath,
    issue.prUrl,
    ...(Array.isArray(issue.repoKeys) ? issue.repoKeys : []),
    ...(Array.isArray(issue.blockers) ? issue.blockers : []),
  ].join(" ").toLowerCase().includes(query);
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function statusDotClass(kind: StatusKind): string {
  if (kind === "error") return "bg-flow-red";
  if (kind === "loading" || kind === "stale") return "bg-flow-yellow";
  return "accent-dot";
}

function statusMessage(payload: DashboardPayload): string {
  if (payload.degraded) return payload.degradedError || "Flow CLI refresh degraded";
  if (payload.refreshing) return "Refreshing snapshot";
  if (payload.stale || payload.snapshot?.stale) {
    const age = typeof payload.snapshot?.ageSeconds === "number" ? ` (${payload.snapshot.ageSeconds}s old)` : "";
    return `Snapshot stale${age}`;
  }
  if (typeof payload.snapshot?.ageSeconds === "number") return `Current (${payload.snapshot.ageSeconds}s old)`;
  return "Current";
}

function parseEventPayload(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function ensureCustomStylesheet(): void {
  const id = "flow-dashboard-custom-css";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = "/dashboard/custom.css";
  document.head.appendChild(link);
}

function formatSnapshotTime(snapshot: DashboardPayload["snapshot"]): string {
  if (!snapshot?.refreshedAt) return "Snapshot not loaded";
  const date = new Date(snapshot.refreshedAt);
  if (Number.isNaN(date.getTime())) return "Snapshot time unknown";
  const age = typeof snapshot.ageSeconds === "number" ? `, ${snapshot.ageSeconds}s old` : "";
  return `Snapshot ${date.toLocaleTimeString()}${age}`;
}

function relativeTime(raw?: string): string {
  if (!raw) return "unknown";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function matchDesktop(): boolean {
  return typeof window !== "undefined" && window.matchMedia(desktopQuery).matches;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
