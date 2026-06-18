import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

import { GitAdapter } from "./adapters/git.js";
import { validateFlowConfig } from "./config/config-loader.js";
import type { FlowConfig } from "./config/config-schema.js";
import {
  type FindingSeverity,
  type WorkItem,
  type WorkRuntimeEvent,
  nowIso,
  workRuntimeEventSchema,
  workRuntimeSessionSchema,
} from "./contracts.js";
import type { WorkflowLedger } from "./engine/ledger-contracts.js";
import type { FlowStoreBackend } from "./store.js";

/** Session ids that signal a bare/default scratch session rather than a scoped one. */
const BARE_SESSION_IDS = new Set(["mcp", "default", "flow"]);
/** Issue states whose worktrees are expected to still be in flight. */
const ACTIVE_ISSUE_STATES = new Set(["queued", "selected", "ready_to_run", "running", "blocked", "awaiting_review", "awaiting_human"]);
/** How many issues to scan from the ledger when relating worktrees to active work. */
const LEDGER_SCAN_LIMIT = 200;

export interface FlowDoctorFinding {
  id: string;
  area: "session" | "worktree" | "config" | "ledger";
  severity: FindingSeverity;
  summary: string;
  detail?: string;
  suggestedFix: string;
  sessionId?: string;
  issueRef?: string;
  worktreePath?: string;
}

export interface FlowDoctorReport {
  ok: boolean;
  status: "ok" | "warning" | "blocker";
  projectRoot: string;
  checkedAt: string;
  counts: {
    sessions: number;
    worktrees: number;
    findings: number;
    bySeverity: Record<FindingSeverity, number>;
  };
  findings: FlowDoctorFinding[];
}

export interface FlowDoctorInput {
  projectRoot: string;
  flowConfig?: FlowConfig;
  runtimeStorePath: string;
  runtimeStoreBackend: FlowStoreBackend;
  workflowLedger: WorkflowLedger;
  workflowLedgerPath: string;
  defaultSessionId: string;
}

/**
 * Read-only health aggregator over Flow's project store and config. Surfaces
 * session-hygiene, worktree, config, and ledger findings with severities and a
 * suggested fix each. Never mutates store, config, ledger, or worktree state.
 */
export async function runFlowDoctor(input: FlowDoctorInput): Promise<FlowDoctorReport> {
  const findings: FlowDoctorFinding[] = [];

  const sessions = await readSessionHealth(input);
  findings.push(...sessionFindings(sessions, input.defaultSessionId));

  const worktrees = await readWorktreeHealth(input);
  findings.push(...worktrees.findings);

  findings.push(...(await configFindings(input)));
  findings.push(...(await ledgerFindings(input)));

  const bySeverity: Record<FindingSeverity, number> = { info: 0, warning: 0, blocker: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  const status = bySeverity.blocker > 0 ? "blocker" : bySeverity.warning > 0 ? "warning" : "ok";

  return {
    ok: status === "ok",
    status,
    projectRoot: resolve(input.projectRoot),
    checkedAt: nowIso(),
    counts: {
      sessions: sessions.length,
      worktrees: worktrees.scanned,
      findings: findings.length,
      bySeverity,
    },
    findings,
  };
}

// --- Session hygiene -------------------------------------------------------

interface SessionHealth {
  id: string;
  selectedIssueRef?: string;
  eventIssueRefs: string[];
}

function sessionFindings(sessions: SessionHealth[], defaultSessionId: string): FlowDoctorFinding[] {
  const findings: FlowDoctorFinding[] = [];
  for (const session of sessions) {
    const distinctRefs = new Set(session.eventIssueRefs);
    if (session.selectedIssueRef) distinctRefs.add(session.selectedIssueRef);
    if (distinctRefs.size > 1) {
      findings.push({
        id: `session.collision.${session.id}`,
        area: "session",
        severity: "blocker",
        summary: `Session ${session.id} spans ${distinctRefs.size} distinct issues.`,
        detail: `Distinct issue refs observed: ${[...distinctRefs].sort().join(", ")}. Concurrent sessions sharing one id clobber each other's selection.`,
        suggestedFix: "Pass an explicit per-issue sessionId (for example camden-pro-3329) instead of sharing one session across issues.",
        sessionId: session.id,
      });
    }
    if (BARE_SESSION_IDS.has(session.id)) {
      findings.push({
        id: `session.bare.${session.id}`,
        area: "session",
        severity: session.id === defaultSessionId ? "info" : "warning",
        summary: `Session id "${session.id}" is a bare/default id.`,
        detail: "Bare session ids are shared across processes and are prone to selection collisions.",
        suggestedFix: "Use a scoped sessionId per agent/issue (for example camden-pro-3329) for any concurrent work.",
        sessionId: session.id,
      });
    }
  }
  return findings;
}

async function readSessionHealth(input: FlowDoctorInput): Promise<SessionHealth[]> {
  return input.runtimeStoreBackend === "file"
    ? readFileStoreSessions(input.runtimeStorePath)
    : readSqliteStoreSessions(input.runtimeStorePath);
}

function readSqliteStoreSessions(storeRoot: string): SessionHealth[] {
  const dbPath = join(storeRoot, "flow-store.db");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const eventRefs = new Map<string, Set<string>>();
    for (const row of selectAll(db, "SELECT session_id AS sessionId, data FROM flow_events")) {
      const event = safeParse(workRuntimeEventSchema, row.data);
      if (!event?.issueRef) continue;
      addRef(eventRefs, String(row.sessionId), event.issueRef);
    }
    const sessions: SessionHealth[] = [];
    const seen = new Set<string>();
    for (const row of selectAll(db, "SELECT id, data FROM flow_sessions")) {
      const session = safeParse(workRuntimeSessionSchema, row.data);
      const id = session?.id ?? String(row.id);
      seen.add(id);
      sessions.push({
        id,
        selectedIssueRef: session?.selectedIssueRef,
        eventIssueRefs: [...(eventRefs.get(id) ?? [])],
      });
    }
    // Events can reference a session id that no longer has a stored row.
    for (const [id, refs] of eventRefs) {
      if (seen.has(id)) continue;
      sessions.push({ id, eventIssueRefs: [...refs] });
    }
    return sessions;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function readFileStoreSessions(storeRoot: string): Promise<SessionHealth[]> {
  const eventRefs = new Map<string, Set<string>>();
  for (const file of await listFiles(join(storeRoot, "events"), ".jsonl")) {
    for (const event of await readEventLines(join(storeRoot, "events", file))) {
      if (event.issueRef) addRef(eventRefs, event.sessionId, event.issueRef);
    }
  }
  const sessions: SessionHealth[] = [];
  const seen = new Set<string>();
  for (const file of await listFiles(join(storeRoot, "sessions"), ".json")) {
    const session = safeParse(workRuntimeSessionSchema, await readFileText(join(storeRoot, "sessions", file)));
    if (!session) continue;
    seen.add(session.id);
    sessions.push({
      id: session.id,
      selectedIssueRef: session.selectedIssueRef,
      eventIssueRefs: [...(eventRefs.get(session.id) ?? [])],
    });
  }
  for (const [id, refs] of eventRefs) {
    if (seen.has(id)) continue;
    sessions.push({ id, eventIssueRefs: [...refs] });
  }
  return sessions;
}

// --- Worktree health -------------------------------------------------------

interface WorktreeHealthResult {
  findings: FlowDoctorFinding[];
  scanned: number;
}

async function readWorktreeHealth(input: FlowDoctorInput): Promise<WorktreeHealthResult> {
  const findings: FlowDoctorFinding[] = [];
  const activePaths = await activeWorktreePaths(input.workflowLedger);
  const git = new GitAdapter();
  let scanned = 0;

  for (const repoPath of repoPaths(input.projectRoot, input.flowConfig)) {
    const worktreesRoot = join(repoPath, ".worktrees");
    for (const entry of await listDirectories(worktreesRoot)) {
      const worktreePath = join(worktreesRoot, entry);
      if (pathEquals(worktreePath, input.projectRoot)) continue;
      scanned += 1;
      const status = await git.inspect(worktreePath).catch(() => undefined);
      const orphaned = !activePaths.has(resolve(worktreePath));
      if (status?.dirty) {
        findings.push({
          id: `worktree.dirty.${entry}`,
          area: "worktree",
          severity: "warning",
          summary: `Worktree ${entry} has uncommitted changes.`,
          detail: `Path: ${worktreePath}${status.entries.length ? `; ${status.entries.slice(0, 5).join(", ")}` : ""}`,
          suggestedFix: "Commit or stash the changes, then publish or clean up the worktree.",
          worktreePath,
        });
      }
      if (orphaned) {
        findings.push({
          id: `worktree.orphan.${entry}`,
          area: "worktree",
          severity: status?.dirty ? "warning" : "info",
          summary: `Worktree ${entry} is not linked to any active issue.`,
          detail: `Path: ${worktreePath}. No active ledger issue records this worktree.`,
          suggestedFix: status?.dirty
            ? "Confirm the work is captured, then run flow_cleanup_workspaces (or git worktree remove) once clean."
            : "Run flow_cleanup_workspaces, or git worktree remove this stale worktree.",
          worktreePath,
        });
      }
    }
  }

  return { findings, scanned };
}

async function activeWorktreePaths(ledger: WorkflowLedger): Promise<Set<string>> {
  const paths = new Set<string>();
  const issues = await ledger.listIssues(LEDGER_SCAN_LIMIT).catch(() => [] as WorkItem[]);
  for (const issue of issues) {
    if (!ACTIVE_ISSUE_STATES.has(issue.state)) continue;
    for (const value of worktreePathsForIssue(issue)) paths.add(resolve(value));
  }
  return paths;
}

function worktreePathsForIssue(issue: WorkItem): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(issue.metadata)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (key.endsWith(".worktree_path") || key === "worktree_path" || key === "work_dir") {
      paths.push(value.trim());
    }
  }
  return paths;
}

function repoPaths(projectRoot: string, flowConfig?: FlowConfig): string[] {
  const root = resolve(projectRoot);
  const repos = flowConfig?.topology?.repos;
  if (!repos || Object.keys(repos).length === 0) return [root];
  const paths = new Set<string>();
  for (const repo of Object.values(repos)) {
    paths.add(repo.pathFromRoot ? resolve(root, repo.pathFromRoot) : root);
  }
  return [...paths];
}

// --- Config + ledger -------------------------------------------------------

async function configFindings(input: FlowDoctorInput): Promise<FlowDoctorFinding[]> {
  const validation = await validateFlowConfig({ projectRoot: input.projectRoot });
  if (validation.ok) return [];
  return validation.errors.map((error, index) => ({
    id: `config.invalid.${index}`,
    area: "config" as const,
    severity: "blocker" as const,
    summary: "Flow config is invalid.",
    detail: error,
    suggestedFix: "Fix the config field via flow_config_update, or re-run flow_bootstrap.",
  }));
}

async function ledgerFindings(input: FlowDoctorInput): Promise<FlowDoctorFinding[]> {
  try {
    await input.workflowLedger.listIssues(1);
    return [];
  } catch (error) {
    return [{
      id: "ledger.unreadable",
      area: "ledger",
      severity: "blocker",
      summary: "Workflow ledger could not be read.",
      detail: `${input.workflowLedgerPath}: ${errorMessage(error)}`,
      suggestedFix: "Verify the ledger backend (flow_ledger_verify) and its connection or file path.",
    }];
  }
}

// --- Helpers ---------------------------------------------------------------

function addRef(map: Map<string, Set<string>>, sessionId: string, ref: string): void {
  const set = map.get(sessionId) ?? new Set<string>();
  set.add(ref);
  map.set(sessionId, set);
}

function selectAll(db: DatabaseSync, sql: string): Array<{ [key: string]: string }> {
  return db.prepare(sql).all() as Array<{ [key: string]: string }>;
}

function safeParse<T>(schema: { parse(value: unknown): T }, raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function readEventLines(path: string): Promise<WorkRuntimeEvent[]> {
  const raw = await readFileText(path);
  if (!raw) return [];
  const events: WorkRuntimeEvent[] = [];
  for (const line of raw.split("\n")) {
    const event = safeParse(workRuntimeEventSchema, line.trim() || undefined);
    if (event) events.push(event);
  }
  return events;
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readFileText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function pathEquals(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
