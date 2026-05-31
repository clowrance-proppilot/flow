import { IssueStateValue, type WorkItem } from "./contracts.js";

export interface CliIssueResolverRuntime {
  inspectQueue(limit: number): Promise<WorkItem[]>;
  inspectIssue(issueRef: string): Promise<WorkItem>;
}

export async function resolveCliIssue(
  runtime: CliIssueResolverRuntime,
  issueRef: string,
  matchesIssue: (issue: WorkItem, ref: string) => boolean = (issue, ref) => issue.ref.toUpperCase() === ref.toUpperCase(),
): Promise<WorkItem> {
  const issueKey = issueRef.toUpperCase();
  const queue = await runtime.inspectQueue(50);
  const issue = queue.find((candidate) => matchesIssue(candidate, issueRef));
  if (issue) return issue;
  try {
    return await runtime.inspectIssue(issueRef);
  } catch {
    // Keep local-only projects usable when the configured issue tracker cannot hydrate the ref.
  }
  return { ref: issueKey, title: issueKey, repoKeys: [], state: IssueStateValue.Queued, metadata: {} };
}
