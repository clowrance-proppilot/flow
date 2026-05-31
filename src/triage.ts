/**
 * Issue triage engine for Flow.
 *
 * Analyzes open issues and proposes structured triage actions:
 * - Missing section detection
 * - Duplicate candidate detection
 * - Priority and lane tag proposals
 * - Close-as-duplicate/not-needed proposals
 */

import type {
  UnifiedIssue,
  TriageOptions,
  TriageResult,
  TriageIssueResult,
  TriageMissingSection,
  TriageDuplicateCandidate,
  TriageAction,
} from "./adapters/provider-contracts.js";

const REQUIRED_SECTIONS: Array<{ section: string; patterns: RegExp[]; description: string }> = [
  {
    section: "Problem",
    patterns: [/^##\s*Problem\b/im, /^##\s*Issue\b/im, /^##\s*Motivation\b/im],
    description: "A clear description of the problem being solved",
  },
  {
    section: "Scope",
    patterns: [/^##\s*Scope\b/im, /^##\s*In\s*Scope\b/im],
    description: "What is included in this issue",
  },
  {
    section: "Out of scope",
    patterns: [/^##\s*Out\s*of\s*Scope\b/im, /^##\s*Not\s*in\s*Scope\b/im],
    description: "What is explicitly excluded",
  },
  {
    section: "Files to inspect first",
    patterns: [/^##\s*Files?\s*to\s*[Ii]nspect\b/im, /^##\s*Relevant\s*Files?\b/im, /^##\s*Key\s*Files?\b/im],
    description: "Files that should be examined first",
  },
  {
    section: "Acceptance criteria",
    patterns: [/^##\s*Acceptance\s*[Cc]riteria\b/im, /^##\s*Done\s*[Ww]hen\b/im, /^##\s*Success\s*[Cc]riteria\b/im],
    description: "Measurable criteria for completion",
  },
  {
    section: "Verification commands",
    patterns: [/^##\s*Verification\b/im, /^##\s*[Hh]ow\s*to\s*[Tt]est\b/im, /^##\s*Testing\b/im],
    description: "Commands or steps to verify the work",
  },
  {
    section: "Dependencies",
    patterns: [/^##\s*Dependencies?\b/im, /^##\s*[Bb]locked\s*[Bb]y\b/im, /^##\s*[Rr]elated\b/im],
    description: "Dependencies on other work or issues",
  },
  {
    section: "Concurrency notes",
    patterns: [/^##\s*Concurrency\b/im, /^##\s*[Pp]arallel\b/im, /^##\s*[Oo]verlap\b/im],
    description: "Notes about concurrent work or conflicts",
  },
];

const PRIORITY_TAGS = ["critical", "priority-p0", "priority-p1", "priority-p2", "priority-p3"];
const LANE_TAGS = ["lane-sql", "lane-desktop-runner", "lane-test-infra", "lane-docs"];

const VAGUE_TITLE_PATTERNS = [
  /^(fix|update|change|improve|add|remove|refactor)\s+.*\s+(stuff|things|issue|bug|problem)$/i,
  /^(misc|miscellaneous|general|various)\b/i,
  /^(wip|todo|tbd|fixme)\b/i,
];

export interface TriageEngineOptions {
  issues: UnifiedIssue[];
  options: TriageOptions;
  postComment?: (ref: string, body: string) => Promise<{ url?: string; body: string }>;
  transitionIssue?: (ref: string, status: string) => Promise<unknown>;
  addTags?: (ref: string, tags: string[]) => Promise<unknown>;
  removeTags?: (ref: string, tags: string[]) => Promise<unknown>;
}

export async function triageIssues(params: TriageEngineOptions): Promise<TriageResult> {
  const { issues, options } = params;
  const isDryRun = options.apply !== true;
  const targetIds = options.ids?.map((id) => id.toUpperCase()) ?? [];
  const filteredIssues = targetIds.length > 0
    ? issues.filter((issue) => targetIds.includes(issue.ref.toUpperCase()))
    : issues;

  const limit = options.limit ?? filteredIssues.length;
  const issuesToTriage = filteredIssues.slice(0, limit);

  const issueResults: TriageIssueResult[] = [];
  const allProposedActions: TriageAction[] = [];

  for (const issue of issuesToTriage) {
    const result = triageIssue(issue, issuesToTriage);
    issueResults.push(result);
    allProposedActions.push(...result.proposedActions);
  }

  const result: TriageResult = {
    dryRun: isDryRun,
    issuesScanned: issuesToTriage.length,
    issues: issueResults,
    proposedActions: allProposedActions,
    appliedActions: isDryRun ? undefined : [],
  };

  if (!isDryRun) {
    result.appliedActions = [];
    for (const action of safeActionsForApply(allProposedActions)) {
      const applied = await applyAction(params, action);
      if (applied) result.appliedActions.push(action);
    }
  }

  return result;
}

function triageIssue(issue: UnifiedIssue, allIssues: UnifiedIssue[]): TriageIssueResult {
  const body = issue.description ?? "";
  const missingSections = detectMissingSections(body);
  const duplicateCandidates = detectDuplicateCandidates(issue, allIssues);
  const proposedLabels: string[] = [];
  const proposedActions: TriageAction[] = [];

  // Detect priority from existing tags
  const existingPriority = issue.labels.find((label) =>
    PRIORITY_TAGS.includes(label.toLowerCase())
  );
  const proposedPriority = existingPriority ?? proposePriority(issue, missingSections);

  // Detect lane from existing tags
  const existingLane = issue.labels.find((label) =>
    LANE_TAGS.includes(label.toLowerCase())
  );
  const proposedLane = existingLane ?? proposeLane(issue);

  // Propose priority tag if missing
  if (!existingPriority && proposedPriority) {
    proposedLabels.push(proposedPriority);
    proposedActions.push({
      type: "add_tag",
      target: issue.ref,
      payload: { tags: [proposedPriority] },
      reason: `Issue lacks a priority tag; proposed ${proposedPriority} based on content analysis`,
    });
  }

  // Propose lane tag if missing
  if (!existingLane && proposedLane) {
    proposedLabels.push(proposedLane);
    proposedActions.push({
      type: "add_tag",
      target: issue.ref,
      payload: { tags: [proposedLane] },
      reason: `Issue lacks a lane tag; proposed ${proposedLane} based on content analysis`,
    });
  }

  // Flag vague titles
  if (isVagueTitle(issue.title)) {
    proposedActions.push({
      type: "add_comment",
      target: issue.ref,
      payload: {
        body: "**Flow Triage**: This issue has a vague title. Please update the title to clearly describe the work needed.",
      },
      reason: "Issue title is vague or underspecified",
    });
  }

  // Propose close for high-confidence duplicates
  for (const candidate of duplicateCandidates) {
    if (candidate.confidence >= 0.9) {
      proposedActions.push({
        type: "close_duplicate",
        target: issue.ref,
        payload: { duplicateOf: candidate.ref, confidence: candidate.confidence },
        reason: `High confidence duplicate of ${candidate.ref}: ${candidate.reason}`,
      });
    }
  }

  // Propose comment for missing sections
  if (missingSections.length > 0) {
    const missingList = missingSections
      .map((s) => `- **${s.section}**: ${s.description}`)
      .join("\n");
    proposedActions.push({
      type: "add_comment",
      target: issue.ref,
      payload: {
        body: `**Flow Triage**: This issue is missing structured sections:\n\n${missingList}\n\nPlease update the issue body with these sections to improve clarity and trackability.`,
      },
      reason: `Missing ${missingSections.length} recommended section(s)`,
    });
  }

  return {
    ref: issue.ref,
    title: issue.title,
    url: issue.url,
    missingSections,
    duplicateCandidates,
    proposedLabels,
    proposedPriority,
    proposedLane,
    proposedActions,
  };
}

function safeActionsForApply(actions: TriageAction[]): TriageAction[] {
  return actions.filter((action) =>
    action.type === "add_comment" ||
    action.type === "add_tag" ||
    action.type === "remove_tag"
  );
}

async function applyAction(params: TriageEngineOptions, action: TriageAction): Promise<boolean> {
  if (action.type === "add_comment") {
    const body = typeof action.payload.body === "string" ? action.payload.body : "";
    if (!body || !params.postComment) return false;
    await params.postComment(action.target, body);
    return true;
  }
  if (action.type === "add_tag") {
    const tags = readTags(action.payload);
    if (!tags.length || !params.addTags) return false;
    await params.addTags(action.target, tags);
    return true;
  }
  if (action.type === "remove_tag") {
    const tags = readTags(action.payload);
    if (!tags.length || !params.removeTags) return false;
    await params.removeTags(action.target, tags);
    return true;
  }
  if (action.type === "close_duplicate" || action.type === "close_not_needed") {
    if (!params.transitionIssue) return false;
    await params.transitionIssue(action.target, "closed");
    return true;
  }
  return false;
}

function readTags(payload: Record<string, unknown>): string[] {
  const value = payload.tags;
  return Array.isArray(value) ? value.map(String).map((tag) => tag.trim()).filter(Boolean) : [];
}

function detectMissingSections(body: string): TriageMissingSection[] {
  if (!body || body.trim().length < 50) {
    // Very short body is missing everything
    return REQUIRED_SECTIONS.map((section) => ({
      section: section.section,
      severity: "recommended" as const,
      description: section.description,
    }));
  }

  const missing: TriageMissingSection[] = [];
  for (const { section, patterns, description } of REQUIRED_SECTIONS) {
    const found = patterns.some((pattern) => pattern.test(body));
    if (!found) {
      missing.push({ section, severity: "recommended", description });
    }
  }
  return missing;
}

function detectDuplicateCandidates(
  issue: UnifiedIssue,
  allIssues: UnifiedIssue[],
): TriageDuplicateCandidate[] {
  const candidates: TriageDuplicateCandidate[] = [];
  const issueTitle = normalizeForComparison(issue.title);
  const issueBody = normalizeForComparison(issue.description ?? "");

  for (const other of allIssues) {
    if (other.ref === issue.ref) continue;

    const otherTitle = normalizeForComparison(other.title);
    const otherBody = normalizeForComparison(other.description ?? "");

    // Title similarity
    const titleSimilarity = stringSimilarity(issueTitle, otherTitle);
    const bodySimilarity = issueBody && otherBody
      ? stringSimilarity(issueBody, otherBody)
      : 0;

    const weightedSimilarity = titleSimilarity * 0.6 + bodySimilarity * 0.4;
    const confidence = Math.max(titleSimilarity, bodySimilarity, weightedSimilarity);

    if (confidence >= 0.5) {
      const reasons: string[] = [];
      if (titleSimilarity >= 0.7) reasons.push(`title similarity: ${Math.round(titleSimilarity * 100)}%`);
      if (bodySimilarity >= 0.7) reasons.push(`body similarity: ${Math.round(bodySimilarity * 100)}%`);
      if (reasons.length === 0) reasons.push(`combined similarity: ${Math.round(confidence * 100)}%`);

      candidates.push({
        ref: other.ref,
        confidence: Math.round(confidence * 100) / 100,
        reason: reasons.join("; "),
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

function proposePriority(issue: UnifiedIssue, missingSections: TriageMissingSection[]): string | undefined {
  const labels = issue.labels.map((l) => l.toLowerCase());
  const title = issue.title.toLowerCase();
  const body = (issue.description ?? "").toLowerCase();

  // Critical indicators
  if (
    labels.some((l) => /\b(security|vulnerability|cve|urgent|blocker)\b/.test(l)) ||
    /\b(security|vulnerability|cve|urgent|critical|blocker|data loss|crash)\b/.test(title) ||
    /\b(security|vulnerability|cve|urgent|critical|blocker|data loss|crash)\b/.test(body)
  ) {
    return "priority-p0";
  }

  // High indicators
  if (
    labels.some((l) => /\b(bug|regression|broken|production)\b/.test(l)) ||
    /\b(bug|regression|broken|production|urgent|important|timeout|stuck|runner|autoflow|agent)\b/.test(title) ||
    /\b(bug|regression|broken|production|urgent|important)\b/.test(body)
  ) {
    return "priority-p1";
  }

  // Low indicators
  if (
    labels.some((l) => /\b(nice.to.have|cosmetic|chore|cleanup|tech.debt)\b/.test(l)) ||
    /\b(nice.to.have|cosmetic|chore|cleanup|refactor|tech.debt|minor)\b/.test(title) ||
    missingSections.length >= 5
  ) {
    return "priority-p3";
  }

  return "priority-p2";
}

function proposeLane(issue: UnifiedIssue): string | undefined {
  const labels = issue.labels.map((l) => l.toLowerCase());
  const title = issue.title.toLowerCase();

  if (labels.some((l) => LANE_TAGS.includes(l))) return undefined;

  if (
    /\b(sql|sqlite|postgres|ledger|database|migration)\b/.test(title) ||
    labels.some((l) => /\b(sql|migration)\b/.test(l))
  ) {
    return "lane-sql";
  }

  if (
    /\b(desktop|pi|agent|autoflow|runner|prompt|session)\b/.test(title) ||
    labels.some((l) => /\b(desktop)\b/.test(l))
  ) {
    return "lane-desktop-runner";
  }

  if (
    /\b(test|coverage|fixture|runner)\b/.test(title)
  ) {
    return "lane-test-infra";
  }

  if (
    /\b(doc|docs|documentation|example|guide|readme)\b/.test(title)
  ) {
    return "lane-docs";
  }

  return undefined;
}

function isVagueTitle(title: string): boolean {
  if (title.length < 10) return true;
  return VAGUE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aWords = new Set(a.split(" ").map(stemComparisonWord).filter((w) => w.length > 2));
  const bWords = new Set(b.split(" ").map(stemComparisonWord).filter((w) => w.length > 2));

  if (aWords.size === 0 || bWords.size === 0) return 0;

  let intersection = 0;
  for (const word of aWords) {
    if (bWords.has(word)) intersection++;
  }

  return (2 * intersection) / (aWords.size + bWords.size);
}

function stemComparisonWord(word: string): string {
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}
