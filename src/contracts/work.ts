import { z } from "zod";
import { LifecycleStatusValue, workerTaskResultSchema } from "./executor.js";

export const IssueStateValue = {
  Queued: LifecycleStatusValue.Queued,
  Selected: "selected",
  ReadyToRun: "ready_to_run",
  Running: LifecycleStatusValue.Running,
  Blocked: LifecycleStatusValue.Blocked,
  AwaitingReview: "awaiting_review",
  AwaitingHuman: "awaiting_human",
  Done: "done",
} as const;

export const ExecutionModeValue = {
  LocalThread: "local_thread",
  Background: "background",
} as const;

export const WorkJobStatusValue = {
  Queued: LifecycleStatusValue.Queued,
  Claimed: "claimed",
  Running: LifecycleStatusValue.Running,
  Succeeded: LifecycleStatusValue.Succeeded,
  Blocked: LifecycleStatusValue.Blocked,
  Failed: LifecycleStatusValue.Failed,
  Cancelled: "cancelled",
} as const;

export const WorkJobExecutorValue = {
  PiWorker: "pi_worker",
  LiveAgentThread: "live_agent_thread",
  CodexWorker: "codex_worker",
} as const;

export const issueStateValues = [
  IssueStateValue.Queued,
  IssueStateValue.Selected,
  IssueStateValue.ReadyToRun,
  IssueStateValue.Running,
  IssueStateValue.Blocked,
  IssueStateValue.AwaitingReview,
  IssueStateValue.AwaitingHuman,
  IssueStateValue.Done,
] as const;

export const executionModeValues = [
  ExecutionModeValue.LocalThread,
  ExecutionModeValue.Background,
] as const;

export const workJobStatusValues = [
  WorkJobStatusValue.Queued,
  WorkJobStatusValue.Claimed,
  WorkJobStatusValue.Running,
  WorkJobStatusValue.Succeeded,
  WorkJobStatusValue.Blocked,
  WorkJobStatusValue.Failed,
  WorkJobStatusValue.Cancelled,
] as const;

export const terminalWorkJobStatusValues = [
  WorkJobStatusValue.Succeeded,
  WorkJobStatusValue.Blocked,
  WorkJobStatusValue.Failed,
  WorkJobStatusValue.Cancelled,
] as const;

export const workJobExecutorValues = [
  WorkJobExecutorValue.PiWorker,
  WorkJobExecutorValue.LiveAgentThread,
  WorkJobExecutorValue.CodexWorker,
] as const;

export const issueStateSchema = z.enum(issueStateValues);
export type IssueState = z.infer<typeof issueStateSchema>;

export const executionModeSchema = z.enum(executionModeValues);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const workTypeSchema = z.string().min(1);
export type WorkType = string;

export const workTypeCategorySchema = z.enum(["prepare", "implement", "remediate", "verify", "custom"]);
export type WorkTypeCategory = z.infer<typeof workTypeCategorySchema>;

export const workJobStatusSchema = z.enum(workJobStatusValues);
export type WorkJobStatus = z.infer<typeof workJobStatusSchema>;

export const workJobExecutorSchema = z.enum(workJobExecutorValues);
export type WorkJobExecutor = z.infer<typeof workJobExecutorSchema>;

export const workEnvelopeSchema = z.object({
  workType: workTypeSchema,
  issueRef: z.string().min(1),
  repoKey: z.string().min(1),
  executionMode: executionModeSchema,
  idempotencyKey: z.string().min(1).optional(),
  parentJobId: z.string().min(1).optional(),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  body: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type WorkEnvelope = z.infer<typeof workEnvelopeSchema>;

export const workItemSchema = z.object({
  ref: z.string().min(1),
  title: z.string().min(1),
  repoKeys: z.array(z.string().min(1)).default([]),
  state: issueStateSchema.default(IssueStateValue.Queued),
  summary: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type WorkItem = z.infer<typeof workItemSchema>;

export const workJobSchema = z.object({
  id: z.string().min(1),
  issueRef: z.string().min(1),
  repoKey: z.string().min(1),
  workType: workTypeSchema,
  status: workJobStatusSchema,
  input: z.record(z.string(), z.unknown()).default({}),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  claimedBy: workJobExecutorSchema.optional(),
  parentJobId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  claimedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type WorkJob = z.infer<typeof workJobSchema>;

export const workJobResultSchema = z.object({
  jobId: z.string().min(1),
  issueRef: z.string().min(1),
  repoKey: z.string().min(1),
  workType: workTypeSchema,
  status: workJobStatusSchema,
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
  workerResult: workerTaskResultSchema.optional(),
  completedAt: z.string().datetime(),
});
export type WorkJobResult = z.infer<typeof workJobResultSchema>;
