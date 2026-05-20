import {
  Clipboard,
  ExternalLink,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import "./styles.css";

type LaneId = "needs_flow" | "needs_work" | "needs_intervention" | "pr_review";
type SurfaceFilterId = "all" | `surface:${string}`;
type StatusKind = "loading" | "stale" | "ok" | "error";

type DashboardIssue = {
  ref: string;
  title?: string;
  workflowState?: string;
  lane?: LaneId;
  substate?: string;
  substateTooltip?: string;
  nextAction?: string;
  hidden?: boolean;
  flowActionable?: boolean;
  jiraStatus?: string;
  repoKeys?: string[];
  blockers?: string[];
  jiraUrl?: string;
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
  actions?: DashboardAction[];
};

type IssueView = DashboardIssue & {
  lane: LaneId;
  substate: string;
  substateTooltip: string;
  nextAction: string;
  flowActionable: boolean;
  searchText: string;
};

type FlowSurface = {
  id: SurfaceFilterId;
  label: string;
  count: number;
  dotClass: string;
};

type DashboardAction = {
  id: string;
  label: string;
  enabled?: boolean;
  blocker?: string;
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
};

const desktopQuery = "(min-width: 1280px)";
const laneOrder: LaneId[] = ["needs_flow", "needs_work", "needs_intervention", "pr_review"];
const lanes: Record<LaneId, { label: string; accent: string; dot: string; border: string; text: string }> = {
  needs_flow: {
    label: "Needs Flow",
    accent: "bg-fs-blue",
    dot: "bg-fs-blue",
    border: "border-l-fs-blue",
    text: "text-sky-700",
  },
  needs_work: {
    label: "Needs Work",
    accent: "bg-fs-green",
    dot: "bg-fs-green",
    border: "border-l-fs-green",
    text: "text-green-700",
  },
  needs_intervention: {
    label: "Needs Intervention",
    accent: "bg-fs-red",
    dot: "bg-fs-red",
    border: "border-l-fs-red",
    text: "text-red-700",
  },
  pr_review: {
    label: "PR Review",
    accent: "bg-fs-yellow",
    dot: "bg-fs-yellow",
    border: "border-l-fs-yellow",
    text: "text-amber-700",
  },
};

function App() {
  const [issues, setIssues] = useState<IssueView[]>([]);
  const [selectedRef, setSelectedRef] = useState("");
  const [activeSurface, setActiveSurface] = useState<SurfaceFilterId>("all");
  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(() => matchDesktop());
  const [autoflowEnabled, setAutoflowEnabled] = useState(() => window.localStorage.getItem("flow.autoflow.enabled") === "1");
  const [status, setStatus] = useState<{ kind: StatusKind; message: string }>({ kind: "loading", message: "Loading" });
  const [lastUpdated, setLastUpdated] = useState("Last updated -");
  const [loaded, setLoaded] = useState(false);
  const [handoffPrompt, setHandoffPrompt] = useState<{ issueRef: string; text: string; copied: boolean } | undefined>();
  const refreshInFlight = useRef(false);
  const autoflowInFlight = useRef(false);
  const lastAutoflowAt = useRef(0);
  const hasLoaded = useRef(false);
  const tabId = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

  useEffect(() => {
    const media = window.matchMedia(desktopQuery);
    const onChange = (event: MediaQueryListEvent) => setDetailOpen(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const applyDashboardPayload = useCallback((payload: DashboardPayload) => {
    if (!payload.ok) throw new Error(payload.error || "Dashboard failed");
    const nextIssues = normalizeIssues(Array.isArray(payload.issues) ? payload.issues : []);
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

  const copyHandoffPrompt = useCallback(async (issue: IssueView) => {
    const text = buildHandoffPrompt(issue);
    try {
      await copyText(text);
      setHandoffPrompt({ issueRef: issue.ref, text, copied: true });
      setStatus({ kind: "ok", message: "Handoff prompt copied" });
    } catch (error) {
      setHandoffPrompt({ issueRef: issue.ref, text, copied: false });
      setStatus({
        kind: "ok",
        message: "Handoff prompt ready for manual copy",
      });
    }
  }, []);

  const runAutoflow = useCallback(async (issue: IssueView) => {
    const response = await fetch("/api/actions/autoflow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        issueRef: issue.ref,
        options: { autoApproveWorker: true, runWorker: true, maxSteps: 8 },
      }),
    });
    const payload = await response.json() as { ok?: boolean; error?: string; dashboard?: DashboardPayload };
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Autoflow failed with HTTP ${response.status}`);
    if (payload.dashboard) applyDashboardPayload(payload.dashboard);
  }, [applyDashboardPayload]);

  const toggleAutoflow = useCallback(() => {
    setAutoflowEnabled((enabled) => {
      const next = !enabled;
      window.localStorage.setItem("flow.autoflow.enabled", next ? "1" : "0");
      if (!next) releaseAutoflowLease(tabId.current);
      setStatus({ kind: "ok", message: next ? "Autoflow started" : "Autoflow paused" });
      return next;
    });
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "flow.autoflow.enabled") {
        setAutoflowEnabled(event.newValue === "1");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
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
      if (type.endsWith(".started")) {
        setStatus({ kind: "loading", message: issueRef ? `Flow running ${issueRef}` : "Flow event received" });
      } else if (type.endsWith(".failed")) {
        setStatus({ kind: "error", message: typeof payload.error === "string" ? payload.error : "Flow action failed" });
      } else if (type.endsWith(".completed")) {
        setStatus({ kind: "ok", message: issueRef ? `Flow updated ${issueRef}` : "Flow updated" });
      }
      if (type !== "connected") void refresh(false);
    };
    source.addEventListener("dashboard.action.started", onEvent);
    source.addEventListener("dashboard.action.completed", onEvent);
    source.addEventListener("dashboard.action.failed", onEvent);
    source.addEventListener("work_runtime.event", onEvent);
    source.onerror = () => setStatus((current) => current.kind === "error" ? current : { kind: "stale", message: "Event stream reconnecting" });
    return () => source.close();
  }, [refresh]);

  useEffect(() => {
    if (!autoflowEnabled || autoflowInFlight.current) return;
    const now = Date.now();
    if (now - lastAutoflowAt.current < 3000) return;
    const candidate = issues.find(isAutoflowCandidate);
    if (!candidate) return;
    if (!acquireAutoflowLease(tabId.current)) return;
    autoflowInFlight.current = true;
    lastAutoflowAt.current = now;
    setStatus({ kind: "loading", message: `Autoflow running ${candidate.ref}` });
    void runAutoflow(candidate)
      .then(() => setStatus({ kind: "ok", message: `Autoflow attempted ${candidate.ref}` }))
      .catch((error) => {
        setStatus({ kind: "error", message: error instanceof Error ? error.message : "Autoflow failed" });
        setAutoflowEnabled(false);
        window.localStorage.setItem("flow.autoflow.enabled", "0");
      })
      .finally(() => {
        autoflowInFlight.current = false;
        releaseAutoflowLease(tabId.current);
      });
  }, [autoflowEnabled, issues, runAutoflow]);

  const filteredIssues = useMemo(() => {
    const trimmedQuery = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (activeSurface !== "all" && surfaceFilterId(issue) !== activeSurface) return false;
      return !trimmedQuery || issue.searchText.includes(trimmedQuery);
    });
  }, [activeSurface, issues, query]);

  const surfaces = useMemo(() => flowSurfaces(issues), [issues]);
  const selectedIssue = issues.find((issue) => issue.ref === selectedRef) || issues[0];
  const detailButtonLabel = detailOpen ? "Hide details" : "Show details";
  const connectionLabel = status.kind === "error" ? "Down" : status.kind === "loading" || status.kind === "stale" ? status.kind === "stale" ? "Degraded" : "Refreshing" : "Live";

  return (
    <div className="min-h-dvh bg-[#0f1115] text-neutral-100">
      <div className="grid h-dvh w-full grid-rows-[3.5rem_1fr] overflow-hidden">
        <TopBar />
        {!loaded ? (
          <div className="grid min-h-0 place-items-center bg-[#0f1115] px-6 text-center">
            <div>
              <div className="mx-auto mb-4 h-8 w-8 rounded-full border-2 border-neutral-700 border-t-fs-green" />
              <div className="text-sm font-semibold text-white">Loading Flow state</div>
              <div className="mt-1 text-xs text-neutral-400">Waiting for Work Runtime reconciliation</div>
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
            activeSurface={activeSurface}
            autoflowEnabled={autoflowEnabled}
            issues={issues}
            lastUpdated={lastUpdated}
            query={query}
            surfaces={surfaces}
            statusKind={status.kind}
            connectionLabel={connectionLabel}
            onSurfaceChange={setActiveSurface}
            onQueryChange={setQuery}
            onRefresh={() => void refresh(true)}
            onToggleAutoflow={toggleAutoflow}
          />
          <main className="grid min-h-0 min-w-0 grid-rows-[auto_1fr] bg-[#0f1115]">
            <header className="grid grid-cols-1 gap-3 border-b border-neutral-800 bg-[#11151b] px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center lg:px-6">
              <div className="min-w-0">
                <h1 className="m-0 text-[1.25rem] font-semibold leading-tight text-white">Flow Mirror</h1>
                <p className="m-0 mt-1 break-words text-[0.8rem] text-neutral-400">
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
                    "grid h-8 w-8 place-items-center rounded-md border border-neutral-700 bg-[#0f1115] text-neutral-300 hover:border-neutral-500 hover:bg-[#1a2029] hover:text-white",
                    detailOpen && "border-fs-green bg-fs-green/15 text-white",
                    detailOpen && "fixed right-3 top-3 z-30 lg:top-[3.125rem] xl:static",
                  )}
                >
                  {detailOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                </button>
              </div>
            </header>
            <FlowDiagram
              issues={filteredIssues}
              selectedRef={selectedIssue?.ref || ""}
              onSelect={(ref) => {
                setSelectedRef(ref);
                setDetailOpen(true);
              }}
            />
          </main>
          {detailOpen ? <DetailPanel issue={selectedIssue} onCopyHandoff={copyHandoffPrompt} /> : null}
          {handoffPrompt ? (
            <HandoffPromptDialog
              copied={handoffPrompt.copied}
              issueRef={handoffPrompt.issueRef}
              text={handoffPrompt.text}
              onClose={() => setHandoffPrompt(undefined)}
              onRetry={async () => {
                try {
                  await copyText(handoffPrompt.text);
                  setHandoffPrompt({ ...handoffPrompt, copied: true });
                  setStatus({ kind: "ok", message: "Handoff prompt copied" });
                } catch {
                  setStatus({ kind: "ok", message: "Handoff prompt ready for manual copy" });
                }
              }}
            />
          ) : null}
        </div>
        )}
      </div>
    </div>
  );
}

function TopBar() {
  return (
    <header className="grid grid-cols-[auto_1fr] items-center gap-4 border-b border-neutral-800 bg-[#11151b] px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <BrandMark className="h-8 w-8 rounded-md" iconClassName="h-4 w-4" />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-white">Flow</div>
          <div className="hidden truncate text-xs text-neutral-400 sm:block">Workflow control plane</div>
        </div>
      </div>
    </header>
  );
}

function Sidebar(props: {
  activeSurface: SurfaceFilterId;
  autoflowEnabled: boolean;
  issues: IssueView[];
  lastUpdated: string;
  query: string;
  surfaces: FlowSurface[];
  statusKind: StatusKind;
  connectionLabel: string;
  onSurfaceChange: (surface: SurfaceFilterId) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onToggleAutoflow: () => void;
}) {
  const filters: FlowSurface[] = [
    { id: "all", label: "All", count: props.issues.length, dotClass: "bg-fs-green" },
    ...props.surfaces,
  ];
  return (
    <aside className="flex min-h-0 flex-col border-b border-neutral-800 bg-[#11151b] p-3 lg:border-b-0 lg:border-r lg:p-4">
      <div className="mb-3 hidden border-b border-neutral-800 pb-3 lg:block">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={cx("h-2 w-2 rounded-full", props.autoflowEnabled ? "bg-fs-green animate-pulse" : "bg-neutral-600")} />
              <div className="truncate text-[0.78rem] font-bold text-white">Autoflow</div>
            </div>
          </div>
          <button
            type="button"
            onClick={props.onToggleAutoflow}
            aria-pressed={props.autoflowEnabled}
            className={cx(
              "relative h-6 w-11 rounded-full border transition-colors",
              props.autoflowEnabled
                ? "border-fs-green/60 bg-fs-green/30"
                : "border-neutral-700 bg-[#0f1115]",
            )}
          >
            <span className={cx(
              "absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white transition-transform",
              props.autoflowEnabled ? "translate-x-[1.375rem]" : "translate-x-1",
            )} />
            <span className="sr-only">{props.autoflowEnabled ? "Pause Autoflow" : "Start Autoflow"}</span>
          </button>
        </div>
      </div>
      <label className="relative mb-3 lg:mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
        <input
          type="search"
          placeholder="Search issues..."
          autoComplete="off"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          className="h-9 w-full rounded-md border border-neutral-700 bg-[#0f1115] px-3 pl-9 text-[0.8rem] text-white outline-none focus:border-fs-green focus:ring-2 focus:ring-fs-green/20"
        />
      </label>
      <SectionLabel>Flow Surfaces</SectionLabel>
      <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] lg:mb-4 lg:grid-cols-1">
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => props.onSurfaceChange(filter.id)}
            className={cx(
              "grid min-h-9 grid-cols-[0.625rem_1fr_auto] items-center gap-2 rounded-md border px-2 text-left text-[0.8rem] font-semibold",
              props.activeSurface === filter.id
                ? "border-fs-green/40 bg-fs-green/15 text-white"
                : "border-transparent text-neutral-300 hover:bg-white/5",
            )}
          >
            <span className={cx("h-2 w-2 rounded-full", filter.dotClass)} />
            <span className="truncate">{filter.label}</span>
            <span className="font-mono text-xs font-bold text-neutral-400">{filter.count}</span>
          </button>
        ))}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 pt-3 lg:block">
        <button
          type="button"
          onClick={props.onRefresh}
          className="inline-flex h-9 min-w-32 items-center justify-center gap-2 rounded-md border border-neutral-700 bg-[#0f1115] px-3 text-[0.8rem] font-semibold text-white hover:border-neutral-500 hover:bg-[#1a2029] lg:w-full"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
        <div className="flex items-center gap-2 text-xs text-neutral-400 lg:mt-3">
          <span className={cx("h-2 w-2 rounded-full", statusDotClass(props.statusKind), props.statusKind === "ok" && "animate-pulse")} />
          <div>
            <div>{props.connectionLabel}</div>
            <div className="text-neutral-500">{props.lastUpdated}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function FlowDiagram(props: {
  issues: IssueView[];
  selectedRef: string;
  onSelect: (ref: string) => void;
}) {
  return (
    <div className="min-h-0 overflow-auto p-3.5 lg:p-4">
      <div className="grid gap-2.5">
        {props.issues.length ? props.issues.map((issue) => (
          <button
            key={issue.ref}
            type="button"
            onClick={() => props.onSelect(issue.ref)}
            className={cx(
              "grid w-full min-w-0 gap-3 rounded-md border border-l-4 border-neutral-800 bg-[#151a22] p-3 text-left text-white shadow-sm hover:border-neutral-700 hover:bg-[#1a2029] lg:grid-cols-[minmax(13rem,0.55fr)_minmax(0,1fr)] lg:items-start",
              lanes[issue.lane].border,
              issue.ref === props.selectedRef && "border-fs-green bg-fs-green/10 shadow-selected",
            )}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-start gap-2">
                <span className={cx("whitespace-nowrap font-mono text-[0.8rem] font-extrabold", lanes[issue.lane].text)}>
                  {issue.ref}
                </span>
                <SubstateBadge issue={issue} />
              </div>
              <div className="mt-1.5 line-clamp-2 break-words text-[0.86rem] font-semibold leading-relaxed text-neutral-100">
                {issue.title || "Untitled issue"}
              </div>
            </div>
            <FlowState issue={issue} />
          </button>
        )) : (
          <div className="rounded-md border border-dashed border-neutral-700 p-6 text-center text-xs text-neutral-500">No matching issues</div>
        )}
      </div>
    </div>
  );
}

function FlowState({ issue }: { issue: IssueView }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-neutral-800 bg-[#0f1115] p-2.5">
      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(7rem,0.75fr)_minmax(7rem,0.75fr)_minmax(0,1.4fr)_auto] sm:items-start">
        <FlowDatum label="lane" value={issue.lane} valueClassName={lanes[issue.lane].text} />
        <FlowDatum label="substate" value={issue.substate} />
        <FlowDatum label="next" value={nextText(issue)} />
        <FlowDatum label="auto" value={issue.flowActionable ? "yes" : "no"} valueClassName={issue.flowActionable ? "text-lime-300" : "text-neutral-500"} />
      </div>
    </div>
  );
}

function FlowDatum({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[0.62rem] font-bold uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={cx("truncate font-mono text-[0.78rem] font-semibold text-neutral-200", valueClassName)} title={value}>
        {value}
      </div>
    </div>
  );
}

function DetailPanel({
  issue,
  onCopyHandoff,
}: {
  issue?: IssueView;
  onCopyHandoff: (issue: IssueView) => void;
}) {
  if (!issue) {
    return (
      <aside id="detail-panel" className="fixed inset-0 z-20 min-w-0 overflow-auto bg-[#11151b] lg:absolute lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[min(25rem,calc(100%-13.75rem))] xl:static xl:w-auto xl:border-l xl:border-neutral-800">
        <div className="border-b border-neutral-800 p-5 pr-16 xl:pr-5">
          <div className="break-words text-lg font-semibold text-white">No issue selected</div>
        </div>
      </aside>
    );
  }
  const blockers = Array.isArray(issue.blockers) ? issue.blockers : [];
  const repos = Array.isArray(issue.repoKeys) ? issue.repoKeys : [];
  return (
    <aside id="detail-panel" className="fixed inset-0 z-20 min-w-0 overflow-auto bg-[#11151b] lg:absolute lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[min(25rem,calc(100%-13.75rem))] xl:static xl:w-auto xl:border-l xl:border-neutral-800">
      <div className="border-b border-neutral-800 p-5 pr-16 xl:pr-5">
        <div className="font-mono text-xs font-extrabold tracking-wide text-fs-green">{issue.ref}</div>
        <div className="mb-3 mt-2 break-words text-[1.05rem] font-semibold leading-snug text-white">{issue.title || "Untitled issue"}</div>
        <div className="grid grid-cols-2 gap-2">
          {issue.jiraUrl ? <ExternalButton primary href={issue.jiraUrl} label="Open Jira" /> : <DisabledButton label="No Jira" />}
          {issue.prUrl ? <ExternalButton href={issue.prUrl} label="Open PR" /> : <DisabledButton label="No PR" />}
          <button
            type="button"
            onClick={() => onCopyHandoff(issue)}
            className="col-span-2 inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-fs-green bg-fs-green/15 px-3 text-center text-[0.78rem] font-semibold text-lime-200 hover:bg-fs-green/25 hover:text-white"
          >
            <Clipboard size={14} />
            Copy Handoff Prompt
          </button>
        </div>
      </div>
      <DetailSection title="Next">
        <p>{nextText(issue)}</p>
      </DetailSection>
      <DetailSection title="Flow Payload">
        <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[0.8rem]">
          <dt className="text-neutral-400">Lane</dt>
          <dd className="m-0 break-words font-mono text-white">{issue.lane}</dd>
          <dt className="text-neutral-400">Substate</dt>
          <dd className="m-0 break-words font-mono text-white">{issue.substate}</dd>
          <dt className="text-neutral-400">Auto</dt>
          <dd className={cx("m-0 font-mono", issue.flowActionable ? "text-lime-300" : "text-neutral-400")}>
            {issue.flowActionable ? "yes" : "no"}
          </dd>
          <dt className="text-neutral-400">Workflow</dt>
          <dd className="m-0 break-words font-mono text-white">{issue.workflowState || "unknown"}</dd>
          <dt className="text-neutral-400">Status</dt>
          <dd className="m-0 break-words text-white">{issue.jiraStatus || "unknown"}</dd>
          <dt className="text-neutral-400">Repos</dt>
          <dd className="m-0 break-words font-mono text-white [overflow-wrap:anywhere]">{repos.length ? repos.join(", ") : "unknown"}</dd>
          <dt className="text-neutral-400">PR</dt>
          <dd className="m-0 break-words text-white">
            {issue.prUrl
              ? `${issue.prIsDraft ? "draft" : "ready"} / checks ${issue.prChecksPassing === true ? "passing" : issue.prChecksPassing === false ? "failing" : "unknown"}`
              : "none"}
          </dd>
          <dt className="text-neutral-400">Review</dt>
          <dd className="m-0 break-words text-white">{issue.prReviewDecision || (issue.humanReviewRequired ? "review required" : "unknown")}</dd>
          <dt className="text-neutral-400">Evidence</dt>
          <dd className={cx("m-0", issue.evidenceRecorded ? "text-lime-300" : "text-red-300")}>
            {issue.evidenceRecorded ? "recorded" : "missing"}
          </dd>
          <dt className="text-neutral-400">Docs</dt>
          <dd className={cx("m-0", issue.documentationRecorded ? "text-lime-300" : "text-red-300")}>
            {issue.documentationRecorded ? "recorded" : "missing"}
          </dd>
          <dt className="text-neutral-400">Updated</dt>
          <dd className="m-0 font-mono text-white">{relativeTime(issue.updatedAt)}</dd>
        </dl>
      </DetailSection>
      <DetailSection title="Blockers">
        {blockers.length ? (
          <div className="grid gap-2">
            {blockers.map((blocker) => (
              <div key={blocker} className="rounded-md border border-fs-red/40 bg-fs-red/10 p-2 text-xs leading-relaxed text-red-300 [overflow-wrap:anywhere]">
                {blocker}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-neutral-500">No blockers recorded.</p>
        )}
      </DetailSection>
    </aside>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border-b border-neutral-800 p-5 text-[0.8rem] text-neutral-300 [overflow-wrap:anywhere]">
      <h2 className="mb-2.5 text-[0.8rem] font-bold text-white">{title}</h2>
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
          ? "border-fs-green bg-fs-green text-[#0c1a05]"
          : "border-neutral-700 bg-[#0f1115] text-white hover:border-neutral-500 hover:bg-[#1a2029]",
      )}
    >
      {label}
      <ExternalLink size={13} />
    </a>
  );
}

function DisabledButton({ label }: { label: string }) {
  return (
    <span className="inline-flex min-h-9 items-center justify-center rounded-md border border-neutral-800 bg-[#0f1115] px-2 text-center text-[0.78rem] font-semibold text-neutral-600">
      {label}
    </span>
  );
}

function HandoffPromptDialog({
  copied,
  issueRef,
  text,
  onClose,
  onRetry,
}: {
  copied: boolean;
  issueRef: string;
  text: string;
  onClose: () => void;
  onRetry: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (copied) return;
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, [copied, text]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/65 p-4">
      <section className="grid max-h-[min(42rem,calc(100vh-2rem))] w-full max-w-3xl grid-rows-[auto_1fr_auto] overflow-hidden rounded-md border border-neutral-700 bg-[#11151b] shadow-2xl">
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div className="min-w-0">
            <div className="font-mono text-xs font-extrabold text-fs-green">{issueRef}</div>
            <h2 className="m-0 truncate text-base font-semibold text-white">
              {copied ? "Handoff Prompt Copied" : "Handoff Prompt"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-neutral-700 bg-[#0f1115] text-neutral-300 hover:border-neutral-500 hover:text-white"
            aria-label="Close handoff prompt"
          >
            <X size={16} />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          readOnly
          value={text}
          className="min-h-0 w-full resize-none border-0 bg-[#0f1115] p-4 font-mono text-xs leading-relaxed text-neutral-100 outline-none"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800 px-4 py-3">
          <span className="text-xs text-neutral-400">
            {copied ? "The prompt was copied to the clipboard." : "Clipboard access was blocked; the prompt text is selected."}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-fs-green bg-fs-green/15 px-3 text-[0.78rem] font-semibold text-lime-200 hover:bg-fs-green/25 hover:text-white"
            >
              <Clipboard size={14} />
              Copy Again
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-9 items-center justify-center rounded-md border border-neutral-700 bg-[#0f1115] px-3 text-[0.78rem] font-semibold text-white hover:border-neutral-500 hover:bg-[#1a2029]"
            >
              Close
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx("mx-0.5 mb-2 text-[0.66rem] font-bold uppercase tracking-wide text-neutral-400", className)}>{children}</div>;
}

function BrandMark({ className, iconClassName }: { className: string; iconClassName: string }) {
  return (
    <span className={cx("grid place-items-center bg-fs-green shadow-sm", className)} aria-hidden="true">
      <svg className={iconClassName} viewBox="0 0 35 46" xmlns="http://www.w3.org/2000/svg">
        <path d="m34.468 16.599v-7.617h-24.651v-8.69h-8.834v8.706h8.821v36.921h8.944v-14.346h14.502v-7.357h-14.502v-7.617z" fill="#fff" />
      </svg>
    </span>
  );
}

function SubstateBadge({ issue }: { issue: IssueView }) {
  const label = substateLabel(issue);
  if (!label) return null;
  const attempts = issue.autoflowAttempts ?? 0;
  const limit = issue.autoflowAttemptLimit ?? 3;
  return (
    <Tooltip text={issue.substateTooltip || substateTooltip(label)}>
      <span className={cx("rounded-full border px-2 py-0.5 text-[0.68rem] font-extrabold", substateClasses(issue))}>
        {label === "autoflow" ? `autoflow ${attempts}/${limit}` : label}
      </span>
    </Tooltip>
  );
}

function Tooltip({ children, text }: { children: React.ReactNode; text: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);

  const show = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = 256;
    const margin = 12;
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, margin), window.innerWidth - width - margin);
    const belowTop = rect.bottom + 8;
    const placement = belowTop + 96 > window.innerHeight && rect.top > 112 ? "above" : "below";
    setPosition({
      left,
      placement,
      top: placement === "above" ? rect.top - 8 : belowTop,
    });
  }, []);

  return (
    <span
      ref={anchorRef}
      className="inline-flex align-middle"
      onBlur={() => setPosition(null)}
      onFocus={show}
      onPointerEnter={show}
      onPointerLeave={() => setPosition(null)}
      onPointerMove={show}
    >
      {children}
      {position
        ? createPortal(
            <span
              role="tooltip"
              className={cx(
                "pointer-events-none fixed z-50 w-64 rounded-md border border-black/80 bg-black px-3 py-2 text-left text-[0.875rem] font-medium normal-case leading-relaxed tracking-normal text-white shadow-[0_18px_45px_rgba(0,0,0,0.42)]",
                position.placement === "above" && "-translate-y-full",
              )}
              style={{ left: position.left, top: position.top }}
            >
              {text}
              <span
                className={cx(
                  "absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-black/80 bg-black",
                  position.placement === "above" ? "-bottom-1 border-b border-r" : "-top-1 border-l border-t",
                )}
                aria-hidden="true"
              />
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

function substateLabel(issue: IssueView): string {
  return issue.substate;
}

function substateClasses(issue: IssueView): string {
  const label = substateLabel(issue);
  if (label === "autoflow") return "border-fs-purple/55 bg-fs-purple/25 text-fuchsia-100";
  if (label === "autoflow exhausted") return "border-fs-red/50 bg-fs-red/15 text-red-200";
  if (label === "needs flow") return "border-fs-blue/55 bg-fs-blue/20 text-sky-100";
  if (issue.lane === "needs_work") return "border-fs-green/50 bg-fs-green/20 text-lime-200";
  if (issue.lane === "pr_review") return "border-fs-yellow/45 bg-fs-yellow/15 text-amber-200";
  if (issue.lane === "needs_intervention") return "border-fs-red/50 bg-fs-red/15 text-red-200";
  return "border-neutral-700 bg-[#0f1115] text-neutral-300";
}

function substateTooltip(label: string): string {
  if (!label) return label;
  switch (label) {
    case "needs flow":
      return "Flow still needs to reconcile, route, prepare, advance, or choose the next action.";
    case "autoflow":
      return "Flow has started retrying the automatic path.";
    case "autoflow exhausted":
      return "Flow has tried the automatic path enough times and now needs human input.";
    case "worker started":
      return "A worker was started. Treat this as a work marker, not proof of live process health.";
    case "worktree ready":
      return "A prepared worktree exists and implementation or remediation is the next useful work.";
    case "review":
      return "The pull request is waiting for human GitHub review.";
    case "github":
      return "The next external action is on the GitHub pull request.";
    case "credentials":
      return "Flow is blocked on missing or invalid credentials.";
    case "provider":
      return "Flow is blocked on external provider behavior, access, or data.";
    case "conflict":
      return "Flow is blocked on git or pull-request merge conflicts.";
    case "needs human":
      return "Flow cannot safely continue without operator judgment.";
    default:
      return label;
  }
}

function isAutoflowCandidate(issue: IssueView): boolean {
  return issue.flowActionable && issue.autoflowExhausted !== true;
}

function acquireAutoflowLease(owner: string): boolean {
  const key = "flow.autoflow.lease";
  const now = Date.now();
  const existing = parseAutoflowLease(window.localStorage.getItem(key));
  if (existing && existing.owner !== owner && existing.expiresAt > now) return false;
  window.localStorage.setItem(key, JSON.stringify({ owner, expiresAt: now + 30000 }));
  return true;
}

function releaseAutoflowLease(owner: string): void {
  const key = "flow.autoflow.lease";
  const existing = parseAutoflowLease(window.localStorage.getItem(key));
  if (!existing || existing.owner === owner) window.localStorage.removeItem(key);
}

function parseAutoflowLease(raw: string | null): { owner: string; expiresAt: number } | undefined {
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const owner = (parsed as { owner?: unknown }).owner;
    const expiresAt = (parsed as { expiresAt?: unknown }).expiresAt;
    return typeof owner === "string" && typeof expiresAt === "number" ? { owner, expiresAt } : undefined;
  } catch {
    return undefined;
  }
}

function normalizeIssues(rawIssues: DashboardIssue[]): IssueView[] {
  return rawIssues
    .filter((issue) => !isDoneIssue(issue))
    .map((issue) => {
      const lane = laneFromFlow(issue);
      const substate = issue.substate || "unknown";
      const substateTooltip = issue.substateTooltip || "Flow did not surface a dashboard substate for this issue.";
      const nextAction = issue.nextAction || "No Flow action surfaced";
      return {
        ...issue,
        lane,
        substate,
        substateTooltip,
        nextAction,
        flowActionable: issue.flowActionable === true,
        searchText: [
          issue.ref,
          issue.title,
          issue.workflowState,
          issue.jiraStatus,
          lane,
          substate,
          nextAction,
          ...(Array.isArray(issue.repoKeys) ? issue.repoKeys : []),
          ...(Array.isArray(issue.blockers) ? issue.blockers : []),
        ].join(" ").toLowerCase(),
      };
    });
}

function flowSurfaces(issues: IssueView[]): FlowSurface[] {
  const grouped = new Map<string, { count: number; dotClass: string }>();
  for (const issue of issues) {
    const label = issue.substate || "unknown";
    const existing = grouped.get(label);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(label, { count: 1, dotClass: lanes[issue.lane].dot });
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => ({
      id: `surface:${label}`,
      label,
      count: value.count,
      dotClass: value.dotClass,
    }));
}

function surfaceFilterId(issue: IssueView): SurfaceFilterId {
  return `surface:${issue.substate || "unknown"}`;
}

function laneFromFlow(issue: DashboardIssue): LaneId {
  if (issue.lane && laneOrder.includes(issue.lane)) return issue.lane;
  return "needs_intervention";
}

function nextText(issue: DashboardIssue): string {
  return issue.nextAction || "No Flow action surfaced";
}

function isDoneIssue(issue: DashboardIssue): boolean {
  return issue.hidden === true;
}

function buildHandoffPrompt(issue: IssueView): string {
  const blockers = Array.isArray(issue.blockers) && issue.blockers.length
    ? issue.blockers.map((blocker) => `- ${blocker}`).join("\n")
    : "- None recorded";
  return [
    `You are a local-thread executor for FARMserver Jira issue ${issue.ref}.`,
    `Name this thread "${threadTitleForIssue(issue)}".`,
    "",
    "Work through Flow. First reconcile/adopt this executor task using the metadata below, then keep going until Flow reports a real blocker or the work is review-ready.",
    "",
    "## Issue",
    `- Jira: ${issue.jiraUrl || issue.ref}`,
    `- Title: ${issue.title || "Untitled issue"}`,
    `- Jira status: ${issue.jiraStatus || "unknown"}`,
    `- Repos: ${Array.isArray(issue.repoKeys) && issue.repoKeys.length ? issue.repoKeys.join(", ") : "unknown"}`,
    `- Worktree: ${issue.worktreePath || "not recorded"}`,
    `- Branch: ${issue.branch || "not recorded"}`,
    `- Head SHA: ${issue.headSha || "not recorded"}`,
    `- PR: ${issue.prUrl || "none"}`,
    `- PR state: ${issue.prUrl ? `${issue.prIsDraft ? "draft" : "ready"} / checks ${issue.prChecksPassing === true ? "passing" : issue.prChecksPassing === false ? "failing" : "unknown"} / review ${issue.prReviewDecision || "unknown"}` : "none"}`,
    "",
    "## Current Blockers",
    blockers,
    "",
    "## Next Action",
    nextText(issue),
  ].join("\n");
}

function threadTitleForIssue(issue: IssueView): string {
  const shortDescription = (issue.title || "")
    .replace(/\b[A-Z]+-\d+\b/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
  return `${shortDescription || "FARMserver work"} ${issue.ref}`.trim();
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("Clipboard copy failed.");
}

function statusDotClass(kind: StatusKind): string {
  if (kind === "error") return "bg-fs-red";
  if (kind === "loading" || kind === "stale") return "bg-fs-yellow";
  return "bg-fs-green";
}

function statusMessage(payload: DashboardPayload): string {
  if (payload.degraded) return payload.degradedError || "Work Runtime refresh degraded";
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
