import type { WorkItem, WorkerRunRecord, WorkerTaskResult } from "./contracts.js";
import { nowIso } from "./contracts.js";
import type { GitRepoStatus } from "./adapters/git.js";
import type { PullRequestStatus } from "./adapters/github.js";
import type { ProjectTopology } from "./project-topology.js";
import type { WorkflowLedger } from "./ledger.js";
import { isPullRequestConflicted } from "./pr-gate.js";
import {
  normalizeRepoKey,
  normalizeRepoKeys,
  existingString,
  metadataBoolean,
  metadataNumber,
  metadataStringArray,
  metadataValueEquals,
  mapWithConcurrency,
  workRuntimeQueueConcurrency,
} from "./runtime-utils.js";

export type PullRequestsByRepo = Map<string, PullRequestStatus[]>;

export interface ReconcileOptions {
  persist?: boolean;
}

export interface ReconciliationDeps {
  topology: ProjectTopology;
  sourceControl: SourceControlForReconciliation;
  collaboration?: CollaborationForReconciliation;
  ledger: WorkflowLedger;
  staleWorkerRunTimeoutMs?: number;
  debug?: (event: string, details: Record<string, unknown>) => void;
}

export interface SourceControlForReconciliation {
  inspect(repoPath: string): Promise<GitRepoStatus>;
}

export interface CollaborationForReconciliation {
  findPullRequests(repo: string, headRefName?: string): Promise<PullRequestStatus[]>;
  getPullRequest?(repo: string, number: number): Promise<PullRequestStatus | undefined>;
}

export class ReconciliationEngine {
  private readonly topology: ProjectTopology;
  private readonly sourceControl: SourceControlForReconciliation;
  private readonly collaboration?: CollaborationForReconciliation;
  private readonly ledger: WorkflowLedger;
  private readonly staleWorkerRunTimeoutMs: number;
  private readonly debug: (event: string, details: Record<string, unknown>) => void;

  constructor(deps: ReconciliationDeps) {
    this.topology = deps.topology;
    this.sourceControl = deps.sourceControl;
    this.collaboration = deps.collaboration;
    this.ledger = deps.ledger;
    this.staleWorkerRunTimeoutMs = deps.staleWorkerRunTimeoutMs ?? defaultStaleWorkerRunMs();
    this.debug = deps.debug ?? (() => {});
  }

  private repoKeyFromRepoName(repoName: string): string | undefined {
    for (const key of this.topology.validRepoKeys) {
      if (this.topology.repoName(key) === repoName) return key;
    }
    return normalizeRepoKey(repoName);
  }

  private repoNameForKey(repoKey: string): string {
    const normalized = normalizeRepoKey(repoKey);
    return this.topology.isValidRepoKey(normalized)
      ? this.topology.repoName(normalized)
      : normalized.replace(/_/g, "-");
  }

  async reconcile(
    issue: WorkItem,
    pullRequestsByRepo?: PullRequestsByRepo,
    options: ReconcileOptions = {},
  ): Promise<WorkItem> {
    const persist = options.persist ?? true;
    const metadata = { ...issue.metadata };
    let repoKeys = issue.repoKeys.length ? issue.repoKeys : inferredRepoKeys(metadata, (n) => this.repoKeyFromRepoName(n));
    let changed = false;

    if (repoKeys.length === 0) {
      repoKeys = await this.discoverRepoKeysFromOpenPullRequests(issue.ref, pullRequestsByRepo);
      changed = repoKeys.length > 0;
    }
    const routedRepoKeys = repoKeys.filter((repoKey) => this.topology.isValidRepoKey(normalizeRepoKey(repoKey)));
    if (issue.repoKeys.length === 0 && routedRepoKeys.length > 0) {
      changed = true;
    }

    const directPrMetadata = await this.reconcileRecordedPullRequest(metadata, repoKeys, pullRequestsByRepo);
    if (Object.keys(directPrMetadata).length > 0) {
      Object.assign(metadata, directPrMetadata);
      changed = true;
    }

    for (const repoKey of routedRepoKeys) {
      const repoMetadata = await this.reconcileRepo(issue, repoKey, metadata, pullRequestsByRepo);
      if (Object.keys(repoMetadata).length > 0) {
        Object.assign(metadata, repoMetadata);
        changed = true;
      }
    }

    const aggregatePrMetadata = aggregatePullRequestMetadata(
      metadata,
      repoKeys,
      (k) => this.repoNameForKey(k),
    );
    if (Object.keys(aggregatePrMetadata).length > 0) {
      Object.assign(metadata, aggregatePrMetadata);
      changed = true;
    }
    if (persist) await this.reconcileSatisfiedPrWorkerRuns(issue.ref, metadata);

    if (
      metadata.prAutoReviewNeedsConfirmation === true &&
      typeof metadata.prAutoReviewNeedsConfirmationDisposition !== "string"
    ) {
      const defaultDisposition = autoReviewNeedsConfirmationDefaultDisposition();
      if (defaultDisposition) {
        metadata.prAutoReviewNeedsConfirmationDisposition = defaultDisposition;
        changed = true;
      }
    }

    const state = externallyDrivenState(issue.state, metadata);
    if (!changed && state === issue.state) return issue;
    const persistedRepoKeys = issue.repoKeys.length ? issue.repoKeys : routedRepoKeys;
    if (!persist) return { ...issue, repoKeys: persistedRepoKeys, state, metadata };
    return this.ledger.writeIssue({ ...issue, repoKeys: persistedRepoKeys, state, metadata });
  }

  async reconcileSafely(
    issue: WorkItem,
    pullRequestsByRepo?: PullRequestsByRepo,
    options: ReconcileOptions = {},
  ): Promise<WorkItem> {
    try {
      return await this.reconcile(issue, pullRequestsByRepo, options);
    } catch (error) {
      this.debug("reconcile.safely.error", {
        issueRef: issue.ref,
        repoKeys: issue.repoKeys,
        error: errorMessage(error),
      });
      return issue;
    }
  }

  async reconcileStaleWorkerRuns(issueRef: string): Promise<void> {
    const staleAfterMs = this.staleWorkerRunTimeoutMs;
    const now = Date.now();
    const runs = await this.ledger.listWorkerRuns(issueRef);
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const updatedAtMs = Date.parse(run.updatedAt);
      if (Number.isNaN(updatedAtMs)) continue;
      if (now - updatedAtMs <= staleAfterMs) continue;
      const expiredAt = nowIso();
      await this.ledger.recordWorkerRun({
        ...run,
        status: "failed",
        summary: `Worker run expired after ${Math.round(staleAfterMs / 60000)} minutes without progress.`,
        blockers: ["Worker run became stale and was auto-expired by workRuntime reconciliation."],
        updatedAt: expiredAt,
        completedAt: expiredAt,
      });
      this.debug("worker.stale_expired", {
        issueRef,
        taskId: run.taskId,
        repoKey: run.repoKey,
        staleAfterMs,
        previousUpdatedAt: run.updatedAt,
      });
    }
  }

  async preloadPullRequests(issues: WorkItem[]): Promise<PullRequestsByRepo | undefined> {
    if (!this.collaboration) return undefined;
    const repoNames = new Set<string>();
    for (const issue of issues) {
      const repoKeys = issue.repoKeys.length ? issue.repoKeys : inferredRepoKeys(issue.metadata, (n) => this.repoKeyFromRepoName(n));
      for (const repoKey of repoKeys) {
        repoNames.add(this.repoNameForKey(repoKey));
      }
    }
    if (repoNames.size === 0) return undefined;

    const entries = await mapWithConcurrency([...repoNames], workRuntimeQueueConcurrency(), async (repoName) => {
      try {
        return [repoName, await this.collaboration?.findPullRequests(repoName) ?? []] as const;
      } catch (error) {
        this.debug("reconcile.preload_pr.error", {
          repoName,
          error: errorMessage(error),
        });
        return [repoName, [] as PullRequestStatus[]] as const;
      }
    });
    return new Map(entries);
  }

  private async reconcileRepo(
    issue: WorkItem,
    repoKey: string,
    metadata: Record<string, unknown>,
    pullRequestsByRepo?: PullRequestsByRepo,
  ): Promise<Record<string, unknown>> {
    const normalizedRepoKey = normalizeRepoKey(repoKey);
    const repoName = this.topology.repoName(repoKey);
    const updates: Record<string, unknown> = {};
    const path =
      metadata[`workflow.repos.${normalizedRepoKey}.worktree_path`] ??
      metadata.work_dir ??
      metadata.worktree_path;

    let branch =
      metadata[`workflow.repos.${normalizedRepoKey}.branch`] ??
      metadata.branch;

    if (typeof path === "string" && path) {
      try {
        const status = await this.sourceControl.inspect(path);
        branch = status.branch || branch;
        maybeSet(updates, metadata, `workflow.repos.${normalizedRepoKey}.branch`, status.branch);
        maybeSet(updates, metadata, `workflow.repos.${normalizedRepoKey}.head_sha`, status.headSha);
        maybeSet(updates, metadata, `workflow.repos.${normalizedRepoKey}.dirty`, status.dirty);
      } catch (error) {
        this.debug("reconcile.inspect_repo.error", {
          issueRef: issue.ref,
          repoKey: normalizedRepoKey,
          operation: "sourceControl.inspect",
          error: errorMessage(error),
        });
      }
    }

    if (this.collaboration) {
      try {
        const pr = await this.findOpenPullRequestForRepo(
          issue.ref,
          repoName,
          typeof branch === "string" ? branch : "",
          pullRequestsByRepo,
        );
        if (pr) {
          for (const [key, value] of Object.entries(pullRequestMetadata(normalizedRepoKey, pr))) {
            if (isRecordedAtPullRequestKey(key) && typeof metadata[key] === "string") continue;
            maybeSet(updates, metadata, key, value);
          }
        }
      } catch (error) {
        this.debug("reconcile.find_pr.error", {
          issueRef: issue.ref,
          repoKey: normalizedRepoKey,
          repoName,
          operation: "findOpenPullRequestForRepo",
          error: errorMessage(error),
        });
      }
    }

    return updates;
  }

  private async reconcileRecordedPullRequest(
    metadata: Record<string, unknown>,
    repoKeys: string[],
    pullRequestsByRepo?: PullRequestsByRepo,
  ): Promise<Record<string, unknown>> {
    if (!this.collaboration?.getPullRequest && !pullRequestsByRepo) return {};
    const updates: Record<string, unknown> = {};
    const snapshots = collectPullRequestSnapshots(metadata, repoKeys, (k) => this.repoNameForKey(k));
    for (const snapshot of snapshots) {
      const repo = snapshot.repo ?? repoFromPullRequestUrl(snapshot.url);
      const number = snapshot.number;
      if (!repo || typeof number !== "number" || !Number.isFinite(number)) continue;
      try {
        const pr = pullRequestsByRepo?.get(repo)?.find((candidate) => candidate.number === number) ??
          await this.collaboration?.getPullRequest?.(repo, number);
        if (!pr) continue;
        const nextMetadata = snapshot.source === "repo"
          ? pullRequestMetadata(snapshot.repoKey ?? pr.repo, pr)
          : globalPullRequestMetadata(pullRequestStatusSnapshot(pr, "global"));
        for (const [key, value] of Object.entries(nextMetadata)) {
          maybeSet(updates, metadata, key, value);
        }
      } catch (error) {
        this.debug("reconcile.recorded_pr.error", {
          repo,
          prNumber: number,
          prUrl: snapshot.url,
          operation: "getPullRequest",
          error: errorMessage(error),
        });
      }
    }
    return updates;
  }

  private async reconcileSatisfiedPrWorkerRuns(issueRef: string, metadata: Record<string, unknown>): Promise<void> {
    if (metadata.prIsDraft !== false) return;

    const completedAt = nowIso();
    const runs = await this.ledger.listWorkerRuns(issueRef);
    for (const run of runs) {
      if (run.status !== "running" && run.status !== "queued") continue;
      if (!isUndraftWorkerRun(run)) continue;
      await this.ledger.recordWorkerRun({
        ...run,
        status: "succeeded",
        summary: "PR is no longer draft in refreshed GitHub metadata.",
        blockers: [],
        updatedAt: completedAt,
        completedAt,
      });
      this.debug("worker.pr_undraft_satisfied", {
        issueRef,
        taskId: run.taskId,
        prUrl: metadata.prUrl,
      });
    }
  }

  private async findOpenPullRequestForRepo(
    issueRef: string,
    repoName: string,
    branch: string,
    pullRequestsByRepo?: PullRequestsByRepo,
  ): Promise<PullRequestStatus | undefined> {
    if (!this.collaboration) return undefined;
    const preloaded = pullRequestsByRepo?.get(repoName);
    if (preloaded) return findPullRequestForIssue(preloaded, issueRef, branch);

    if (branch) {
      const [branchMatch] = await this.collaboration.findPullRequests(repoName, branch);
      if (branchMatch) return await this.hydratePullRequest(repoName, branchMatch);
    }

    const issueKey = issueRef.toUpperCase();
    const candidates = await this.collaboration.findPullRequests(repoName);
    const issueMatch = candidates.find((pr) =>
      pr.headRefName.toUpperCase().includes(issueKey) ||
      pr.title.toUpperCase().includes(issueKey)
    );
    if (!issueMatch) return undefined;
    return await this.hydratePullRequest(repoName, issueMatch);
  }

  private async hydratePullRequest(repoName: string, pr: PullRequestStatus): Promise<PullRequestStatus> {
    if (!this.collaboration?.getPullRequest) return pr;
    try {
      return await this.collaboration.getPullRequest(repoName, pr.number) ?? pr;
    } catch (error) {
      this.debug("reconcile.hydrate_pr.error", {
        repoName,
        prNumber: pr.number,
        operation: "getPullRequest",
        error: errorMessage(error),
      });
      return pr;
    }
  }

  private async discoverRepoKeysFromOpenPullRequests(
    issueRef: string,
    pullRequestsByRepo?: PullRequestsByRepo,
  ): Promise<string[]> {
    if (!this.collaboration && !pullRequestsByRepo) return [];
    const discovered = new Set<string>();
    const repoKeys = [...this.topology.validRepoKeys];

    await mapWithConcurrency(repoKeys, workRuntimeQueueConcurrency(), async (repoKey) => {
      const repoName = this.topology.repoName(repoKey);
      try {
        const pullRequests = pullRequestsByRepo?.get(repoName) ?? await this.collaboration?.findPullRequests(repoName) ?? [];
        if (findPullRequestForIssue(pullRequests, issueRef, "")) discovered.add(repoKey);
      } catch (error) {
        this.debug("reconcile.discover_repos.error", {
          issueRef,
          repoKey,
          repoName,
          operation: "findPullRequests",
          error: errorMessage(error),
        });
      }
    });

    return repoKeys.filter((repoKey) => discovered.has(repoKey));
  }
}

// --- PR metadata helpers (exported for use by work-runtime) ---

export interface PullRequestMetadataSnapshot {
  source: "repo" | "global";
  repoKey?: string;
  repo?: string;
  number?: number;
  url: string;
  headRefName?: string;
  expectedBranch?: string;
  state?: string;
  mergedAt?: string;
  mergeCommitSha?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  checksPassing?: boolean;
  checksPending?: boolean;
  templateMissingHeadings?: string[];
  autoReviewStatus?: string;
  autoReviewMustFix?: boolean;
  autoReviewMustFixDetail?: string;
  autoReviewNeedsConfirmation?: boolean;
  autoReviewNeedsConfirmationDetail?: string;
  reviewCommentCount?: number;
  reviewCommentAuthors?: string[];
  autoReviewNeedsConfirmationDisposition?: string;
  autoReviewNeedsConfirmationPostedUrl?: string;
  recordedAt?: string;
}

export function collectPullRequestSnapshots(
  metadata: Record<string, unknown>,
  repoKeys: string[],
  repoNameFallback: (repoKey: string) => string,
): PullRequestMetadataSnapshot[] {
  const snapshots: PullRequestMetadataSnapshot[] = [];
  const fallback = repoNameFallback;

  for (const repoKey of repoKeys.map(normalizeRepoKey)) {
    const prefix = `workflow.repos.${repoKey}.pr`;
    const url = existingString(metadata[`${prefix}_url`]);
    if (!url) continue;
    snapshots.push({
      repo: existingString(metadata[`${prefix}_repo`]) ?? fallback(repoKey),
      number: metadataNumber(metadata[`${prefix}_number`]),
      url,
      source: "repo",
      repoKey,
      headRefName: existingString(metadata[`${prefix}_head_ref_name`]),
      expectedBranch: existingString(metadata[`workflow.repos.${repoKey}.branch`]),
      state: existingString(metadata[`${prefix}_state`]),
      mergedAt: existingString(metadata[`${prefix}_merged_at`]),
      mergeCommitSha: existingString(metadata[`${prefix}_merge_commit_sha`]),
      isDraft: metadataBoolean(metadata[`${prefix}_is_draft`]),
      mergeable: existingString(metadata[`${prefix}_mergeable`]),
      mergeStateStatus: existingString(metadata[`${prefix}_merge_state_status`]),
      reviewDecision: existingString(metadata[`${prefix}_review_decision`]),
      checksPassing: metadataBoolean(metadata[`${prefix}_checks_passing`]),
      checksPending: metadataBoolean(metadata[`${prefix}_checks_pending`]),
      templateMissingHeadings: metadataStringArray(metadata[`${prefix}_template_missing_headings`]),
      autoReviewStatus: existingString(metadata[`${prefix}_auto_review_status`]),
      autoReviewMustFix: metadataBoolean(metadata[`${prefix}_auto_review_must_fix`]),
      autoReviewMustFixDetail: existingString(metadata[`${prefix}_auto_review_must_fix_detail`]),
      autoReviewNeedsConfirmation: metadataBoolean(metadata[`${prefix}_auto_review_needs_confirmation`]),
      autoReviewNeedsConfirmationDetail: existingString(metadata[`${prefix}_auto_review_needs_confirmation_detail`]),
      reviewCommentCount: metadataNumber(metadata[`${prefix}_review_comment_count`]),
      reviewCommentAuthors: metadataStringArray(metadata[`${prefix}_review_comment_authors`]),
      autoReviewNeedsConfirmationDisposition: existingString(metadata[`${prefix}_auto_review_needs_confirmation_disposition`]),
      autoReviewNeedsConfirmationPostedUrl: existingString(metadata[`${prefix}_auto_review_needs_confirmation_posted_url`]),
      recordedAt: existingString(metadata[`${prefix}_recorded_at`]),
    });
  }

  const globalUrl = existingString(metadata.prUrl);
  if (globalUrl && !snapshots.some((snapshot) => snapshot.url === globalUrl)) {
    snapshots.push({
      repo: existingString(metadata.prRepo),
      number: metadataNumber(metadata.prNumber),
      url: globalUrl,
      source: "global",
      headRefName: existingString(metadata.prHeadRefName),
      expectedBranch: existingString(metadata.branch),
      state: existingString(metadata.prState),
      mergedAt: existingString(metadata.prMergedAt),
      mergeCommitSha: existingString(metadata.prMergeCommitSha),
      isDraft: metadataBoolean(metadata.prIsDraft),
      mergeable: existingString(metadata.prMergeable),
      mergeStateStatus: existingString(metadata.prMergeStateStatus),
      reviewDecision: existingString(metadata.prReviewDecision),
      checksPassing: metadataBoolean(metadata.prChecksPassing),
      checksPending: metadataBoolean(metadata.prChecksPending),
      templateMissingHeadings: metadataStringArray(metadata.prTemplateMissingHeadings),
      autoReviewStatus: existingString(metadata.prAutoReviewStatus),
      autoReviewMustFix: metadataBoolean(metadata.prAutoReviewMustFix),
      autoReviewMustFixDetail: existingString(metadata.prAutoReviewMustFixDetail),
      autoReviewNeedsConfirmation: metadataBoolean(metadata.prAutoReviewNeedsConfirmation),
      autoReviewNeedsConfirmationDetail: existingString(metadata.prAutoReviewNeedsConfirmationDetail),
      reviewCommentCount: metadataNumber(metadata.prReviewCommentCount),
      reviewCommentAuthors: metadataStringArray(metadata.prReviewCommentAuthors),
      autoReviewNeedsConfirmationDisposition: existingString(metadata.prAutoReviewNeedsConfirmationDisposition),
      autoReviewNeedsConfirmationPostedUrl: existingString(metadata.prAutoReviewNeedsConfirmationPostedUrl),
      recordedAt: existingString(metadata.prRecordedAt),
    });
  }
  return snapshots;
}

export function selectPullRequestForGate(
  snapshots: PullRequestMetadataSnapshot[],
): PullRequestMetadataSnapshot | undefined {
  let selected = snapshots[0];
  let selectedScore = selected ? pullRequestSelectionScore(selected) : -1;
  for (const snapshot of snapshots.slice(1)) {
    const score = pullRequestSelectionScore(snapshot);
    if (score <= selectedScore) continue;
    selected = snapshot;
    selectedScore = score;
  }
  return selected;
}

export function repoFromPullRequestUrl(value: string): string | undefined {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/\d+/.exec(value);
  return match?.[1];
}

export function inferredRepoKeys(
  metadata: Record<string, unknown>,
  repoKeyFromRepoName?: (repoName: string) => string | undefined,
): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(metadata)) {
    const match = /^workflow\.repos\.([^.]+)\./.exec(key);
    if (match) keys.add(match[1]);
  }
  if (typeof metadata["workflow.repo"] === "string" && metadata["workflow.repo"]) {
    keys.add(metadata["workflow.repo"]);
  }
  const prUrl = typeof metadata.prUrl === "string" ? metadata.prUrl : undefined;
  const prRepo = prUrl ? repoFromPullRequestUrl(prUrl) : undefined;
  if (prRepo) {
    const resolved = repoKeyFromRepoName?.(prRepo) ?? normalizeRepoKey(prRepo);
    if (resolved) keys.add(resolved);
  }
  return [...keys];
}

export function findPullRequestForIssue(
  pullRequests: PullRequestStatus[],
  issueRef: string,
  branch: string,
): PullRequestStatus | undefined {
  const branchMatch = pullRequests.find((pr) => pr.headRefName === branch);
  if (branchMatch) return branchMatch;

  const issueKey = issueRef.toUpperCase();
  return pullRequests.find((pr) =>
    pr.headRefName.toUpperCase().includes(issueKey) ||
    pr.title.toUpperCase().includes(issueKey)
  );
}

export function pullRequestMetadata(repoKeyOrName: string, pr: PullRequestStatus): Record<string, unknown> {
  const normalizedRepoKey = normalizeRepoKey(repoKeyOrName);
  const snapshot = pullRequestStatusSnapshot(pr, "repo", normalizedRepoKey);
  return {
    ...globalPullRequestMetadata(snapshot),
    ...repoScopedPullRequestMetadata(normalizedRepoKey, snapshot),
  };
}

export function globalPullRequestMetadata(pr: PullRequestMetadataSnapshot): Record<string, unknown> {
  return {
    prRepo: pr.repo,
    prNumber: pr.number,
    prUrl: pr.url,
    prHeadRefName: pr.headRefName,
    prState: pr.state,
    prMergedAt: pr.mergedAt,
    prMergeCommitSha: pr.mergeCommitSha,
    prIsDraft: pr.isDraft,
    prMergeable: pr.mergeable,
    prMergeStateStatus: pr.mergeStateStatus,
    prReviewDecision: pr.reviewDecision,
    humanReviewRequired: pr.reviewDecision === "REVIEW_REQUIRED",
    prChecksPassing: pr.checksPassing,
    prChecksPending: pr.checksPending,
    prTemplateMissingHeadings: templateMissingHeadingsMetadata(pr.templateMissingHeadings),
    prAutoReviewStatus: pr.autoReviewStatus,
    prAutoReviewMustFix: pr.autoReviewMustFix,
    prAutoReviewMustFixDetail: pr.autoReviewMustFixDetail,
    prAutoReviewNeedsConfirmation: pr.autoReviewNeedsConfirmation,
    prAutoReviewNeedsConfirmationDetail: pr.autoReviewNeedsConfirmationDetail,
    prReviewCommentCount: pr.reviewCommentCount,
    prReviewCommentAuthors: pr.reviewCommentAuthors,
    prAutoReviewNeedsConfirmationDisposition: pr.autoReviewNeedsConfirmationDisposition,
    prAutoReviewNeedsConfirmationPostedUrl: pr.autoReviewNeedsConfirmationPostedUrl,
    prRecordedAt: pr.recordedAt ?? nowIso(),
  };
}

export function repoScopedPullRequestMetadata(
  repoKey: string,
  snapshot: PullRequestMetadataSnapshot,
): Record<string, unknown> {
  const prefix = `workflow.repos.${repoKey}.pr`;
  return {
    [`${prefix}_repo`]: snapshot.repo,
    [`${prefix}_number`]: snapshot.number,
    [`${prefix}_url`]: snapshot.url,
    [`${prefix}_head_ref_name`]: snapshot.headRefName,
    [`${prefix}_state`]: snapshot.state,
    [`${prefix}_merged_at`]: snapshot.mergedAt,
    [`${prefix}_merge_commit_sha`]: snapshot.mergeCommitSha,
    [`${prefix}_is_draft`]: snapshot.isDraft,
    [`${prefix}_mergeable`]: snapshot.mergeable,
    [`${prefix}_merge_state_status`]: snapshot.mergeStateStatus,
    [`${prefix}_review_decision`]: snapshot.reviewDecision,
    [`${prefix}_checks_passing`]: snapshot.checksPassing,
    [`${prefix}_checks_pending`]: snapshot.checksPending,
    [`${prefix}_template_missing_headings`]: templateMissingHeadingsMetadata(snapshot.templateMissingHeadings),
    [`${prefix}_auto_review_status`]: snapshot.autoReviewStatus,
    [`${prefix}_auto_review_must_fix`]: snapshot.autoReviewMustFix,
    [`${prefix}_auto_review_must_fix_detail`]: snapshot.autoReviewMustFixDetail,
    [`${prefix}_auto_review_needs_confirmation`]: snapshot.autoReviewNeedsConfirmation,
    [`${prefix}_auto_review_needs_confirmation_detail`]: snapshot.autoReviewNeedsConfirmationDetail,
    [`${prefix}_review_comment_count`]: snapshot.reviewCommentCount,
    [`${prefix}_review_comment_authors`]: snapshot.reviewCommentAuthors,
    [`${prefix}_auto_review_needs_confirmation_disposition`]: snapshot.autoReviewNeedsConfirmationDisposition,
    [`${prefix}_auto_review_needs_confirmation_posted_url`]: snapshot.autoReviewNeedsConfirmationPostedUrl,
    [`${prefix}_recorded_at`]: snapshot.recordedAt ?? nowIso(),
  };
}

export function pullRequestStatusSnapshot(
  pr: PullRequestStatus,
  source: PullRequestMetadataSnapshot["source"],
  repoKey?: string,
): PullRequestMetadataSnapshot {
  return {
    source,
    repoKey,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName,
    state: pr.state,
    mergedAt: pr.mergedAt,
    mergeCommitSha: pr.mergeCommitSha,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    checksPassing: pr.checksPassing,
    checksPending: pr.checksPending,
    templateMissingHeadings: pr.templateMissingHeadings,
    autoReviewStatus: pr.autoReviewStatus,
    autoReviewMustFix: pr.autoReviewMustFix,
    autoReviewMustFixDetail: pr.autoReviewMustFixDetail,
    autoReviewNeedsConfirmation: pr.autoReviewNeedsConfirmation,
    autoReviewNeedsConfirmationDetail: pr.autoReviewNeedsConfirmationDetail,
    reviewCommentCount: pr.reviewCommentCount,
    reviewCommentAuthors: pr.reviewCommentAuthors,
    recordedAt: nowIso(),
  };
}

export { isPullRequestConflicted };

// --- Internal helpers ---

function pullRequestSelectionScore(snapshot: PullRequestMetadataSnapshot): number {
  return pullRequestCurrentScore(snapshot) + pullRequestBlockerScore(snapshot);
}

function pullRequestCurrentScore(snapshot: PullRequestMetadataSnapshot): number {
  if (snapshot.source !== "repo") return 0;
  if (snapshot.expectedBranch && snapshot.headRefName === snapshot.expectedBranch) return 1000;
  return 500;
}

function pullRequestBlockerScore(snapshot: PullRequestMetadataSnapshot): number {
  if (isPullRequestSnapshotMerged(snapshot)) return 0;
  if (snapshot.isDraft === true) return 100;
  if (isPullRequestConflicted(snapshot)) return 90;
  if (snapshot.checksPassing === false) return 80;
  if (snapshot.checksPending === true) return 78;
  if (snapshot.templateMissingHeadings && snapshot.templateMissingHeadings.length > 0) return 75;
  if (snapshot.autoReviewMustFix === true) return 70;
  if (snapshot.autoReviewStatus === "failed") return 60;
  if (snapshot.autoReviewStatus === "pending") return 50;
  if (snapshot.autoReviewNeedsConfirmation === true) return 40;
  return 0;
}

function isPullRequestSnapshotMerged(snapshot: PullRequestMetadataSnapshot): boolean {
  return snapshot.state?.toUpperCase() === "MERGED" || Boolean(snapshot.mergedAt);
}

function isUndraftWorkerRun(run: WorkerRunRecord): boolean {
  const text = `${run.taskId} ${run.summary ?? ""}`.toLowerCase();
  return text.includes("undraft") || text.includes("ready-for-review") || text.includes("ready for review");
}

function templateMissingHeadingsMetadata(value: string[] | undefined): string[] {
  return value?.length ? value : [];
}

function maybeSet(
  updates: Record<string, unknown>,
  metadata: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === "") return;
  if (isRecordedAtPullRequestKey(key) && typeof metadata[key] === "string") return;
  if (metadataValueEquals(metadata[key], value)) return;
  updates[key] = value;
}

function isRecordedAtPullRequestKey(key: string): boolean {
  return key === "prRecordedAt" || key.endsWith("_recorded_at");
}

const clearableAggregatePullRequestKeys = new Set([
  "prState",
  "prMergedAt",
  "prMergeCommitSha",
  "prMergeable",
  "prMergeStateStatus",
  "prReviewDecision",
  "humanReviewRequired",
  "prChecksPassing",
  "prAutoReviewStatus",
  "prAutoReviewMustFix",
  "prAutoReviewMustFixDetail",
  "prAutoReviewNeedsConfirmation",
  "prAutoReviewNeedsConfirmationDetail",
  "prAutoReviewNeedsConfirmationDisposition",
  "prAutoReviewNeedsConfirmationPostedUrl",
]);

function maybeSetAggregatePr(
  updates: Record<string, unknown>,
  metadata: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if ((value === undefined || value === "") && clearableAggregatePullRequestKeys.has(key)) {
    if (metadata[key] !== undefined && metadata[key] !== "") updates[key] = undefined;
    return;
  }
  maybeSet(updates, metadata, key, value);
}

function aggregatePullRequestMetadata(
  metadata: Record<string, unknown>,
  repoKeys: string[],
  repoNameFallback: (repoKey: string) => string,
): Record<string, unknown> {
  const selected = selectPullRequestForGate(collectPullRequestSnapshots(metadata, repoKeys, repoNameFallback));
  if (!selected) return {};
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(globalPullRequestMetadata(selected))) {
    maybeSetAggregatePr(updates, metadata, key, value);
  }
  return updates;
}

function externallyDrivenState(current: WorkItem["state"], metadata: Record<string, unknown>): WorkItem["state"] {
  const issueStatus = existingString(metadata.issueStatus)?.toLowerCase() ?? "";
  const issueStatusCategory = existingString(metadata.issueStatusCategory)?.toLowerCase() ?? "";
  const issueResolution = existingString(metadata.issueResolution)?.toLowerCase() ?? "";
  const jiraStatus = existingString(metadata.jiraStatus)?.toLowerCase() ?? "";
  const jiraStatusCategory = existingString(metadata.jiraStatusCategory)?.toLowerCase() ?? "";
  const jiraResolution = existingString(metadata.jiraResolution)?.toLowerCase() ?? "";
  const localStatus = existingString(metadata.localStatus)?.toLowerCase() ?? "";
  const localStatusCategory = existingString(metadata.localStatusCategory)?.toLowerCase() ?? "";
  if (
    issueStatusCategory === "done" ||
    issueStatusCategory === "complete" ||
    issueStatus === "done" ||
    issueStatus === "closed" ||
    issueStatus === "complete" ||
    issueResolution === "done" ||
    issueResolution === "complete" ||
    localStatusCategory === "done" ||
    localStatusCategory === "complete" ||
    localStatus === "done" ||
    localStatus === "closed" ||
    localStatus === "complete" ||
    jiraStatusCategory === "done" ||
    jiraStatus === "done" ||
    jiraStatus === "closed" ||
    jiraResolution === "done" ||
    jiraStatus === "ready for qa"
  ) {
    return "done";
  }
  if (existingString(metadata.prMergedAt)) return "done";
  if (existingString(metadata.prUrl) && metadata.prIsDraft === true) return "blocked";
  if (issueStatus.includes("review") || localStatus.includes("review") || jiraStatus.includes("review")) return "awaiting_human";
  if (metadata.humanReviewRequired === true) return "awaiting_human";
  if (existingString(metadata.prUrl)) return "awaiting_review";
  return current;
}

function autoReviewNeedsConfirmationDefaultDisposition(): "accept" | "reject" | "defer" | undefined {
  return undefined;
}

function defaultStaleWorkerRunMs(): number {
  return 20 * 60 * 1000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
