import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CodeCollaborationProvider,
  CollaborationCapabilities,
  IssueTrackerCapabilities,
  IssueTrackerProvider,
  UnifiedIssue,
  UnifiedCodeReview,
} from "./provider-contracts.js";

const execFileAsync = promisify(execFile);

export interface PullRequestStatus {
  repo: string;
  number: number;
  title: string;
  url: string;
  body?: string;
  headRefName: string;
  state?: string;
  mergedAt?: string;
  mergeCommitSha?: string;
  isDraft: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  templateMissingHeadings?: string[];
  checksPassing?: boolean;
  autoReviewStatus?: "passed" | "failed" | "pending" | "missing";
  autoReviewMustFix?: boolean;
  autoReviewMustFixDetail?: string;
  autoReviewNeedsConfirmation?: boolean;
  autoReviewNeedsConfirmationDetail?: string;
  reviewCommentCount?: number;
  reviewCommentAuthors?: string[];
}

export interface GitHubAdapterOptions {
  cwd: string;
  owner?: string;
}

export interface GitHubIssueTrackerOptions extends GitHubAdapterOptions {
  repo: string;
  assignee?: string;
  activeLabels?: string[];
  backlogLabels?: string[];
}

export interface GitHubIssueStatus {
  number: number;
  title: string;
  url: string;
  state: string;
  body?: string;
  updatedAt?: string;
  labels: string[];
  assignees: string[];
}

export interface PullRequestComment {
  url?: string;
  body: string;
}

export interface PullRequestMergeResult {
  url?: string;
  mergedAt?: string;
  mergeCommitSha?: string;
}

export class GhGitHubAdapter implements CodeCollaborationProvider {
  readonly capabilities: CollaborationCapabilities = {
    canMarkReady: true,
    canPostComments: true,
    canMerge: true,
  };

  private readonly cwd: string;
  private readonly owner: string;

  constructor(options: GitHubAdapterOptions) {
    this.cwd = options.cwd;
    this.owner = options.owner ?? process.env.FLOW_GITHUB_OWNER ?? process.env.GITHUB_OWNER ?? "";
  }

  async findCodeReviews(repo: string, branchName?: string): Promise<UnifiedCodeReview[]> {
    const prs = await this.findPullRequests(repo, branchName);
    return prs.map(normalizePullRequest);
  }

  async getCodeReview(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined> {
    const pr = await this.getPullRequest(repo, Number(id));
    if (pr) return normalizePullRequest(pr);
  }

  async markReadyForReview(repo: string, id: string | number): Promise<UnifiedCodeReview | undefined> {
    const pr = await this.markPullRequestReadyForReview(repo, Number(id));
    if (pr) return normalizePullRequest(pr);
  }

  async postReviewComment(repo: string, id: string | number, body: string): Promise<{ url?: string; body: string }> {
    return this.postPullRequestComment(repo, Number(id), body);
  }

  async mergeCodeReview(repo: string, id: string | number, options?: { method?: string }): Promise<{ merged: boolean; sha?: string }> {
    const methodStr = options?.method === "merge" ? "merge" : options?.method === "rebase" ? "rebase" : "squash";
    const result = await this.mergePullRequest(repo, Number(id), { method: methodStr });
    return {
      merged: true,
      sha: result.mergeCommitSha,
    };
  }

  async findPullRequests(repo: string, headRefName?: string): Promise<PullRequestStatus[]> {
    const repoSpecifier = this.repoSpecifier(repo);
    const args = [
      "pr",
      "list",
      "--repo",
      repoSpecifier,
      "--state",
      "open",
      "--json",
      "number,title,url,headRefName,state,mergedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,body,statusCheckRollup",
      "--limit",
      "50",
    ];
    if (headRefName) args.push("--head", headRefName);
    const { stdout } = await withPerfLog(`gh pr list ${repo}${headRefName ? " --head" : ""}`, () =>
      execFileAsync("gh", args, { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024 })
    );
    return parsePullRequests(JSON.parse(stdout) as unknown, repo);
  }

  private repoSpecifier(repo: string): string {
    if (repo.includes("/")) return repo;
    if (!this.owner) {
      throw new Error("GitHub owner is required. Configure collaboration.owner, FLOW_GITHUB_OWNER, or GITHUB_OWNER.");
    }
    return `${this.owner}/${repo}`;
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestStatus | undefined> {
    const { stdout } = await withPerfLog(`gh pr view ${repo}#${number}`, () =>
      execFileAsync(
        "gh",
        [
        "pr",
        "view",
        String(number),
        "--repo",
        this.repoSpecifier(repo),
        "--json",
        "number,title,url,headRefName,state,mergedAt,mergeCommit,isDraft,mergeable,mergeStateStatus,reviewDecision,body,statusCheckRollup,reviews",
        ],
        { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024 },
      )
    );
    const parsed = parseSinglePullRequest(JSON.parse(stdout) as unknown, repo);
    if (!parsed) return undefined;
    const feedback = await this.getAutoReviewFeedback(repo, parsed.number);
    if (feedback) applyAutoReviewFeedback(parsed, feedback);
    return parsed;
  }

  async postPullRequestComment(repo: string, number: number, body: string): Promise<PullRequestComment> {
    const { stdout } = await withPerfLog(`gh pr comment ${repo}#${number}`, () =>
      execFileAsync(
        "gh",
        [
        "pr",
        "comment",
        String(number),
        "--repo",
        this.repoSpecifier(repo),
        "--body",
        body,
        ],
        { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024 },
      )
    );
    const url = stdout.trim();
    return { url: url || undefined, body };
  }

  async mergePullRequest(
    repo: string,
    number: number,
    options: { method?: "merge" | "squash" | "rebase" } = {},
  ): Promise<PullRequestMergeResult> {
    const methodFlag = mergeMethodFlag(options.method ?? "squash");
    await withPerfLog(`gh pr merge ${repo}#${number}`, () =>
      execFileAsync(
        "gh",
        [
        "pr",
        "merge",
        String(number),
        "--repo",
        this.repoSpecifier(repo),
        methodFlag,
        ],
        { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024 },
      ).then(() => undefined)
    );
    const merged = await this.getPullRequest(repo, number);
    return {
      url: merged?.url,
      mergedAt: merged?.mergedAt,
      mergeCommitSha: merged?.mergeCommitSha,
    };
  }

  async markPullRequestReadyForReview(repo: string, number: number): Promise<PullRequestStatus | undefined> {
    await withPerfLog(`gh pr ready ${repo}#${number}`, () =>
      execFileAsync(
        "gh",
        [
        "pr",
        "ready",
        String(number),
        "--repo",
        this.repoSpecifier(repo),
        ],
        { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024 },
      ).then(() => undefined)
    );
    return this.getPullRequest(repo, number);
  }

  private async getAutoReviewFeedback(
    repo: string,
    number: number,
  ): Promise<AutoReviewFeedback | undefined> {
    const { stdout } = await withPerfLog(`gh pr comments ${repo}#${number}`, () =>
      execFileAsync(
        "gh",
        [
        "pr",
        "view",
        String(number),
        "--repo",
        this.repoSpecifier(repo),
        "--json",
        "comments",
        ],
        { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024 },
      )
    );
    const payload = JSON.parse(stdout) as { comments?: Array<{ author?: { login?: string }; body?: string }> };
    const codexComments = (payload.comments ?? [])
      .filter((comment) => comment?.author?.login === "github-actions")
      .map((comment) => comment.body ?? "")
      .filter((body) => body.includes("<!-- codex-pr-review -->"));
    if (codexComments.length === 0) return undefined;
    const latest = codexComments.at(-1) ?? "";
    return extractAutoReviewFeedback(latest);
  }
}

export class GhGitHubIssueTrackerAdapter implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    canCreateIssues: true,
    canTransitionIssues: true,
    canPostComments: true,
    canManageActivePlanningLane: false,
  };

  private readonly cwd: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly assignee: string;
  private readonly activeLabels: string[];
  private readonly backlogLabels: string[];

  constructor(options: GitHubIssueTrackerOptions) {
    this.cwd = options.cwd;
    this.owner = options.owner ?? process.env.FLOW_GITHUB_OWNER ?? process.env.GITHUB_OWNER ?? "";
    this.repo = options.repo;
    this.assignee = options.assignee ?? "@me";
    this.activeLabels = options.activeLabels ?? [];
    this.backlogLabels = options.backlogLabels ?? [];
  }

  async getIssue(ref: string): Promise<UnifiedIssue> {
    const { stdout } = await withPerfLog(`gh issue view ${ref}`, () =>
      execFileAsync("gh", [
        "issue",
        "view",
        String(issueNumberFromRef(ref)),
        "--repo",
        this.repoSpecifier(),
        "--json",
        "number,title,url,state,body,updatedAt,labels,assignees",
      ], { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 })
    );
    const issue = parseSingleGitHubIssue(JSON.parse(stdout) as unknown);
    if (!issue) throw new Error(`GitHub issue ${ref} was not found.`);
    return normalizeGitHubIssue(issue);
  }

  async fetchActiveQueue(limit = 10): Promise<UnifiedIssue[]> {
    return this.listIssues({
      limit,
      labels: this.activeLabels,
      assignee: this.assignee,
    });
  }

  async fetchBacklogQueue(limit = 10): Promise<UnifiedIssue[]> {
    return this.listIssues({
      limit,
      labels: this.backlogLabels,
      assignee: this.backlogLabels.length ? undefined : this.assignee,
    });
  }

  async createIssue(input: { issueType: string; summary: string; description?: string }): Promise<UnifiedIssue> {
    const args = [
      "issue",
      "create",
      "--repo",
      this.repoSpecifier(),
      "--title",
      input.summary,
      "--body",
      input.description ?? "",
    ];
    const typeLabel = labelForIssueType(input.issueType);
    if (typeLabel) args.push("--label", typeLabel);
    const { stdout } = await withPerfLog("gh issue create", () =>
      execFileAsync("gh", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 })
    );
    const number = issueNumberFromUrl(stdout.trim());
    return this.getIssue(String(number));
  }

  async transitionIssue(ref: string, targetStatus: string): Promise<UnifiedIssue | void> {
    const normalized = targetStatus.toLowerCase();
    if (["done", "closed", "complete", "resolved"].includes(normalized)) {
      await withPerfLog(`gh issue close ${ref}`, () =>
        execFileAsync("gh", ["issue", "close", String(issueNumberFromRef(ref)), "--repo", this.repoSpecifier()], {
          cwd: this.cwd,
          maxBuffer: 10 * 1024 * 1024,
        }).then(() => undefined)
      );
      return this.getIssue(ref);
    }
    if (["open", "todo", "to do", "reopen"].includes(normalized)) {
      await withPerfLog(`gh issue reopen ${ref}`, () =>
        execFileAsync("gh", ["issue", "reopen", String(issueNumberFromRef(ref)), "--repo", this.repoSpecifier()], {
          cwd: this.cwd,
          maxBuffer: 10 * 1024 * 1024,
        }).then(() => undefined)
      );
      return this.getIssue(ref);
    }
    throw new Error(`GitHub Issues only supports open/closed transitions, got ${targetStatus}.`);
  }

  async postComment(ref: string, body: string): Promise<{ url?: string; body: string }> {
    const { stdout } = await withPerfLog(`gh issue comment ${ref}`, () =>
      execFileAsync("gh", [
        "issue",
        "comment",
        String(issueNumberFromRef(ref)),
        "--repo",
        this.repoSpecifier(),
        "--body",
        body,
      ], { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 })
    );
    return { url: stdout.trim() || undefined, body };
  }

  private async listIssues(options: { limit: number; labels: string[]; assignee?: string }): Promise<UnifiedIssue[]> {
    const args = [
      "issue",
      "list",
      "--repo",
      this.repoSpecifier(),
      "--state",
      "open",
      "--limit",
      String(options.limit),
      "--json",
      "number,title,url,state,body,updatedAt,labels,assignees",
    ];
    if (options.assignee) args.push("--assignee", options.assignee);
    for (const label of options.labels) args.push("--label", label);
    const { stdout } = await withPerfLog(`gh issue list ${this.repo}`, () =>
      execFileAsync("gh", args, { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 })
    );
    return parseGitHubIssues(JSON.parse(stdout) as unknown).map(normalizeGitHubIssue);
  }

  private repoSpecifier(): string {
    if (this.repo.includes("/")) return this.repo;
    if (!this.owner) {
      throw new Error("GitHub owner is required. Configure issueTracker.owner, collaboration.owner, FLOW_GITHUB_OWNER, or GITHUB_OWNER.");
    }
    return `${this.owner}/${this.repo}`;
  }
}

async function withPerfLog<T>(label: string, operation: () => Promise<T>, defaultThresholdMs = 1000): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    const durationMs = Date.now() - startedAt;
    const thresholdMs = Number(process.env.FLOW_PERF_CLI_THRESHOLD_MS ?? defaultThresholdMs);
    if (process.env.FLOW_PERF_LOG === "1" || durationMs >= thresholdMs) {
      console.error(`[flow perf] ${label} duration_ms=${durationMs}`);
    }
  }
}

interface AutoReviewFeedback {
  mustFix: boolean;
  mustFixDetail?: string;
  needsConfirmation: boolean;
  needsConfirmationDetail?: string;
}

function applyAutoReviewFeedback(pr: PullRequestStatus, feedback: AutoReviewFeedback): void {
  pr.autoReviewMustFix = feedback.mustFix;
  pr.autoReviewMustFixDetail = feedback.mustFixDetail;
  pr.autoReviewNeedsConfirmation = feedback.needsConfirmation;
  pr.autoReviewNeedsConfirmationDetail = feedback.needsConfirmationDetail;
}

export function parsePullRequests(value: unknown, repo: string): PullRequestStatus[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => parseSinglePullRequest(item, repo)).filter((item): item is PullRequestStatus => Boolean(item));
}

export function parseGitHubIssues(value: unknown): GitHubIssueStatus[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseSingleGitHubIssue).filter((issue): issue is GitHubIssueStatus => Boolean(issue));
}

function parseSingleGitHubIssue(value: unknown): GitHubIssueStatus | undefined {
  if (!isRecord(value)) return undefined;
  const number = Number(value.number);
  if (!Number.isFinite(number)) return undefined;
  return {
    number,
    title: String(value.title ?? ""),
    url: String(value.url ?? ""),
    state: String(value.state ?? "OPEN"),
    body: typeof value.body === "string" ? value.body : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    labels: readNameList(value.labels),
    assignees: readNameList(value.assignees),
  };
}

function normalizeGitHubIssue(issue: GitHubIssueStatus): UnifiedIssue {
  const state = issue.state.toUpperCase();
  const closed = state === "CLOSED";
  return {
    ref: `GH-${issue.number}`,
    title: issue.title,
    description: issue.body,
    status: closed ? "Closed" : "Open",
    statusCategory: closed ? "Complete" : "To Do",
    resolution: closed ? "Done" : undefined,
    type: githubIssueType(issue.labels),
    url: issue.url,
    updatedAt: issue.updatedAt,
    labels: issue.labels,
    assignee: issue.assignees[0],
    raw: issue,
  };
}

function githubIssueType(labels: string[]): string {
  const normalized = labels.map((label) => label.toLowerCase());
  if (normalized.some((label) => /\bbug\b/.test(label))) return "bug";
  if (normalized.some((label) => /\bstory\b|\bfeature\b|\benhancement\b/.test(label))) return "story";
  return "task";
}

function labelForIssueType(issueType: string): string | undefined {
  const normalized = issueType.toLowerCase();
  if (normalized === "bug") return "bug";
  if (normalized === "story" || normalized === "feature") return "enhancement";
  return undefined;
}

function issueNumberFromRef(ref: string): number {
  const match = /(?:^|[#-])(\d+)$/.exec(ref.trim());
  const number = match ? Number(match[1]) : Number(ref);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid GitHub issue ref: ${ref}.`);
  return number;
}

function issueNumberFromUrl(url: string): number {
  const match = /\/issues\/(\d+)(?:\D*$|$)/.exec(url);
  if (!match) throw new Error(`Could not read GitHub issue number from ${url}.`);
  return Number(match[1]);
}

function readNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => isRecord(item) ? item.name ?? item.login : item)
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSinglePullRequest(value: unknown, repo: string): PullRequestStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const number = Number(record.number);
  if (!Number.isFinite(number)) return undefined;
  const templateMissingHeadings = missingPullRequestTemplateHeadings(
    typeof record.body === "string" ? record.body : "",
  );
  const reviewComments = reviewCommentSummary(record.reviews);
  return {
    repo,
    number,
    title: String(record.title ?? ""),
    url: String(record.url ?? ""),
    body: typeof record.body === "string" ? record.body : undefined,
    headRefName: String(record.headRefName ?? ""),
    state: typeof record.state === "string" ? record.state : undefined,
    mergedAt: typeof record.mergedAt === "string" ? record.mergedAt : undefined,
    mergeCommitSha: mergeCommitSha(record.mergeCommit),
    isDraft: record.isDraft === true,
    mergeable: typeof record.mergeable === "string" ? record.mergeable : undefined,
    mergeStateStatus: typeof record.mergeStateStatus === "string" ? record.mergeStateStatus : undefined,
    reviewDecision: typeof record.reviewDecision === "string" ? record.reviewDecision : undefined,
    templateMissingHeadings: templateMissingHeadings.length ? templateMissingHeadings : undefined,
    checksPassing: checksPassing(record.statusCheckRollup),
    autoReviewStatus: autoReviewStatus(record.statusCheckRollup),
    reviewCommentCount: reviewComments.count || undefined,
    reviewCommentAuthors: reviewComments.authors.length ? reviewComments.authors : undefined,
  };
}

function reviewCommentSummary(value: unknown): { count: number; authors: string[] } {
  if (!Array.isArray(value)) return { count: 0, authors: [] };
  const authors = new Set<string>();
  let count = 0;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (String(item.state ?? "").toUpperCase() !== "COMMENTED") continue;
    count += 1;
    const author = isRecord(item.author) && typeof item.author.login === "string"
      ? item.author.login
      : typeof item.author === "string"
        ? item.author
        : undefined;
    if (author) authors.add(author);
  }
  return { count, authors: [...authors] };
}

function mergeMethodFlag(method: "merge" | "squash" | "rebase"): "--merge" | "--squash" | "--rebase" {
  if (method === "merge") return "--merge";
  if (method === "rebase") return "--rebase";
  return "--squash";
}

function mergeCommitSha(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.oid === "string" && record.oid ? record.oid : undefined;
}

const requiredPullRequestTemplateHeadings = [
  "JIRA Ticket or Reason for Change",
  "Description",
  "Summary of Changes",
  "Related PRs or Issues",
];

export function missingPullRequestTemplateHeadings(body: string): string[] {
  const headings = new Set(
    body
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => /^#{1,6}\s+(.+?)\s*$/.exec(line.trim())?.[1])
      .filter((heading): heading is string => Boolean(heading))
      .map(normalizeHeading),
  );
  return requiredPullRequestTemplateHeadings.filter((heading) => !headings.has(normalizeHeading(heading)));
}

function normalizeHeading(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function checksPassing(value: unknown): boolean | undefined {
  const checks = latestChecksByName(value);
  if (checks.length === 0) return undefined;
  return checks.every((item) => {
    const record = item as Record<string, unknown>;
    const status = String(record.status ?? "");
    const conclusion = String(record.conclusion ?? "");
    return status === "COMPLETED" && ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion);
  });
}

function autoReviewStatus(value: unknown): "passed" | "failed" | "pending" | "missing" {
  const normalized = latestChecksByName(value)
    .map((item) => item as Record<string, unknown>)
    .map((record) => ({
      name: String(record.name ?? ""),
      status: String(record.status ?? "").toUpperCase(),
      conclusion: String(record.conclusion ?? "").toUpperCase(),
    }))
    .find((check) => /run codex review|codex review|auto.?review/i.test(check.name));
  if (!normalized) return "missing";
  if (normalized.status !== "COMPLETED") return "pending";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(normalized.conclusion)) return "passed";
  return "failed";
}

function latestChecksByName(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) return [];
  const latest = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const key = String(record.name ?? "").trim() || `__idx_${i}`;
    const current = latest.get(key);
    if (!current || checkTimestamp(record) >= checkTimestamp(current)) {
      latest.set(key, record);
    }
  }
  return [...latest.values()];
}

function checkTimestamp(record: Record<string, unknown>): number {
  const completed = typeof record.completedAt === "string" ? Date.parse(record.completedAt) : NaN;
  if (!Number.isNaN(completed) && completed > 0) return completed;
  const started = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : NaN;
  if (!Number.isNaN(started) && started > 0) return started;
  return 0;
}

export function extractAutoReviewFeedback(body: string): AutoReviewFeedback {
  const mustFixDetail = extractAutoReviewSection(body, "Must-fix");
  const needsConfirmationDetail = extractAutoReviewSection(body, "Needs Confirmation");
  return {
    mustFix: Boolean(mustFixDetail),
    mustFixDetail,
    needsConfirmation: Boolean(needsConfirmationDetail),
    needsConfirmationDetail,
  };
}

function extractAutoReviewSection(body: string, heading: string): string | undefined {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`##\\s*${escapedHeading}\\s*([\\s\\S]*?)(?:\\n##\\s|\\s*$)`, "i").exec(body);
  if (!match) return undefined;
  const content = match[1]
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!content) return undefined;
  if (isEmptyAutoReviewSection(content)) return undefined;
  return content.slice(0, 2000);
}

function isEmptyAutoReviewSection(content: string): boolean {
  const normalized = content
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^none(?:\s+(?:identified|found))?\.?$/i.test(normalized);
}

export function normalizePullRequest(pr: PullRequestStatus): UnifiedCodeReview {
  return {
    id: pr.number,
    repo: pr.repo,
    url: pr.url,
    title: pr.title,
    sourceBranch: pr.headRefName,
    targetBranch: "develop",
    isDraft: pr.isDraft,
    isMerged: pr.state?.toUpperCase() === "MERGED",
    isClosed: pr.state?.toUpperCase() === "CLOSED",
    mergeableState: pr.mergeable === "MERGEABLE" ? "clean" : pr.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
    checksPassing: pr.checksPassing,
    state: pr.state,
    reviewDecision: pr.reviewDecision,
    templateMissingHeadings: pr.templateMissingHeadings ?? [],
    autoReviewStatus: pr.autoReviewStatus,
    autoReviewMustFix: pr.autoReviewMustFix === true,
    autoReviewMustFixDetail: pr.autoReviewMustFixDetail,
    autoReviewNeedsConfirmation: pr.autoReviewNeedsConfirmation === true,
    autoReviewNeedsConfirmationDetail: pr.autoReviewNeedsConfirmationDetail,
    reviewCommentCount: pr.reviewCommentCount,
    reviewCommentAuthors: pr.reviewCommentAuthors,
    autoReviewNeedsConfirmationDisposition: undefined,
    autoReviewNeedsConfirmationPostedUrl: undefined,
    mergedAt: pr.mergedAt,
    mergeCommitSha: pr.mergeCommitSha,
    raw: pr,
  };
}
