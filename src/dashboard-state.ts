import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DashboardSnapshotSource = "work_runtime" | "empty";

export interface DashboardSnapshot {
  issues: Record<string, unknown>[];
  refreshedAt: string;
  source: DashboardSnapshotSource;
  degradedError?: string;
}

export interface DashboardPayloadOptions {
  health?: Record<string, unknown>;
  limit?: number;
}

export interface DashboardStateOptions {
  workRuntimeUrl: string;
  repoRoot?: string;
  debugLog?: (event: string, details: Record<string, unknown>) => void;
}

export class DashboardState {
  private readonly workRuntimeUrl: string;
  private readonly repoRoot: string;
  private readonly debugLog: (event: string, details: Record<string, unknown>) => void;
  private refresh: Promise<DashboardSnapshot> | undefined;

  constructor(options: DashboardStateOptions) {
    this.workRuntimeUrl = options.workRuntimeUrl.replace(/\/+$/, "");
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.debugLog = options.debugLog ?? (() => undefined);
  }

  get isRefreshing(): boolean {
    return Boolean(this.refresh);
  }

  startRefreshDaemon(_limit = 25): void {
    // No dashboard cache: the browser poll is the refresh loop.
  }

  stopRefreshDaemon(): void {
    // No dashboard cache or daemon to stop.
  }

  async payload(options: DashboardPayloadOptions = {}): Promise<Record<string, unknown>> {
    const snapshot = await this.getLiveSnapshot(options.limit ?? 25);
    const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(snapshot.refreshedAt)) / 1000));
    const degradedError = snapshot.degradedError ?? "";
    return {
      ok: true,
      degraded: Boolean(degradedError),
      degradedError,
      stale: false,
      refreshing: Boolean(this.refresh),
      snapshot: {
        source: snapshot.source,
        refreshedAt: snapshot.refreshedAt,
        ageSeconds,
        stale: false,
      },
      health: options.health,
      issues: snapshot.issues.map((issue) => summarizeIssue(issue)),
    };
  }

  async workRuntimeAction(method: string, params: Record<string, unknown>): Promise<unknown> {
    return callWorkRuntime(this.workRuntimeUrl, method, params);
  }

  private async getLiveSnapshot(limit: number): Promise<DashboardSnapshot> {
    if (!this.refresh) {
      this.refresh = this.refreshSnapshot(limit).finally(() => {
        this.refresh = undefined;
      });
    }
    try {
      return await this.refresh;
    } catch (error) {
      return {
        issues: [],
        source: "empty",
        refreshedAt: new Date().toISOString(),
        degradedError: firstErrorLine(error),
      };
    }
  }

  private async refreshSnapshot(limit: number): Promise<DashboardSnapshot> {
    const issues = await withTimeout(this.inspectQueue(limit), dashboardLiveRefreshTimeoutMs());
    return {
      issues,
      source: "work_runtime",
      refreshedAt: new Date().toISOString(),
      degradedError: "",
    };
  }

  private async inspectQueue(limit: number): Promise<Record<string, unknown>[]> {
    try {
      return await this.workRuntimeInspectQueue(limit);
    } catch (error) {
      this.debugLog("dashboard.work_runtime_unavailable", { error: firstErrorLine(error) });
      return await this.cliInspectQueue(limit);
    }
  }

  private async workRuntimeInspectQueue(limit: number): Promise<Record<string, unknown>[]> {
    const result = await callWorkRuntime(this.workRuntimeUrl, "inspectDashboardQueue", { limit });
    return Array.isArray(result) ? result as Record<string, unknown>[] : [];
  }

  private async cliInspectQueue(limit: number): Promise<Record<string, unknown>[]> {
    const bin = process.env.FLOW_BIN ?? "flow";
    const { stdout, stderr } = await execFileAsync(bin, ["call", "inspectDashboardQueue", JSON.stringify({ limit })], {
      cwd: this.repoRoot,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (stderr.trim()) this.debugLog("dashboard.cli_queue_stderr", { stderr: stderr.trim().slice(0, 1000) });
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
  }

}

export async function callWorkRuntime(
  workRuntimeUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${workRuntimeUrl.replace(/\/+$/, "")}/v1/work-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json() as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Work Runtime ${method} failed with HTTP ${response.status}.`);
  }
  return payload.result;
}

function dashboardLiveRefreshTimeoutMs(): number {
  const parsed = Number(process.env.FLOW_DASHBOARD_LIVE_REFRESH_TIMEOUT_MS ?? "60000");
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 60000;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function firstErrorLine(error: unknown): string {
  return errorMessage(error).split("\n")[0] ?? "Dashboard refresh failed.";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  return String(error);
}

function summarizeIssue(issue: Record<string, unknown>): Record<string, unknown> {
  const ref = String(issue.ref ?? "");
  const repoKeys = Array.isArray(issue.repoKeys) ? issue.repoKeys.map(String) : [];
  const blockers = Array.isArray(issue.blockers) ? issue.blockers.map(String) : [];
  return {
    ref,
    title: asString(issue.title),
    workflowState: asString(issue.workflowState) || asString(issue.state),
    lane: asString(issue.lane),
    substate: asString(issue.substate),
    substateTooltip: asString(issue.substateTooltip),
    nextAction: asString(issue.nextAction),
    hidden: issue.hidden === true,
    flowActionable: issue.flowActionable === true ? true : issue.flowActionable === false ? false : undefined,
    jiraStatus: asString(issue.jiraStatus),
    jiraUrl: asString(issue.jiraUrl) || (ref ? `https://beckshybrids.atlassian.net/browse/${ref}` : ""),
    repoKeys,
    branch: asString(issue.branch),
    headSha: asString(issue.headSha),
    worktreePath: asString(issue.worktreePath),
    prUrl: asString(issue.prUrl),
    prIsDraft: issue.prIsDraft === true,
    prChecksPassing: issue.prChecksPassing === true ? true : issue.prChecksPassing === false ? false : undefined,
    prReviewDecision: asString(issue.prReviewDecision),
    humanReviewRequired: issue.humanReviewRequired === true,
    evidenceRecorded: issue.evidenceRecorded === true,
    documentationRecorded: issue.documentationRecorded === true,
    autoflowAttempts: asNumber(issue.autoflowAttempts) ?? 0,
    autoflowAttemptLimit: asNumber(issue.autoflowAttemptLimit) ?? 3,
    autoflowLastAttemptedAt: asString(issue.autoflowLastAttemptedAt),
    autoflowExhausted: issue.autoflowExhausted === true,
    updatedAt: asString(issue.updatedAt),
    blockers,
    actions: dashboardActions(issue, blockers),
  };
}

function dashboardActions(issue: Record<string, unknown>, blockers: string[]): Record<string, unknown>[] {
  const ref = String(issue.ref ?? "");
  const repoKeys = Array.isArray(issue.repoKeys) ? issue.repoKeys.map(String) : [];
  const hasRepo = repoKeys.length > 0;
  const hasWorktree = Boolean(asString(issue.worktreePath));
  return [
    { id: "select", label: "Select issue", enabled: Boolean(ref), blocker: ref ? "" : "Issue reference is missing." },
    { id: "prepare_workspace", label: "Prepare workspace", enabled: Boolean(ref && hasRepo), blocker: hasRepo ? "" : "Repo routing is missing." },
    { id: "advance", label: "Advance", enabled: Boolean(ref && hasWorktree), blocker: hasWorktree ? "" : "Prepared workspace is missing." },
    { id: "summarize_handoff", label: "Summarize handoff", enabled: Boolean(ref), blocker: ref ? "" : "Issue reference is missing." },
    { id: "blocked", label: "Current blockers", enabled: blockers.length === 0, blocker: blockers.join(" ") },
  ];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
