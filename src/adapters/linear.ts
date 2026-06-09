import type {
  IssueTrackerCapabilities,
  IssueSearchParams,
  IssueTrackerProvider,
  CreateIssueInput,
  UnifiedIssue,
} from "./provider-contracts.js";
import { ProviderAdapterError } from "./provider-errors.js";

export interface LinearAdapterOptions {
  apiKey: string;
  teamId: string;
  workspaceUrl?: string;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: { name: string; type: string };
  url: string;
  updatedAt: string;
  labels: { nodes: Array<{ name: string }> };
  assignee?: { name: string };
}

interface LinearGraphqlResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  state { name type }
  url
  updatedAt
  labels { nodes { name } }
  assignee { name }
`;

const STATUS_CATEGORY_MAP: Record<string, { status: string; statusCategory: string }> = {
  completed: { status: "Done", statusCategory: "Complete" },
  canceled: { status: "Canceled", statusCategory: "Complete" },
  started: { status: "In Progress", statusCategory: "In Progress" },
  backlog: { status: "Backlog", statusCategory: "To Do" },
  unstarted: { status: "To Do", statusCategory: "To Do" },
};

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export class LinearIssueTrackerAdapter implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    canCreateIssues: true,
    canTransitionIssues: true,
    canPostComments: true,
    canManageActivePlanningLane: false,
    canFetchOpenIssues: true,
    canSearchIssues: true,
    canTagIssues: true,
  };

  private readonly apiKey: string;
  private readonly teamId: string;
  private readonly apiUrl: string;

  constructor(options: LinearAdapterOptions) {
    this.apiKey = options.apiKey;
    this.teamId = options.teamId;
    this.apiUrl = options.workspaceUrl
      ? options.workspaceUrl.replace(/\/+$/, "")
      : "https://api.linear.app";
  }

  async getIssue(ref: string): Promise<UnifiedIssue> {
    return withLinearErrorHandling("getIssue", async () => {
      const issue = await this.fetchIssueByIdentifier(ref);
      return this.normalizeIssue(issue);
    });
  }

  async fetchActiveQueue(limit = 10): Promise<UnifiedIssue[]> {
    return withLinearErrorHandling("fetchActiveQueue", async () => {
      const data = await this.graphql<{
        issues: { nodes: LinearIssueNode[] };
      }>(
        `query($teamId: String!, $first: Int!) {
          issues(
            filter: {
              team: { id: { eq: $teamId } }
              state: { type: { nin: ["completed", "canceled"] } }
            }
            first: $first
            order: { updatedAt: { direction: DESC } }
          ) {
            nodes { ${ISSUE_FRAGMENT} }
          }
        }`,
        { teamId: this.teamId, first: limit },
      );
      return (data.issues?.nodes ?? []).map((node) => this.normalizeIssue(node));
    });
  }

  async fetchBacklogQueue(limit = 10): Promise<UnifiedIssue[]> {
    return withLinearErrorHandling("fetchBacklogQueue", async () => {
      const data = await this.graphql<{
        issues: { nodes: LinearIssueNode[] };
      }>(
        `query($teamId: String!, $first: Int!) {
          issues(
            filter: {
              team: { id: { eq: $teamId } }
              state: { type: { eq: "backlog" } }
            }
            first: $first
            order: { updatedAt: { direction: DESC } }
          ) {
            nodes { ${ISSUE_FRAGMENT} }
          }
        }`,
        { teamId: this.teamId, first: limit },
      );
      return (data.issues?.nodes ?? []).map((node) => this.normalizeIssue(node));
    });
  }

  async fetchOpenIssues(limit = 100): Promise<UnifiedIssue[]> {
    return withLinearErrorHandling("fetchOpenIssues", async () => {
      const data = await this.graphql<{
        issues: { nodes: LinearIssueNode[] };
      }>(
        `query($teamId: String!, $first: Int!) {
          issues(
            filter: {
              team: { id: { eq: $teamId } }
              state: { type: { nin: ["completed", "canceled"] } }
            }
            first: $first
            order: { updatedAt: { direction: DESC } }
          ) {
            nodes { ${ISSUE_FRAGMENT} }
          }
        }`,
        { teamId: this.teamId, first: limit },
      );
      return (data.issues?.nodes ?? []).map((node) => this.normalizeIssue(node));
    });
  }

  async searchIssues(params: IssueSearchParams): Promise<UnifiedIssue[]> {
    return withLinearErrorHandling("searchIssues", async () => {
      const limit = params.limit ?? 10;
      const query = params.title || params.summary || "";

      const filterParts: string[] = [`team: { id: { eq: "${this.teamId}" } }`];

      if (params.state) {
        const normalized = params.state.toLowerCase();
        if (normalized === "open" || normalized === "todo") {
          filterParts.push(`state: { type: { nin: ["completed", "canceled"] } }`);
        } else if (normalized === "closed" || normalized === "done") {
          filterParts.push(`state: { type: { in: ["completed", "canceled"] } }`);
        }
      } else {
        filterParts.push(`state: { type: { nin: ["completed", "canceled"] } }`);
      }

      if (query) {
        filterParts.push(`title: { contains: "${escapeGraphQLString(query)}" }`);
      }

      const filterStr = filterParts.join(", ");

      const data = await this.graphql<{
        issues: { nodes: LinearIssueNode[] };
      }>(
        `query($first: Int!) {
          issues(
            filter: { ${filterStr} }
            first: $first
            order: { updatedAt: { direction: DESC } }
          ) {
            nodes { ${ISSUE_FRAGMENT} }
          }
        }`,
        { first: limit },
      );
      return (data.issues?.nodes ?? []).map((node) => this.normalizeIssue(node));
    });
  }

  async createIssue(input: CreateIssueInput): Promise<UnifiedIssue> {
    return withLinearErrorHandling("createIssue", async () => {
      const title = input.title?.trim() || input.summary;
      const description = input.description ?? "";

      const data = await this.graphql<{
        issueCreate: { issue: LinearIssueNode };
      }>(
        `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            issue { ${ISSUE_FRAGMENT} }
          }
        }`,
        {
          input: {
            teamId: this.teamId,
            title,
            description,
          },
        },
      );

      const issue = data.issueCreate?.issue;
      if (!issue) {
        throw new Error("Linear issueCreate mutation returned no issue.");
      }
      return this.normalizeIssue(issue);
    });
  }

  async transitionIssue(ref: string, targetStatus: string): Promise<UnifiedIssue | void> {
    return withLinearErrorHandling("transitionIssue", async () => {
      const issue = await this.fetchIssueByIdentifier(ref);
      const stateId = await this.findStateId(targetStatus);

      await this.graphql(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }`,
        { id: issue.id, input: { stateId } },
      );

      return this.normalizeIssue(await this.fetchIssueByIdentifier(ref));
    });
  }

  async postComment(ref: string, body: string): Promise<{ url?: string; body: string }> {
    return withLinearErrorHandling("postComment", async () => {
      const issue = await this.fetchIssueByIdentifier(ref);

      const data = await this.graphql<{
        commentCreate: { comment: { url?: string } };
      }>(
        `mutation($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            comment { url }
          }
        }`,
        { input: { issueId: issue.id, body } },
      );

      return {
        url: data.commentCreate?.comment?.url,
        body,
      };
    });
  }

  async addIssueTags(ref: string, tags: string[]): Promise<UnifiedIssue | void> {
    return withLinearErrorHandling("addIssueTags", async () => {
      const issue = await this.fetchIssueByIdentifier(ref);
      const labelIds = await this.findOrCreateLabelIds(tags);

      if (labelIds.length === 0) return this.normalizeIssue(issue);

      const currentLabelIds = await this.getIssueLabelIds(issue.id);
      const mergedIds = [...new Set([...currentLabelIds, ...labelIds])];

      await this.graphql(
        `mutation($issueId: String!, $labelIds: [String!]!) {
          issueUpdate(
            id: $issueId
            input: { labelIds: $labelIds }
          ) {
            success
          }
        }`,
        { issueId: issue.id, labelIds: mergedIds },
      );

      return this.normalizeIssue(await this.fetchIssueByIdentifier(ref));
    });
  }

  async removeIssueTags(ref: string, tags: string[]): Promise<UnifiedIssue | void> {
    return withLinearErrorHandling("removeIssueTags", async () => {
      const issue = await this.fetchIssueByIdentifier(ref);
      const removals = new Set(tags.map((t) => t.trim().toLowerCase()));
      const currentLabelIds = await this.getIssueLabelIds(issue.id);
      const labelNamesById = await this.getLabelNameMap();

      const remainingIds = currentLabelIds.filter((id) => {
        const name = labelNamesById.get(id);
        return name ? !removals.has(name.toLowerCase()) : true;
      });

      await this.graphql(
        `mutation($issueId: String!, $labelIds: [String!]!) {
          issueUpdate(
            id: $issueId
            input: { labelIds: $labelIds }
          ) {
            success
          }
        }`,
        { issueId: issue.id, labelIds: remainingIds },
      );

      return this.normalizeIssue(await this.fetchIssueByIdentifier(ref));
    });
  }

  // --- Private helpers ---

  private async fetchIssueByIdentifier(identifier: string): Promise<LinearIssueNode> {
    const data = await this.graphql<{
      issues: { nodes: LinearIssueNode[] };
    }>(
      `query($teamId: String!, $identifier: String!) {
        issues(
          filter: {
            team: { id: { eq: $teamId } }
            identifier: { eq: $identifier }
          }
          first: 1
        ) {
          nodes { ${ISSUE_FRAGMENT} }
        }
      }`,
      { teamId: this.teamId, identifier },
    );

    const issue = data.issues?.nodes?.[0];
    if (!issue) {
      throw new Error(`Linear issue ${identifier} was not found in team ${this.teamId}.`);
    }
    return issue;
  }

  private async findStateId(targetStatus: string): Promise<string> {
    const normalized = targetStatus.trim().toLowerCase();

    let stateType: string | undefined;
    if (["done", "completed", "complete", "resolved"].includes(normalized)) {
      stateType = "completed";
    } else if (["canceled", "cancelled"].includes(normalized)) {
      stateType = "canceled";
    } else if (["in progress", "started", "active", "working"].includes(normalized)) {
      stateType = "started";
    } else if (["backlog"].includes(normalized)) {
      stateType = "backlog";
    } else if (["to do", "todo", "open"].includes(normalized)) {
      stateType = "unstarted";
    }

    const data = await this.graphql<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
    }>(
      `query($teamId: String!) {
        workflowStates(
          filter: { team: { id: { eq: $teamId } } }
        ) {
          nodes { id name type }
        }
      }`,
      { teamId: this.teamId },
    );

    const states = data.workflowStates?.nodes ?? [];

    if (stateType) {
      const match = states.find((s) => s.type.toLowerCase() === stateType);
      if (match) return match.id;
    }

    const exactMatch = states.find((s) => s.name.toLowerCase() === normalized);
    if (exactMatch) return exactMatch.id;

    throw new Error(
      `Linear workflow state "${targetStatus}" not found in team ${this.teamId}. Available states: ${states.map((s) => s.name).join(", ")}`,
    );
  }

  private async findOrCreateLabelIds(labelNames: string[]): Promise<string[]> {
    const normalizedNames = labelNames.map((n) => n.trim()).filter(Boolean);
    if (normalizedNames.length === 0) return [];

    const data = await this.graphql<{
      issueLabels: { nodes: Array<{ id: string; name: string }> };
    }>(
      `query($teamId: String!) {
        issueLabels(
          filter: { team: { id: { eq: $teamId } } }
          first: 250
        ) {
          nodes { id name }
        }
      }`,
      { teamId: this.teamId },
    );

    const existingLabels = data.issueLabels?.nodes ?? [];
    const nameToId = new Map(existingLabels.map((l) => [l.name.toLowerCase(), l.id]));

    const result: string[] = [];
    for (const name of normalizedNames) {
      const existingId = nameToId.get(name.toLowerCase());
      if (existingId) {
        result.push(existingId);
      } else {
        const created = await this.graphql<{
          issueLabelCreate: { issueLabel: { id: string } };
        }>(
          `mutation($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) {
              issueLabel { id }
            }
          }`,
          { input: { name, teamId: this.teamId } },
        );
        const newId = created.issueLabelCreate?.issueLabel?.id;
        if (newId) result.push(newId);
      }
    }
    return result;
  }

  private async getIssueLabelIds(issueId: string): Promise<string[]> {
    const data = await this.graphql<{
      issue: { labels: { nodes: Array<{ id: string }> } };
    }>(
      `query($issueId: String!) {
        issue(id: $issueId) {
          labels { nodes { id } }
        }
      }`,
      { issueId },
    );
    return (data.issue?.labels?.nodes ?? []).map((l) => l.id);
  }

  private async getLabelNameMap(): Promise<Map<string, string>> {
    const data = await this.graphql<{
      issueLabels: { nodes: Array<{ id: string; name: string }> };
    }>(
      `query($teamId: String!) {
        issueLabels(
          filter: { team: { id: { eq: $teamId } } }
          first: 250
        ) {
          nodes { id name }
        }
      }`,
      { teamId: this.teamId },
    );
    return new Map((data.issueLabels?.nodes ?? []).map((l) => [l.id, l.name]));
  }

  private normalizeIssue(node: LinearIssueNode): UnifiedIssue {
    const stateType = node.state.type.toLowerCase();
    const mapping = STATUS_CATEGORY_MAP[stateType] ?? {
      status: node.state.name,
      statusCategory: "To Do",
    };

    const labels = (node.labels?.nodes ?? []).map((l) => l.name);

    return {
      ref: node.identifier,
      title: node.title,
      description: node.description,
      status: mapping.status,
      statusCategory: mapping.statusCategory,
      resolution: stateType === "completed" ? "Done" : undefined,
      type: inferIssueType(labels),
      url: node.url,
      updatedAt: node.updatedAt,
      labels,
      assignee: node.assignee?.name,
      raw: node,
    };
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${this.apiUrl}/graphql`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: this.apiKey,
          },
          body: JSON.stringify({ query, variables }),
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const delayMs = retryAfter
            ? Number(retryAfter) * 1000
            : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await delay(delayMs);
          lastError = new Error(`Rate limited (HTTP 429)`);
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`Linear API HTTP ${response.status}: ${text.slice(0, 500)}`);
        }

        const body = (await response.json()) as LinearGraphqlResponse<T>;
        if (body.errors?.length) {
          throw new Error(`Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
        }
        if (!body.data) {
          throw new Error("Linear API returned no data.");
        }
        return body.data;
      } catch (error) {
        lastError = error;
        const errorText = String(error instanceof Error ? error.message : error).toLowerCase();
        if (
          errorText.includes("rate limit") ||
          errorText.includes("429") ||
          errorText.includes("too many requests")
        ) {
          const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await delay(delayMs);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Linear API request failed after retries.");
  }
}

// --- Exported utility functions ---

export function inferIssueType(labels: string[]): string {
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.some((l) => l.includes("bug"))) return "bug";
  if (lower.some((l) => l.includes("feature") || l.includes("story") || l.includes("enhancement"))) return "story";
  return "task";
}

export function escapeGraphQLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLinearErrorHandling<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    const errorText = String(error instanceof Error ? error.message : error).toLowerCase();
    const code =
      /auth|unauthorized|forbidden|401|403/.test(errorText)
        ? "auth_missing" as const
        : /rate.?limit|429|too many requests/.test(errorText)
          ? "rate_limited" as const
          : /network|econnreset|etimedout|enotfound|timeout/.test(errorText)
            ? "network" as const
            : "provider_failed" as const;
    throw new ProviderAdapterError({
      provider: "linear",
      operation,
      code,
      message: `Linear ${operation} failed (${code}): ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
}
