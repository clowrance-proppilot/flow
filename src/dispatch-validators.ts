import { z } from "zod";
import {
  workItemSchema,
  workJobExecutorSchema,
  workJobResultSchema,
  type WorkItem,
  type WorkJobExecutor,
  type WorkJobResult,
  type CreateIssueOptions,
} from "./index.js";
import { JsonCliError } from "./json-cli.js";

export const createIssueOptionsSchema = z.object({
  projectKey: z.string().optional(),
  issueType: z.enum(["Bug", "Task", "Story"]).optional(),
  branchKind: z.enum(["bug", "feature"]).optional(),
  title: z.string().optional(),
  summary: z.string().min(1),
  description: z.string().optional(),
  repoKeys: z.array(z.string().min(1)).optional(),
  select: z.boolean().optional(),
  apply: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  review: z.boolean().optional(),
}).passthrough();

function validationError(method: string, field: string, issues: z.ZodIssue[]): JsonCliError {
  return new JsonCliError("BAD_FIELD", `Invalid ${field} in ${method}`, {
    manifestTarget: "runtime",
    details: {
      method,
      field,
      issues: issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
  });
}

export function requireWorkItem(value: unknown, method: string): WorkItem {
  const result = workItemSchema.safeParse(value);
  if (result.success) return result.data;
  throw validationError(method, "params.issue", result.error.issues);
}

export function requireCreateIssueOptions(value: unknown, method: string): CreateIssueOptions {
  const result = createIssueOptionsSchema.safeParse(value);
  if (result.success) return result.data as CreateIssueOptions;
  throw validationError(method, "params.options", result.error.issues);
}

export function requireWorkJobExecutor(value: unknown, method: string): WorkJobExecutor {
  const result = workJobExecutorSchema.safeParse(value);
  if (result.success) return result.data;
  throw validationError(method, "params.executor", result.error.issues);
}

export function requireWorkJobResult(value: unknown, method: string): WorkJobResult {
  const result = workJobResultSchema.safeParse(value);
  if (result.success) return result.data;
  throw validationError(method, "params.result", result.error.issues);
}
