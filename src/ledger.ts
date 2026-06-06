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
import { flowUserWorkflowLedgerDatabasePath } from "./flow-layout.js";
import { createKyselyFlowState, createSqliteSqlStateConfig } from "./sql-state.js";
import type { WorkflowLedger, WorkflowLedgerMirror } from "./engine/ledger-contracts.js";
export type { WorkflowLedger, WorkflowLedgerMirror } from "./engine/ledger-contracts.js";

export class MemoryWorkflowLedger implements WorkflowLedger {
  private readonly issues = new Map<string, WorkItem>();
  private readonly workerRuns = new Map<string, WorkerRunRecord[]>();
  private readonly workerResults = new Map<string, WorkerTaskResult[]>();
  private readonly workJobs = new Map<string, WorkJob[]>();
  private readonly workJobResults = new Map<string, WorkJobResult[]>();
  private readonly contexts = new Map<string, FlowContextRecord>();

  async listIssues(limit = 20): Promise<WorkItem[]> {
    return [...this.issues.values()].slice(0, limit);
  }

  async readIssue(ref: string): Promise<WorkItem | undefined> {
    return this.issues.get(ref);
  }

  async readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    return new Map(refs.map((ref) => [ref, this.issues.get(ref)]).filter((entry): entry is [string, WorkItem] => Boolean(entry[1])));
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    return this.writeIssue(issue);
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    const parsed = workItemSchema.parse({ ...issue, updatedAt: nowIso() });
    this.issues.set(parsed.ref, parsed);
    return parsed;
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    return this.workerResults.get(issueRef) ?? [];
  }

  async listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    return this.workerRuns.get(issueRef) ?? [];
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    const parsed = workerRunRecordSchema.parse(run);
    const existing = this.workerRuns.get(parsed.issueRef) ?? [];
    const next = upsertByTaskId(existing, parsed);
    this.workerRuns.set(parsed.issueRef, next);
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    const parsed = workerTaskResultSchema.parse(result);
    const existing = this.workerResults.get(parsed.issueRef) ?? [];
    this.workerResults.set(parsed.issueRef, upsertByTaskId(existing, parsed));
    await this.recordWorkerRun(workerResultToRun(parsed));
  }

  async listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    return this.workJobs.get(issueRef) ?? [];
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    const parsed = workJobSchema.parse(job);
    const existing = this.workJobs.get(parsed.issueRef) ?? [];
    this.workJobs.set(parsed.issueRef, upsertById(existing, parsed));
  }

  async listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    return this.workJobResults.get(issueRef) ?? [];
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    const parsed = workJobResultSchema.parse(result);
    const existing = this.workJobResults.get(parsed.issueRef) ?? [];
    this.workJobResults.set(parsed.issueRef, upsertByJobId(existing, parsed));
  }

  async recordContext(record: FlowContextRecordInput): Promise<FlowContextRecord> {
    const parsed = flowContextRecordSchema.parse(record);
    this.contexts.set(parsed.id, parsed);
    return parsed;
  }

  async readContext(scope: FlowContextScope = {}): Promise<FlowContextProjection> {
    return contextProjection([...this.contexts.values()], scope);
  }
}

function contextProjection(records: FlowContextRecord[], scope: FlowContextScope = {}): FlowContextProjection {
  const parsedScope = flowContextScopeSchema.parse(scope);
  const filtered = records
    .map((record) => flowContextRecordSchema.parse(record))
    .filter((record) => contextMatchesScope(record, parsedScope))
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

function contextMatchesScope(record: FlowContextRecord, scope: FlowContextScope): boolean {
  if (scope.projectId && record.projectId !== scope.projectId) return false;
  if (scope.issueRef && record.issueRef !== scope.issueRef) return false;
  if (scope.threadId && record.threadId !== scope.threadId && record.id !== scope.threadId) return false;
  if (scope.sessionId && record.sessionId !== scope.sessionId && record.id !== scope.sessionId) return false;
  if (scope.artifactId && record.id !== scope.artifactId && !record.artifactRefs.includes(scope.artifactId)) return false;
  return true;
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

export interface WorkflowLedgerFactoryOptions {
  cwd: string;
  adapter?: string;
  path?: string;
}

export function createWorkflowLedger(options: WorkflowLedgerFactoryOptions): WorkflowLedger {
  if (options.adapter === "jsonl") {
    throw new Error("JSONL workflow ledger is no longer supported. Use SQLite (default SQL ledger).");
  }
  if (options.adapter && options.adapter !== "flow" && options.adapter !== "sql") {
    throw new Error(`Unsupported workflow ledger adapter: ${options.adapter}. Supported adapters: flow, sql.`);
  }
  const path = options.path ?? flowUserWorkflowLedgerDatabasePath(options.cwd);
  return createKyselyFlowState({
    root: options.cwd,
    dialectConfig: createSqliteSqlStateConfig({ path }),
  });
}

export class MirroredWorkflowLedger implements WorkflowLedger {
  constructor(
    private readonly primary: WorkflowLedger,
    private readonly mirror: WorkflowLedgerMirror,
  ) {}

  listIssues(limit?: number): Promise<WorkItem[]> {
    return this.primary.listIssues(limit);
  }

  readIssue(ref: string): Promise<WorkItem | undefined> {
    return this.primary.readIssue(ref);
  }

  readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    return this.primary.readIssues
      ? this.primary.readIssues(refs)
      : Promise.all(refs.map(async (ref) => [ref, await this.primary.readIssue(ref)] as const))
        .then((entries) => new Map(entries.filter((entry): entry is readonly [string, WorkItem] => Boolean(entry[1]))));
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    const stored = await this.primary.ensureIssue(issue);
    await this.mirrorBestEffort("issue.ensure", () => this.mirror.mirrorIssue("ensureIssue", stored));
    return stored;
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    const stored = await this.primary.writeIssue(issue);
    await this.mirrorBestEffort("issue.write", () => this.mirror.mirrorIssue("writeIssue", stored));
    return stored;
  }

  listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    return this.primary.listWorkerRuns(issueRef);
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    await this.primary.recordWorkerRun(run);
    await this.mirrorBestEffort("worker_run.record", () => this.mirror.mirrorWorkerRun(run));
  }

  listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    return this.primary.listWorkerResults(issueRef);
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    await this.primary.recordWorkerResult(result);
    await this.mirrorBestEffort("worker_result.record", () => this.mirror.mirrorWorkerResult(result));
  }

  listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    return this.primary.listWorkJobs(issueRef);
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    await this.primary.recordWorkJob(job);
    await this.mirrorBestEffort("work_job.record", () => this.mirror.mirrorWorkJob(job));
  }

  listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    return this.primary.listWorkJobResults(issueRef);
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    await this.primary.recordWorkJobResult(result);
    await this.mirrorBestEffort("work_job_result.record", () => this.mirror.mirrorWorkJobResult(result));
  }

  async recordContext(record: FlowContextRecordInput): Promise<FlowContextRecord> {
    if (!this.primary.recordContext) {
      throw new Error("Primary workflow ledger does not support Flow context records.");
    }
    return this.primary.recordContext(record);
  }

  async readContext(scope: FlowContextScope = {}): Promise<FlowContextProjection> {
    if (!this.primary.readContext) {
      return contextProjection([], scope);
    }
    return this.primary.readContext(scope);
  }

  private async mirrorBestEffort(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await withPerfLog(`mirror.${label}`, operation, 1000);
    } catch (error) {
      console.error(`Flow mirror failed: ${errorMessage(error)}`);
    }
  }
}

async function withPerfLog<T>(label: string, operation: () => Promise<T>, defaultThresholdMs = 1000): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    const durationMs = Date.now() - startedAt;
    if (shouldPerfLog(durationMs, defaultThresholdMs)) {
      console.error(`[flow perf] ${label} duration_ms=${durationMs}`);
    }
  }
}

function shouldPerfLog(durationMs: number, defaultThresholdMs: number): boolean {
  return durationMs >= defaultThresholdMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function upsertByTaskId<T extends { taskId: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.taskId === item.taskId);
  if (index === -1) return [...items, item];
  return items.map((existing, itemIndex) => (itemIndex === index ? { ...existing, ...item } : existing));
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((existing, itemIndex) => (itemIndex === index ? { ...existing, ...item } : existing));
}

function upsertByJobId<T extends { jobId: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.jobId === item.jobId);
  if (index === -1) return [...items, item];
  return items.map((existing, itemIndex) => (itemIndex === index ? { ...existing, ...item } : existing));
}
