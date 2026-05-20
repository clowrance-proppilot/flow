import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CodeCollaborationProvider,
  CollaborationCapabilities,
  UnifiedCodeReview,
} from "./provider-contracts.js";

const execFileAsync = promisify(execFile);

export interface PullRequestStatus {
  repo: string;
  number: number;
  title: string;
  url: string;
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
}

export interface GitHubAdapterOptions {
  cwd: string;
  owner?: string;
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
    this.owner = options.owner ?? "BecksDevTeam";
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
    const args = [
      "pr",
      "list",
      "--repo",
      `${this.owner}/${repo}`,
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

  async getPullRequest(repo: string, number: number): Promise<PullRequestStatus | undefined> {
    const { stdout } = await withPerfLog(`gh pr view ${repo}#${number}`, () =>
      execFileAsync(
        "gh",
        [
        "pr",
        "view",
        String(number),
        "--repo",
        `${this.owner}/${repo}`,
        "--json",
        "number,title,url,headRefName,state,mergedAt,mergeCommit,isDraft,mergeable,mergeStateStatus,reviewDecision,body,statusCheckRollup",
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
        `${this.owner}/${repo}`,
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
        `${this.owner}/${repo}`,
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
        `${this.owner}/${repo}`,
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
        `${this.owner}/${repo}`,
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

function parseSinglePullRequest(value: unknown, repo: string): PullRequestStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const number = Number(record.number);
  if (!Number.isFinite(number)) return undefined;
  const templateMissingHeadings = missingPullRequestTemplateHeadings(
    typeof record.body === "string" ? record.body : "",
  );
  return {
    repo,
    number,
    title: String(record.title ?? ""),
    url: String(record.url ?? ""),
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
  };
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
    autoReviewNeedsConfirmationDisposition: undefined,
    autoReviewNeedsConfirmationPostedUrl: undefined,
    mergedAt: pr.mergedAt,
    mergeCommitSha: pr.mergeCommitSha,
    raw: pr,
  };
}
