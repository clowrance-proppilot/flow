import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const skipFiles = new Set(["package-lock.json", "public-readiness.mjs"]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const exposurePattern = /beck|beckshybrids|FSB-|BecksDevTeam|farmserver|FARMserver/i;
const secretPattern = /AIza|AKIA|ASIA|xox[baprs]-|ghp_|github_pat_|sk-(proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN/i;

const failures = [];

function fail(message) {
  failures.push(message);
}

function isTextFile(file) {
  if (skipFiles.has(file.split(/[\\/]/).pop())) return false;
  const lower = file.toLowerCase();
  return [...textExtensions].some((ext) => lower.endsWith(ext));
}

/** Read .gitignore and convert entries to git pathspec exclusions. */
function gitignorePathspecExclusions() {
  let lines;
  try {
    lines = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }

  const exclusions = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) continue; // negated patterns un-ignore files

    let pattern = line;
    if (pattern.startsWith("/")) pattern = pattern.slice(1);

    if (pattern.endsWith("/")) {
      const dir = pattern.slice(0, -1);
      exclusions.push(`:!${dir}`);
      exclusions.push(`:!${dir}/**`);
    } else {
      exclusions.push(`:!${pattern}`);
    }
  }
  return exclusions;
}

function scanCurrentTree() {
  const matches = [];
  // git ls-files respects .gitignore, .git/info/exclude, and global gitignore
  const result = runGit(["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (result.status !== 0) {
    fail(`could not list tracked files: ${result.stderr.trim()}`);
    return;
  }

  for (const relPath of result.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!isTextFile(relPath)) continue;
    const fullPath = join(root, relPath);
    try {
      const text = readFileSync(fullPath, "utf8");
      if (exposurePattern.test(text)) matches.push(`${relPath}: old project/company reference`);
      if (secretPattern.test(text)) matches.push(`${relPath}: possible secret`);
    } catch {
      // Skip unreadable files (binary, permissions, etc.)
    }
  }
  if (matches.length > 0) {
    fail(`current tree exposure scan failed:\n${matches.slice(0, 20).map((m) => `  - ${m}`).join("\n")}`);
  }
}

function runGit(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function branchCommitRange() {
  for (const baseRef of ["origin/main", "main"]) {
    const base = runGit(["merge-base", baseRef, "HEAD"]);
    if (base.status === 0 && base.stdout.trim()) return `${base.stdout.trim()}..HEAD`;
  }
  return "HEAD";
}

function scanHistory() {
  const commits = runGit(["log", branchCommitRange(), "--format=%H"]);
  if (commits.status !== 0) {
    fail(`could not read git history: ${commits.stderr.trim()}`);
    return;
  }

  const exclusions = [
    ...gitignorePathspecExclusions(),
    ":!package-lock.json",
    ":!package.json",
    ":!scripts/public-readiness.mjs",
  ];

  const matches = [];
  for (const commit of commits.stdout.split(/\r?\n/).filter(Boolean)) {
    const result = runGit([
      "grep",
      "-n",
      "-I",
      "-i",
      "-E",
      "beck|beckshybrids|FSB-|BecksDevTeam|farmserver|FARMserver",
      commit,
      "--",
      ...exclusions,
    ]);
    if (result.status === 0 && result.stdout.trim()) {
      matches.push(...result.stdout.trim().split(/\r?\n/));
    }
    if (matches.length >= 20) break;
  }
  if (matches.length > 0) {
    fail(`git history exposure scan failed:\n${matches.slice(0, 20).map((m) => `  - ${m}`).join("\n")}`);
  }
}

function checkPackageMetadata() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.private === true) fail("package.json still has private:true");
  for (const key of ["license", "repository", "homepage", "bugs", "bin", "exports"]) {
    if (!pkg[key]) fail(`package.json missing ${key}`);
  }
  if (!pkg.dependencies?.pathe) fail("package.json missing pathe dependency");
}

scanCurrentTree();
checkPackageMetadata();
scanHistory();

if (failures.length > 0) {
  console.error(`public readiness: blocked\n\n${failures.join("\n\n")}`);
  process.exit(1);
}

console.log("public readiness: ok");
