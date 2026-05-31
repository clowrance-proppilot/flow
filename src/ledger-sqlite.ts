import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import {
  type WorkItem,
  type WorkJob,
  type WorkJobResult,
  type FlowContextProjection,
  type FlowContextRecord,
  type FlowContextRecordInput,
  type FlowContextScope,
  type FlowActiveContext,
  type FlowPromptContextRecord,
  type FlowThreadContextRecord,
  type FlowSessionContextRecord,
  type FlowArtifactContextRecord,
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

export interface SqliteWorkflowLedgerOptions {
  path: string;
}

export class SqliteWorkflowLedger implements WorkflowLedger {
  private readonly db: Database.Database;

  constructor(options: SqliteWorkflowLedgerOptions) {
    const dir = dirname(options.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(options.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        ref TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_runs (
        task_id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS worker_results (
        task_id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (task_id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS work_jobs (
        id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS work_job_results (
        job_id TEXT NOT NULL,
        issue_ref TEXT NOT NULL,
        data TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (job_id, issue_ref)
      );

      CREATE TABLE IF NOT EXISTS context_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT NOT NULL,
        issue_ref TEXT,
        thread_id TEXT,
        session_id TEXT,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_worker_runs_issue_ref ON worker_runs(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_worker_results_issue_ref ON worker_results(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_work_jobs_issue_ref ON work_jobs(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_work_job_results_issue_ref ON work_job_results(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_context_records_project_id ON context_records(project_id);
      CREATE INDEX IF NOT EXISTS idx_context_records_issue_ref ON context_records(issue_ref);
      CREATE INDEX IF NOT EXISTS idx_context_records_thread_id ON context_records(thread_id);
      CREATE INDEX IF NOT EXISTS idx_context_records_session_id ON context_records(session_id);
    `);
  }

  async listIssues(limit = 20): Promise<WorkItem[]> {
    const rows = this.db
      .prepare("SELECT data FROM issues ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as { data: string }[];
    return rows.map((row) => workItemSchema.parse(JSON.parse(row.data)));
  }

  async readIssue(ref: string): Promise<WorkItem | undefined> {
    const row = this.db
      .prepare("SELECT data FROM issues WHERE ref = ?")
      .get(ref) as { data: string } | undefined;
    return row ? workItemSchema.parse(JSON.parse(row.data)) : undefined;
  }

  async readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    if (refs.length === 0) return new Map();
    const placeholders = refs.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT data FROM issues WHERE ref IN (${placeholders})`)
      .all(...refs) as { data: string }[];
    const issues = new Map<string, WorkItem>();
    for (const row of rows) {
      const issue = workItemSchema.parse(JSON.parse(row.data));
      issues.set(issue.ref, issue);
    }
    return issues;
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    return this.writeIssue(issue);
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    const parsed = workItemSchema.parse({ ...issue, updatedAt: nowIso() });
    const stmt = this.db.prepare(`
      INSERT INTO issues (ref, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    stmt.run(parsed.ref, JSON.stringify(parsed), parsed.updatedAt);
    return parsed;
  }

  async listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    const rows = this.db
      .prepare("SELECT data FROM worker_runs WHERE issue_ref = ? ORDER BY updated_at")
      .all(issueRef) as { data: string }[];
    return rows.map((row) => workerRunRecordSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    const parsed = workerRunRecordSchema.parse(run);
    const stmt = this.db.prepare(`
      INSERT INTO worker_runs (task_id, issue_ref, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, issue_ref) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    stmt.run(parsed.taskId, parsed.issueRef, JSON.stringify(parsed), parsed.updatedAt);
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    const rows = this.db
      .prepare("SELECT data FROM worker_results WHERE issue_ref = ? ORDER BY completed_at")
      .all(issueRef) as { data: string }[];
    return rows.map((row) => workerTaskResultSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    const parsed = workerTaskResultSchema.parse(result);
    const stmt = this.db.prepare(`
      INSERT INTO worker_results (task_id, issue_ref, data, completed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id, issue_ref) DO UPDATE SET data = excluded.data, completed_at = excluded.completed_at
    `);
    stmt.run(parsed.taskId, parsed.issueRef, JSON.stringify(parsed), parsed.completedAt);

    // Also record as a worker run
    await this.recordWorkerRun(workerResultToRun(parsed));
  }

  async listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    const rows = this.db
      .prepare("SELECT data FROM work_jobs WHERE issue_ref = ? ORDER BY updated_at")
      .all(issueRef) as { data: string }[];
    return rows.map((row) => workJobSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    const parsed = workJobSchema.parse(job);
    const stmt = this.db.prepare(`
      INSERT INTO work_jobs (id, issue_ref, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id, issue_ref) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    stmt.run(parsed.id, parsed.issueRef, JSON.stringify(parsed), parsed.updatedAt);
  }

  async listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    const rows = this.db
      .prepare("SELECT data FROM work_job_results WHERE issue_ref = ? ORDER BY completed_at")
      .all(issueRef) as { data: string }[];
    return rows.map((row) => workJobResultSchema.parse(JSON.parse(row.data)));
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    const parsed = workJobResultSchema.parse(result);
    const stmt = this.db.prepare(`
      INSERT INTO work_job_results (job_id, issue_ref, data, completed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id, issue_ref) DO UPDATE SET data = excluded.data, completed_at = excluded.completed_at
    `);
    stmt.run(parsed.jobId, parsed.issueRef, JSON.stringify(parsed), parsed.completedAt);
  }

  async recordContext(record: FlowContextRecordInput): Promise<FlowContextRecord> {
    const parsed = flowContextRecordSchema.parse(record);
    const stmt = this.db.prepare(`
      INSERT INTO context_records (id, kind, project_id, issue_ref, thread_id, session_id, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        project_id = excluded.project_id,
        issue_ref = excluded.issue_ref,
        thread_id = excluded.thread_id,
        session_id = excluded.session_id,
        data = excluded.data,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      parsed.id,
      parsed.kind,
      parsed.projectId,
      parsed.issueRef ?? null,
      parsed.threadId ?? null,
      parsed.sessionId ?? null,
      JSON.stringify(parsed),
      parsed.createdAt,
      parsed.updatedAt,
    );
    return parsed;
  }

  async readContext(scope: FlowContextScope = {}): Promise<FlowContextProjection> {
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

    query += " ORDER BY updated_at, id";

    const rows = this.db.prepare(query).all(...params) as { data: string }[];
    const records = rows.map((row) => flowContextRecordSchema.parse(JSON.parse(row.data)));

    // Filter by artifactId if specified (requires post-filter due to array field)
    const filtered = parsedScope.artifactId
      ? records.filter(
          (record) =>
            record.id === parsedScope.artifactId ||
            record.artifactRefs.includes(parsedScope.artifactId!),
        )
      : records;

    return contextProjectionFromRecords(filtered);
  }

  close(): void {
    this.db.close();
  }
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

function contextProjectionFromRecords(records: FlowContextRecord[]): FlowContextProjection {
  const sorted = [...records].sort((a, b) => {
    const updated = a.updatedAt.localeCompare(b.updatedAt);
    if (updated !== 0) return updated;
    return a.id.localeCompare(b.id);
  });

  const latest = [...sorted].reverse().find((record) => record.kind === "prompt") ?? sorted.at(-1);
  const active: FlowActiveContext = latest
    ? {
        projectId: latest.projectId,
        issueRef: latest.issueRef,
        threadId: latest.kind === "thread" ? latest.id : latest.threadId,
        sessionId: latest.kind === "session" ? latest.id : latest.sessionId,
        artifactId: latest.kind === "artifact" ? latest.id : latest.artifactRefs.at(-1),
        updatedAt: latest.updatedAt,
      }
    : {};

  return flowContextProjectionSchema.parse({
    active,
    prompts: sorted.filter((record): record is FlowPromptContextRecord => record.kind === "prompt"),
    threads: sorted.filter((record): record is FlowThreadContextRecord => record.kind === "thread"),
    sessions: sorted.filter((record): record is FlowSessionContextRecord => record.kind === "session"),
    artifacts: sorted.filter((record): record is FlowArtifactContextRecord => record.kind === "artifact"),
    updatedAt: sorted.at(-1)?.updatedAt ?? nowIso(),
  });
}
