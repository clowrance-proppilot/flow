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

export const serviceEndpointConfigSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  url: z.string().min(1).optional(),
}).catchall(z.unknown());

export const dashboardThemeConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  primary: z.string().min(1),
  primaryDark: z.string().min(1),
  primaryFg: z.string().min(1),
});

export const dashboardRuntimeConfigSchema = serviceEndpointConfigSchema.extend({
  themes: z.array(dashboardThemeConfigSchema).optional(),
  defaultThemeId: z.string().min(1).optional(),
  defaultMode: z.enum(["dark", "light"]).optional(),
});

export const runtimeConfigSchema = z.object({
  stateDir: z.string().min(1).optional(),
  storeDir: z.string().min(1).optional(),
  eventLedgerPath: z.string().min(1).optional(),
  workflowLedgerPath: z.string().min(1).optional(),
  defaultSessionId: z.string().min(1).optional(),
  workRuntime: serviceEndpointConfigSchema.optional(),
  dashboard: dashboardRuntimeConfigSchema.optional(),
}).catchall(z.unknown());

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
  runtime: runtimeConfigSchema.optional(),
  workTypes: z.array(workTypeConfigSchema).optional(),
  executors: z.array(executorConfigSchema).optional(),
}).superRefine((config, ctx) => {
  const trackerType = config.issueTracker?.type?.toString().trim().toLowerCase();
  if (!trackerType) return;

  if (trackerType === "jira") {
    const siteUrl = config.issueTracker?.siteUrl;
    const projectKey = config.issueTracker?.projectKey;
    if (typeof siteUrl !== "string" || !siteUrl.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["issueTracker", "siteUrl"],
        message: "issueTracker.siteUrl is required when issueTracker.type is jira.",
      });
    }
    if (typeof projectKey !== "string" || !projectKey.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["issueTracker", "projectKey"],
        message: "issueTracker.projectKey is required when issueTracker.type is jira.",
      });
    }
    return;
  }

  if (trackerType === "github" || trackerType === "github_issues") {
    const owner = config.issueTracker?.owner;
    const repo = config.issueTracker?.repo;
    if (typeof owner !== "string" || !owner.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["issueTracker", "owner"],
        message: "issueTracker.owner is required when issueTracker.type is github.",
      });
    }
    if (typeof repo !== "string" || !repo.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["issueTracker", "repo"],
        message: "issueTracker.repo is required when issueTracker.type is github.",
      });
    }
  }
});

export type AdapterSelectionConfig = z.infer<typeof adapterSelectionConfigSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type IssueInferenceRuleConfig = z.infer<typeof issueInferenceRuleConfigSchema>;
export type TopologyConfig = z.infer<typeof topologyConfigSchema>;
export type WorkTypeConfig = z.infer<typeof workTypeConfigSchema>;
export type ExecutorConfig = z.infer<typeof executorConfigSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type DashboardThemeConfig = z.infer<typeof dashboardThemeConfigSchema>;
export type FlowConfig = z.infer<typeof flowConfigSchema>;
