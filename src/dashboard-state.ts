import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { flowRoot } from "./flow-runtime.js";
import { normalizeRecordStatusLabel, normalizeWorkStatusLabel } from "./dashboard-labels.js";

const execFileAsync = promisify(execFile);
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
  issues: Record<string, unknown>[];
  refreshedAt: string;
}

export interface DashboardPayloadOptions {
  limit?: number;
}

export interface DashboardStateOptions {
  repoRoot?: string;
  debugLog?: (event: string, details: Record<string, unknown>) => void;
}

export class DashboardState {
  private readonly repoRoot: string;
  private readonly debugLog: (event: string, details: Record<string, unknown>) => void;
  private refresh: Promise<DashboardSnapshot> | undefined;

  constructor(options: DashboardStateOptions) {
    this.repoRoot = options.repoRoot ?? process.cwd();
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
    if (!this.refresh) {
      this.refresh = this.refreshSnapshot(limit).finally(() => {
        this.refresh = undefined;
      });
    }
    return await this.refresh;
  }

  private async refreshSnapshot(limit: number): Promise<DashboardSnapshot> {
    const issues = await withTimeout(this.inspectQueue(limit), dashboardLiveRefreshTimeoutMs());
    return {
      issues,
      refreshedAt: new Date().toISOString(),
    };
  }

  private async inspectQueue(limit: number): Promise<Record<string, unknown>[]> {
    const parsed = await callFlowCli(this.repoRoot, "inspectDashboardQueue", { limit }, this.debugLog);
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
  }

}

async function callFlowCli(
  repoRoot: string,
  method: string,
  params: Record<string, unknown>,
  debugLog: (event: string, details: Record<string, unknown>) => void = () => undefined,
): Promise<unknown> {
  const bin = join(flowRoot, "bin", "flow");
  const args = [JSON.stringify({ op: "runtime", method, params })];
  const command = shouldRunWithNode(bin) ? process.execPath : bin;
  const commandArgs = shouldRunWithNode(bin) ? [bin, ...args] : args;
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stderr.trim()) debugLog("dashboard.flow_cli_stderr", { method, stderr: stderr.trim().slice(0, 1000) });
  const parsed = JSON.parse(stdout) as { ok?: boolean; result?: unknown; error?: unknown };
  if (parsed.ok === false) throw new Error(`Flow CLI failed: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

function shouldRunWithNode(bin: string): boolean {
  if (!existsSync(bin)) return false;
  const extension = extname(bin).toLowerCase();
  return extension === "" || extension === ".js" || extension === ".mjs" || extension === ".cjs";
}

function dashboardLiveRefreshTimeoutMs(): number {
  return 60000;
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

function summarizeIssue(issue: Record<string, unknown>): Record<string, unknown> {
  const ref = String(issue.ref ?? "");
  const repositories = Array.isArray(issue.repositories) ? issue.repositories.map(String) : [];
  const blockerLabels = Array.isArray(issue.blockerLabels) ? issue.blockerLabels.map(String) : [];
  const summary: Record<string, unknown> = {
    ref,
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
