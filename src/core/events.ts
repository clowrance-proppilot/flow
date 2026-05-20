import { randomUUID } from "node:crypto";
import { z } from "zod";

export const flowPrimitiveSchema = z.enum([
  "observe",
  "issue",
  "claim",
  "record",
  "ask",
  "decide",
  "link",
  "handoff",
  "complete",
]);
export type FlowPrimitive = z.infer<typeof flowPrimitiveSchema>;

export const flowSubjectSchema = z.object({
  type: z.string().min(1),
  ref: z.string().min(1),
});
export type FlowSubject = z.infer<typeof flowSubjectSchema>;

export const flowActorSchema = z.object({
  type: z.enum(["human", "agent", "system", "adapter"]),
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
});
export type FlowActor = z.infer<typeof flowActorSchema>;

export const flowEventLinkSchema = z.object({
  type: z.string().min(1),
  target: flowSubjectSchema,
});
export type FlowEventLink = z.infer<typeof flowEventLinkSchema>;

export const flowEventSchema = z.object({
  id: z.string().min(1),
  primitive: flowPrimitiveSchema,
  subject: flowSubjectSchema,
  actor: flowActorSchema,
  timestamp: z.string().datetime(),
  input: z.unknown().optional(),
  result: z.unknown().optional(),
  links: z.array(flowEventLinkSchema).default([]),
  causationId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
});
export type FlowEvent = z.infer<typeof flowEventSchema>;

export const flowEventInputSchema = flowEventSchema
  .omit({ id: true, timestamp: true, links: true })
  .extend({
    id: z.string().min(1).optional(),
    timestamp: z.string().datetime().optional(),
    links: z.array(flowEventLinkSchema).optional(),
  });
export type FlowEventInput = z.infer<typeof flowEventInputSchema>;

export const flowEventQuerySchema = z.object({
  subject: flowSubjectSchema.optional(),
  primitive: flowPrimitiveSchema.optional(),
  actorId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
});
export type FlowEventQuery = z.infer<typeof flowEventQuerySchema>;

export function normalizeFlowEvent(input: FlowEvent | FlowEventInput): FlowEvent {
  return flowEventSchema.parse({
    ...input,
    id: "id" in input && input.id ? input.id : randomUUID(),
    timestamp: "timestamp" in input && input.timestamp ? input.timestamp : new Date().toISOString(),
    links: "links" in input && input.links ? input.links : [],
  });
}

export function sameSubject(left: FlowSubject, right: FlowSubject): boolean {
  return left.type === right.type && left.ref === right.ref;
}
