import { z } from "zod";

export const LifecycleStatusValue = {
  Queued: "queued",
  Running: "running",
  Succeeded: "succeeded",
  Blocked: "blocked",
  Failed: "failed",
} as const;

export const WorkerStatusValue = LifecycleStatusValue;

export const WorkerExecutorValue = {
  LiveAgentThread: "live_agent_thread",
} as const;

export const workerStatusValues = [
  LifecycleStatusValue.Queued,
  LifecycleStatusValue.Running,
  LifecycleStatusValue.Succeeded,
  LifecycleStatusValue.Blocked,
  LifecycleStatusValue.Failed,
] as const;

export const terminalWorkerStatusValues = [
  LifecycleStatusValue.Succeeded,
  LifecycleStatusValue.Blocked,
  LifecycleStatusValue.Failed,
] as const;

export const workerExecutorValues = [
  WorkerExecutorValue.LiveAgentThread,
] as const;

export const workerStatusSchema = z.enum(workerStatusValues);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export const workerExecutorSchema = z.enum(workerExecutorValues);
export type WorkerExecutor = z.infer<typeof workerExecutorSchema>;

export const workerTaskRequestSchema = z.object({
  id: z.string().min(1),
  issueRef: z.string().min(1),
  repoKey: z.string().min(1),
  workJobId: z.string().min(1).optional(),
  executor: workerExecutorSchema.optional(),
  prompt: z.string().min(1),
  workspacePath: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type WorkerTaskRequest = z.infer<typeof workerTaskRequestSchema>;

export const workerTaskResultSchema = z.object({
  taskId: z.string().min(1),
  issueRef: z.string().min(1),
  repoKey: z.string().min(1),
  workJobId: z.string().min(1).optional(),
  executor: workerExecutorSchema.optional(),
  status: workerStatusSchema,
  summary: z.string().min(1),
  changedFiles: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  nextPickup: z.string().optional(),
  handoffPrompt: z.string().optional(),
  evidenceCandidate: z.string().optional(),
  completedAt: z.string().datetime(),
});
export type WorkerTaskResult = z.infer<typeof workerTaskResultSchema>;

export const workerRunRecordSchema = z.object({
  taskId: z.string().min(1),
  issueRef: z.string().min(1),
  repoKey: z.string().min(1),
  workJobId: z.string().min(1).optional(),
  executor: workerExecutorSchema.optional(),
  status: workerStatusSchema,
  workspacePath: z.string().optional(),
  summary: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type WorkerRunRecord = z.infer<typeof workerRunRecordSchema>;
