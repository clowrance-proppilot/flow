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

export const dashboardRuntimeConfigSchema = serviceEndpointConfigSchema;

export const runtimeConfigSchema = z.object({
  stateDir: z.string().min(1).optional(),
  storeDir: z.string().min(1).optional(),
  eventLedgerPath: z.string().min(1).optional(),
  workflowLedgerPath: z.string().min(1).optional(),
  defaultSessionId: z.string().min(1).optional(),
  autoflowBlockedThreshold: z.number().int().positive().optional(),
  debug: z.boolean().optional(),
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
  if (config.topology.branchPattern && !config.topology.branchPattern.includes("{issueRef}")) {
    ctx.addIssue({
      code: "custom",
      path: ["topology", "branchPattern"],
      message: "topology.branchPattern must include {issueRef}.",
    });
  }

  if (config.topology.pullRequestUrlPattern) {
    if (!config.topology.pullRequestUrlPattern.includes("{repoName}")) {
      ctx.addIssue({
        code: "custom",
        path: ["topology", "pullRequestUrlPattern"],
        message: "topology.pullRequestUrlPattern must include {repoName}.",
      });
    }
    if (!config.topology.pullRequestUrlPattern.includes("{number}")) {
      ctx.addIssue({
        code: "custom",
        path: ["topology", "pullRequestUrlPattern"],
        message: "topology.pullRequestUrlPattern must include {number}.",
      });
    }
  }

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
    addOptionalStringFieldIssue(config.issueTracker, "activeQueueJql", ["issueTracker", "activeQueueJql"], ctx);
    addOptionalStringFieldIssue(config.issueTracker, "backlogQueueJql", ["issueTracker", "backlogQueueJql"], ctx);
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
    addOptionalStringArrayFieldIssue(config.issueTracker, "activeLabels", ["issueTracker", "activeLabels"], ctx);
    addOptionalStringArrayFieldIssue(config.issueTracker, "backlogLabels", ["issueTracker", "backlogLabels"], ctx);
  }
});

function addOptionalStringFieldIssue(
  config: Record<string, unknown> | undefined,
  key: string,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const value = config?.[key];
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `${path.join(".")} must be a non-empty string when provided.`,
    });
  }
}

function addOptionalStringArrayFieldIssue(
  config: Record<string, unknown> | undefined,
  key: string,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const value = config?.[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `${path.join(".")} must be an array of non-empty strings when provided.`,
    });
  }
}

export type AdapterSelectionConfig = z.infer<typeof adapterSelectionConfigSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type IssueInferenceRuleConfig = z.infer<typeof issueInferenceRuleConfigSchema>;
export type TopologyConfig = z.infer<typeof topologyConfigSchema>;
export type WorkTypeConfig = z.infer<typeof workTypeConfigSchema>;
export type ExecutorConfig = z.infer<typeof executorConfigSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type FlowConfig = z.infer<typeof flowConfigSchema>;
