import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { FlowConfig } from "./config/config-schema.js";

const frontmatterDelimiter = "---";
const dateHeadingPattern = /^##\s+(\d{4}-\d{2}-\d{2})(?:\s*)$/;
const anyDateHeadingPattern = /^##\s+(.+?)\s*$/;
const markdownLinkPattern = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
const skipDirs = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__"]);

export type OkfBundleSource = "configured" | "detected" | "input";
export type OkfValidationStatus = "valid" | "invalid" | "missing";
export type OkfFindingLevel = "error" | "warning";
export type OkfKnowledgeDisposition = "updated" | "not_needed" | "needed" | "drift_recorded" | "validated";

export interface OkfBundleDescriptor {
  id: string;
  path: string;
  absolutePath: string;
  source: OkfBundleSource;
  exists: boolean;
  description?: string;
  owner?: string;
}

export interface OkfFinding {
  level: OkfFindingLevel;
  path: string;
  message: string;
}

export interface OkfValidationResult {
  ok: boolean;
  status: OkfValidationStatus;
  bundle: OkfBundleDescriptor;
  fileCount: number;
  conceptCount: number;
  errors: OkfFinding[];
  warnings: OkfFinding[];
}

export interface OkfStatusResult {
  ok: boolean;
  bundles: OkfValidationResult[];
}

export interface OkfKnowledgeRecord {
  issueRef: string;
  disposition: OkfKnowledgeDisposition;
  summary: string;
  bundleId?: string;
  concept?: string;
  source?: string;
  recordedAt: string;
}

export function listOkfBundles(projectRoot: string, flowConfig?: FlowConfig): OkfBundleDescriptor[] {
  const configured = flowConfig?.knowledge?.okfBundles ?? [];
  const bundles = configured.map((bundle) => describeBundle(projectRoot, {
    id: bundle.id,
    path: bundle.path,
    source: "configured",
    description: bundle.description,
    owner: bundle.owner,
  }));

  const defaultOkfPath = resolve(projectRoot, ".okf");
  const hasConfiguredDefault = bundles.some((bundle) => bundle.absolutePath === defaultOkfPath);
  if (!hasConfiguredDefault && existsSync(defaultOkfPath)) {
    bundles.push(describeBundle(projectRoot, {
      id: "default",
      path: ".okf",
      source: "detected",
      description: "Repo-local OKF projection",
    }));
  }

  return bundles;
}

export function resolveOkfBundle(
  projectRoot: string,
  flowConfig: FlowConfig | undefined,
  input: { bundleId?: string; path?: string } = {},
): OkfBundleDescriptor {
  if (input.path) {
    return describeBundle(projectRoot, {
      id: input.bundleId ?? "input",
      path: input.path,
      source: "input",
    });
  }

  const bundles = listOkfBundles(projectRoot, flowConfig);
  if (input.bundleId) {
    const bundle = bundles.find((candidate) => candidate.id === input.bundleId);
    if (!bundle) throw new Error(`Unknown OKF bundle "${input.bundleId}". Configure it under knowledge.okfBundles or pass path.`);
    return bundle;
  }

  const defaultBundle = bundles[0];
  if (!defaultBundle) throw new Error("No OKF bundle is configured or detected. Configure knowledge.okfBundles or pass path.");
  return defaultBundle;
}

export async function validateOkfBundle(bundle: OkfBundleDescriptor): Promise<OkfValidationResult> {
  const findings: OkfFinding[] = [];
  if (!existsSync(bundle.absolutePath)) {
    findings.push({ level: "error", path: ".", message: `bundle does not exist: ${bundle.absolutePath}` });
    return validationResult(bundle, [], findings, "missing");
  }

  const bundleStat = await stat(bundle.absolutePath);
  if (!bundleStat.isDirectory()) {
    findings.push({ level: "error", path: ".", message: `bundle is not a directory: ${bundle.absolutePath}` });
    return validationResult(bundle, [], findings, "invalid");
  }

  const markdownFiles = await iterMarkdownFiles(bundle.absolutePath);
  for (const path of markdownFiles) {
    const rel = toPosix(relative(bundle.absolutePath, path));
    let text: string;
    try {
      text = stripBom(await readFile(path, "utf8"));
    } catch (error) {
      findings.push({ level: "error", path: rel, message: `could not read file: ${errorMessage(error)}` });
      continue;
    }

    if (basename(path) === "index.md") {
      validateIndex(bundle.absolutePath, path, rel, text, findings);
    } else if (basename(path) === "log.md") {
      validateLog(rel, text, findings);
    } else {
      validateConcept(rel, text, findings);
    }

    validateLinks(bundle.absolutePath, path, rel, text, findings);
  }

  return validationResult(bundle, markdownFiles, findings);
}

export async function okfStatus(projectRoot: string, flowConfig?: FlowConfig): Promise<OkfStatusResult> {
  const bundles = await Promise.all(listOkfBundles(projectRoot, flowConfig).map((bundle) => validateOkfBundle(bundle)));
  return {
    ok: bundles.every((bundle) => bundle.ok),
    bundles,
  };
}

function describeBundle(
  projectRoot: string,
  input: {
    id: string;
    path: string;
    source: OkfBundleSource;
    description?: string;
    owner?: string;
  },
): OkfBundleDescriptor {
  const absolutePath = isAbsolute(input.path) ? resolve(input.path) : resolve(projectRoot, input.path);
  return {
    id: input.id,
    path: displayPath(projectRoot, absolutePath),
    absolutePath,
    source: input.source,
    exists: existsSync(absolutePath),
    description: input.description,
    owner: input.owner,
  };
}

async function iterMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files.sort();
}

async function walk(path: string, files: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      await walk(join(path, entry.name), files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(join(path, entry.name));
    }
  }
}

function validateConcept(path: string, text: string, findings: OkfFinding[]): void {
  const parts = splitFrontmatter(text);
  if (!parts) {
    findings.push({ level: "error", path, message: "concept document must start with YAML frontmatter." });
    return;
  }

  const parsed = parseFrontmatter(parts.frontmatter, path, findings);
  if (!parsed) return;

  const conceptType = parsed.type;
  if (typeof conceptType !== "string" || !conceptType.trim()) {
    findings.push({ level: "error", path, message: "concept frontmatter must contain a non-empty string `type`." });
  }
}

function validateIndex(bundleRoot: string, path: string, rel: string, text: string, findings: OkfFinding[]): void {
  const parts = splitFrontmatter(text);
  if (!parts) return;

  const isRootIndex = resolve(dirname(path)) === resolve(bundleRoot);
  if (!isRootIndex) {
    findings.push({ level: "error", path: rel, message: "`index.md` must not contain frontmatter outside the bundle root." });
    return;
  }

  const parsed = parseFrontmatter(parts.frontmatter, rel, findings);
  if (!parsed) return;
  const extraKeys = Object.keys(parsed).filter((key) => key !== "okf_version").sort();
  if (extraKeys.length > 0) {
    findings.push({
      level: "error",
      path: rel,
      message: `root \`index.md\` frontmatter may only declare \`okf_version\`; found: ${extraKeys.join(", ")}`,
    });
  }
}

function validateLog(path: string, text: string, findings: OkfFinding[]): void {
  if (splitFrontmatter(text)) {
    findings.push({ level: "error", path, message: "`log.md` must not contain frontmatter." });
  }

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (anyDateHeadingPattern.test(line) && !dateHeadingPattern.test(line)) {
      findings.push({ level: "error", path, message: `\`log.md\` level-2 heading on line ${index + 1} must use YYYY-MM-DD.` });
    }
  }
}

function validateLinks(bundleRoot: string, path: string, rel: string, text: string, findings: OkfFinding[]): void {
  for (const match of text.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1] ?? "";
    const target = normalizeLinkTarget(rawTarget);
    if (!target) continue;

    const candidate = target.startsWith("/")
      ? resolve(bundleRoot, target.slice(1))
      : resolve(dirname(path), target);
    if (!isInside(candidate, bundleRoot)) continue;
    if (existsSync(candidate)) continue;
    if (!targetHasExtension(candidate) && existsSync(join(candidate, "index.md"))) continue;

    findings.push({ level: "warning", path: rel, message: `local link target does not exist: ${rawTarget}` });
  }
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== frontmatterDelimiter) return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === frontmatterDelimiter) {
      return {
        frontmatter: lines.slice(1, index).join("\n"),
        body: lines.slice(index + 1).join("\n"),
      };
    }
  }
  return undefined;
}

function parseFrontmatter(frontmatter: string, path: string, findings: OkfFinding[]): Record<string, unknown> | undefined {
  try {
    const parsed = frontmatter.trim() ? parseYaml(frontmatter) : {};
    if (parsed === null) return {};
    if (!isRecord(parsed)) {
      findings.push({ level: "error", path, message: "frontmatter must be a YAML mapping." });
      return undefined;
    }
    return parsed;
  } catch (error) {
    findings.push({ level: "error", path, message: `frontmatter is not parseable YAML: ${errorMessage(error)}` });
    return undefined;
  }
}

function normalizeLinkTarget(rawTarget: string): string | undefined {
  let target = rawTarget.trim();
  if (!target || target.startsWith("#")) return undefined;
  target = target.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
  if (!target) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return undefined;
  if (target.startsWith("//")) return undefined;

  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function validationResult(
  bundle: OkfBundleDescriptor,
  markdownFiles: string[],
  findings: OkfFinding[],
  forcedStatus?: OkfValidationStatus,
): OkfValidationResult {
  const errors = findings.filter((finding) => finding.level === "error");
  const warnings = findings.filter((finding) => finding.level === "warning");
  const conceptCount = markdownFiles.filter((path) => !["index.md", "log.md"].includes(basename(path))).length;
  return {
    ok: errors.length === 0,
    status: forcedStatus ?? (errors.length === 0 ? "valid" : "invalid"),
    bundle: { ...bundle, exists: existsSync(bundle.absolutePath) },
    fileCount: markdownFiles.length,
    conceptCount,
    errors,
    warnings,
  };
}

function displayPath(projectRoot: string, absolutePath: string): string {
  if (isInside(absolutePath, projectRoot)) {
    const rel = toPosix(relative(projectRoot, absolutePath));
    return rel || ".";
  }
  return absolutePath;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function targetHasExtension(path: string): boolean {
  return /\/[^/]+\.[^/]+$/.test(toPosix(path));
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
