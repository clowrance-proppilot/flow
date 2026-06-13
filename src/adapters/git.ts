import { execFile } from "node:child_process";
import { access, lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve, toNamespacedPath } from "node:path";
import { promisify } from "node:util";

import type {
  UnifiedBranchCleanupResult,
  SourceControlProvider,
  UnifiedDiff,
  UnifiedWorktreePruneResult,
  UnifiedWorkspaceStatus,
} from "./provider-contracts.js";

const execFileAsync = promisify(execFile);

export interface GitRepoStatus {
  branch: string;
  headSha: string;
  dirty: boolean;
  entries: string[];
  worktreePath?: string;
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
    worktreePath: status.worktreePath,
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
      worktreePath: repoPath,
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
    const status = await this.inspectWorkspace(inspectPath);
    return { ...status, worktreePath: inspectPath };
  }

  async diffWorkspace(options: { repoPath: string; baseRef?: string; headRef?: string }): Promise<UnifiedDiff> {
    const baseRef = options.baseRef ?? "origin/main";
    const headRef = options.headRef ?? "HEAD";
    const committedRange = `${baseRef}...${headRef}`;
    const [committedFiles, committedPatch, committedStat] = await Promise.all([
      gitOutput(options.repoPath, ["diff", "--name-only", committedRange]),
      gitOutput(options.repoPath, ["diff", "--no-ext-diff", committedRange]),
      gitOutput(options.repoPath, ["diff", "--stat", committedRange]),
    ]);
    const [workingFiles, workingPatch, workingStat] = await Promise.all([
      gitOutput(options.repoPath, ["diff", "--name-only"]),
      gitOutput(options.repoPath, ["diff", "--no-ext-diff"]),
      gitOutput(options.repoPath, ["diff", "--stat"]),
    ]);
    const files = uniqueNonEmptyLines(`${committedFiles}\n${workingFiles}`);
    return {
      baseRef,
      headRef,
      files,
      patch: joinNonEmpty([committedPatch, workingPatch]),
      stat: joinNonEmpty([committedStat, workingStat]),
    };
  }

  async publishBranch(options: { worktreePath: string; branch?: string; remote?: string; force?: boolean }): Promise<UnifiedWorkspaceStatus> {
    const status = await this.inspect(options.worktreePath);
    if (status.dirty) {
      throw new Error(`Worktree has uncommitted changes; commit them before publishing: ${status.entries.slice(0, 5).join(", ")}`);
    }
    if (options.branch && status.branch !== options.branch) {
      throw new Error(`Branch mismatch: expected ${options.branch}, got ${status.branch || "detached"}.`);
    }
    if (!status.branch) throw new Error("Cannot publish a detached HEAD.");
    const remote = options.remote ?? "origin";
    await execFileAsync(
      "git",
      [
        "-C", options.worktreePath,
        "push", "--set-upstream",
        ...(options.force ? ["--force-with-lease"] : []),
        remote, status.branch,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return normalizeGitStatus(await this.inspect(options.worktreePath));
  }

  async syncBranch(options: { worktreePath: string; baseRef: string; remote?: string }): Promise<UnifiedWorkspaceStatus> {
    const status = await this.inspect(options.worktreePath);
    if (status.dirty) {
      throw new Error(`Worktree has uncommitted changes; commit or stash them before syncing: ${status.entries.slice(0, 5).join(", ")}`);
    }
    const remote = options.remote ?? "origin";
    await execFileAsync("git", ["-C", options.worktreePath, "fetch", remote, options.baseRef], { maxBuffer: 10 * 1024 * 1024 });
    try {
      await execFileAsync("git", ["-C", options.worktreePath, "rebase", `${remote}/${options.baseRef}`], { maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      await execFileAsync("git", ["-C", options.worktreePath, "rebase", "--abort"], { maxBuffer: 10 * 1024 * 1024 })
        .catch(() => undefined);
      throw new Error(`Rebase onto ${remote}/${options.baseRef} failed and was aborted; resolve conflicts manually: ${errorMessage(error)}`);
    }
    return normalizeGitStatus(await this.inspect(options.worktreePath));
  }

  async pruneWorktree(options: { repoPath: string; worktreePath: string; branch?: string; requireClean?: boolean }): Promise<UnifiedWorktreePruneResult> {
    if (!await pathExists(options.worktreePath)) {
      await execFileAsync("git", ["-C", options.repoPath, "worktree", "prune"], { maxBuffer: 10 * 1024 * 1024 })
        .catch(() => undefined);
      return {
        removed: true,
        reason: "worktree directory already absent",
        worktreePath: options.worktreePath,
        branch: options.branch,
      };
    }
    if (pathContains(options.worktreePath, process.cwd())) {
      return {
        removed: false,
        reason: "worktree is current process directory",
        worktreePath: options.worktreePath,
        branch: options.branch,
      };
    }
    const status = await this.inspect(options.worktreePath);
    if (options.branch && status.branch !== options.branch) {
      return {
        removed: false,
        reason: `branch mismatch: expected ${options.branch}, got ${status.branch || "detached"}`,
        worktreePath: options.worktreePath,
        branch: status.branch,
      };
    }
    if (options.requireClean !== false && status.dirty) {
      return {
        removed: false,
        reason: "worktree is dirty",
        worktreePath: options.worktreePath,
        branch: status.branch,
      };
    }
    try {
      await execFileAsync("git", ["-C", options.repoPath, "worktree", "remove", options.worktreePath], {
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const reason = errorMessage(error);
      if (!isSafeFlowWorktreePath(options.repoPath, options.worktreePath)) {
        return {
          removed: false,
          reason,
          worktreePath: options.worktreePath,
          branch: status.branch,
        };
      }
      try {
        if (await pathExists(options.worktreePath)) {
          await removePathWithoutFollowingLinks(options.worktreePath);
        }
        await execFileAsync("git", ["-C", options.repoPath, "worktree", "prune"], {
          maxBuffer: 10 * 1024 * 1024,
        }).catch(() => undefined);
        return {
          removed: true,
          reason: `git worktree remove failed; removed worktree directory safely: ${reason}`,
          worktreePath: options.worktreePath,
          branch: status.branch,
        };
      } catch (cleanupError) {
        return {
          removed: false,
          reason: `${reason}; safe cleanup failed: ${errorMessage(cleanupError)}`,
          worktreePath: options.worktreePath,
          branch: status.branch,
        };
      }
    }
    return {
      removed: true,
      worktreePath: options.worktreePath,
      branch: status.branch,
    };
  }

  async cleanupMergedBranch(options: {
    repoPath: string;
    branch: string;
    baseRef: string;
    mergeCommitSha?: string;
    remote?: string;
  }): Promise<UnifiedBranchCleanupResult> {
    const remote = options.remote ?? "origin";
    const result: UnifiedBranchCleanupResult = {
      branch: options.branch,
      baseRef: options.baseRef,
      mergeCommitSha: options.mergeCommitSha,
      localDeleted: false,
      remoteDeleted: false,
    };
    const branchError = await validateBranchCleanupInput(options.branch, options.baseRef);
    if (branchError) {
      return {
        ...result,
        localReason: branchError,
        remoteReason: branchError,
      };
    }

    let localExists = false;
    let remoteExists = false;
    try {
      localExists = await localBranchExists(options.repoPath, options.branch);
      remoteExists = await remoteBranchExists(options.repoPath, remote, options.branch);
    } catch (error) {
      const reason = `branch lookup failed: ${errorMessage(error)}`;
      return {
        ...result,
        localDeleted: !localExists,
        localReason: localExists ? reason : "local branch already absent",
        remoteReason: reason,
      };
    }

    if (!localExists && !remoteExists) {
      return {
        ...result,
        localDeleted: true,
        localReason: "local branch already absent",
        remoteDeleted: true,
        remoteReason: "remote branch already absent",
      };
    }

    if (!options.mergeCommitSha) {
      const reason = "merge commit sha is required to confirm branch cleanup is safe";
      return {
        ...result,
        localDeleted: !localExists,
        localReason: localExists ? reason : "local branch already absent",
        remoteDeleted: !remoteExists,
        remoteReason: remoteExists ? reason : "remote branch already absent",
      };
    }

    const confirmation = await mergeCommitOnBase(options.repoPath, remote, options.baseRef, options.mergeCommitSha);
    if (confirmation !== true) {
      const reason = confirmation;
      return {
        ...result,
        localDeleted: !localExists,
        localReason: localExists ? reason : "local branch already absent",
        remoteDeleted: !remoteExists,
        remoteReason: remoteExists ? reason : "remote branch already absent",
      };
    }

    if (localExists) {
      try {
        await execFileAsync("git", ["-C", options.repoPath, "branch", "-D", options.branch], {
          maxBuffer: 10 * 1024 * 1024,
        });
        result.localDeleted = true;
      } catch (error) {
        result.localReason = errorMessage(error);
      }
    } else {
      result.localDeleted = true;
      result.localReason = "local branch already absent";
    }

    if (remoteExists) {
      try {
        await execFileAsync("git", ["-C", options.repoPath, "push", remote, "--delete", options.branch], {
          maxBuffer: 10 * 1024 * 1024,
        });
        result.remoteDeleted = true;
      } catch (error) {
        result.remoteReason = errorMessage(error);
      }
    } else {
      result.remoteDeleted = true;
      result.remoteReason = "remote branch already absent";
    }

    return result;
  }
}

function pathContains(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\"));
}

function isSafeFlowWorktreePath(repoPath: string, worktreePath: string): boolean {
  const worktreesRoot = resolve(repoPath, ".worktrees");
  const resolvedWorktree = resolve(worktreePath);
  return resolvedWorktree !== worktreesRoot &&
    pathContains(worktreesRoot, resolvedWorktree) &&
    !pathContains(resolvedWorktree, process.cwd());
}

async function removePathWithoutFollowingLinks(path: string): Promise<void> {
  const stat = await lstat(fsPath(path));
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    await rm(fsPath(path), { force: true });
    return;
  }
  for (const entry of await readdir(fsPath(path))) {
    await removePathWithoutFollowingLinks(join(path, entry));
  }
  await rmdir(fsPath(path));
}

function fsPath(path: string): string {
  return process.platform === "win32" ? toNamespacedPath(path) : path;
}

async function validateBranchCleanupInput(branch: string, baseRef: string): Promise<string | undefined> {
  const protectedBranches = new Set(["main", "master", "develop", "trunk"]);
  if (!branch) return "branch is required";
  if (!baseRef) return "base ref is required";
  if (branch === baseRef || protectedBranches.has(branch)) return `refusing to delete protected branch ${branch}`;
  if (branch.startsWith("-") || branch.includes("..") || branch.includes(":")) return `invalid branch name ${branch}`;
  if (baseRef.startsWith("-") || baseRef.includes("..") || baseRef.includes(":")) return `invalid base ref ${baseRef}`;
  try {
    await execFileAsync("git", ["check-ref-format", "--branch", branch], { maxBuffer: 1024 * 1024 });
    await execFileAsync("git", ["check-ref-format", "--branch", baseRef], { maxBuffer: 1024 * 1024 });
  } catch {
    return `invalid branch or base ref ${branch}`;
  }
  return undefined;
}

async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function remoteBranchExists(repoPath: string, remote: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "ls-remote", "--exit-code", "--heads", remote, branch], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    if (typeof error === "object" && error && (error as { code?: unknown }).code === 2) return false;
    throw error;
  }
}

async function mergeCommitOnBase(repoPath: string, remote: string, baseRef: string, mergeCommitSha: string): Promise<true | string> {
  const baseRemoteRef = `refs/remotes/${remote}/${baseRef}`;
  try {
    await execFileAsync("git", ["-C", repoPath, "fetch", remote, `+refs/heads/${baseRef}:${baseRemoteRef}`], { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    return `could not fetch ${remote}/${baseRef} to confirm merge commit: ${errorMessage(error)}`;
  }
  try {
    await execFileAsync("git", ["-C", repoPath, "merge-base", "--is-ancestor", mergeCommitSha, baseRemoteRef], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return `merge commit ${mergeCommitSha} is not confirmed on ${baseRemoteRef}`;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], { maxBuffer: 20 * 1024 * 1024 })
    .catch(() => ({ stdout: "" }));
  return stdout.trim();
}

function uniqueNonEmptyLines(value: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(trimmed);
  }
  return lines;
}

function joinNonEmpty(values: string[]): string | undefined {
  const joined = values.map((value) => value.trim()).filter(Boolean).join("\n\n");
  return joined || undefined;
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
    await access(fsPath(path));
    return true;
  } catch {
    return false;
  }
}
