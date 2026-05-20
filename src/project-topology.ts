import { join } from "node:path";
import type { WorkItem } from "./contracts.js";

export interface TopologyIssueHint {
  title: string;
  labels: string[];
  type?: string;
  description?: string;
}

export interface ProjectTopology {
  readonly validRepoKeys: ReadonlySet<string>;
  isValidRepoKey(repoKey: string): boolean;
  inferRepoKeysFromIssue(issue: TopologyIssueHint): string[];
  branchName(issue: WorkItem): string;
  defaultBaseBranch(repoKey: string): string;
  repoName(repoKey: string): string;
  repoPath(projectRoot: string, repoKey: string): string;
  pullRequestUrl(repo: string, number: number): string;
}

export class DefaultProjectTopology implements ProjectTopology {
  readonly validRepoKeys: ReadonlySet<string> = DEFAULT_REPO_KEYS;

  isValidRepoKey(repoKey: string): boolean {
    return DEFAULT_REPO_KEYS.has(normalizeRepoKey(repoKey));
  }

  inferRepoKeysFromIssue(issue: TopologyIssueHint): string[] {
    const text = `${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
    const candidates: string[] = [];
    if (containsAny(text, ["fs-python", "leaf", "agi", "agfiniti", "agleader", "celery", "controller data", "controller-data", "pixi", "flask"])) {
      candidates.push("fs_python");
    }
    if (containsAny(text, ["fs-client-pwa", "pwa", "frontend", "react", "vite", "browser ui"])) {
      candidates.push("fs_client_pwa");
    }
    if (containsAny(text, ["fs-client-ios", "ios", "swift", "xcode", "iphone"])) {
      candidates.push("fs_client_ios");
    }
    if (containsAny(text, ["fs-public-api", "public api", "request-export", "endpoint contract", "nx workspace"])) {
      candidates.push("fs_public_api");
    }
    if (containsAny(text, ["fs-core-database", "stored procedure", "sproc", "sql revision", "sql trigger"])) {
      candidates.push("fs_core_database");
    }
    if (containsAny(text, ["flow", "workflow workRuntime", "worker executor"])) {
      candidates.push("fs_flow");
    }
    return candidates;
  }

  branchName(issue: WorkItem): string {
    const slug = issue.title
      .replace(/\b[A-Z]+-\d+\b/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56);
    const kind = branchKindForIssue(issue);
    return `${kind}/${issue.ref.toLowerCase()}${slug ? `-${slug}` : ""}`;
  }

  defaultBaseBranch(repoKey: string): string {
    return normalizeRepoKey(repoKey) === "fs_flow" ? "main" : "develop";
  }

  repoName(repoKey: string): string {
    const normalized = normalizeRepoKey(repoKey);
    return normalized === "fs_flow" ? "FARMserver" : normalized.replace(/_/g, "-");
  }

  repoPath(projectRoot: string, repoKey: string): string {
    const normalized = normalizeRepoKey(repoKey);
    if (normalized === "fs_flow") return projectRoot;
    return join(projectRoot, normalized.replace(/_/g, "-"));
  }

  pullRequestUrl(repo: string, number: number): string {
    return `https://github.com/BecksDevTeam/${repo}/pull/${number}`;
  }
}

type BranchKind = "bug" | "feature";

const DEFAULT_REPO_KEYS = new Set([
  "fs_flow",
  "fs_client_pwa",
  "fs_client_ios",
  "fs_public_api",
  "fs_python",
  "fs_core_database",
]);

function normalizeRepoKey(value: string): string {
  return value.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
}

function containsAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function branchKindForIssue(issue: WorkItem): BranchKind {
  const explicitKind = String(issue.metadata.branchKind ?? "").toLowerCase();
  if (explicitKind === "bug" || explicitKind === "feature") return explicitKind;
  const issueType = String(issue.metadata.jiraIssueType ?? "").toLowerCase();
  if (issueType === "bug") return "bug";
  if (issueType === "story" || issueType === "task") return "feature";
  throw new Error(
    `Cannot generate branch for ${issue.ref}: branch kind is missing. ` +
      "Provide an explicit branch or agent-selected branchKind before preparing the workspace.",
  );
}
