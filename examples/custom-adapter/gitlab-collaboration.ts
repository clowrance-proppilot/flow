/**
 * GitLab Code Collaboration Adapter Example
 *
 * Demonstrates how to create a custom CodeCollaborationProvider
 * that integrates with GitLab's API for merge requests.
 */

import type {
  CodeCollaborationProvider,
  CollaborationCapabilities,
  UnifiedCodeReview,
} from "../../src/adapters/provider-contracts.js";
import { ProviderAdapterError } from "../../src/adapters/provider-errors.js";

export interface GitLabAdapterOptions {
  baseUrl: string;
  token: string;
}

interface GitLabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: string;
  draft: boolean;
  merge_status: string;
  approvals_before_merge?: number;
  updated_at: string;
  merged_at?: string;
  merge_commit_sha?: string;
  description?: string;
  reviewers?: Array<{ username: string }>;
}

export class GitLabCollaborationAdapter implements CodeCollaborationProvider {
  readonly capabilities: CollaborationCapabilities = {
    requiresCodeReview: true,
    canMarkReady: true,
    canPostComments: true,
    canMerge: true,
  };

  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: GitLabAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
  }

  async findCodeReviews(repo: string, branchName?: string): Promise<UnifiedCodeReview[]> {
    try {
      const projectId = encodeURIComponent(repo);
      let url = `${this.baseUrl}/api/v4/projects/${projectId}/merge_requests?state=opened`;

      if (branchName) {
        url += `&source_branch=${encodeURIComponent(branchName)}`;
      }

      const mrs = await this.fetch<GitLabMergeRequest[]>(url);
      return mrs.map((mr) => this.normalizeMergeRequest(mr, repo));
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "gitlab",
        operation: "findCodeReviews",
        code: "provider_failed",
        message: `Failed to fetch GitLab merge requests for ${repo}`,
        cause: error,
      });
    }
  }

  async getCodeReview(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined> {
    try {
      const projectId = encodeURIComponent(repo);
      const mrIid = Number(id);

      const mr = await this.fetch<GitLabMergeRequest>(
        `${this.baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}`
      );

      return this.normalizeMergeRequest(mr, repo);
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "gitlab",
        operation: "getCodeReview",
        code: "provider_failed",
        message: `Failed to fetch GitLab MR ${repo}!${id}`,
        cause: error,
      });
    }
  }

  async markReadyForReview(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined> {
    try {
      const projectId = encodeURIComponent(repo);
      const mrIid = Number(id);

      await this.fetch(
        `${this.baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draft: false }),
        }
      );

      return this.getCodeReview(repo, id);
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "gitlab",
        operation: "markReadyForReview",
        code: "provider_failed",
        message: `Failed to mark GitLab MR ${repo}!${id} as ready`,
        cause: error,
      });
    }
  }

  async postReviewComment(repo: string, id: string | number, body: string): Promise<{ url?: string; body: string }> {
    try {
      const projectId = encodeURIComponent(repo);
      const mrIid = Number(id);

      const response = await this.fetch<{ id: number; noteable_id: number }>(
        `${this.baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        }
      );

      return {
        url: `${this.baseUrl}/${repo}/-/merge_requests/${mrIid}#note_${response.id}`,
        body,
      };
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "gitlab",
        operation: "postReviewComment",
        code: "provider_failed",
        message: `Failed to post comment on GitLab MR ${repo}!${id}`,
        cause: error,
      });
    }
  }

  async mergeCodeReview(
    repo: string,
    id: string | number,
    options?: { method?: string }
  ): Promise<{ merged: boolean; sha?: string }> {
    try {
      const projectId = encodeURIComponent(repo);
      const mrIid = Number(id);

      // GitLab merge methods: merge, squash, rebase_merge
      const mergeMethod = options?.method === "rebase" ? "rebase_merge"
        : options?.method === "merge" ? "merge"
        : "squash";

      const response = await this.fetch<{ merge_commit_sha?: string; sha?: string }>(
        `${this.baseUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/merge`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            squash: mergeMethod === "squash",
            should_remove_source_branch: true,
          }),
        }
      );

      return {
        merged: true,
        sha: response.merge_commit_sha ?? response.sha,
      };
    } catch (error) {
      throw new ProviderAdapterError({
        provider: "gitlab",
        operation: "mergeCodeReview",
        code: "provider_failed",
        message: `Failed to merge GitLab MR ${repo}!${id}`,
        cause: error,
      });
    }
  }

  private async fetch<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`GitLab API error: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    return response.json();
  }

  private normalizeMergeRequest(mr: GitLabMergeRequest, repo: string): UnifiedCodeReview {
    const isMerged = mr.state === "merged";
    const isClosed = mr.state === "closed";
    const isDraft = mr.draft === true;

    let mergeableState: "clean" | "conflicting" | "unknown";
    switch (mr.merge_status) {
      case "mergeable":
        mergeableState = "clean";
        break;
      case "cannot_be_merged":
        mergeableState = "conflicting";
        break;
      default:
        mergeableState = "unknown";
    }

    // Check for review approval status
    const reviewDecision = mr.approvals_before_merge && mr.approvals_before_merge > 0
      ? "REVIEW_REQUIRED"
      : "APPROVED";

    return {
      id: mr.iid,
      repo,
      url: mr.web_url,
      title: mr.title,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      isDraft,
      isMerged,
      isClosed,
      mergeableState,
      state: mr.state,
      reviewDecision,
      templateMissingHeadings: [],
      reviewCommentCount: undefined,
      reviewCommentAuthors: mr.reviewers?.map((r) => r.username),
      mergedAt: mr.merged_at,
      mergeCommitSha: mr.merge_commit_sha,
      raw: mr,
    };
  }
}
