export interface UnifiedIssue {
  ref: string;
  title: string;
  description?: string;
  status: string;                      // Normalized status (e.g. "In Progress", "Done")
  statusCategory?: string;             // e.g. "To Do", "In Progress", "Complete"
  resolution?: string;
  type: string;                        // e.g. "story", "bug"
  url: string;
  updatedAt?: string;
  labels: string[];
  assignee?: string;
  raw?: unknown;                       // Native representation escape hatch
}

export interface UnifiedCodeReview {
  id: string | number;                 // PR number or GitLab MR IID
  repo: string;
  url: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  isDraft: boolean;
  isMerged: boolean;
  isClosed: boolean;
  mergeableState: "clean" | "conflicting" | "unknown";
  checksPassing?: boolean;
  state?: string;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | string;
  templateMissingHeadings: string[];
  autoReviewStatus?: string;
  autoReviewMustFix: boolean;
  autoReviewMustFixDetail?: string;
  autoReviewNeedsConfirmation: boolean;
  autoReviewNeedsConfirmationDetail?: string;
  reviewCommentCount?: number;
  reviewCommentAuthors?: string[];
  autoReviewNeedsConfirmationDisposition?: string;
  autoReviewNeedsConfirmationPostedUrl?: string;
  mergedAt?: string;
  mergeCommitSha?: string;
  raw?: unknown;
}

export interface UnifiedWorkspaceStatus {
  dirty: boolean;
  headSha: string;
  branch: string;
  entries: string[];                   // Raw status lines to preserve zero parsing risk
  structuredEntries?: { path: string; status: string }[];
  worktreePath?: string;
}

export interface IssueTrackerCapabilities {
  canCreateIssues: boolean;
  canTransitionIssues: boolean;
  canPostComments: boolean;
  canManageActivePlanningLane: boolean;
}

export interface CollaborationCapabilities {
  canMarkReady: boolean;
  canPostComments: boolean;
  canMerge: boolean;
}

export interface CreateIssueInput {
  projectKey?: string;
  issueType: string;
  summary: string;
  description?: string;
}

export interface IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities;
  getIssue(ref: string): Promise<UnifiedIssue>;
  fetchActiveQueue?(limit?: number): Promise<UnifiedIssue[]>;
  fetchBacklogQueue?(limit?: number): Promise<UnifiedIssue[]>;
  createIssue?(input: CreateIssueInput): Promise<UnifiedIssue>;
  transitionIssue?(ref: string, targetStatus: string): Promise<UnifiedIssue | void>;
  postComment?(ref: string, body: string): Promise<{ url?: string; body: string }>;
  moveIssuesToActivePlanningLane?(input: {
    issueRefs: string[];
    laneId?: string;
    projectKey?: string;
  }): Promise<{ laneId: string; laneName?: string }>;
}

export interface CodeCollaborationProvider {
  readonly capabilities: CollaborationCapabilities;
  findCodeReviews(repo: string, branchName?: string): Promise<UnifiedCodeReview[]>;
  getCodeReview?(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined>;
  markReadyForReview?(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined>;
  postReviewComment?(repo: string, id: string | number, body: string): Promise<{ url?: string; body: string }>;
  mergeCodeReview?(repo: string, id: string | number, options?: { method?: string }): Promise<{ merged: boolean; sha?: string }>;
}

export interface SourceControlProvider {
  inspectWorkspace(repoPath: string): Promise<UnifiedWorkspaceStatus>;
  prepareWorktree?(options: { repoPath: string; worktreePath: string; branch: string; baseRef?: string }): Promise<UnifiedWorkspaceStatus>;
}
