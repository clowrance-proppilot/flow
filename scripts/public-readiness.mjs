import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const blockedDirs = new Set([".git", ".worktrees", "node_modules", "dist", ".tmp"]);
const blockedFiles = new Set(["package-lock.json", "public-readiness.mjs"]);
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

function walk(dir, visitor) {
  for (const entry of readdirSync(dir)) {
    if (blockedDirs.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, visitor);
    } else if (stats.isFile()) {
      visitor(fullPath);
    }
  }
}

function isTextFile(file) {
  if (blockedFiles.has(file.split(/[\\/]/).pop())) return false;
  const lower = file.toLowerCase();
  return [...textExtensions].some((ext) => lower.endsWith(ext));
}

function scanCurrentTree() {
  const matches = [];
  walk(root, (file) => {
    if (!isTextFile(file)) return;
    const rel = relative(root, file).replace(/\\/g, "/");
    const text = readFileSync(file, "utf8");
    if (exposurePattern.test(text)) matches.push(`${rel}: old project/company reference`);
    if (secretPattern.test(text)) matches.push(`${rel}: possible secret`);
  });
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
      ":!package-lock.json",
      ":!package.json",
      ":!node_modules/**",
      ":!dist/**",
      ":!.tmp/**",
      ":!scripts/public-readiness.mjs",
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
