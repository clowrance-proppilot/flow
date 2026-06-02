import {
  type ReadinessFinding,
  type WorkItem,
  type WorkerTaskResult,
  createId,
  nowIso,
} from "./contracts.js";

export interface ReadinessAssessmentInput {
  issue: WorkItem;
  workerResults?: WorkerTaskResult[];
  review?: {
    prUrl?: string;
    state?: string;
    mergedAt?: string;
    isDraft?: boolean;
    mergeable?: string;
    mergeStateStatus?: string;
    checksPassing?: boolean;
    checksPending?: boolean;
    templateMissingHeadings?: string[];
    autoReviewStatus?: string;
    autoReviewMustFix?: boolean;
    autoReviewMustFixDetail?: string;
    autoReviewNeedsConfirmation?: boolean;
    autoReviewNeedsConfirmationDetail?: string;
    autoReviewNeedsConfirmationDisposition?: string;
    autoReviewNeedsConfirmationPostedUrl?: string;
    checkedAt?: string;
    humanReviewRequired?: boolean;
    reviewDecision?: string;
    reviewCommentCount?: number;
    reviewCommentAuthors?: string[];
  };
  evidenceRecorded?: boolean;
  documentationRecorded?: boolean;
  codeReviewRequired?: boolean;
}

export interface ReadinessAssessment {
  issueRef: string;
  findings: ReadinessFinding[];
  readyToAdvance: boolean;
  reviewReady: boolean;
}

export function assessIssue(input: ReadinessAssessmentInput): ReadinessAssessment {
  const findings: ReadinessFinding[] = [];
  const workerResults = input.workerResults ?? [];
  const latestWorker = workerResults.at(-1);
  const latestSuccessfulWorker = latestSuccessfulWorkerResult(workerResults);
  const satisfiedPrWorker = latestWorker && shouldIgnoreSatisfiedPrWorker(latestWorker, input.review);
  const satisfiedWorkspaceWorker = latestWorker && shouldIgnoreSatisfiedWorkspaceWorker(latestWorker, input.issue);
  const shouldIgnoreLatestWorker = Boolean(satisfiedPrWorker || satisfiedWorkspaceWorker);
  const workerForReadiness = shouldIgnoreLatestWorker
    ? latestSuccessfulWorker
    : latestWorker && shouldAutoRetryWorker(latestWorker) && latestSuccessfulWorker
    ? latestSuccessfulWorker
    : latestWorker;
  const hasSuccessfulWorker = workerForReadiness?.status === "succeeded" &&
    (workerHasCompletionOutput(workerForReadiness) || Boolean(input.review?.prUrl));
  const externalProviderEscalation = input.issue.metadata.externalProviderEscalation;
  const codeReviewRequired = (input.codeReviewRequired ?? true) && !isRecordedOnBaseBranch(input.issue);

  if (input.issue.repoKeys.length === 0) {
    findings.push(finding(input.issue.ref, "blocker", "Repo routing is missing."));
  }

  if (!latestWorker && input.issue.repoKeys.length > 0 && !hasPreparedWorkspace(input.issue)) {
    findings.push(finding(input.issue.ref, "blocker", "Prepared worktree is missing."));
  }

  if (
    !shouldIgnoreLatestWorker &&
    !isProviderCredentialWorkerFailure(latestWorker) &&
    (latestWorker?.status === "failed" || latestWorker?.status === "blocked")
  ) {
    const workerSummary = readableText(latestWorker.summary);
    const summary = workerSummary ? `Worker is blocked: ${workerSummary}` : "Worker is blocked";
    const severity = shouldAutoRetryWorker(latestWorker) ? "warning" : "blocker";
    findings.push(finding(input.issue.ref, severity, summary, latestWorker.nextPickup));
  }

  if (latestWorker?.status === "running" || latestWorker?.status === "queued") {
    findings.push(
      finding(
        input.issue.ref,
        "blocker",
        "Execution handoff is already active for this issue.",
        "Wait for the current Worker run to finish before requesting another run.",
      ),
    );
  }

  for (const blocker of shouldIgnoreLatestWorker ? [] : latestWorker?.blockers ?? []) {
    const cleaned = readableText(blocker);
    if (!cleaned) continue;
    if (latestWorker && shouldTreatBlockerAsRetryable(cleaned, latestWorker)) continue;
    findings.push(finding(input.issue.ref, "blocker", cleaned));
  }

  if (input.issue.state === "running" && !latestWorker) {
    findings.push(finding(input.issue.ref, "warning", "Issue is marked running but has no execution result."));
  }

  if (latestWorker?.status === "succeeded" && !workerHasCompletionOutput(latestWorker) && !input.review?.prUrl) {
    findings.push(finding(
      input.issue.ref,
      "warning",
      "Successful worker result has no changed files or tests.",
      "Retry execution before applying closeout gates.",
    ));
  }

  const pullRequestMerged = isPullRequestMerged(input.review);

  if (input.review?.prUrl && !pullRequestMerged && hasDirtyPreparedWorktree(input.issue) && latestSuccessfulWorker) {
    findings.push(finding(
      input.issue.ref,
      "blocker",
      "Executor changes are not pushed.",
      "Commit and push the prepared worktree changes before reassessing pull request checks.",
    ));
  }

  if (input.review?.prUrl && !pullRequestMerged && input.review.isDraft) {
    findings.push(finding(input.issue.ref, "blocker", "Pull request is still draft."));
  }

  if (input.review?.prUrl && !pullRequestMerged && isPullRequestConflicted(input.review)) {
    findings.push(finding(input.issue.ref, "blocker", "Pull request has merge conflicts."));
  }

  if (input.review?.prUrl && !pullRequestMerged && input.review.checksPending === true) {
    findings.push(finding(input.issue.ref, "blocker", "Pull request checks are still running."));
  } else if (input.review?.prUrl && !pullRequestMerged && input.review.checksPassing === false) {
    findings.push(finding(input.issue.ref, "blocker", "Pull request checks are not passing."));
  }

  if (input.review?.prUrl && !pullRequestMerged && hasMissingPullRequestTemplateHeadings(input.review)) {
    findings.push(finding(
      input.issue.ref,
      "blocker",
      "Pull request does not follow the repo template.",
      `Missing template headings: ${input.review.templateMissingHeadings.join(", ")}.`,
    ));
  }

  if (input.review?.prUrl && !pullRequestMerged && input.review.autoReviewStatus === "failed") {
    findings.push(finding(input.issue.ref, "blocker", "Auto review checks failed."));
  }

  if (input.review?.prUrl && !pullRequestMerged && input.review.autoReviewStatus === "pending") {
    findings.push(finding(input.issue.ref, "blocker", "Auto review is still running."));
  }

  if (input.review?.prUrl && !pullRequestMerged && input.review.autoReviewMustFix && !isEmptyAutoReviewDetail(input.review.autoReviewMustFixDetail)) {
    const detail = input.review.autoReviewMustFixDetail ??
      "Resolve the auto-review must-fix feedback before advancing.";
    findings.push(finding(input.issue.ref, "blocker", "Auto review has must-fix feedback.", detail));
  }

  if (input.review?.prUrl && !pullRequestMerged && input.review.autoReviewNeedsConfirmation) {
    const disposition = input.review.autoReviewNeedsConfirmationDisposition;
    const postedUrl = input.review.autoReviewNeedsConfirmationPostedUrl;
    const detail = input.review.autoReviewNeedsConfirmationDetail ??
      "Review the auto-review needs-confirmation item and record accept/reject/defer before advancing.";
    if (disposition && postedUrl) {
      findings.push(finding(input.issue.ref, "info", `Auto review needs-confirmation resolved as ${disposition}.`, detail));
    } else if (disposition) {
      findings.push(finding(input.issue.ref, "blocker", "Auto review confirmation has not been posted to the code review.", detail));
    } else {
      findings.push(finding(input.issue.ref, "blocker", "Auto review requires confirmation.", detail));
    }
  }

  if (input.review?.prUrl && !pullRequestMerged && isStaleReviewSnapshot(input.review.checkedAt)) {
    findings.push(finding(input.issue.ref, "warning", "Pull request status is stale; refresh is required."));
  }

  if (isExternalProviderEscalation(externalProviderEscalation)) {
    findings.push(finding(
      input.issue.ref,
      "blocker",
      `Blocked on ${externalProviderEscalation.provider} escalation.`,
      externalProviderEscalation.blocker,
    ));
  }

  if (hasSuccessfulWorker && !input.evidenceRecorded) {
    findings.push(finding(input.issue.ref, "blocker", "Acceptance evidence is missing."));
  }

  if (hasSuccessfulWorker && !input.documentationRecorded) {
    findings.push(finding(input.issue.ref, "blocker", "Documentation disposition is missing."));
  }

  if (hasSuccessfulWorker && codeReviewRequired && !input.review?.prUrl) {
    findings.push(finding(input.issue.ref, "blocker", "Pull request is missing."));
  }

  if (!pullRequestMerged && input.review?.humanReviewRequired) {
    if ((input.review.reviewCommentCount ?? 0) > 0) {
      const authors = input.review.reviewCommentAuthors?.length
        ? ` from ${input.review.reviewCommentAuthors.join(", ")}`
        : "";
      findings.push(finding(
        input.issue.ref,
        "info",
        "Review comments are present.",
        `Inspect and address any actionable PR review comments${authors} before requesting approval.`,
      ));
    }
    const reviewDecision = input.review.reviewDecision
      ? ` Review decision is ${input.review.reviewDecision}.`
      : "";
    findings.push(finding(
      input.issue.ref,
      "info",
      "Approval review is required.",
      `No approving review is recorded.${reviewDecision} Comment-only reviews do not satisfy approval-required review policy.`,
    ));
  }

  const hasBlocker = findings.some((item) => item.severity === "blocker");
  const pullRequestGateSatisfied = codeReviewRequired ? Boolean(input.review?.prUrl) : true;
  const pullRequestStateReady = !input.review?.prUrl ||
      (pullRequestMerged || input.review?.isDraft === false) &&
      (pullRequestMerged || !isPullRequestConflicted(input.review)) &&
      (pullRequestMerged || input.review?.checksPending !== true) &&
      (pullRequestMerged || input.review?.checksPassing !== false) &&
      (pullRequestMerged || !hasMissingPullRequestTemplateHeadings(input.review)) &&
      (pullRequestMerged || input.review?.autoReviewStatus !== "failed") &&
      (pullRequestMerged || input.review?.autoReviewStatus !== "pending") &&
      (pullRequestMerged || input.review?.autoReviewMustFix !== true || isEmptyAutoReviewDetail(input.review?.autoReviewMustFixDetail)) &&
      (pullRequestMerged || input.review?.autoReviewNeedsConfirmation !== true ||
        Boolean(input.review?.autoReviewNeedsConfirmationDisposition && input.review?.autoReviewNeedsConfirmationPostedUrl));
  const reviewReady =
    !hasBlocker &&
    hasSuccessfulWorker &&
    pullRequestGateSatisfied &&
    pullRequestStateReady &&
    input.evidenceRecorded === true &&
    input.documentationRecorded === true;

  return {
    issueRef: input.issue.ref,
    findings,
    readyToAdvance: !hasBlocker,
    reviewReady,
  };
}

function latestSuccessfulWorkerResult(workerResults: WorkerTaskResult[]): WorkerTaskResult | undefined {
  for (let index = workerResults.length - 1; index >= 0; index -= 1) {
    const result = workerResults[index];
    if (result?.status === "succeeded") return result;
  }
  return undefined;
}

function isRecordedOnBaseBranch(issue: WorkItem): boolean {
  const repoKeys = issue.repoKeys.length ? issue.repoKeys : [""];
  for (const repoKey of repoKeys) {
    const branch = metadataString(
      repoKey ? issue.metadata[`workflow.repos.${repoKey}.branch`] : issue.metadata.branch,
    ) ?? metadataString(issue.metadata.branch);
    const baseBranch = metadataString(
      repoKey ? issue.metadata[`workflow.repos.${repoKey}.base_branch`] : issue.metadata.baseBranch,
    ) ?? metadataString(issue.metadata.baseBranch) ?? "main";
    if (branch && branch === baseBranch) return true;
  }
  return false;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workerHasCompletionOutput(result: WorkerTaskResult): boolean {
  return result.changedFiles.length > 0 || result.testsRun.length > 0;
}

function blockedAssessment(issueRef: string, findings: ReadinessFinding[]): ReadinessAssessment {
  return {
    issueRef,
    findings,
    readyToAdvance: false,
    reviewReady: false,
  };
}

function isExternalProviderEscalation(value: unknown): value is { provider: string; blocker: string } {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    Boolean((value as { provider?: string }).provider) &&
    typeof (value as { blocker?: unknown }).blocker === "string" &&
    Boolean((value as { blocker?: string }).blocker);
}

function isPullRequestConflicted(review: { mergeable?: string; mergeStateStatus?: string } | undefined): boolean {
  const mergeable = review?.mergeable?.toUpperCase();
  const mergeStateStatus = review?.mergeStateStatus?.toUpperCase();
  return mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY";
}

function isPullRequestMerged(review: { state?: string; mergedAt?: string } | undefined): boolean {
  return review?.state?.toUpperCase() === "MERGED" || Boolean(review?.mergedAt);
}

function isEmptyAutoReviewDetail(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^none(?:\s+(?:identified|found))?\.?$/i.test(normalized);
}

function hasMissingPullRequestTemplateHeadings(review: { templateMissingHeadings?: string[] } | undefined): review is {
  templateMissingHeadings: string[];
} {
  return Array.isArray(review?.templateMissingHeadings) && review.templateMissingHeadings.length > 0;
}

function isStaleReviewSnapshot(checkedAt: string | undefined): boolean {
  if (!checkedAt) return true;
  const parsed = Date.parse(checkedAt);
  if (Number.isNaN(parsed)) return true;
  return Date.now() - parsed > 10 * 60 * 1000;
}

function hasPreparedWorkspace(issue: WorkItem): boolean {
  const metadata = issue.metadata;
  if (typeof metadata.work_dir === "string" && metadata.work_dir) return true;
  if (typeof metadata.worktree_path === "string" && metadata.worktree_path) return true;
  return issue.repoKeys.some((repoKey) => {
    const normalized = repoKey.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
    return typeof metadata[`workflow.repos.${normalized}.worktree_path`] === "string" &&
      Boolean(metadata[`workflow.repos.${normalized}.worktree_path`]);
  });
}

function hasDirtyPreparedWorktree(issue: WorkItem): boolean {
  const metadata = issue.metadata;
  return issue.repoKeys.some((repoKey) => {
    const normalized = repoKey.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
    return metadata[`workflow.repos.${normalized}.dirty`] === true;
  });
}

function finding(
  issueRef: string,
  severity: ReadinessFinding["severity"],
  summary: string,
  detail?: string,
): ReadinessFinding {
  return {
    id: createId("finding"),
    severity,
    summary,
    detail,
    issueRef,
    source: "readiness",
    createdAt: nowIso(),
  };
}

function readableText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (!/[a-zA-Z0-9]/.test(compact)) return undefined;
  if (/^[\[\]{}(),:;'"`]+$/.test(compact)) return undefined;
  return compact;
}

export function isRetryableWorkerFailure(result: WorkerTaskResult | undefined): boolean {
  if (!result || (result.status !== "blocked" && result.status !== "failed")) return false;
  const text = readableText([
    result.summary,
    result.nextPickup,
    ...result.blockers,
  ].filter((item): item is string => typeof item === "string").join(" "))?.toLowerCase() ?? "";
  if (text.includes("without a readable error message")) return true;
  if (text.includes("timed out")) return true;
  if (text.includes("interrupted before returning a structured result")) return true;
  if (text.includes("provider credentials")) return true;
  if (text.includes("executor setup")) return true;
  if (text.includes("environment setup")) return true;
  if (text.includes("pi sdk")) return true;
  if (text.includes("@earendil-works/pi-coding-agent")) return true;
  if (text.includes("worker session stalled")) return true;
  if (text.includes("autoflow") && text.includes("stuck")) return true;
  return false;
}

function shouldAutoRetryWorker(result: WorkerTaskResult): boolean {
  return isRetryableWorkerFailure(result);
}

function shouldTreatBlockerAsRetryable(blocker: string, result: WorkerTaskResult): boolean {
  if (!shouldAutoRetryWorker(result)) return false;
  const normalized = blocker.toLowerCase();
  return normalized.includes("without a readable error message") ||
    normalized.includes("timed out") ||
    normalized.includes("interrupted before returning a structured result") ||
    normalized.includes("provider credentials") ||
    normalized.includes("executor setup") ||
    normalized.includes("environment setup") ||
    normalized.includes("pi sdk") ||
    normalized.includes("@earendil-works/pi-coding-agent") ||
    normalized.includes("worker session stalled") ||
    (normalized.includes("autoflow") && normalized.includes("stuck"));
}

function isProviderCredentialWorkerFailure(result: WorkerTaskResult | undefined): boolean {
  if (!result || (result.status !== "blocked" && result.status !== "failed")) return false;
  const text = `${result.summary} ${result.nextPickup ?? ""} ${result.blockers.join(" ")}`.toLowerCase();
  return text.includes("provider credentials");
}

function shouldIgnoreSatisfiedPrWorker(
  result: WorkerTaskResult,
  review: ReadinessAssessmentInput["review"],
): boolean {
  if (result.status !== "blocked" && result.status !== "failed") return false;
  if (review?.isDraft !== false) return false;
  const text = `${result.taskId} ${result.summary} ${result.nextPickup ?? ""} ${result.handoffPrompt ?? ""}`.toLowerCase();
  return text.includes("undraft") || text.includes("ready-for-review") || text.includes("ready for review");
}

function shouldIgnoreSatisfiedWorkspaceWorker(
  result: WorkerTaskResult,
  issue: WorkItem,
): boolean {
  if (result.status !== "blocked" && result.status !== "failed") return false;
  if (!hasPreparedWorkspace(issue)) return false;
  const text = `${result.summary} ${result.nextPickup ?? ""} ${result.blockers.join(" ")}`.toLowerCase();
  return text.includes("workspace path is missing") ||
    (text.includes("prepared workspace") && text.includes("missing"));
}
