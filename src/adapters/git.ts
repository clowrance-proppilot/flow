import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type {
  SourceControlProvider,
  UnifiedWorkspaceStatus,
} from "./provider-contracts.js";

const execFileAsync = promisify(execFile);

export interface GitRepoStatus {
  branch: string;
  headSha: string;
  dirty: boolean;
  entries: string[];
}

export interface WorktreePlan {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}

export function normalizeGitStatus(status: GitRepoStatus): UnifiedWorkspaceStatus {
  return {
    dirty: status.dirty,
    headSha: status.headSha,
    branch: status.branch,
    entries: status.entries,
  };
}

export class GitAdapter implements SourceControlProvider {
  async inspectWorkspace(repoPath: string): Promise<UnifiedWorkspaceStatus> {
    const status = await this.inspect(repoPath);
    return normalizeGitStatus(status);
  }

  async inspect(repoPath: string): Promise<GitRepoStatus> {
    const [{ stdout: branch }, { stdout: headSha }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["-C", repoPath, "branch", "--show-current"], { maxBuffer: 1024 * 1024 }),
      execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], { maxBuffer: 1024 * 1024 }),
      execFileAsync("git", ["-C", repoPath, "status", "--short"], { maxBuffer: 5 * 1024 * 1024 }),
    ]);
    const entries = status.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    return {
      branch: branch.trim(),
      headSha: headSha.trim(),
      dirty: entries.length > 0,
      entries,
    };
  }

  async prepareWorktree(options: {
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseRef?: string;
  }): Promise<UnifiedWorkspaceStatus> {
    const baseRef = options.baseRef ?? "develop";
    await mkdir(dirname(options.worktreePath), { recursive: true });
    let inspectPath = options.worktreePath;
    await execFileAsync("git", ["-C", options.repoPath, "fetch", "origin", baseRef], { maxBuffer: 10 * 1024 * 1024 })
      .catch(() => undefined);
    await execFileAsync(
      "git",
      ["-C", options.repoPath, "worktree", "add", "-B", options.branch, options.worktreePath, `origin/${baseRef}`],
      { maxBuffer: 10 * 1024 * 1024 },
    ).catch(async (error: unknown) => {
      if (worktreeAlreadyExists(error)) {
        const existingPath = await findWorktreePathForBranch(options.repoPath, options.branch);
        if (existingPath) inspectPath = existingPath;
        else if (!await pathExists(options.worktreePath)) throw error;
        return;
      }
      throw error;
    });
    return this.inspectWorkspace(inspectPath);
  }
}

function worktreeAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const message = typeof record.message === "string" ? record.message : "";
  return /already exists|is a missing but already registered worktree|already checked out|already used by worktree/i
    .test(`${stderr}\n${message}`);
}

async function findWorktreePathForBranch(repoPath: string, branch: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    maxBuffer: 10 * 1024 * 1024,
  }).catch(() => ({ stdout: "" }));

  let currentPath: string | undefined;
  let currentBranch: string | undefined;
  const flush = () => {
    if (!currentPath || !currentBranch) return undefined;
    return currentBranch === `refs/heads/${branch}` ? currentPath : undefined;
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const hit = flush();
      if (hit) return hit;
      currentPath = line.slice("worktree ".length).trim();
      currentBranch = undefined;
      continue;
    }
    if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length).trim();
      continue;
    }
    if (!line.trim()) {
      const hit = flush();
      if (hit) return hit;
      currentPath = undefined;
      currentBranch = undefined;
    }
  }

  return flush();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
