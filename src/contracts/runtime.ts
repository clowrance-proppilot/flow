import { z } from "zod";
import { workerTaskResultSchema } from "./executor.js";
import { issueStateSchema } from "./work.js";

export const findingSeveritySchema = z.enum(["info", "warning", "blocker"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const readinessFindingSchema = z.object({
  id: z.string().min(1),
  severity: findingSeveritySchema,
  summary: z.string().min(1),
  detail: z.string().optional(),
  issueRef: z.string().min(1).optional(),
  source: z.string().min(1).default("readiness"),
  createdAt: z.string().datetime(),
});
export type ReadinessFinding = z.infer<typeof readinessFindingSchema>;

export const pendingConfirmationSchema = z.object({
  id: z.string().min(1),
  issueRef: z.string().min(1),
  action: z.enum(["prepare_workspace", "request_execution", "record_evidence", "handoff_review"]),
  summary: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type PendingConfirmation = z.infer<typeof pendingConfirmationSchema>;

export const workRuntimeEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  type: z.string().min(1),
  issueRef: z.string().min(1).optional(),
  message: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
});
export type WorkRuntimeEvent = z.infer<typeof workRuntimeEventSchema>;

export const workRuntimeSessionSchema = z.object({
  id: z.string().min(1),
  selectedIssueRef: z.string().min(1).optional(),
  selectedRepoKey: z.string().min(1).optional(),
  pendingConfirmation: pendingConfirmationSchema.optional(),
  findings: z.array(readinessFindingSchema).default([]),
  workerResults: z.array(workerTaskResultSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkRuntimeSession = z.infer<typeof workRuntimeSessionSchema>;

export const runtimeIssueProjectionSchema = z.object({
  ref: z.string().min(1),
  state: issueStateSchema,
});
export type RuntimeIssueProjection = z.infer<typeof runtimeIssueProjectionSchema>;
