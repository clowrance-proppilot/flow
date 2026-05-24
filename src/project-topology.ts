import { join } from "pathe";
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

interface DefaultRepoConfig {
  name: string;
  baseBranch?: string;
  pathFromRoot?: string;
  keywords?: string[];
}

export class DefaultProjectTopology implements ProjectTopology {
  readonly validRepoKeys: ReadonlySet<string> = new Set(Object.keys(BUILTIN_DEFAULT_REPOS));

  isValidRepoKey(repoKey: string): boolean {
    return this.repoConfig(repoKey) !== undefined;
  }

  inferRepoKeysFromIssue(issue: TopologyIssueHint): string[] {
    const text = [
      issue.title,
      issue.description,
      issue.type,
      ...issue.labels,
    ].filter(Boolean).join(" ").toLowerCase();
    return Object.entries(BUILTIN_DEFAULT_REPOS)
      .filter(([, repo]) => repo.keywords?.some((keyword) => text.includes(keyword.toLowerCase())))
      .map(([repoKey]) => repoKey);
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
    return this.requireRepoConfig(repoKey).baseBranch ?? "main";
  }

  repoName(repoKey: string): string {
    return this.requireRepoConfig(repoKey).name;
  }

  repoPath(projectRoot: string, repoKey: string): string {
    const pathFromRoot = this.requireRepoConfig(repoKey).pathFromRoot;
    return pathFromRoot ? join(projectRoot, pathFromRoot) : projectRoot;
  }

  pullRequestUrl(repo: string, number: number): string {
    return `${repo}/pull/${number}`;
  }

  private repoConfig(repoKey: string): DefaultRepoConfig | undefined {
    return BUILTIN_DEFAULT_REPOS[normalizeRepoKey(repoKey)];
  }

  private requireRepoConfig(repoKey: string): DefaultRepoConfig {
    const config = this.repoConfig(repoKey);
    if (!config) throw new Error(`Unknown repo key ${repoKey}.`);
    return config;
  }
}

type BranchKind = "bug" | "feature";

const BUILTIN_DEFAULT_REPOS: Record<string, DefaultRepoConfig> = {
  main: { name: "main" },
};

function normalizeRepoKey(value: string): string {
  return value.replace(/-/g, "_").replace(/[^a-zA-Z0-9_]/g, "_");
}

function branchKindForIssue(issue: WorkItem): BranchKind {
  const explicitKind = String(issue.metadata.branchKind ?? "").toLowerCase();
  if (explicitKind === "bug" || explicitKind === "feature") return explicitKind;
  const issueType = String(issue.metadata.issueType ?? issue.metadata.jiraIssueType ?? "").toLowerCase();
  if (issueType === "bug") return "bug";
  if (issueType === "story" || issueType === "task") return "feature";
  throw new Error(
    `Cannot generate branch for ${issue.ref}: branch kind is missing. ` +
      "Provide an explicit branch or agent-selected branchKind before preparing the workspace.",
  );
}
