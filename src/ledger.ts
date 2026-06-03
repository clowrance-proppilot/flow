import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { flowIssueProjectionFileName, flowUserWorkflowLedgerDatabasePath } from "./flow-layout.js";
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

type JsonlWorkflowLedgerRecord =
  | { kind: "issue"; value: WorkItem }
  | { kind: "workerRun"; value: WorkerRunRecord }
  | { kind: "workerResult"; value: WorkerTaskResult }
  | { kind: "workJob"; value: WorkJob }
  | { kind: "workJobResult"; value: WorkJobResult }
  | { kind: "context"; value: FlowContextRecord };

export interface WorkflowLedgerDiagnostic {
  line: number;
  message: string;
}

export interface WorkflowLedgerVerifyOptions {
  rebuildProjections?: boolean;
}

export interface WorkflowLedgerVerifyResult {
  ok: boolean;
  path: string;
  totalLines: number;
  validRecords: number;
  invalidRecords: number;
  rebuiltProjections: number;
  diagnostics: WorkflowLedgerDiagnostic[];
}


interface IssueWorkflowProjection {
  issue?: WorkItem;
  workerRuns: WorkerRunRecord[];
  workerResults: WorkerTaskResult[];
  workJobs: WorkJob[];
  workJobResults: WorkJobResult[];
  updatedAt: string;
}

export interface JsonlWorkflowLedgerOptions {
  path: string;
}

export class JsonlWorkflowLedger implements WorkflowLedger {
  private readonly path: string;
  private readonly projections: IssueProjectionStore;
  private readonly contextProjectionPath: string;
  private readonly memory = new MemoryWorkflowLedger();
  private loaded = false;

  constructor(options: JsonlWorkflowLedgerOptions) {
    this.path = options.path;
    this.projections = new IssueProjectionStore(join(dirname(options.path), "issues"));
    this.contextProjectionPath = join(dirname(options.path), "context.json");
  }

  async listIssues(limit?: number): Promise<WorkItem[]> {
    await this.load();
    return this.memory.listIssues(limit);
  }

  async readIssue(ref: string): Promise<WorkItem | undefined> {
    const projected = await this.projections.read(ref);
    if (projected?.issue) return projected.issue;
    await this.load();
    const issue = await this.memory.readIssue(ref);
    if (issue) await this.writeProjection(ref);
    return issue;
  }

  async readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    const projected = await this.projections.readMany(refs);
    const issues = new Map<string, WorkItem>();
    const missing: string[] = [];
    for (const ref of refs) {
      const issue = projected.get(ref)?.issue;
      if (issue) issues.set(ref, issue);
      else missing.push(ref);
    }
    if (missing.length === 0) return issues;
    await this.load();
    const replayed = await this.memory.readIssues(missing);
    for (const [ref, issue] of replayed) {
      issues.set(ref, issue);
      await this.writeProjection(ref);
    }
    return issues;
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    return this.writeIssue(issue);
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    await this.load();
    const stored = await this.memory.writeIssue(issue);
    await this.append({ kind: "issue", value: stored });
    await this.writeProjection(stored.ref);
    return stored;
  }

  async listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    const projected = await this.projections.read(issueRef);
    if (projected) return projected.workerRuns;
    await this.load();
    const runs = await this.memory.listWorkerRuns(issueRef);
    if (runs.length || await this.memory.readIssue(issueRef)) await this.writeProjection(issueRef);
    return runs;
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    await this.load();
    await this.memory.recordWorkerRun(run);
    await this.append({ kind: "workerRun", value: workerRunRecordSchema.parse(run) });
    await this.writeProjection(run.issueRef);
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    const projected = await this.projections.read(issueRef);
    if (projected) return projected.workerResults;
    await this.load();
    const results = await this.memory.listWorkerResults(issueRef);
    if (results.length || await this.memory.readIssue(issueRef)) await this.writeProjection(issueRef);
    return results;
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    await this.load();
    const parsed = workerTaskResultSchema.parse(result);
    await this.memory.recordWorkerResult(parsed);
    await this.append({ kind: "workerResult", value: parsed });
    await this.writeProjection(parsed.issueRef);
  }

  async listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    const projected = await this.projections.read(issueRef);
    if (projected) return projected.workJobs;
    await this.load();
    const jobs = await this.memory.listWorkJobs(issueRef);
    if (jobs.length || await this.memory.readIssue(issueRef)) await this.writeProjection(issueRef);
    return jobs;
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    await this.load();
    const parsed = workJobSchema.parse(job);
    await this.memory.recordWorkJob(parsed);
    await this.append({ kind: "workJob", value: parsed });
    await this.writeProjection(parsed.issueRef);
  }

  async listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    const projected = await this.projections.read(issueRef);
    if (projected) return projected.workJobResults;
    await this.load();
    const results = await this.memory.listWorkJobResults(issueRef);
    if (results.length || await this.memory.readIssue(issueRef)) await this.writeProjection(issueRef);
    return results;
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    await this.load();
    const parsed = workJobResultSchema.parse(result);
    await this.memory.recordWorkJobResult(parsed);
    await this.append({ kind: "workJobResult", value: parsed });
    await this.writeProjection(parsed.issueRef);
  }

  async recordContext(record: FlowContextRecordInput): Promise<FlowContextRecord> {
    await this.load();
    const parsed = await this.memory.recordContext(record);
    await this.append({ kind: "context", value: parsed });
    await this.writeContextProjection();
    return parsed;
  }

  async readContext(scope: FlowContextScope = {}): Promise<FlowContextProjection> {
    const projected = await readContextProjection(this.contextProjectionPath);
    if (projected) return filterContextProjection(projected, scope);
    await this.load();
    const projection = await this.memory.readContext(scope);
    await this.writeContextProjection();
    return projection;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    const raw = await readFile(this.path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as JsonlWorkflowLedgerRecord;
      if (record.kind === "issue") await this.memory.writeIssue(record.value);
      if (record.kind === "workerRun") await this.memory.recordWorkerRun(record.value);
      if (record.kind === "workerResult") await this.memory.recordWorkerResult(record.value);
      if (record.kind === "workJob") await this.memory.recordWorkJob(record.value);
      if (record.kind === "workJobResult") await this.memory.recordWorkJobResult(record.value);
      if (record.kind === "context") await this.memory.recordContext(record.value);
    }
  }

  private async append(record: JsonlWorkflowLedgerRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  private async writeProjection(issueRef: string): Promise<void> {
    await this.projections.write(issueRef, {
      issue: await this.memory.readIssue(issueRef),
      workerRuns: await this.memory.listWorkerRuns(issueRef),
      workerResults: await this.memory.listWorkerResults(issueRef),
      workJobs: await this.memory.listWorkJobs(issueRef),
      workJobResults: await this.memory.listWorkJobResults(issueRef),
      updatedAt: nowIso(),
    });
  }

  private async writeContextProjection(): Promise<void> {
    const projection = await this.memory.readContext();
    await writeContextProjection(this.contextProjectionPath, projection);
  }
}

export async function verifyJsonlWorkflowLedger(
  path: string,
  options: WorkflowLedgerVerifyOptions = {},
): Promise<WorkflowLedgerVerifyResult> {
  const memory = new MemoryWorkflowLedger();
  const diagnostics: WorkflowLedgerDiagnostic[] = [];
  const issueRefs = new Set<string>();
  let hasContextRecords = false;
  let totalLines = 0;
  let validRecords = 0;

  if (existsSync(path)) {
    const raw = await readFile(path, "utf8");
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      totalLines += 1;
      const lineNumber = index + 1;
      try {
        const record = parseWorkflowLedgerRecord(JSON.parse(line));
        await applyWorkflowLedgerRecord(memory, record);
        const issueRef = workflowLedgerRecordIssueRef(record);
        if (issueRef) issueRefs.add(issueRef);
        if (record.kind === "context") hasContextRecords = true;
        validRecords += 1;
      } catch (error) {
        diagnostics.push({ line: lineNumber, message: errorMessage(error) });
      }
    }
  }

  let rebuiltProjections = 0;
  if (options.rebuildProjections && diagnostics.length === 0) {
    const projections = new IssueProjectionStore(join(dirname(path), "issues"));
    for (const issueRef of issueRefs) {
      await projections.write(issueRef, {
        issue: await memory.readIssue(issueRef),
        workerRuns: await memory.listWorkerRuns(issueRef),
        workerResults: await memory.listWorkerResults(issueRef),
        workJobs: await memory.listWorkJobs(issueRef),
        workJobResults: await memory.listWorkJobResults(issueRef),
        updatedAt: nowIso(),
      });
      rebuiltProjections += 1;
    }
    if (hasContextRecords) {
      await writeContextProjection(join(dirname(path), "context.json"), await memory.readContext());
      rebuiltProjections += 1;
    }
  }

  return {
    ok: diagnostics.length === 0,
    path,
    totalLines,
    validRecords,
    invalidRecords: diagnostics.length,
    rebuiltProjections,
    diagnostics,
  };
}

function parseWorkflowLedgerRecord(value: unknown): JsonlWorkflowLedgerRecord {
  if (typeof value !== "object" || value === null) throw new Error("Ledger record must be an object.");
  const kind = (value as { kind?: unknown }).kind;
  const recordValue = (value as { value?: unknown }).value;
  if (kind === "issue") return { kind, value: workItemSchema.parse(recordValue) };
  if (kind === "workerRun") return { kind, value: workerRunRecordSchema.parse(recordValue) };
  if (kind === "workerResult") return { kind, value: workerTaskResultSchema.parse(recordValue) };
  if (kind === "workJob") return { kind, value: workJobSchema.parse(recordValue) };
  if (kind === "workJobResult") return { kind, value: workJobResultSchema.parse(recordValue) };
  if (kind === "context") return { kind, value: flowContextRecordSchema.parse(recordValue) };
  throw new Error(`Unsupported ledger record kind: ${String(kind)}.`);
}

async function applyWorkflowLedgerRecord(
  ledger: WorkflowLedger,
  record: JsonlWorkflowLedgerRecord,
): Promise<void> {
  if (record.kind === "issue") await ledger.writeIssue(record.value);
  if (record.kind === "workerRun") await ledger.recordWorkerRun(record.value);
  if (record.kind === "workerResult") await ledger.recordWorkerResult(record.value);
  if (record.kind === "workJob") await ledger.recordWorkJob(record.value);
  if (record.kind === "workJobResult") await ledger.recordWorkJobResult(record.value);
  if (record.kind === "context") {
    if (!ledger.recordContext) throw new Error("Target workflow ledger does not support context records.");
    await ledger.recordContext(record.value);
  }
}

function workflowLedgerRecordIssueRef(record: JsonlWorkflowLedgerRecord): string | undefined {
  if (record.kind === "issue") return record.value.ref;
  if (record.kind === "context") return record.value.issueRef;
  return record.value.issueRef;
}

class IssueProjectionStore {
  constructor(private readonly root: string) {}

  async read(issueRef: string): Promise<IssueWorkflowProjection | undefined> {
    const path = this.pathForIssue(issueRef);
    if (!existsSync(path)) return undefined;
    const raw = await readFile(path, "utf8");
    return parseIssueProjection(JSON.parse(raw));
  }

  async readMany(issueRefs: string[]): Promise<Map<string, IssueWorkflowProjection>> {
    const projections = new Map<string, IssueWorkflowProjection>();
    await Promise.all(issueRefs.map(async (ref) => {
      const projection = await this.read(ref);
      if (projection) projections.set(ref, projection);
    }));
    return projections;
  }

  async write(issueRef: string, projection: IssueWorkflowProjection): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const path = this.pathForIssue(issueRef);
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  private pathForIssue(issueRef: string): string {
    return join(this.root, `${flowIssueProjectionFileName(issueRef)}.json`);
  }
}

async function readContextProjection(path: string): Promise<FlowContextProjection | undefined> {
  if (!existsSync(path)) return undefined;
  const raw = await readFile(path, "utf8");
  return flowContextProjectionSchema.parse(JSON.parse(raw));
}

async function writeContextProjection(path: string, projection: FlowContextProjection): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(flowContextProjectionSchema.parse(projection), null, 2)}\n`, "utf8");
  await rm(path, { force: true });
  await rename(tempPath, path);
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

function filterContextProjection(projection: FlowContextProjection, scope: FlowContextScope = {}): FlowContextProjection {
  return contextProjection([
    ...projection.threads,
    ...projection.prompts,
    ...projection.sessions,
    ...projection.artifacts,
  ], scope);
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

function parseIssueProjection(value: unknown): IssueWorkflowProjection {
  if (!isRecord(value)) throw new Error("Invalid Flow issue projection.");
  return {
    issue: value.issue === undefined ? undefined : workItemSchema.parse(value.issue),
    workerRuns: workerRunRecordSchema.array().parse(value.workerRuns ?? []),
    workerResults: workerTaskResultSchema.array().parse(value.workerResults ?? []),
    workJobs: workJobSchema.array().parse(value.workJobs ?? []),
    workJobResults: workJobResultSchema.array().parse(value.workJobResults ?? []),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function disabledMetadata(value: unknown): boolean {
  if (value === false || value === 0) return true;
  if (typeof value !== "string") return false;
  return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}
