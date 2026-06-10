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
  checksPending?: boolean;
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

export interface UnifiedWorktreePruneResult {
  removed: boolean;
  reason?: string;
  worktreePath: string;
  branch?: string;
}

export interface TriageMissingSection {
  section: string;
  severity: "required" | "recommended";
  description: string;
}

export interface TriageDuplicateCandidate {
  ref: string;
  confidence: number;                  // 0.0 to 1.0
  reason: string;
}

export interface TriageAction {
  type: "add_tag" | "remove_tag" | "add_comment" | "update_body" | "close_duplicate" | "close_not_needed";
  target: string;                      // Issue ref
  payload: Record<string, unknown>;
  reason: string;
}

export interface TriageIssueResult {
  ref: string;
  title: string;
  url: string;
  missingSections: TriageMissingSection[];
  duplicateCandidates: TriageDuplicateCandidate[];
  proposedLabels: string[];
  proposedPriority?: string;
  proposedLane?: string;
  proposedActions: TriageAction[];
}

export interface TriageOptions {
  dryRun?: boolean;
  apply?: boolean;
  limit?: number;
  ids?: string[];
}

export interface TriageResult {
  dryRun: boolean;
  issuesScanned: number;
  issues: TriageIssueResult[];
  proposedActions: TriageAction[];
  appliedActions?: TriageAction[];
}

export interface IssueTrackerCapabilities {
  canCreateIssues: boolean;
  canTransitionIssues: boolean;
  canPostComments: boolean;
  canManageActivePlanningLane: boolean;
  canFetchOpenIssues?: boolean;
  canSearchIssues?: boolean;
  canTagIssues?: boolean;
}

export interface IssueSearchParams {
  title?: string;
  summary?: string;
  projectKey?: string;
  issueType?: string;
  state?: string;
  limit?: number;
}

export interface IssueIntakeCandidate {
  ref: string;
  title: string;
  summary?: string;
  url?: string;
  labels?: string[];
}

export interface CollaborationCapabilities {
  requiresCodeReview?: boolean;
  canMarkReady: boolean;
  canPostComments: boolean;
  canMerge: boolean;
}

export interface UnifiedDiff {
  baseRef?: string;
  headRef?: string;
  files: string[];
  patch?: string;
  stat?: string;
}

export interface CreateIssueInput {
  projectKey?: string;
  issueType: string;
  title?: string;
  summary: string;
  description?: string;
}

export interface IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities;
  getIssue(ref: string): Promise<UnifiedIssue>;
  fetchActiveQueue?(limit?: number): Promise<UnifiedIssue[]>;
  fetchBacklogQueue?(limit?: number): Promise<UnifiedIssue[]>;
  searchIssues?(params: IssueSearchParams): Promise<UnifiedIssue[]>;
  createIssue?(input: CreateIssueInput): Promise<UnifiedIssue>;
  transitionIssue?(ref: string, targetStatus: string): Promise<UnifiedIssue | void>;
  postComment?(ref: string, body: string): Promise<{ url?: string; body: string }>;
  addIssueTags?(ref: string, tags: string[]): Promise<UnifiedIssue | void>;
  removeIssueTags?(ref: string, tags: string[]): Promise<UnifiedIssue | void>;
  moveIssuesToActivePlanningLane?(input: {
    issueRefs: string[];
    laneId?: string;
    projectKey?: string;
  }): Promise<{ laneId: string; laneName?: string }>;
  fetchOpenIssues?(limit?: number): Promise<UnifiedIssue[]>;
}

export interface CodeCollaborationProvider {
  readonly capabilities: CollaborationCapabilities;
  findCodeReviews(repo: string, branchName?: string): Promise<UnifiedCodeReview[]>;
  createCodeReview?(input: {
    repo: string;
    title: string;
    body: string;
    sourceBranch: string;
    targetBranch: string;
    draft?: boolean;
  }): Promise<UnifiedCodeReview>;
  getCodeReview?(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined>;
  getCodeReviewDiff?(repo: string, id: string | number): Promise<UnifiedDiff>;
  markReadyForReview?(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined>;
  postReviewComment?(repo: string, id: string | number, body: string): Promise<{ url?: string; body: string }>;
  mergeCodeReview?(repo: string, id: string | number, options?: { method?: string }): Promise<{ merged: boolean; sha?: string }>;
}

export interface SourceControlProvider {
  inspectWorkspace(repoPath: string): Promise<UnifiedWorkspaceStatus>;
  prepareWorktree?(options: { repoPath: string; worktreePath: string; branch: string; baseRef?: string }): Promise<UnifiedWorkspaceStatus>;
  diffWorkspace?(options: { repoPath: string; baseRef?: string; headRef?: string }): Promise<UnifiedDiff>;
  pruneWorktree?(options: { repoPath: string; worktreePath: string; branch?: string; requireClean?: boolean }): Promise<UnifiedWorktreePruneResult>;
  publishBranch?(options: { worktreePath: string; branch?: string; remote?: string; force?: boolean }): Promise<UnifiedWorkspaceStatus>;
  syncBranch?(options: { worktreePath: string; baseRef: string; remote?: string }): Promise<UnifiedWorkspaceStatus>;
}
