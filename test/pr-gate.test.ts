import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultPullRequestGateMessage,
  evaluatePullRequestGates,
  isEmptyAutoReviewDetail,
  pullRequestGatesSatisfied,
} from "../src/pr-gate.js";

test("pull request gates detect review blockers in stable order", () => {
  const gates = evaluatePullRequestGates({
    isDraft: true,
    mergeable: "CONFLICTING",
    checksPending: true,
    templateMissingHeadings: ["Summary"],
    autoReviewStatus: "failed",
    autoReviewMustFix: true,
    autoReviewMustFixDetail: "Fix the regression.",
    autoReviewNeedsConfirmation: true,
    autoReviewNeedsConfirmationDetail: "Confirm generated docs.",
    humanReviewRequired: true,
    reviewDecision: "REVIEW_REQUIRED",
  });

  assert.deepEqual(gates.map((gate) => gate.rule), [
    "draft",
    "conflicts",
    "checks_pending",
    "template_missing",
    "auto_review_failed",
    "auto_review_must_fix",
    "auto_review_needs_confirmation",
    "approval_required",
  ]);
  assert.equal(defaultPullRequestGateMessage(gates[3]!.rule, gates[3]!.detail).detail, "Missing template headings: Summary.");
});

test("pull request gates are satisfied for merged pull requests", () => {
  assert.deepEqual(evaluatePullRequestGates({
    state: "MERGED",
    isDraft: true,
    checksPassing: false,
  }), []);
  assert.equal(pullRequestGatesSatisfied({ mergedAt: "2026-06-02T00:00:00Z", checksPassing: false }), true);
});

test("empty auto-review must-fix details can be ignored by callers", () => {
  assert.equal(isEmptyAutoReviewDetail("- None identified."), true);
  assert.equal(isEmptyAutoReviewDetail("Fix this."), false);
});
