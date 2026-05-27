import { z } from "zod";
import { nowIso } from "./common.js";

export const flowContextKindValues = ["thread", "prompt", "session", "artifact"] as const;
export const flowContextTargetValues = ["project", "issue", "thread", "session", "artifact"] as const;
export const flowThreadStatusValues = ["active", "paused", "done", "archived"] as const;
export const flowSessionStatusValues = ["active", "paused", "done", "failed"] as const;
export const flowArtifactTypeValues = ["diff", "html", "dashboard", "document", "test_output", "design", "file", "other"] as const;

export const flowContextTargetSchema = z.enum(flowContextTargetValues);
export type FlowContextTarget = z.infer<typeof flowContextTargetSchema>;

export const flowThreadStatusSchema = z.enum(flowThreadStatusValues);
export type FlowThreadStatus = z.infer<typeof flowThreadStatusSchema>;

export const flowSessionStatusSchema = z.enum(flowSessionStatusValues);
export type FlowSessionStatus = z.infer<typeof flowSessionStatusSchema>;

export const flowArtifactTypeSchema = z.enum(flowArtifactTypeValues);
export type FlowArtifactType = z.infer<typeof flowArtifactTypeSchema>;

const flowContextBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  issueRef: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  artifactRefs: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1).optional(),
  createdAt: z.string().datetime().default(() => nowIso()),
  updatedAt: z.string().datetime().default(() => nowIso()),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const flowThreadContextRecordSchema = flowContextBaseSchema.extend({
  kind: z.literal("thread"),
  title: z.string().min(1),
  status: flowThreadStatusSchema.default("active"),
});
export type FlowThreadContextRecord = z.infer<typeof flowThreadContextRecordSchema>;

export const flowPromptContextRecordSchema = flowContextBaseSchema.extend({
  kind: z.literal("prompt"),
  prompt: z.string().min(1),
  target: flowContextTargetSchema.default("project"),
});
export type FlowPromptContextRecord = z.infer<typeof flowPromptContextRecordSchema>;

export const flowSessionContextRecordSchema = flowContextBaseSchema.extend({
  kind: z.literal("session"),
  provider: z.string().min(1).default("local"),
  externalSessionId: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  status: flowSessionStatusSchema.default("active"),
});
export type FlowSessionContextRecord = z.infer<typeof flowSessionContextRecordSchema>;

export const flowArtifactContextRecordSchema = flowContextBaseSchema.extend({
  kind: z.literal("artifact"),
  artifactType: flowArtifactTypeSchema,
  title: z.string().min(1),
  uri: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional(),
});
export type FlowArtifactContextRecord = z.infer<typeof flowArtifactContextRecordSchema>;

export const flowContextRecordSchema = z.discriminatedUnion("kind", [
  flowThreadContextRecordSchema,
  flowPromptContextRecordSchema,
  flowSessionContextRecordSchema,
  flowArtifactContextRecordSchema,
]);
export type FlowContextRecord = z.infer<typeof flowContextRecordSchema>;
export type FlowContextRecordInput = z.input<typeof flowContextRecordSchema>;

export const flowContextScopeSchema = z.object({
  projectId: z.string().min(1).optional(),
  issueRef: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  artifactId: z.string().min(1).optional(),
}).default({});
export type FlowContextScope = z.infer<typeof flowContextScopeSchema>;

export const flowActiveContextSchema = z.object({
  projectId: z.string().min(1).optional(),
  issueRef: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  artifactId: z.string().min(1).optional(),
  updatedAt: z.string().datetime().optional(),
});
export type FlowActiveContext = z.infer<typeof flowActiveContextSchema>;

export const flowContextProjectionSchema = z.object({
  active: flowActiveContextSchema,
  prompts: z.array(flowPromptContextRecordSchema),
  threads: z.array(flowThreadContextRecordSchema),
  sessions: z.array(flowSessionContextRecordSchema),
  artifacts: z.array(flowArtifactContextRecordSchema),
  updatedAt: z.string().datetime(),
});
export type FlowContextProjection = z.infer<typeof flowContextProjectionSchema>;
