import { join } from "pathe";
import type { WorkItem } from "../contracts.js";
import type { ProjectTopology, TopologyIssueHint } from "../project-topology.js";
import type { FlowConfig } from "./config-schema.js";

export class ConfigDrivenTopology implements ProjectTopology {
  readonly validRepoKeys: ReadonlySet<string>;

  constructor(private readonly config: FlowConfig) {
    this.validRepoKeys = new Set(Object.keys(config.topology.repos));
  }

  isValidRepoKey(repoKey: string): boolean {
    return this.validRepoKeys.has(repoKey);
  }

  inferRepoKeysFromIssue(issue: TopologyIssueHint): string[] {
    const text = [
      issue.title,
      issue.description,
      issue.type,
      ...issue.labels,
    ].filter(Boolean).join(" ").toLowerCase();
    const matches: string[] = [];
    for (const rule of this.config.topology.issueInference) {
      if (rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
        matches.push(rule.repo);
      }
    }
    return matches;
  }

  branchName(issue: WorkItem): string {
    const pattern = this.config.topology.branchPattern ?? "{kind}/{issueRef}-{slug}";
    const slug = slugForTitle(issue.title);
    const kind = branchKindForIssue(issue);
    return pattern
      .replaceAll("{kind}", kind)
      .replaceAll("{issueRef}", issue.ref.toLowerCase())
      .replaceAll("{slug}", slug)
      .replace(/-+$/g, "");
  }

  defaultBaseBranch(repoKey: string): string {
    return this.repoConfig(repoKey).baseBranch ?? "main";
  }

  repoName(repoKey: string): string {
    return this.repoConfig(repoKey).name;
  }

  repoPath(projectRoot: string, repoKey: string): string {
    const pathFromRoot = this.repoConfig(repoKey).pathFromRoot;
    return pathFromRoot ? join(projectRoot, pathFromRoot) : projectRoot;
  }

  pullRequestUrl(repo: string, number: number): string {
    const pattern = this.config.topology.pullRequestUrlPattern;
    if (!pattern) return `${repo}/pull/${number}`;
    const repoKey = this.repoKeyForName(repo) ?? repo;
    return pattern
      .replaceAll("{repoKey}", repoKey)
      .replaceAll("{repoName}", repo)
      .replaceAll("{number}", String(number));
  }

  private repoConfig(repoKey: string) {
    const config = this.config.topology.repos[repoKey];
    if (!config) throw new Error(`Unknown repo key ${repoKey}.`);
    return config;
  }

  private repoKeyForName(repoName: string): string | undefined {
    for (const [repoKey, repo] of Object.entries(this.config.topology.repos)) {
      if (repo.name === repoName) return repoKey;
    }
    return undefined;
  }
}

function slugForTitle(title: string): string {
  return title
    .replace(/\b[A-Z]+-\d+\b/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
}

function branchKindForIssue(issue: WorkItem): "bug" | "feature" {
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
