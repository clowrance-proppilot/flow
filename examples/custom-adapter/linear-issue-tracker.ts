/**
 * Linear Issue Tracker Adapter Example
 *
 * Demonstrates how to create a custom IssueTrackerProvider
 * that integrates with Linear's API.
 */

import type {
  IssueTrackerProvider,
  IssueTrackerCapabilities,
  UnifiedIssue,
  CreateIssueInput,
} from "../../src/adapters/provider-contracts.js";
import { ProviderAdapterError } from "../../src/adapters/provider-errors.js";

export interface LinearAdapterOptions {
  apiKey: string;
  teamId: string;
  workspaceUrl?: string;
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: {
    name: string;
    type: string;
  };
  url: string;
  updatedAt: string;
  labels: Array<{ name: string }>;
  assignee?: {
    name: string;
  };
}

export class LinearIssueTrackerAdapter implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    canCreateIssues: true,
    canTransitionIssues: true,
    canPostComments: true,
    canManageActivePlanningLane: false,
  };

  private readonly apiKey: string;
  private readonly teamId: string;
  private readonly baseUrl: string;

  constructor(options: LinearAdapterOptions) {
    this.apiKey = options.apiKey;
    this.teamId = options.teamId;
    this.baseUrl = options.workspaceUrl ?? "https://api.linear.app";
  }

  async getIssue(ref: string): Promise<UnifiedIssue> {
    try {
      const issueId = this.extractIssueId(ref);
      const response = await this.graphql(`
        query {
          issue(id: "${issueId}") {
            id
            identifier
            title
            description
            state { name type }
            url
            updatedAt
            labels { nodes { name } }
            assignee { name }
          }
        }
      `);

      if (!response.data?.issue) {
        throw new Error(`Issue ${ref} not found`);
      }

      return this.normalizeIssue(response.data.issue);
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "linear",
        operation: "getIssue",
        code: "provider_failed",
        message: `Failed to fetch Linear issue ${ref}`,
        cause: error,
      });
    }
  }

  async fetchActiveQueue(limit = 10): Promise<UnifiedIssue[]> {
    try {
      const response = await this.graphql(`
        query {
          issues(
            filter: {
              team: { id: { eq: "${this.teamId}" } }
              state: { type: { nin: ["completed", "canceled"] } }
            }
            first: ${limit}
          ) {
            nodes {
              id
              identifier
              title
              description
              state { name type }
              url
              updatedAt
              labels { nodes { name } }
              assignee { name }
            }
          }
        }
      `);

      return (response.data?.issues?.nodes ?? []).map((issue: LinearIssue) =>
        this.normalizeIssue(issue)
      );
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "linear",
        operation: "fetchActiveQueue",
        code: "provider_failed",
        message: "Failed to fetch active Linear issues",
        cause: error,
      });
    }
  }

  async fetchBacklogQueue(limit = 10): Promise<UnifiedIssue[]> {
    try {
      const response = await this.graphql(`
        query {
          issues(
            filter: {
              team: { id: { eq: "${this.teamId}" } }
              state: { type: { eq: "backlog" } }
            }
            first: ${limit}
          ) {
            nodes {
              id
              identifier
              title
              description
              state { name type }
              url
              updatedAt
              labels { nodes { name } }
              assignee { name }
            }
          }
        }
      `);

      return (response.data?.issues?.nodes ?? []).map((issue: LinearIssue) =>
        this.normalizeIssue(issue)
      );
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "linear",
        operation: "fetchBacklogQueue",
        code: "provider_failed",
        message: "Failed to fetch Linear backlog",
        cause: error,
      });
    }
  }

  async createIssue(input: CreateIssueInput): Promise<UnifiedIssue> {
    try {
      const response = await this.graphql(`
        mutation {
          issueCreate(input: {
            teamId: "${this.teamId}"
            title: "${this.escapeGraphQL(input.title ?? input.summary)}"
            description: "${this.escapeGraphQL(input.description ?? "")}"
          }) {
            issue {
              id
              identifier
              title
              description
              state { name type }
              url
              updatedAt
              labels { nodes { name } }
              assignee { name }
            }
          }
        }
      `);

      if (!response.data?.issueCreate?.issue) {
        throw new Error("Failed to create issue");
      }

      return this.normalizeIssue(response.data.issueCreate.issue);
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "linear",
        operation: "createIssue",
        code: "provider_failed",
        message: "Failed to create Linear issue",
        cause: error,
      });
    }
  }

  async transitionIssue(ref: string, targetStatus: string): Promise<UnifiedIssue | void> {
    try {
      const issueId = this.extractIssueId(ref);
      const stateId = await this.getStateId(targetStatus);

      await this.graphql(`
        mutation {
          issueUpdate(
            id: "${issueId}"
            input: { stateId: "${stateId}" }
          ) {
            success
          }
        }
      `);

      return this.getIssue(ref);
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "linear",
        operation: "transitionIssue",
        code: "provider_failed",
        message: `Failed to transition Linear issue ${ref}`,
        cause: error,
      });
    }
  }

  async postComment(ref: string, body: string): Promise<{ url?: string; body: string }> {
    try {
      const issueId = this.extractIssueId(ref);

      const response = await this.graphql(`
        mutation {
          commentCreate(input: {
            issueId: "${issueId}"
            body: "${this.escapeGraphQL(body)}"
          }) {
            comment {
              url
            }
          }
        }
      `);

      return {
        url: response.data?.commentCreate?.comment?.url,
        body,
      };
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "linear",
        operation: "postComment",
        code: "provider_failed",
        message: `Failed to post comment on Linear issue ${ref}`,
        cause: error,
      });
    }
  }

  private async graphql(query: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private normalizeIssue(issue: LinearIssue): UnifiedIssue {
    const stateType = issue.state.type.toLowerCase();
    let status: string;
    let statusCategory: string;

    switch (stateType) {
      case "completed":
        status = "Done";
        statusCategory = "Complete";
        break;
      case "started":
        status = "In Progress";
        statusCategory = "In Progress";
        break;
      case "backlog":
        status = "Backlog";
        statusCategory = "To Do";
        break;
      default:
        status = issue.state.name;
        statusCategory = "To Do";
    }

    return {
      ref: issue.identifier,
      title: issue.title,
      description: issue.description,
      status,
      statusCategory,
      resolution: stateType === "completed" ? "Done" : undefined,
      type: this.inferIssueType(issue.labels),
      url: issue.url,
      updatedAt: issue.updatedAt,
      labels: issue.labels.map((l) => l.name),
      assignee: issue.assignee?.name,
      raw: issue,
    };
  }

  private inferIssueType(labels: Array<{ name: string }>): string {
    const labelNames = labels.map((l) => l.name.toLowerCase());
    if (labelNames.some((l) => l.includes("bug"))) return "bug";
    if (labelNames.some((l) => l.includes("feature") || l.includes("story"))) return "story";
    return "task";
  }

  private extractIssueId(ref: string): string {
    // Linear uses identifiers like "ENG-123" or UUIDs
    if (ref.match(/^[A-Z]+-\d+$/)) {
      // Need to look up the actual ID from the identifier
      throw new Error("Use Linear issue ID (UUID) instead of identifier");
    }
    return ref;
  }

  private async getStateId(stateName: string): Promise<string> {
    const response = await this.graphql(`
      query {
        workflowStates(filter: { name: { eq: "${stateName}" } }) {
          nodes { id }
        }
      }
    `);

    const stateId = response.data?.workflowStates?.nodes?.[0]?.id;
    if (!stateId) {
      throw new Error(`Workflow state "${stateName}" not found`);
    }
    return stateId;
  }

  private escapeGraphQL(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  }
}
