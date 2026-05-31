import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Kysely, SqliteDialect, type Dialect } from "kysely";

import {
  type FlowContextProjection,
  type FlowContextRecord,
  type FlowContextRecordInput,
  type FlowContextScope,
  type WorkItem,
  type WorkJob,
  type WorkJobResult,
  type WorkRuntimeEvent,
  type WorkRuntimeSession,
  type WorkerRunRecord,
  type WorkerTaskResult,
  createId,
  flowContextProjectionSchema,
  flowContextRecordSchema,
  nowIso,
  workItemSchema,
  workJobResultSchema,
  workJobSchema,
  workRuntimeEventSchema,
  workRuntimeSessionSchema,
  workerRunRecordSchema,
  workerTaskResultSchema,
} from "./contracts.js";
import type { WorkflowLedger } from "./engine/ledger-contracts.js";
import type { FlowStoreInterface } from "./store.js";

interface JsonTable {
  id: string;
  data: string;
  created_at: string | null;
  updated_at: string;
}

interface IssueScopedJsonTable {
  issue_ref: string;
  id: string;
  data: string;
  created_at: string | null;
  updated_at: string;
}

interface FlowEventsTable {
  id: string;
  session_id: string;
  type: string;
  data: string;
  created_at: string;
}

interface FlowContextTable {
  id: string;
  project_id: string;
  issue_ref: string | null;
  thread_id: string | null;
  session_id: string | null;
  kind: string;
  data: string;
  created_at: string;
  updated_at: string;
}

interface ProjectStateTable {
  project_id: string;
  key: string;
  value_json: string;
  updated_at: string;
}

interface FlowSqlDatabase {
  flow_sessions: JsonTable;
  flow_events: FlowEventsTable;
  workflow_issues: JsonTable;
  worker_runs: IssueScopedJsonTable;
  worker_results: IssueScopedJsonTable;
  work_jobs: IssueScopedJsonTable;
  work_job_results: IssueScopedJsonTable;
  flow_context: FlowContextTable;
  project_state: ProjectStateTable;
}

export interface SqliteSqlStateOptions {
  root?: string;
  path?: string;
}

export interface PostgresSqlStateOptions {
  connectionString?: string;
  dialect?: Dialect;
}

export type SqlStateDialectConfig =
  | { kind: "sqlite"; path: string; dialect: Dialect }
  | { kind: "postgres"; connectionString?: string; dialect?: Dialect };

export function createSqliteSqlStateConfig(options: SqliteSqlStateOptions): SqlStateDialectConfig {
  const path = options.path ?? join(options.root ?? ".", "flow-state.db");
  return {
    kind: "sqlite",
    path,
    dialect: createNodeSqliteDialect(path),
  };
}

export function createPostgresSqlStateConfig(options: PostgresSqlStateOptions = {}): SqlStateDialectConfig {
  return {
    kind: "postgres",
    connectionString: options.connectionString,
    dialect: options.dialect,
  };
}

export class KyselyFlowState implements FlowStoreInterface, WorkflowLedger {
  readonly root: string;
  private readonly db: Kysely<FlowSqlDatabase>;
  private ensured = false;

  constructor(options: { root?: string; dialect: Dialect }) {
    this.root = options.root ?? ".";
    this.db = new Kysely<FlowSqlDatabase>({ dialect: options.dialect });
  }

  async ensure(): Promise<void> {
    if (this.ensured) return;
    await this.db.schema
      .createTable("flow_sessions")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("data", "text", (col) => col.notNull())
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text", (col) => col.notNull())
      .execute();
    await this.db.schema
      .createTable("flow_events")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("session_id", "text", (col) => col.notNull())
      .addColumn("type", "text", (col) => col.notNull())
      .addColumn("data", "text", (col) => col.notNull())
      .addColumn("created_at", "text", (col) => col.notNull())
      .execute();
    await this.db.schema
      .createTable("workflow_issues")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("data", "text", (col) => col.notNull())
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text", (col) => col.notNull())
      .execute();
    await this.createIssueScopedTable("worker_runs");
    await this.createIssueScopedTable("worker_results");
    await this.createIssueScopedTable("work_jobs");
    await this.createIssueScopedTable("work_job_results");
    await this.db.schema
      .createTable("flow_context")
      .ifNotExists()
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("project_id", "text", (col) => col.notNull())
      .addColumn("issue_ref", "text")
      .addColumn("thread_id", "text")
      .addColumn("session_id", "text")
      .addColumn("kind", "text", (col) => col.notNull())
      .addColumn("data", "text", (col) => col.notNull())
      .addColumn("created_at", "text", (col) => col.notNull())
      .addColumn("updated_at", "text", (col) => col.notNull())
      .execute();
    await this.db.schema
      .createTable("project_state")
      .ifNotExists()
      .addColumn("project_id", "text", (col) => col.notNull())
      .addColumn("key", "text", (col) => col.notNull())
      .addColumn("value_json", "text", (col) => col.notNull())
      .addColumn("updated_at", "text", (col) => col.notNull())
      .addPrimaryKeyConstraint("project_state_pk", ["project_id", "key"])
      .execute();
    await this.db.schema.createIndex("flow_events_session_id_idx").ifNotExists().on("flow_events").column("session_id").execute();
    await this.db.schema.createIndex("flow_context_scope_idx").ifNotExists().on("flow_context").columns(["project_id", "issue_ref"]).execute();
    this.ensured = true;
  }

  async createSession(id = createId("session")): Promise<WorkRuntimeSession> {
    const now = nowIso();
    const session = workRuntimeSessionSchema.parse({
      id,
      findings: [],
      workerResults: [],
      createdAt: now,
      updatedAt: now,
    });
    await this.writeSession(session);
    return session;
  }

  async readSession(id: string): Promise<WorkRuntimeSession | undefined> {
    await this.ensure();
    const row = await this.db.selectFrom("flow_sessions").select("data").where("id", "=", id).executeTakeFirst();
    return row ? workRuntimeSessionSchema.parse(JSON.parse(row.data)) : undefined;
  }

  async writeSession(session: WorkRuntimeSession): Promise<WorkRuntimeSession> {
    await this.ensure();
    const parsed = workRuntimeSessionSchema.parse({ ...session, updatedAt: nowIso() });
    await this.upsertJson("flow_sessions", parsed.id, parsed, parsed.createdAt, parsed.updatedAt);
    return parsed;
  }

  async appendEvent(event: Omit<WorkRuntimeEvent, "id" | "createdAt">): Promise<WorkRuntimeEvent> {
    await this.ensure();
    const parsed = workRuntimeEventSchema.parse({
      ...event,
      id: createId("event"),
      createdAt: nowIso(),
    });
    await this.db
      .insertInto("flow_events")
      .values({
        id: parsed.id,
        session_id: parsed.sessionId,
        type: parsed.type,
        data: JSON.stringify(parsed),
        created_at: parsed.createdAt,
      })
      .execute();
    return parsed;
  }

  async listIssues(limit = 20): Promise<WorkItem[]> {
    await this.ensure();
    const rows = await this.db.selectFrom("workflow_issues").select("data").orderBy("updated_at", "desc").limit(limit).execute();
    return rows.map((row) => workItemSchema.parse(JSON.parse(row.data)));
  }

  async readIssue(ref: string): Promise<WorkItem | undefined> {
    await this.ensure();
    const row = await this.db.selectFrom("workflow_issues").select("data").where("id", "=", ref).executeTakeFirst();
    return row ? workItemSchema.parse(JSON.parse(row.data)) : undefined;
  }

  async readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    await this.ensure();
    if (refs.length === 0) return new Map();
    const rows = await this.db.selectFrom("workflow_issues").select(["id", "data"]).where("id", "in", refs).execute();
    return new Map(rows.map((row) => [row.id, workItemSchema.parse(JSON.parse(row.data))]));
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    return this.writeIssue(issue);
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    await this.ensure();
    const updatedAt = nowIso();
    const parsed = workItemSchema.parse({ ...issue, updatedAt });
    await this.upsertJson("workflow_issues", parsed.ref, parsed, issue.updatedAt ?? updatedAt, updatedAt);
    return parsed;
  }

  async listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    return this.listIssueScoped("worker_runs", issueRef, workerRunRecordSchema);
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    const parsed = workerRunRecordSchema.parse(run);
    await this.upsertIssueScoped("worker_runs", parsed.issueRef, parsed.taskId, parsed, parsed.startedAt ?? parsed.updatedAt, parsed.updatedAt);
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    return this.listIssueScoped("worker_results", issueRef, workerTaskResultSchema);
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    const parsed = workerTaskResultSchema.parse(result);
    await this.upsertIssueScoped("worker_results", parsed.issueRef, parsed.taskId, parsed, parsed.completedAt, parsed.completedAt);
    await this.recordWorkerRun(workerResultToRun(parsed));
  }

  async listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    return this.listIssueScoped("work_jobs", issueRef, workJobSchema);
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    const parsed = workJobSchema.parse(job);
    await this.upsertIssueScoped("work_jobs", parsed.issueRef, parsed.id, parsed, parsed.createdAt, parsed.updatedAt);
  }

  async listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    return this.listIssueScoped("work_job_results", issueRef, workJobResultSchema);
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    const parsed = workJobResultSchema.parse(result);
    await this.upsertIssueScoped("work_job_results", parsed.issueRef, parsed.jobId, parsed, parsed.completedAt, parsed.completedAt);
  }

  async recordContext(record: FlowContextRecordInput): Promise<FlowContextRecord> {
    await this.ensure();
    const parsed = flowContextRecordSchema.parse(record);
    await this.db
      .insertInto("flow_context")
      .values({
        id: parsed.id,
        project_id: parsed.projectId,
        issue_ref: parsed.issueRef ?? null,
        thread_id: parsed.threadId ?? null,
        session_id: parsed.sessionId ?? null,
        kind: parsed.kind,
        data: JSON.stringify(parsed),
        created_at: parsed.createdAt,
        updated_at: parsed.updatedAt,
      })
      .onConflict((oc) => oc.column("id").doUpdateSet({
        project_id: parsed.projectId,
        issue_ref: parsed.issueRef ?? null,
        thread_id: parsed.threadId ?? null,
        session_id: parsed.sessionId ?? null,
        kind: parsed.kind,
        data: JSON.stringify(parsed),
        updated_at: parsed.updatedAt,
      }))
      .execute();
    return parsed;
  }

  async readContext(scope: FlowContextScope = {}): Promise<FlowContextProjection> {
    await this.ensure();
    let query = this.db.selectFrom("flow_context").select("data");
    if (scope.projectId) query = query.where("project_id", "=", scope.projectId);
    if (scope.issueRef) query = query.where("issue_ref", "=", scope.issueRef);
    if (scope.threadId) query = query.where("thread_id", "=", scope.threadId);
    if (scope.sessionId) query = query.where("session_id", "=", scope.sessionId);
    if (scope.artifactId) query = query.where("id", "=", scope.artifactId);
    const rows = await query.orderBy("updated_at", "desc").execute();
    return contextProjection(rows.map((row) => flowContextRecordSchema.parse(JSON.parse(row.data))));
  }

  async setProjectState(projectId: string, key: string, value: unknown): Promise<void> {
    await this.ensure();
    await this.db
      .insertInto("project_state")
      .values({ project_id: projectId, key, value_json: JSON.stringify(value), updated_at: nowIso() })
      .onConflict((oc) => oc.columns(["project_id", "key"]).doUpdateSet({
        value_json: JSON.stringify(value),
        updated_at: nowIso(),
      }))
      .execute();
  }

  async getProjectState<T = unknown>(projectId: string, key: string): Promise<T | undefined> {
    await this.ensure();
    const row = await this.db
      .selectFrom("project_state")
      .select("value_json")
      .where("project_id", "=", projectId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  private async createIssueScopedTable(table: "worker_runs" | "worker_results" | "work_jobs" | "work_job_results"): Promise<void> {
    await this.db.schema
      .createTable(table)
      .ifNotExists()
      .addColumn("issue_ref", "text", (col) => col.notNull())
      .addColumn("id", "text", (col) => col.notNull())
      .addColumn("data", "text", (col) => col.notNull())
      .addColumn("created_at", "text")
      .addColumn("updated_at", "text", (col) => col.notNull())
      .addPrimaryKeyConstraint(`${table}_pk`, ["issue_ref", "id"])
      .execute();
  }

  private async upsertJson(
    table: "flow_sessions" | "workflow_issues",
    id: string,
    value: unknown,
    createdAt: string | undefined,
    updatedAt: string,
  ): Promise<void> {
    await this.db
      .insertInto(table)
      .values({ id, data: JSON.stringify(value), created_at: createdAt ?? null, updated_at: updatedAt })
      .onConflict((oc) => oc.column("id").doUpdateSet({
        data: JSON.stringify(value),
        updated_at: updatedAt,
      }))
      .execute();
  }

  private async upsertIssueScoped(
    table: "worker_runs" | "worker_results" | "work_jobs" | "work_job_results",
    issueRef: string,
    id: string,
    value: unknown,
    createdAt: string | undefined,
    updatedAt: string,
  ): Promise<void> {
    await this.ensure();
    await this.db
      .insertInto(table)
      .values({ issue_ref: issueRef, id, data: JSON.stringify(value), created_at: createdAt ?? null, updated_at: updatedAt })
      .onConflict((oc) => oc.columns(["issue_ref", "id"]).doUpdateSet({
        data: JSON.stringify(value),
        updated_at: updatedAt,
      }))
      .execute();
  }

  private async listIssueScoped<T>(
    table: "worker_runs" | "worker_results" | "work_jobs" | "work_job_results",
    issueRef: string,
    schema: { parse(value: unknown): T },
  ): Promise<T[]> {
    await this.ensure();
    const rows = await this.db
      .selectFrom(table)
      .select("data")
      .where("issue_ref", "=", issueRef)
      .orderBy("updated_at", "asc")
      .execute();
    return rows.map((row) => schema.parse(JSON.parse(row.data)));
  }
}

export function createKyselyFlowState(options: { root?: string; dialectConfig: SqlStateDialectConfig }): KyselyFlowState {
  if (!options.dialectConfig.dialect) {
    throw new Error(`SQL state dialect ${options.dialectConfig.kind} requires a Kysely dialect.`);
  }
  return new KyselyFlowState({
    root: options.root,
    dialect: options.dialectConfig.dialect,
  });
}

function createNodeSqliteDialect(path: string): Dialect {
  mkdirSync(dirname(path), { recursive: true });
  return new SqliteDialect({
    database: async () => new NodeSqliteDatabase(path),
  });
}

class NodeSqliteDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  close(): void {
    this.db.close();
  }

  prepare(query: string): NodeSqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(query));
  }
}

class NodeSqliteStatement {
  readonly reader: boolean;

  constructor(private readonly stmt: StatementSync) {
    this.reader = this.stmt.columns().length > 0;
  }

  all(parameters: ReadonlyArray<unknown>): unknown[] {
    return this.stmt.all(...parameters as never[]);
  }

  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    const result = this.stmt.run(...parameters as never[]);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
    return this.stmt.iterate(...parameters as never[]);
  }
}

function contextProjection(records: FlowContextRecord[]): FlowContextProjection {
  const sorted = [...records].sort(compareContextRecords);
  return flowContextProjectionSchema.parse({
    active: activeContext(sorted),
    prompts: sorted.filter((record) => record.kind === "prompt"),
    threads: sorted.filter((record) => record.kind === "thread"),
    sessions: sorted.filter((record) => record.kind === "session"),
    artifacts: sorted.filter((record) => record.kind === "artifact"),
    updatedAt: sorted[0]?.updatedAt ?? nowIso(),
  });
}

function activeContext(records: FlowContextRecord[]) {
  const latest = records[0];
  return {
    projectId: latest?.projectId,
    issueRef: latest?.issueRef,
    threadId: latest?.threadId,
    sessionId: latest?.sessionId,
    artifactId: latest?.kind === "artifact" ? latest.id : latest?.artifactRefs[0],
    updatedAt: latest?.updatedAt,
  };
}

function compareContextRecords(a: FlowContextRecord, b: FlowContextRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
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
    startedAt: result.completedAt,
    updatedAt: result.completedAt,
    completedAt: result.completedAt,
  });
}
