import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { flowRoot } from "./flow-runtime.js";

const execFileAsync = promisify(execFile);

export type DashboardSnapshotSource = "flow_cli" | "empty";

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

  async runtimeAction(method: string, params: Record<string, unknown>): Promise<unknown> {
    return callFlowCli(this.repoRoot, method, params, this.debugLog);
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
      source: "flow_cli",
      refreshedAt: new Date().toISOString(),
      degradedError: "",
    };
  }

  private async inspectQueue(limit: number): Promise<Record<string, unknown>[]> {
    const parsed = await callFlowCli(this.repoRoot, "inspectDashboardQueue", { limit }, this.debugLog);
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
  }

}

export async function callFlowCli(
  repoRoot: string,
  method: string,
  params: Record<string, unknown>,
  debugLog: (event: string, details: Record<string, unknown>) => void = () => undefined,
): Promise<unknown> {
  const bin = process.env.FLOW_BIN ?? join(flowRoot, "bin", "flow");
  const args = ["call", method, JSON.stringify(params)];
  const command = shouldRunWithNode(bin) ? process.execPath : bin;
  const commandArgs = shouldRunWithNode(bin) ? [bin, ...args] : args;
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stderr.trim()) debugLog("dashboard.flow_cli_stderr", { method, stderr: stderr.trim().slice(0, 1000) });
  return JSON.parse(stdout) as unknown;
}

function shouldRunWithNode(bin: string): boolean {
  if (!existsSync(bin)) return false;
  const extension = extname(bin).toLowerCase();
  return extension === "" || extension === ".js" || extension === ".mjs" || extension === ".cjs";
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
    issueStatus: asString(issue.issueStatus),
    issueUrl: asString(issue.issueUrl),
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
  };
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
