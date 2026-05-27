import type {
  FlowContextProjection,
  FlowContextRecord,
  FlowContextRecordInput,
  FlowContextScope,
  WorkItem,
  WorkJob,
  WorkJobResult,
  WorkerRunRecord,
  WorkerTaskResult,
} from "../contracts.js";

export interface WorkflowLedger {
  listIssues(limit?: number): Promise<WorkItem[]>;
  readIssue(ref: string): Promise<WorkItem | undefined>;
  readIssues?(refs: string[]): Promise<Map<string, WorkItem>>;
  ensureIssue(issue: WorkItem): Promise<WorkItem>;
  writeIssue(issue: WorkItem): Promise<WorkItem>;
  listWorkerRuns(issueRef: string): Promise<WorkerRunRecord[]>;
  recordWorkerRun(run: WorkerRunRecord): Promise<void>;
  listWorkerResults(issueRef: string): Promise<WorkerTaskResult[]>;
  recordWorkerResult(result: WorkerTaskResult): Promise<void>;
  listWorkJobs(issueRef: string): Promise<WorkJob[]>;
  recordWorkJob(job: WorkJob): Promise<void>;
  listWorkJobResults(issueRef: string): Promise<WorkJobResult[]>;
  recordWorkJobResult(result: WorkJobResult): Promise<void>;
  recordContext?(record: FlowContextRecordInput): Promise<FlowContextRecord>;
  readContext?(scope?: FlowContextScope): Promise<FlowContextProjection>;
}

export interface WorkflowLedgerMirror {
  mirrorIssue(action: "ensureIssue" | "writeIssue", issue: WorkItem): Promise<void>;
  mirrorWorkerRun(run: WorkerRunRecord): Promise<void>;
  mirrorWorkerResult(result: WorkerTaskResult): Promise<void>;
  mirrorWorkJob(job: WorkJob): Promise<void>;
  mirrorWorkJobResult(result: WorkJobResult): Promise<void>;
}
