import { z } from "zod";
import { workTypeCategorySchema } from "../contracts.js";

export const adapterSelectionConfigSchema = z.object({
  type: z.string().min(1),
}).catchall(z.unknown());

export const repoConfigSchema = z.object({
  name: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  pathFromRoot: z.string().min(1).optional(),
});

export const issueInferenceRuleConfigSchema = z.object({
  repo: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
});

export const topologyConfigSchema = z.object({
  repos: z.record(z.string().min(1), repoConfigSchema).refine((repos) => Object.keys(repos).length > 0, {
    message: "At least one repo must be configured.",
  }),
  branchPattern: z.string().min(1).optional(),
  pullRequestUrlPattern: z.string().min(1).optional(),
  issueInference: z.array(issueInferenceRuleConfigSchema).default([]),
}).superRefine((topology, ctx) => {
  const repoKeys = new Set(Object.keys(topology.repos));
  for (const [index, rule] of topology.issueInference.entries()) {
    if (!repoKeys.has(rule.repo)) {
      ctx.addIssue({
        code: "custom",
        path: ["issueInference", index, "repo"],
        message: `Issue inference rule references unknown repo "${rule.repo}".`,
      });
    }
  }
});

export const workTypeConfigSchema = z.object({
  name: z.string().min(1),
  category: workTypeCategorySchema,
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  allowedExecutors: z.array(z.string().min(1)).default(["live_agent_thread"]),
  outputType: z.string().min(1).default("worker_result"),
});

export const executorConfigSchema = z.object({
  name: z.string().min(1),
  executionMode: z.enum(["local_thread", "background"]).default("local_thread"),
  capabilities: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),
});

export const flowConfigSchema = z.object({
  version: z.literal("1"),
  project: z.object({
    name: z.string().min(1),
  }),
  topology: topologyConfigSchema,
  issueTracker: adapterSelectionConfigSchema.optional(),
  collaboration: adapterSelectionConfigSchema.optional(),
  sourceControl: adapterSelectionConfigSchema.optional(),
  ledger: adapterSelectionConfigSchema.optional(),
  workTypes: z.array(workTypeConfigSchema).optional(),
  executors: z.array(executorConfigSchema).optional(),
});

export type AdapterSelectionConfig = z.infer<typeof adapterSelectionConfigSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type IssueInferenceRuleConfig = z.infer<typeof issueInferenceRuleConfigSchema>;
export type TopologyConfig = z.infer<typeof topologyConfigSchema>;
export type WorkTypeConfig = z.infer<typeof workTypeConfigSchema>;
export type ExecutorConfig = z.infer<typeof executorConfigSchema>;
export type FlowConfig = z.infer<typeof flowConfigSchema>;
