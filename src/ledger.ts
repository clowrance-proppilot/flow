import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  type WorkItem,
  type WorkJob,
  type WorkJobResult,
  type WorkerRunRecord,
  type WorkerTaskResult,
  nowIso,
  workJobResultSchema,
  workJobSchema,
  workItemSchema,
  workerRunRecordSchema,
  workerTaskResultSchema,
} from "./contracts.js";
import type { WorkflowLedger, WorkflowLedgerMirror } from "./engine/ledger-contracts.js";
export type { WorkflowLedger, WorkflowLedgerMirror } from "./engine/ledger-contracts.js";

const execFileAsync = promisify(execFile);

export class MemoryWorkflowLedger implements WorkflowLedger {
  private readonly issues = new Map<string, WorkItem>();
  private readonly workerRuns = new Map<string, WorkerRunRecord[]>();
  private readonly workerResults = new Map<string, WorkerTaskResult[]>();
  private readonly workJobs = new Map<string, WorkJob[]>();
  private readonly workJobResults = new Map<string, WorkJobResult[]>();

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
}

type JsonlWorkflowLedgerRecord =
  | { kind: "issue"; value: WorkItem }
  | { kind: "workerRun"; value: WorkerRunRecord }
  | { kind: "workerResult"; value: WorkerTaskResult }
  | { kind: "workJob"; value: WorkJob }
  | { kind: "workJobResult"; value: WorkJobResult };

export interface JsonlWorkflowLedgerOptions {
  path: string;
}

export class JsonlWorkflowLedger implements WorkflowLedger {
  private readonly path: string;
  private readonly memory = new MemoryWorkflowLedger();
  private loaded = false;

  constructor(options: JsonlWorkflowLedgerOptions) {
    this.path = options.path;
  }

  async listIssues(limit?: number): Promise<WorkItem[]> {
    await this.load();
    return this.memory.listIssues(limit);
  }

  async readIssue(ref: string): Promise<WorkItem | undefined> {
    await this.load();
    return this.memory.readIssue(ref);
  }

  async readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    await this.load();
    return this.memory.readIssues(refs);
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    return this.writeIssue(issue);
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    await this.load();
    const stored = await this.memory.writeIssue(issue);
    await this.append({ kind: "issue", value: stored });
    return stored;
  }

  async listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    await this.load();
    return this.memory.listWorkerRuns(issueRef);
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    await this.load();
    await this.memory.recordWorkerRun(run);
    await this.append({ kind: "workerRun", value: workerRunRecordSchema.parse(run) });
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    await this.load();
    return this.memory.listWorkerResults(issueRef);
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    await this.load();
    const parsed = workerTaskResultSchema.parse(result);
    await this.memory.recordWorkerResult(parsed);
    await this.append({ kind: "workerResult", value: parsed });
  }

  async listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    await this.load();
    return this.memory.listWorkJobs(issueRef);
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    await this.load();
    const parsed = workJobSchema.parse(job);
    await this.memory.recordWorkJob(parsed);
    await this.append({ kind: "workJob", value: parsed });
  }

  async listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    await this.load();
    return this.memory.listWorkJobResults(issueRef);
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    await this.load();
    const parsed = workJobResultSchema.parse(result);
    await this.memory.recordWorkJobResult(parsed);
    await this.append({ kind: "workJobResult", value: parsed });
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
    }
  }

  private async append(record: JsonlWorkflowLedgerRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export interface BeadsWorkflowLedgerOptions {
  cwd: string;
}

export interface WorkflowLedgerFactoryOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  adapter?: string;
  path?: string;
}

export function createWorkflowLedger(options: WorkflowLedgerFactoryOptions): WorkflowLedger {
  const env = options.env ?? process.env;
  const adapter = options.adapter ?? env.FLOW_LEDGER_ADAPTER;
  if (adapter === "beads") return new BeadsWorkflowLedger({ cwd: options.cwd });
  return new JsonlWorkflowLedger({
    path: options.path ?? env.FLOW_WORKFLOW_LEDGER_PATH ?? join(options.cwd, ".context", "flow", "workflow.jsonl"),
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

  private async mirrorBestEffort(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await withPerfLog(`mirror.${label}`, operation, 1000);
    } catch (error) {
      if (truthyMetadata(process.env.FLOW_MIRROR_DEBUG)) {
        console.error(`Flow mirror failed: ${errorMessage(error)}`);
      }
    }
  }
}

export class BeadsWorkflowLedger implements WorkflowLedger {
  private readonly cwd: string;

  constructor(options: BeadsWorkflowLedgerOptions) {
    this.cwd = options.cwd;
  }

  async listIssues(limit = 20): Promise<WorkItem[]> {
    const output = await this.runJson(["--readonly", "list", "--json"]);
    if (!Array.isArray(output)) return [];
    return output.map(parseBead).map(beadToWorkItem).slice(0, limit);
  }

  async readIssue(ref: string): Promise<WorkItem | undefined> {
    const bead = await this.findBead(ref);
    return bead ? beadToWorkItem(bead) : undefined;
  }

  async readIssues(refs: string[]): Promise<Map<string, WorkItem>> {
    const wanted = new Set(refs);
    if (wanted.size === 0) return new Map();
    const output = await this.runJson(["--readonly", "list", "--json", "--limit", "0"]);
    if (!Array.isArray(output)) return new Map();
    const issues = new Map<string, WorkItem>();
    for (const bead of output.map(parseBead)) {
      const issue = beadToWorkItem(bead);
      if (wanted.has(issue.ref)) issues.set(issue.ref, issue);
    }
    return issues;
  }

  async writeIssue(issue: WorkItem): Promise<WorkItem> {
    const bead = await this.findBead(issue.ref);
    if (!bead) {
      throw new Error(`No Beads issue is bound to ${issue.ref}.`);
    }
    await this.updateIssueFields(bead.id, issue);
    await this.updateMetadata(bead.id, workItemToBeadsMetadata(issue));
    return issue;
  }

  async ensureIssue(issue: WorkItem): Promise<WorkItem> {
    const existing = await this.findBead(issue.ref);
    if (existing) {
      await this.updateIssueFields(existing.id, issue);
      await this.updateMetadata(existing.id, workItemToBeadsMetadata(issue));
      return issue;
    }

    const created = await this.createBead(issue);
    await this.updateMetadata(created.id, workItemToBeadsMetadata(issue));
    return issue;
  }

  async listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]> {
    const bead = await this.findBead(issueRef);
    if (!bead) return [];
    const metadata = bead.metadata ?? {};
    const raw = metadata["workflow.pi.worker_results_json"];
    if (typeof raw !== "string" || !raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    return workerTaskResultSchema.array().parse(parsed);
  }

  async listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]> {
    const bead = await this.findBead(issueRef);
    if (!bead) return [];
    const metadata = bead.metadata ?? {};
    const raw = metadata["workflow.pi.worker_runs_json"];
    if (typeof raw !== "string" || !raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    return workerRunRecordSchema.array().parse(parsed);
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    const bead = await this.findBead(run.issueRef);
    if (!bead) {
      throw new Error(`No Beads issue is bound to ${run.issueRef}.`);
    }
    const parsed = workerRunRecordSchema.parse(run);
    const existing = await this.listWorkerRuns(run.issueRef);
    const executorKey = normalizeKey(parsed.executor ?? "pi");
    await this.updateMetadata(bead.id, {
      "workflow.pi.worker_runs_json": JSON.stringify(upsertByTaskId(existing, parsed)),
      [`workflow.workers.${executorKey}.${normalizeKey(parsed.repoKey)}.status`]: parsed.status,
      [`workflow.workers.${executorKey}.${normalizeKey(parsed.repoKey)}.summary`]: parsed.summary ?? "",
      [`workflow.workers.${executorKey}.${normalizeKey(parsed.repoKey)}.updated_at`]: parsed.updatedAt,
    });
  }

  async recordWorkerResult(result: WorkerTaskResult): Promise<void> {
    const bead = await this.findBead(result.issueRef);
    if (!bead) {
      throw new Error(`No Beads issue is bound to ${result.issueRef}.`);
    }
    const existing = await this.listWorkerResults(result.issueRef);
    const executorKey = normalizeKey(result.executor ?? "pi");
    await this.updateMetadata(bead.id, {
      "workflow.pi.worker_results_json": JSON.stringify(upsertByTaskId(existing, result)),
      [`workflow.workers.${executorKey}.${normalizeKey(result.repoKey)}.status`]: result.status,
      [`workflow.workers.${executorKey}.${normalizeKey(result.repoKey)}.summary`]: result.summary,
      [`workflow.workers.${executorKey}.${normalizeKey(result.repoKey)}.updated_at`]: result.completedAt,
    });
    await this.recordWorkerRun(workerResultToRun(result));
  }

  async listWorkJobs(issueRef: string): Promise<WorkJob[]> {
    const bead = await this.findBead(issueRef);
    if (!bead) return [];
    const metadata = bead.metadata ?? {};
    const raw = metadata["workflow.jobs_json"];
    if (typeof raw !== "string" || !raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    return workJobSchema.array().parse(parsed);
  }

  async recordWorkJob(job: WorkJob): Promise<void> {
    const bead = await this.findBead(job.issueRef);
    if (!bead) {
      throw new Error(`No Beads issue is bound to ${job.issueRef}.`);
    }
    const parsed = workJobSchema.parse(job);
    const existing = await this.listWorkJobs(parsed.issueRef);
    await this.updateMetadata(bead.id, {
      "workflow.jobs_json": JSON.stringify(upsertById(existing, parsed)),
      [`workflow.jobs.${normalizeKey(parsed.workType)}.${normalizeKey(parsed.repoKey)}.status`]: parsed.status,
      [`workflow.jobs.${normalizeKey(parsed.workType)}.${normalizeKey(parsed.repoKey)}.updated_at`]: parsed.updatedAt,
    });
  }

  async listWorkJobResults(issueRef: string): Promise<WorkJobResult[]> {
    const bead = await this.findBead(issueRef);
    if (!bead) return [];
    const metadata = bead.metadata ?? {};
    const raw = metadata["workflow.job_results_json"];
    if (typeof raw !== "string" || !raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    return workJobResultSchema.array().parse(parsed);
  }

  async recordWorkJobResult(result: WorkJobResult): Promise<void> {
    const bead = await this.findBead(result.issueRef);
    if (!bead) {
      throw new Error(`No Beads issue is bound to ${result.issueRef}.`);
    }
    const parsed = workJobResultSchema.parse(result);
    const existing = await this.listWorkJobResults(parsed.issueRef);
    await this.updateMetadata(bead.id, {
      "workflow.job_results_json": JSON.stringify(upsertByJobId(existing, parsed)),
      [`workflow.jobs.${normalizeKey(parsed.workType)}.${normalizeKey(parsed.repoKey)}.result_status`]: parsed.status,
      [`workflow.jobs.${normalizeKey(parsed.workType)}.${normalizeKey(parsed.repoKey)}.result_updated_at`]: parsed.completedAt,
    });
  }

  private async findBead(ref: string): Promise<BeadJson | undefined> {
    const output = await this.runJson(["--readonly", "list", "--json"]);
    if (!Array.isArray(output)) return undefined;
    return output.map(parseBead).find((bead) => {
      const jiraKey = bead.metadata["workflow.jira_key"];
      return jiraKey === ref || bead.external_ref === `jira-${ref}` || bead.title.includes(ref);
    });
  }

  private async updateMetadata(beadId: string, metadata: Record<string, unknown>): Promise<void> {
    const args = ["update", beadId];
    for (const [key, value] of Object.entries(metadata)) {
      args.push("--set-metadata", `${key}=${formatMetadataValue(value)}`);
    }
    await withRetry(async () => {
      await withPerfLog(`bd update ${beadId} metadata_keys=${Object.keys(metadata).length}`, () =>
        execFileAsync("bd", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }).then(() => undefined)
      );
    });
  }

  private async updateIssueFields(beadId: string, issue: WorkItem): Promise<void> {
    await withRetry(async () => {
      await withPerfLog(`bd update ${beadId} fields`, () =>
        execFileAsync("bd", beadUpdateArgsForIssue(beadId, issue), { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }).then(() => undefined)
      );
    });
  }

  private async createBead(issue: WorkItem): Promise<BeadJson> {
    const metadata = workItemToBeadsMetadata(issue);
    const args = [
      "create",
      "--json",
      "--title",
      issue.title || issue.ref,
      "--description",
      issue.summary ?? "",
      "--external-ref",
      `jira-${issue.ref}`,
      "--labels",
      "flow,jira",
      "--metadata",
      JSON.stringify(metadata),
    ];
    const output = await withRetry(async () => {
      const { stdout } = await withPerfLog("bd create", () =>
        execFileAsync("bd", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 })
      );
      return JSON.parse(stdout) as unknown;
    });
    const bead = parseCreatedBead(output);
    if (bead) return bead;
    const found = await this.findBead(issue.ref);
    if (found) return found;
    throw new Error(`Created Beads issue for ${issue.ref}, but could not read it back.`);
  }

  private async runJson(args: string[]): Promise<unknown> {
    const { stdout } = await withPerfLog(`bd ${safeCommandArgs(args)}`, () =>
      execFileAsync("bd", args, { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024 })
    );
    return JSON.parse(stdout);
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
  const thresholdMs = Number(process.env.FLOW_PERF_CLI_THRESHOLD_MS ?? defaultThresholdMs);
  return process.env.FLOW_PERF_LOG === "1" || durationMs >= thresholdMs;
}

function safeCommandArgs(args: string[]): string {
  return args.map((arg) => (arg.startsWith("{") || arg.includes("\n") || arg.length > 80 ? "<redacted>" : arg)).join(" ");
}

export function beadUpdateArgsForIssue(beadId: string, issue: Pick<WorkItem, "title" | "summary">): string[] {
  const args = ["update", beadId, "--title", issue.title];
  if (issue.summary !== undefined) {
    args.push("--description", issue.summary, "--allow-empty-description");
  }
  return args;
}

interface BeadJson {
  id: string;
  title: string;
  description?: string;
  status?: string;
  updated_at?: string;
  external_ref?: string;
  metadata: Record<string, unknown>;
}

function parseBead(value: unknown): BeadJson {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Beads JSON item.");
  }
  const record = value as Record<string, unknown>;
  return {
    id: String(record.id),
    title: String(record.title ?? ""),
    description: typeof record.description === "string" ? record.description : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : undefined,
    external_ref: typeof record.external_ref === "string" ? record.external_ref : undefined,
    metadata: isRecord(record.metadata) ? record.metadata : {},
  };
}

function parseCreatedBead(value: unknown): BeadJson | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidates = [
    value,
    record.issue,
    record.bead,
    record.item,
    record.data,
  ];
  const candidate = candidates.find((item): item is Record<string, unknown> =>
    isRecord(item) && typeof item.id === "string"
  );
  return candidate ? parseBead(candidate) : undefined;
}

function beadToWorkItem(bead: BeadJson): WorkItem {
  const ref = String(bead.metadata["workflow.jira_key"] ?? extractIssueRef(bead.title) ?? bead.id);
  const phase = String(bead.metadata["workflow.phase"] ?? "");
  const metadata = normalizeWorkflowMetadata(bead.metadata);
  return workItemSchema.parse({
    ref,
    title: bead.title,
    repoKeys: routedRepos(metadata),
    state: phaseToState(phase, bead.status),
    summary: bead.description,
    updatedAt: bead.updated_at ? new Date(bead.updated_at).toISOString() : undefined,
    metadata,
  });
}

export function workItemToBeadsMetadata(issue: WorkItem): Record<string, unknown> {
  const primaryRepoKey = issue.repoKeys[0];
  const branch = primaryRepoKey ? issue.metadata[`workflow.repos.${primaryRepoKey}.branch`] : issue.metadata.branch;
  const worktreePath = primaryRepoKey
    ? issue.metadata[`workflow.repos.${primaryRepoKey}.worktree_path`]
    : (issue.metadata.work_dir ?? issue.metadata.worktree_path);
  return {
    ...repoWorkflowMetadata(issue.metadata),
    "workflow.jira_key": issue.ref,
    "workflow.phase": stateToPhase(issue.state),
    "workflow.ready_for_review": issue.state === "awaiting_review",
    "workflow.routed_repos": JSON.stringify(issue.repoKeys),
    "workflow.repo": primaryRepoKey ?? issue.metadata["workflow.repo"] ?? "",
    branchKind: issue.metadata.branchKind ?? "",
    jiraIssueType: issue.metadata.jiraIssueType ?? "",
    "workflow.autoflow.attempts": issue.metadata["workflow.autoflow.attempts"] ?? "",
    "workflow.autoflow.last_attempted_at": issue.metadata["workflow.autoflow.last_attempted_at"] ?? "",
    "workflow.autoflow.current_action": issue.metadata["workflow.autoflow.current_action"] ?? "",
    "workflow.autoflow.current_action_started_at": issue.metadata["workflow.autoflow.current_action_started_at"] ?? "",
    branch: typeof branch === "string" ? branch : "",
    work_dir: typeof worktreePath === "string" ? worktreePath : "",
    worktree_path: typeof worktreePath === "string" ? worktreePath : "",
    "workflow.pi.updated_at": nowIso(),
    "workflow.pi.evidence_recorded": issue.metadata.evidenceRecorded === true,
    "workflow.pi.evidence_summary": issue.metadata.evidenceSummary ?? "",
    "workflow.pi.evidence_source": issue.metadata.evidenceSource ?? "",
    "workflow.pi.evidence_criteria": issue.metadata.evidenceCriteria
      ? JSON.stringify(issue.metadata.evidenceCriteria)
      : "",
    "workflow.acceptance.jira_written": issue.metadata["workflow.acceptance.jira_written"] === true,
    "workflow.acceptance.jira_comment_url": issue.metadata["workflow.acceptance.jira_comment_url"] ?? "",
    "workflow.acceptance.jira_payload_hash": issue.metadata["workflow.acceptance.jira_payload_hash"] ?? "",
    "workflow.acceptance.jira_written_at": issue.metadata["workflow.acceptance.jira_written_at"] ?? "",
    "workflow.pi.external_provider_escalation": issue.metadata.externalProviderEscalation
      ? JSON.stringify(issue.metadata.externalProviderEscalation)
      : "",
    "workflow.pi.documentation_recorded": issue.metadata.documentationRecorded === true,
    "workflow.pi.documentation_disposition": issue.metadata.documentationDisposition ?? "",
    "workflow.pi.documentation_summary": issue.metadata.documentationSummary ?? "",
    "workflow.pi.pr_repo": issue.metadata.prRepo ?? "",
    "workflow.pi.pr_number": issue.metadata.prNumber ?? "",
    "workflow.pi.pr_url": issue.metadata.prUrl ?? "",
    "workflow.pi.pr_is_draft": issue.metadata.prIsDraft === true,
    "workflow.pi.pr_auto_review_status": issue.metadata.prAutoReviewStatus ?? "",
    "workflow.pi.pr_auto_review_must_fix": issue.metadata.prAutoReviewMustFix === true,
    "workflow.pi.pr_auto_review_must_fix_detail": issue.metadata.prAutoReviewMustFixDetail ?? "",
    "workflow.pi.pr_auto_review_needs_confirmation": issue.metadata.prAutoReviewNeedsConfirmation === true,
    "workflow.pi.pr_auto_review_needs_confirmation_detail": issue.metadata.prAutoReviewNeedsConfirmationDetail ?? "",
    "workflow.pi.pr_auto_review_needs_confirmation_disposition": issue.metadata.prAutoReviewNeedsConfirmationDisposition ?? "",
    "workflow.pi.pr_auto_review_needs_confirmation_posted_url": issue.metadata.prAutoReviewNeedsConfirmationPostedUrl ?? "",
    "workflow.pi.pr_mergeable": issue.metadata.prMergeable ?? "",
    "workflow.pi.pr_merge_state_status": issue.metadata.prMergeStateStatus ?? "",
    "workflow.pi.pr_template_missing_headings": formatTemplateMissingHeadings(issue.metadata.prTemplateMissingHeadings),
    "workflow.pi.pr_checks_passing": issue.metadata.prChecksPassing === undefined ? "" : issue.metadata.prChecksPassing === true,
  };
}

function repoWorkflowMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key.startsWith("workflow.repos.")),
  );
}

function routedRepos(metadata: Record<string, unknown>): string[] {
  const raw = metadata["workflow.routed_repos"];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return raw.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  const repo = metadata["workflow.repo"];
  return typeof repo === "string" && repo ? [repo] : [];
}

function phaseToState(phase: string, beadStatus?: string): WorkItem["state"] {
  if (beadStatus === "closed") return "done";
  if (phase === "ready_for_review") return "awaiting_review";
  if (phase === "done") return "done";
  if (phase === "implementation") return "ready_to_run";
  if (phase === "blocked") return "blocked";
  return "queued";
}

function stateToPhase(state: WorkItem["state"]): string {
  if (state === "awaiting_review" || state === "awaiting_human") return "ready_for_review";
  if (state === "done") return "done";
  if (state === "blocked") return "blocked";
  if (state === "running" || state === "ready_to_run" || state === "selected") return "implementation";
  return "triage";
}

function extractIssueRef(value: string): string | undefined {
  return /\b[A-Z]+-\d+\b/.exec(value)?.[0];
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseJsonMetadata(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseStringArrayMetadata(value: unknown): string[] | undefined {
  const parsed = parseJsonMetadata(value);
  if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return undefined;
}

function formatTemplateMissingHeadings(value: unknown): string {
  if (Array.isArray(value)) return value.length ? JSON.stringify(value.map(String).filter(Boolean)) : "";
  return typeof value === "string" ? value : "";
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

function normalizeWorkflowMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const repoKeys = routedRepos(metadata);
  const primaryRepoKey = repoKeys[0];
  const derivedBranch = typeof metadata.branch === "string" && metadata.branch
    ? metadata.branch
    : (typeof primaryRepoKey === "string" ? metadata[`workflow.repos.${primaryRepoKey}.branch`] : undefined);
  const derivedWorktreePath = typeof metadata.work_dir === "string" && metadata.work_dir
    ? metadata.work_dir
    : (typeof metadata.worktree_path === "string" && metadata.worktree_path
      ? metadata.worktree_path
      : (typeof primaryRepoKey === "string" ? metadata[`workflow.repos.${primaryRepoKey}.worktree_path`] : undefined));
  return {
    ...metadata,
    branch: derivedBranch,
    work_dir: derivedWorktreePath,
    worktree_path: derivedWorktreePath,
    evidenceRecorded: truthyMetadata(metadata["workflow.pi.evidence_recorded"]),
    evidenceSummary: metadata["workflow.pi.evidence_summary"],
    evidenceSource: metadata["workflow.pi.evidence_source"],
    evidenceCriteria: parseJsonMetadata(metadata["workflow.pi.evidence_criteria"]),
    "workflow.acceptance.jira_written": truthyMetadata(metadata["workflow.acceptance.jira_written"]),
    "workflow.acceptance.jira_comment_url": metadata["workflow.acceptance.jira_comment_url"],
    "workflow.acceptance.jira_payload_hash": metadata["workflow.acceptance.jira_payload_hash"],
    "workflow.acceptance.jira_written_at": metadata["workflow.acceptance.jira_written_at"],
    externalProviderEscalation: parseJsonMetadata(metadata["workflow.pi.external_provider_escalation"]),
    documentationRecorded: truthyMetadata(metadata["workflow.pi.documentation_recorded"]),
    documentationDisposition: metadata["workflow.pi.documentation_disposition"],
    documentationSummary: metadata["workflow.pi.documentation_summary"],
    prRepo: metadata["workflow.pi.pr_repo"],
    prNumber: metadata["workflow.pi.pr_number"],
    prUrl: metadata["workflow.pi.pr_url"],
    prIsDraft: truthyMetadata(metadata["workflow.pi.pr_is_draft"]),
    prAutoReviewStatus: metadata["workflow.pi.pr_auto_review_status"],
    prAutoReviewMustFix: truthyMetadata(metadata["workflow.pi.pr_auto_review_must_fix"]),
    prAutoReviewMustFixDetail: metadata["workflow.pi.pr_auto_review_must_fix_detail"],
    prAutoReviewNeedsConfirmation: truthyMetadata(metadata["workflow.pi.pr_auto_review_needs_confirmation"]),
    prAutoReviewNeedsConfirmationDetail: metadata["workflow.pi.pr_auto_review_needs_confirmation_detail"],
    prAutoReviewNeedsConfirmationDisposition: metadata["workflow.pi.pr_auto_review_needs_confirmation_disposition"],
    prAutoReviewNeedsConfirmationPostedUrl: metadata["workflow.pi.pr_auto_review_needs_confirmation_posted_url"],
    prMergeable: metadata["workflow.pi.pr_mergeable"],
    prMergeStateStatus: metadata["workflow.pi.pr_merge_state_status"],
    prTemplateMissingHeadings: parseStringArrayMetadata(metadata["workflow.pi.pr_template_missing_headings"]),
    prChecksPassing: metadata["workflow.pi.pr_checks_passing"] === "" ? undefined : truthyMetadata(metadata["workflow.pi.pr_checks_passing"]),
  };
}

function truthyMetadata(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function disabledMetadata(value: unknown): boolean {
  if (value === false || value === 0) return true;
  if (typeof value !== "string") return false;
  return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableBeadsError(error) || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError;
}

function isRetryableBeadsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const message = typeof record.message === "string" ? record.message : "";
  return /serialization failure|transaction conflicts|try restarting transaction|database is locked/i.test(`${stderr}\n${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
