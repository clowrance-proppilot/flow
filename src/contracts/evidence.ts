import { z } from "zod";

export const acceptanceCriterionEvidenceSchema = z.object({
  label: z.string().min(1),
  status: z.enum(["passed", "failed", "not_applicable"]).default("passed"),
  evidence: z.string().min(1),
  source: z.string().min(1).optional(),
});
export type AcceptanceCriterionEvidence = z.infer<typeof acceptanceCriterionEvidenceSchema>;

export const evidenceRecordSchema = z.object({
  issueRef: z.string().min(1),
  summary: z.string().min(1),
  source: z.string().min(1),
  criteria: z.array(acceptanceCriterionEvidenceSchema).default([]),
  recordedAt: z.string().datetime(),
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export const reviewConfirmationDispositionSchema = z.enum(["accept", "reject", "defer"]);
export type ReviewConfirmationDisposition = z.infer<typeof reviewConfirmationDispositionSchema>;

export const reviewConfirmationRecordSchema = z.object({
  issueRef: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  disposition: reviewConfirmationDispositionSchema,
  summary: z.string().min(1),
  evidence: z.string().min(1).optional(),
  verification: z.string().min(1).optional(),
  githubCommentUrl: z.string().url().optional(),
  recordedAt: z.string().datetime(),
});
export type ReviewConfirmationRecord = z.infer<typeof reviewConfirmationRecordSchema>;

export const providerEscalationRecordSchema = z.object({
  issueRef: z.string().min(1),
  provider: z.string().min(1),
  summary: z.string().min(1),
  blocker: z.string().min(1),
  supportUrl: z.string().url().optional(),
  recordedAt: z.string().datetime(),
});
export type ProviderEscalationRecord = z.infer<typeof providerEscalationRecordSchema>;

export const investigationDispositionSchema = z.enum([
  "needs_code_change",
  "provider_escalation",
  "needs_info",
  "not_actionable",
]);
export type InvestigationDisposition = z.infer<typeof investigationDispositionSchema>;

export const investigationRecordSchema = z.object({
  issueRef: z.string().min(1),
  disposition: investigationDispositionSchema,
  summary: z.string().min(1),
  findings: z.array(z.string().min(1)).default([]),
  nextAction: z.string().min(1).optional(),
  evidenceSource: z.string().min(1).optional(),
  recordedAt: z.string().datetime(),
});
export type InvestigationRecord = z.infer<typeof investigationRecordSchema>;

export const documentationRecordSchema = z.object({
  issueRef: z.string().min(1),
  disposition: z.enum(["not_needed", "updated", "needed"]),
  summary: z.string().min(1),
  recordedAt: z.string().datetime(),
});
export type DocumentationRecord = z.infer<typeof documentationRecordSchema>;
