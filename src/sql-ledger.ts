import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type WorkItem,
  type WorkJob,
  type WorkJobResult,
  type FlowActiveContext,
  type FlowArtifactContextRecord,
  type FlowContextProjection,
  type FlowContextRecord,
  type FlowContextRecordInput,
  type FlowContextScope,
  type FlowPromptContextRecord,
  type FlowSessionContextRecord,
  type FlowThreadContextRecord,
  type WorkerRunRecord,
  type WorkerTaskResult,
  flowContextProjectionSchema,
  flowContextRecordSchema,
  flowContextScopeSchema,
  nowIso,
  workJobResultSchema,
  workJobSchema,
  workItemSchema,
  workerRunRecordSchema,
  workerTaskResultSchema,
} from "./contracts.js";
import type { WorkflowLedger } from "./engine/ledger-contracts.js";

export interface SqlWorkflowLedgerOptions {
  path: string;
}

export class SqlWorkflowLedger implements WorkflowLedger {
  private readonly db: Database.Database;
  private initialized = false;

  constructor(options: SqlWorkflowLedgerOptions) {
    const dir = dirname(options.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(options.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        ref TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(task_id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS worker_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(task_id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS work_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(job_id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS work_job_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(job_id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS context_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT,
        issue_ref TEXT,
        thread_id TEXT,
        session_id TEXT,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_worker_runs_issue ON worker_runs(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_worker_results_issue ON worker_results(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_work_jobs_issue ON work_jobs(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_work_job_results_issue ON work_job_results(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_context_project ON context_records(project_id);
      CREATE INDEX IF NOT EXISTS idx_context_issue ON context_records(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_context_thread ON context_records(thread_id);
      CREATE INDEX IF NOT EXISTS idx_context_session ON context_records(session_id);
    `);
  }

  async listIssues(limit = 20): Promise<WorkItem[]> {
    await this.ensureInitialized();
    const rows = this.db.prepare("SELECT data FROM issues ORDER BY updated_at DESC LIMIT ?").all(limit) as Array<{ data: string }>;
    return rows.map((row) => workItemSchema.parse(JSON.parse(row.data)));
  }

  async readIssue(ref: string): Promise<WorkItem | undefined> {
    await this.ensureInitialized();
    const row = this.db.prepare("SELECT data FROM issues WHERE ref = ?").get(ref) as { data: string } | undefined;
    return row ? workItemSchema.parse(JSON.parse(row.data)) : undefined;
  }

  async readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    await this.ensureInitialized();
    if (refs.length === 0) return new Map();
    const placeholders = refs.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT ref, data FROM issues WHERE ref IN (${placeholders})`).all(...refs) as Array<{ ref: string; data: string }>;
    const result = new Map<string, WorkItem>();
    for (const row of rows) {
      result.set(row.ref, workItemSchema.parse(JSON.parse(row.data)));
    }
    return result;
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    return this.writeIssue(issue);
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    await this.ensureInitialized();
    const parsed = workItemSchema.parse({ ...issue, updatedAt: nowIso() });
    this.db.prepare("INSERT OR REPLACE INTO issues (ref, data, updated_at) VALUES (?, ?, ?)").run(
      parsed.ref,
      JSON.stringify(parsed),
      parsed.updatedAt!,
    );
    return parsed;
  }

  async listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    await this.ensureInitialized();
    const rows = this.db.prepare("SELECT data FROM worker_runs WHERE issue_ref = ?").all(issueRef) as Array<{ data: string }>;
    return rows.map((row) => workerRunRecordSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    await this.ensureInitialized();
    const parsed = workerRunRecordSchema.parse(run);
    this.db.prepare("INSERT OR REPLACE INTO worker_runs (task_id, issue_ref, data) VALUES (?, ?, ?)").run(
      parsed.taskId,
      parsed.issueRef,
      JSON.stringify(parsed),
    );
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    await this.ensureInitialized();
    const rows = this.db.prepare("SELECT data FROM worker_results WHERE issue_ref = ?").all(issueRef) as Array<{ data: string }>;
    return rows.map((row) => workerTaskResultSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    await this.ensureInitialized();
    const parsed = workerTaskResultSchema.parse(result);
    this.db.prepare("INSERT OR REPLACE INTO worker_results (task_id, issue_ref, data) VALUES (?, ?, ?)").run(
      parsed.taskId,
      parsed.issueRef,
      JSON.stringify(parsed),
    );
    // Also record as a worker run
    await this.recordWorkerRun(workerResultToRun(parsed));
  }

  async listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    await this.ensureInitialized();
    const rows = this.db.prepare("SELECT data FROM work_jobs WHERE issue_ref = ?").all(issueRef) as Array<{ data: string }>;
    return rows.map((row) => workJobSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    await this.ensureInitialized();
    const parsed = workJobSchema.parse(job);
    this.db.prepare("INSERT OR REPLACE INTO work_jobs (job_id, issue_ref, data) VALUES (?, ?, ?)").run(
      parsed.id,
      parsed.issueRef,
      JSON.stringify(parsed),
    );
  }

  async listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    await this.ensureInitialized();
    const rows = this.db.prepare("SELECT data FROM work_job_results WHERE issue_ref = ?").all(issueRef) as Array<{ data: string }>;
    return rows.map((row) => workJobResultSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    await this.ensureInitialized();
    const parsed = workJobResultSchema.parse(result);
    this.db.prepare("INSERT OR REPLACE INTO work_job_results (job_id, issue_ref, data) VALUES (?, ?, ?)").run(
      parsed.jobId,
      parsed.issueRef,
      JSON.stringify(parsed),
    );
  }

  async recordContext(record: FlowContextRecordInput): Promise<FlowContextRecord> {
    await this.ensureInitialized();
    const parsed = flowContextRecordSchema.parse(record);
    this.db.prepare("INSERT OR REPLACE INTO context_records (id, kind, project_id, issue_ref, thread_id, session_id, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      parsed.id,
      parsed.kind,
      parsed.projectId,
      parsed.issueRef ?? null,
      parsed.threadId ?? null,
      parsed.sessionId ?? null,
      JSON.stringify(parsed),
      parsed.updatedAt,
    );
    return parsed;
  }

  async readContext(scope: FlowContextScope = {}): Promise<FlowContextProjection> {
    await this.ensureInitialized();
    const parsedScope = flowContextScopeSchema.parse(scope);
    let query = "SELECT data FROM context_records WHERE 1=1";
    const params: unknown[] = [];

    if (parsedScope.projectId) {
      query += " AND project_id = ?";
      params.push(parsedScope.projectId);
    }
    if (parsedScope.issueRef) {
      query += " AND issue_ref = ?";
      params.push(parsedScope.issueRef);
    }
    if (parsedScope.threadId) {
      query += " AND (thread_id = ? OR id = ?)";
      params.push(parsedScope.threadId, parsedScope.threadId);
    }
    if (parsedScope.sessionId) {
      query += " AND (session_id = ? OR id = ?)";
      params.push(parsedScope.sessionId, parsedScope.sessionId);
    }

    query += " ORDER BY updated_at ASC";

    const rows = this.db.prepare(query).all(...params) as Array<{ data: string }>;
    const records = rows.map((row) => flowContextRecordSchema.parse(JSON.parse(row.data)));

    // Filter for artifact scope
    const filtered = parsedScope.artifactId
      ? records.filter((record) => record.id === parsedScope.artifactId || record.artifactRefs.includes(parsedScope.artifactId!))
      : records;

    return contextProjection(filtered, parsedScope);
  }

  close(): void {
    this.db.close();
  }
}

function contextProjection(records: FlowContextRecord[], scope: FlowContextScope = {}): FlowContextProjection {
  const filtered = records
    .map((record) => flowContextRecordSchema.parse(record))
    .sort(compareContextRecords);
  return flowContextProjectionSchema.parse({
    active: activeContext(filtered),
    prompts: filtered.filter((record): record is FlowPromptContextRecord => record.kind === "prompt"),
    threads: filtered.filter((record): record is FlowThreadContextRecord => record.kind === "thread"),
    sessions: filtered.filter((record): record is FlowSessionContextRecord => record.kind === "session"),
    artifacts: filtered.filter((record): record is FlowArtifactContextRecord => record.kind === "artifact"),
    updatedAt: filtered.at(-1)?.updatedAt ?? nowIso(),
  });
}

function activeContext(records: FlowContextRecord[]): FlowActiveContext {
  const latest = [...records].reverse().find((record) => record.kind === "prompt") ?? records.at(-1);
  if (!latest) return {};
  return {
    projectId: latest.projectId,
    issueRef: latest.issueRef,
    threadId: latest.kind === "thread" ? latest.id : latest.threadId,
    sessionId: latest.kind === "session" ? latest.id : latest.sessionId,
    artifactId: latest.kind === "artifact" ? latest.id : latest.artifactRefs.at(-1),
    updatedAt: latest.updatedAt,
  };
}

function compareContextRecords(a: FlowContextRecord, b: FlowContextRecord): number {
  const updated = a.updatedAt.localeCompare(b.updatedAt);
  if (updated !== 0) return updated;
  return a.id.localeCompare(b.id);
}

function workerResultToRun(result: WorkerTaskResult): WorkerRunRecord {
  return workerRunRecordSchema.parse({
    taskId: result.taskId,
    issueRef: result.issueRef,
    repoKey: result.repoKey,
    workJobId: result.workJobId,
    executor: result.executor,
    status: result.status,
    summary: result.summary,
    blockers: result.blockers,
    updatedAt: result.completedAt,
    completedAt: result.completedAt,
  });
}
