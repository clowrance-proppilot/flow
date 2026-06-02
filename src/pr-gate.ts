export type PullRequestGateRule =
  | "draft"
  | "conflicts"
  | "checks_pending"
  | "checks_failed"
  | "template_missing"
  | "auto_review_failed"
  | "auto_review_pending"
  | "auto_review_must_fix"
  | "auto_review_needs_confirmation"
  | "approval_required";

export interface PullRequestGateInput {
  state?: string;
  mergedAt?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  checksPending?: boolean;
  checksPassing?: boolean;
  templateMissingHeadings?: string[];
  autoReviewStatus?: string;
  autoReviewMustFix?: boolean;
  autoReviewMustFixDetail?: string;
  autoReviewNeedsConfirmation?: boolean;
  autoReviewNeedsConfirmationDisposition?: string;
  autoReviewNeedsConfirmationPostedUrl?: string;
  autoReviewNeedsConfirmationDetail?: string;
  reviewDecision?: string;
  humanReviewRequired?: boolean;
}

export interface PullRequestGateResult {
  rule: PullRequestGateRule;
  detail?: string;
}

export function evaluatePullRequestGates(input: PullRequestGateInput): PullRequestGateResult[] {
  if (isPullRequestMerged(input)) return [];
  const results: PullRequestGateResult[] = [];

  if (input.isDraft) results.push({ rule: "draft" });
  if (isPullRequestConflicted(input)) results.push({ rule: "conflicts" });

  if (input.checksPending === true) {
    results.push({ rule: "checks_pending" });
  } else if (input.checksPassing === false) {
    results.push({ rule: "checks_failed" });
  }

  if (hasMissingTemplateHeadings(input)) {
    results.push({ rule: "template_missing", detail: input.templateMissingHeadings.join(", ") });
  }
  if (input.autoReviewStatus === "failed") results.push({ rule: "auto_review_failed" });
  if (input.autoReviewStatus === "pending") results.push({ rule: "auto_review_pending" });
  if (input.autoReviewMustFix === true) {
    results.push({ rule: "auto_review_must_fix", detail: input.autoReviewMustFixDetail });
  }
  if (
    input.autoReviewNeedsConfirmation === true &&
    !(input.autoReviewNeedsConfirmationDisposition && input.autoReviewNeedsConfirmationPostedUrl)
  ) {
    results.push({ rule: "auto_review_needs_confirmation", detail: input.autoReviewNeedsConfirmationDetail });
  }
  if (
    input.reviewDecision === "CHANGES_REQUESTED" ||
    input.reviewDecision === "REVIEW_REQUIRED" ||
    (input.humanReviewRequired && input.reviewDecision !== "APPROVED")
  ) {
    results.push({ rule: "approval_required" });
  }

  return results;
}

export function pullRequestGatesSatisfied(input: PullRequestGateInput): boolean {
  return evaluatePullRequestGates(input).length === 0;
}

export function defaultPullRequestGateMessage(rule: PullRequestGateRule, detail?: string): { summary: string; detail?: string } {
  if (rule === "draft") return { summary: "Pull request is still draft." };
  if (rule === "conflicts") return { summary: "Pull request has merge conflicts." };
  if (rule === "checks_pending") return { summary: "Pull request checks are still running." };
  if (rule === "checks_failed") return { summary: "Pull request checks are not passing." };
  if (rule === "template_missing") {
    return {
      summary: "Pull request does not follow the repo template.",
      ...(detail ? { detail: `Missing template headings: ${detail}.` } : {}),
    };
  }
  if (rule === "auto_review_failed") return { summary: "Auto review checks failed." };
  if (rule === "auto_review_pending") return { summary: "Auto review is still running." };
  if (rule === "auto_review_must_fix") {
    return {
      summary: "Auto review has must-fix feedback.",
      ...(detail ? { detail } : {}),
    };
  }
  if (rule === "auto_review_needs_confirmation") {
    return {
      summary: "Auto review requires confirmation.",
      ...(detail ? { detail } : {}),
    };
  }
  return { summary: "Approval review is required." };
}

export function isPullRequestMerged(input: { state?: string; mergedAt?: string } | undefined): boolean {
  return input?.state?.toUpperCase() === "MERGED" || Boolean(input?.mergedAt);
}

export function isPullRequestConflicted(input: { mergeable?: string; mergeStateStatus?: string } | undefined): boolean {
  const mergeable = input?.mergeable?.toUpperCase();
  const mergeStateStatus = input?.mergeStateStatus?.toUpperCase();
  return mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY";
}

export function isEmptyAutoReviewDetail(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^none(?:\s+(?:identified|found))?\.?$/i.test(normalized);
}

function hasMissingTemplateHeadings(input: { templateMissingHeadings?: string[] }): input is { templateMissingHeadings: string[] } {
  return Array.isArray(input.templateMissingHeadings) && input.templateMissingHeadings.length > 0;
}
