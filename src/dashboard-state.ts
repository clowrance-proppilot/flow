import { normalizeRecordStatusLabel, normalizeWorkStatusLabel } from "./dashboard-labels.js";
import type { DashboardQueueIssue, FlowWorkRuntime } from "./work-runtime.js";

type DashboardQueueReader = Pick<FlowWorkRuntime, "inspectDashboardQueue">;

const dashboardIssueFields = [
  "blockerLabels",
  "documentationStatus",
  "evidenceStatus",
  "handoffPrompt",
  "nextPickup",
  "prStatus",
  "ref",
  "repositories",
  "reviewStatus",
  "statusLabel",
  "title",
  "updatedLabel",
  "workStatus",
  "workStatusDetail",
] as const;

export interface DashboardSnapshot {
  issues: DashboardQueueIssue[];
  refreshedAt: string;
}

export interface DashboardPayloadOptions {
  limit?: number;
}

export interface DashboardStateOptions {
  runtime: DashboardQueueReader;
  debugLog?: (event: string, details: Record<string, unknown>) => void;
}

export class DashboardState {
  private readonly runtime: DashboardQueueReader;
  private readonly debugLog: (event: string, details: Record<string, unknown>) => void;
  private snapshotCache: { limit: number; snapshot: DashboardSnapshot; cachedAt: number } | undefined;
  private refresh: { limit: number; promise: Promise<DashboardSnapshot> } | undefined;

  constructor(options: DashboardStateOptions) {
    this.runtime = options.runtime;
    this.debugLog = options.debugLog ?? (() => undefined);
  }

  async payload(options: DashboardPayloadOptions = {}): Promise<Record<string, unknown>> {
    const snapshot = await this.getLiveSnapshot(options.limit ?? 25);
    return {
      ok: true,
      snapshot: {
        freshnessLabel: dashboardSnapshotFreshnessLabel(snapshot.refreshedAt),
      },
      issues: snapshot.issues.map((issue) => publicDashboardIssue(summarizeIssue(issue))),
    };
  }

  private async getLiveSnapshot(limit: number): Promise<DashboardSnapshot> {
    const now = Date.now();
    if (this.snapshotCache && this.snapshotCache.limit === limit && now - this.snapshotCache.cachedAt < dashboardSnapshotCacheTtlMs()) {
      return this.snapshotCache.snapshot;
    }
    if (!this.refresh || this.refresh.limit !== limit) {
      const promise = this.refreshSnapshot(limit).finally(() => {
        if (this.refresh?.promise === promise) this.refresh = undefined;
      });
      this.refresh = { limit, promise };
    }
    return await this.refresh.promise;
  }

  private async refreshSnapshot(limit: number): Promise<DashboardSnapshot> {
    const startedAt = Date.now();
    const issues = await withTimeout(this.inspectQueue(limit), dashboardLiveRefreshTimeoutMs());
    const snapshot = {
      issues,
      refreshedAt: new Date().toISOString(),
    };
    this.snapshotCache = { limit, snapshot, cachedAt: Date.now() };
    this.debugLog("dashboard.runtime_snapshot", {
      limit,
      issueCount: issues.length,
      durationMs: Date.now() - startedAt,
    });
    return snapshot;
  }

  private async inspectQueue(limit: number): Promise<DashboardQueueIssue[]> {
    return await this.runtime.inspectDashboardQueue(limit);
  }

}

function dashboardLiveRefreshTimeoutMs(): number {
  return 60000;
}

function dashboardSnapshotCacheTtlMs(): number {
  return 3000;
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

function summarizeIssue(issue: DashboardQueueIssue): Record<string, unknown> {
  const repositories = issue.repositories.map(String);
  const blockerLabels = issue.blockerLabels.map(String);
  const summary: Record<string, unknown> = {
    ref: issue.ref,
    repositories,
    evidenceStatus: normalizeRecordStatusLabel(issue.evidenceStatus),
    documentationStatus: normalizeRecordStatusLabel(issue.documentationStatus),
    blockerLabels,
  };
  assignString(summary, "title", issue.title);
  summary.workStatus = normalizeWorkStatusLabel(issue.workStatus);
  assignString(summary, "workStatusDetail", issue.workStatusDetail);
  assignString(summary, "statusLabel", issue.statusLabel);
  assignString(summary, "prStatus", issue.prStatus);
  assignString(summary, "reviewStatus", issue.reviewStatus);
  assignString(summary, "updatedLabel", issue.updatedLabel);
  assignString(summary, "nextPickup", issue.nextPickup);
  assignString(summary, "handoffPrompt", issue.handoffPrompt);
  return summary;
}

function publicDashboardIssue(summary: Record<string, unknown>): Record<string, unknown> {
  const publicIssue: Record<string, unknown> = {};
  for (const field of dashboardIssueFields) {
    if (!Object.hasOwn(summary, field)) continue;
    const value = summary[field];
    if (value === "" || value === undefined) continue;
    publicIssue[field] = value;
  }
  return publicIssue;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assignString(target: Record<string, unknown>, key: string, value: unknown): void {
  const stringValue = asString(value);
  if (stringValue) target[key] = stringValue;
}

function dashboardRelativeTime(value: unknown): string {
  const raw = asString(value);
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function dashboardSnapshotFreshnessLabel(refreshedAt: string): string {
  const relative = dashboardRelativeTime(refreshedAt);
  if (!relative) return "Snapshot not loaded";
  if (relative === "Unknown") return "Snapshot time unknown";
  return `Snapshot ${relative}`;
}
