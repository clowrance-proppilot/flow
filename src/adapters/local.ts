import type { WorkItem } from "../contracts.js";
import type { WorkflowLedger } from "../ledger.js";
import type {
  CodeCollaborationProvider,
  CollaborationCapabilities,
  CreateIssueInput,
  IssueTrackerCapabilities,
  IssueSearchParams,
  IssueTrackerProvider,
  UnifiedCodeReview,
  UnifiedIssue,
} from "./provider-contracts.js";

export interface LocalIssueTrackerOptions {
  ledger: WorkflowLedger;
  projectName?: string;
  prefix?: string;
}

export class LocalIssueTrackerAdapter implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    canCreateIssues: true,
    canTransitionIssues: true,
    canPostComments: true,
    canManageActivePlanningLane: false,
    canFetchOpenIssues: true,
    canSearchIssues: true,
    canTagIssues: true,
  };

  private readonly ledger: WorkflowLedger;
  private readonly prefix: string;

  constructor(options: LocalIssueTrackerOptions) {
    this.ledger = options.ledger;
    this.prefix = normalizeIssuePrefix(options.prefix ?? options.projectName ?? "LOCAL");
  }

  async getIssue(ref: string): Promise<UnifiedIssue> {
    const issue = await this.ledger.readIssue(normalizeIssueRef(ref));
    if (!issue) throw new Error(`Local issue ${ref} was not found in the Flow ledger.`);
    return unifiedIssueFromWorkItem(issue);
  }

  async fetchActiveQueue(limit = 10): Promise<UnifiedIssue[]> {
    const issues = await this.ledger.listIssues(limit);
    return issues
      .filter((issue) => issue.state !== "done")
      .map(unifiedIssueFromWorkItem);
  }

  async fetchBacklogQueue(limit = 10): Promise<UnifiedIssue[]> {
    return this.fetchActiveQueue(limit);
  }

  async fetchOpenIssues(limit = 100): Promise<UnifiedIssue[]> {
    const issues = await this.ledger.listIssues(limit);
    return issues
      .filter((issue) => issue.state !== "done")
      .map(unifiedIssueFromWorkItem);
  }

  async searchIssues(params: IssueSearchParams): Promise<UnifiedIssue[]> {
    const limit = params.limit ?? 10;
    const allIssues = await this.ledger.listIssues(limit * 5);
    const query = (params.title || params.summary || "").toLowerCase();
    
    const filtered = allIssues.filter((issue) => {
      if (params.state) {
        const normalizedState = params.state.toLowerCase();
        if (normalizedState === "open" || normalizedState === "todo") {
          if (issue.state === "done") return false;
        } else if (normalizedState === "closed" || normalizedState === "done") {
          if (issue.state !== "done") return false;
        }
      } else {
        if (issue.state === "done") return false;
      }
      
      if (query) {
        const title = issue.title.toLowerCase();
        const summary = (issue.summary || "").toLowerCase();
        if (!title.includes(query) && !summary.includes(query)) return false;
      }
      
      return true;
    });
    
    return filtered.slice(0, limit).map(unifiedIssueFromWorkItem);
  }

  async createIssue(input: CreateIssueInput): Promise<UnifiedIssue> {
    const ref = await this.nextIssueRef();
    return {
      ref,
      title: input.title?.trim() || input.summary,
      description: input.description,
      status: "To Do",
      statusCategory: "To Do",
      type: input.issueType,
      url: localIssueUrl(ref),
      updatedAt: new Date().toISOString(),
      labels: [],
      raw: { provider: "local" },
    };
  }

  async transitionIssue(ref: string, targetStatus: string): Promise<UnifiedIssue> {
    const issue = await this.ledger.readIssue(normalizeIssueRef(ref));
    if (!issue) throw new Error(`Local issue ${ref} was not found in the Flow ledger.`);
    const status = normalizeLocalStatus(targetStatus);
    const updated = await this.ledger.writeIssue({
      ...issue,
      state: status.state,
      metadata: {
        ...issue.metadata,
        localStatus: status.status,
        localStatusCategory: status.statusCategory,
      },
    });
    return unifiedIssueFromWorkItem(updated);
  }

  async postComment(ref: string, body: string): Promise<{ url?: string; body: string }> {
    const issue = await this.ledger.readIssue(normalizeIssueRef(ref));
    if (!issue) throw new Error(`Local issue ${ref} was not found in the Flow ledger.`);
    const comments = Array.isArray(issue.metadata.localComments) ? issue.metadata.localComments : [];
    await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        localComments: [...comments, { body, createdAt: new Date().toISOString() }],
      },
    });
    return { url: localIssueUrl(issue.ref), body };
  }

  async addIssueTags(ref: string, tags: string[]): Promise<UnifiedIssue> {
    const issue = await this.ledger.readIssue(normalizeIssueRef(ref));
    if (!issue) throw new Error(`Local issue ${ref} was not found in the Flow ledger.`);
    const existing = arrayMetadata(issue, "issueLabels");
    const merged = [...new Set([...existing, ...tags.map((tag) => tag.trim()).filter(Boolean)])];
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        issueLabels: merged,
      },
    });
    return unifiedIssueFromWorkItem(updated);
  }

  async removeIssueTags(ref: string, tags: string[]): Promise<UnifiedIssue> {
    const issue = await this.ledger.readIssue(normalizeIssueRef(ref));
    if (!issue) throw new Error(`Local issue ${ref} was not found in the Flow ledger.`);
    const removals = new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
    const updatedLabels = arrayMetadata(issue, "issueLabels").filter((tag) => !removals.has(tag.toLowerCase()));
    const updated = await this.ledger.writeIssue({
      ...issue,
      metadata: {
        ...issue.metadata,
        issueLabels: updatedLabels,
      },
    });
    return unifiedIssueFromWorkItem(updated);
  }

  private async nextIssueRef(): Promise<string> {
    const issues = await this.ledger.listIssues(1000);
    const next = issues.reduce((max, issue) => {
      const match = new RegExp(`^${escapeRegExp(this.prefix)}-(\\d+)$`, "i").exec(issue.ref);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    return `${this.prefix}-${next}`;
  }
}

export class NoopCodeCollaborationAdapter implements CodeCollaborationProvider {
  readonly capabilities: CollaborationCapabilities = {
    requiresCodeReview: false,
    canMarkReady: false,
    canPostComments: false,
    canMerge: false,
  };

  async findCodeReviews(_repo: string, _branchName?: string): Promise<UnifiedCodeReview[]> {
    return [];
  }
}

function unifiedIssueFromWorkItem(issue: WorkItem): UnifiedIssue {
  return {
    ref: issue.ref,
    title: issue.title,
    description: issue.summary,
    status: stringMetadata(issue, "issueStatus") ?? stringMetadata(issue, "localStatus") ?? stringMetadata(issue, "jiraStatus") ?? issue.state,
    statusCategory: stringMetadata(issue, "issueStatusCategory") ??
      stringMetadata(issue, "localStatusCategory") ??
      stringMetadata(issue, "jiraStatusCategory") ??
      issue.state,
    resolution: stringMetadata(issue, "issueResolution") ?? stringMetadata(issue, "jiraResolution"),
    type: stringMetadata(issue, "issueType") ?? stringMetadata(issue, "jiraIssueType") ?? "Task",
    url: stringMetadata(issue, "issueUrl") ?? stringMetadata(issue, "localUrl") ?? stringMetadata(issue, "jiraUrl") ?? localIssueUrl(issue.ref),
    updatedAt: issue.updatedAt,
    labels: arrayMetadata(issue, "issueLabels").length ? arrayMetadata(issue, "issueLabels") : arrayMetadata(issue, "jiraLabels"),
    raw: issue,
  };
}

function normalizeLocalStatus(targetStatus: string): { status: string; statusCategory: string; state: WorkItem["state"] } {
  const normalized = targetStatus.trim().toLowerCase();
  if (["done", "closed", "complete", "completed", "resolved"].includes(normalized)) {
    return { status: "Done", statusCategory: "Complete", state: "done" };
  }
  if (["in progress", "working", "started", "running"].includes(normalized)) {
    return { status: "In Progress", statusCategory: "In Progress", state: "running" };
  }
  return { status: targetStatus.trim() || "To Do", statusCategory: "To Do", state: "queued" };
}

function normalizeIssuePrefix(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "LOCAL";
}

function normalizeIssueRef(ref: string): string {
  return ref.trim().toUpperCase();
}

function localIssueUrl(ref: string): string {
  return `flow://local/issues/${encodeURIComponent(ref)}`;
}

function stringMetadata(issue: WorkItem, key: string): string | undefined {
  const value = issue.metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function arrayMetadata(issue: WorkItem, key: string): string[] {
  const value = issue.metadata[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
