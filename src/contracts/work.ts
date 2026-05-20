import { z } from "zod";
import { workerTaskResultSchema } from "./executor.js";

export const issueStateSchema = z.enum([
  "queued",
  "selected",
  "ready_to_run",
  "running",
  "blocked",
  "review_ready",
  "human_review",
  "done",
]);
export type IssueState = z.infer<typeof issueStateSchema>;

export const executionModeSchema = z.enum(["local_thread", "background"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const workTypeSchema = z.string().min(1);
export type WorkType = string;

export const workTypeCategorySchema = z.enum(["prepare", "implement", "remediate", "verify", "custom"]);
export type WorkTypeCategory = z.infer<typeof workTypeCategorySchema>;

export const workJobStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
]);
export type WorkJobStatus = z.infer<typeof workJobStatusSchema>;

export const workJobExecutorSchema = z.enum(["pi_worker", "live_agent_thread", "codex_worker"]);
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
  state: issueStateSchema.default("queued"),
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
