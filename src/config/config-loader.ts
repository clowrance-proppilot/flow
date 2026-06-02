import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ProjectTopology } from "../project-topology.js";
import {
  createDefaultFlowWorkTypeRegistry,
  type ExecutorCapabilityDefinition,
  type WorkTypeDefinition,
  WorkTypeRegistry,
} from "../work-registry.js";
import type { WorkJobExecutor } from "../contracts.js";
import { flowConfigPath, flowUserConfigPath, flowUserRuntimePath, flowUserWorkflowLedgerPath } from "../flow-layout.js";
import { ConfigDrivenTopology } from "./config-topology.js";
import { flowConfigSchema, type FlowConfig } from "./config-schema.js";

const execFileAsync = promisify(execFile);

export interface LoadFlowConfigOptions {
  projectRoot?: string;
  configPath?: string;
}

export interface BootstrapFlowConfigOptions {
  projectRoot?: string;
  force?: boolean;
  storage?: FlowConfigStorage;
}

export interface BootstrapFlowConfigResult {
  ok: boolean;
  created: boolean;
  path: string;
  storage: FlowConfigStorage;
  projectName: string;
  repoName: string;
  baseBranch: string;
  owner?: string;
  localExcludeUpdated?: boolean;
}

export type FlowConfigStorage = "user" | "repo-untracked" | "repo-tracked";

export interface ValidateFlowConfigResult {
  ok: boolean;
  path?: string;
  projectName?: string;
  version?: string;
  repoCount?: number;
  issueTrackerType?: string;
  collaborationType?: string;
  sourceControlType?: string;
  ledgerType?: string;
  errors: string[];
  config?: FlowConfig;
}

export interface MigrateFlowConfigOptions extends LoadFlowConfigOptions {
  write?: boolean;
}

export interface MigrateFlowConfigResult {
  ok: boolean;
  path?: string;
  fromVersion?: string;
  toVersion?: string;
  changed: boolean;
  wrote: boolean;
  errors: string[];
  notes: string[];
}

interface BootstrapFlowConfigDraft {
  config: FlowConfig;
  projectName: string;
  repoName: string;
  baseBranch: string;
  owner?: string;
}

export async function loadFlowConfig(options: LoadFlowConfigOptions = {}): Promise<FlowConfig | undefined> {
  const configPath = findFlowConfigPath(options);
  if (!configPath) return undefined;
  const raw = await readFile(configPath, "utf8");
  const parsed = configPath.endsWith(".json")
    ? JSON.parse(raw)
    : parseYaml(raw);
  return flowConfigSchema.parse(parsed);
}

export async function validateFlowConfig(options: LoadFlowConfigOptions = {}): Promise<ValidateFlowConfigResult> {
  let configPath: string | undefined;
  try {
    configPath = findFlowConfigPath(options);
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)] };
  }
  if (!configPath) return { ok: false, errors: ["Flow config not found."] };

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = configPath.endsWith(".json")
      ? JSON.parse(raw)
      : parseYaml(raw);
    const result = flowConfigSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        path: configPath,
        errors: result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
      };
    }
    const config = result.data;
    return {
      ok: true,
      path: configPath,
      projectName: config.project.name,
      version: config.version,
      repoCount: Object.keys(config.topology.repos).length,
      issueTrackerType: config.issueTracker?.type,
      collaborationType: config.collaboration?.type,
      sourceControlType: config.sourceControl?.type,
      ledgerType: config.ledger?.type,
      errors: [],
      config,
    };
  } catch (error) {
    return {
      ok: false,
      path: configPath,
      errors: [errorMessage(error)],
    };
  }
}

export async function migrateFlowConfig(options: MigrateFlowConfigOptions = {}): Promise<MigrateFlowConfigResult> {
  let configPath: string | undefined;
  try {
    configPath = findFlowConfigPath(options);
  } catch (error) {
    return {
      ok: false,
      changed: false,
      wrote: false,
      errors: [errorMessage(error)],
      notes: [],
    };
  }
  if (!configPath) {
    return {
      ok: false,
      changed: false,
      wrote: false,
      errors: ["Flow config not found."],
      notes: [],
    };
  }

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = configPath.endsWith(".json")
      ? JSON.parse(raw)
      : parseYaml(raw);
    const migrated = migrateParsedFlowConfig(parsed);
    if (!migrated.ok) {
      return {
        ok: false,
        path: configPath,
        fromVersion: migrated.fromVersion,
        toVersion: migrated.toVersion,
        changed: false,
        wrote: false,
        errors: migrated.errors,
        notes: migrated.notes,
      };
    }

    const changed = stableJson(parsed) !== stableJson(migrated.config);
    let wrote = false;
    if (options.write && changed) {
      if (configPath.endsWith(".json")) {
        await writeFile(configPath, `${JSON.stringify(migrated.config, null, 2)}\n`, "utf8");
      } else {
        await writeFile(configPath, stringifyYaml(migrated.config), "utf8");
      }
      wrote = true;
    }

    return {
      ok: true,
      path: configPath,
      fromVersion: migrated.fromVersion,
      toVersion: migrated.toVersion,
      changed,
      wrote,
      errors: [],
      notes: migrated.notes,
    };
  } catch (error) {
    return {
      ok: false,
      path: configPath,
      changed: false,
      wrote: false,
      errors: [errorMessage(error)],
      notes: [],
    };
  }
}

export function findFlowConfigPath(options: LoadFlowConfigOptions = {}): string | undefined {
  if (options.configPath) {
    const explicit = resolve(options.configPath);
    if (!existsSync(explicit)) throw new Error(`Flow config not found at ${explicit}.`);
    return explicit;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const candidate = flowConfigPath(projectRoot);
  if (existsSync(candidate)) return candidate;
  const userCandidate = flowUserConfigPath(projectRoot);
  return existsSync(userCandidate) ? userCandidate : undefined;
}

export async function bootstrapFlowConfig(options: BootstrapFlowConfigOptions = {}): Promise<BootstrapFlowConfigResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const storage = options.storage ?? "user";
  const configPath = storage === "user" ? flowUserConfigPath(projectRoot) : flowConfigPath(projectRoot);
  if (existsSync(configPath) && !options.force) {
    throw new Error(`Flow config already exists at ${configPath}. Pass --force to overwrite it.`);
  }

  const draft = await inferBootstrapFlowConfig(projectRoot, storage);

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, stringifyYaml(draft.config), "utf8");
  const localExcludeUpdated = storage === "repo-untracked"
    ? await ensureLocalGitExclude(projectRoot, ".flow/")
    : undefined;
  return {
    ok: true,
    created: true,
    path: configPath,
    storage,
    projectName: draft.projectName,
    repoName: draft.repoName,
    baseBranch: draft.baseBranch,
    owner: draft.owner,
    localExcludeUpdated,
  };
}

export function configToProjectTopology(config: FlowConfig): ProjectTopology {
  return new ConfigDrivenTopology(config);
}

export function configToWorkTypeRegistry(config: FlowConfig): WorkTypeRegistry {
  if (!config.workTypes?.length) return createDefaultFlowWorkTypeRegistry();

  const definitions: WorkTypeDefinition[] = config.workTypes.map((workType) => ({
    workType: workType.name,
    category: workType.category,
    requiredCapabilities: workType.requiredCapabilities,
    allowedExecutors: workType.allowedExecutors,
    outputType: workType.outputType,
  }));
  const executors: ExecutorCapabilityDefinition[] = (config.executors?.length
    ? config.executors
    : [{
      name: "live_agent_thread",
      capabilities: ["repo.worktree.prepare", "code.edit", "test.run", "review.remediate", "evidence.record"],
      outputs: ["workspace_result", "worker_result", "blocked_result", "evidence_result"],
    }]).map((executor) => ({
      executor: executor.name as WorkJobExecutor,
      capabilities: executor.capabilities,
      canSubmit: definitions
        .filter((definition) => definition.allowedExecutors.includes(executor.name))
        .map((definition) => definition.workType),
      outputs: executor.outputs,
    }));

  return new WorkTypeRegistry(definitions, executors);
}

async function inferBootstrapFlowConfig(projectRoot: string, storage: FlowConfigStorage): Promise<BootstrapFlowConfigDraft> {
  const remote = await gitOutput(projectRoot, ["config", "--get", "remote.origin.url"]);
  const github = parseGithubRemote(remote);
  const repoName = github?.repo ?? basename(projectRoot);
  const projectName = repoName;
  const baseBranch = await inferBaseBranch(projectRoot);
  const config = flowConfigSchema.parse({
    version: "1",
    project: {
      name: projectName,
    },
    topology: {
      repos: {
        main: {
          name: repoName,
          baseBranch,
        },
      },
      branchPattern: "{kind}/{issueRef}-{slug}",
      issueInference: [],
    },
    issueTracker: {
      type: "local",
      prefix: normalizeIssuePrefix(projectName),
    },
    collaboration: {
      type: "none",
    },
    sourceControl: {
      type: "git",
    },
    ledger: {
      type: "sql",
      dialect: "sqlite",
    },
    runtime: {
      store: {
        type: "sqlite",
      },
      ...(storage === "user"
        ? {
          stateDir: flowUserRuntimePath(projectRoot),
          workflowLedgerPath: flowUserWorkflowLedgerPath(projectRoot),
        }
        : {}),
      dashboard: {
        host: "127.0.0.1",
        port: 8867,
        url: "http://127.0.0.1:8867",
      },
    },
  });

  return {
    config,
    projectName,
    repoName,
    baseBranch,
  };
}

function migrateParsedFlowConfig(raw: unknown):
  | { ok: true; config: FlowConfig; fromVersion: string; toVersion: string; notes: string[] }
  | { ok: false; fromVersion: string; toVersion: string; errors: string[]; notes: string[] } {
  if (!isRecord(raw)) {
    return {
      ok: false,
      fromVersion: "unknown",
      toVersion: "1",
      errors: ["Flow config must parse to an object."],
      notes: [],
    };
  }

  const detectedVersion = normalizeVersion(raw.version);
  if (detectedVersion !== "0" && detectedVersion !== "1") {
    return {
      ok: false,
      fromVersion: detectedVersion,
      toVersion: "1",
      errors: [`Unsupported Flow config version "${detectedVersion}".`],
      notes: [],
    };
  }

  const candidate = detectedVersion === "1"
    ? raw
    : {
      ...raw,
      version: "1",
    };

  const parsed = flowConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      fromVersion: detectedVersion,
      toVersion: "1",
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
      notes: detectedVersion === "0" ? ["Added version: \"1\" before validation."] : [],
    };
  }

  return {
    ok: true,
    config: candidate as FlowConfig,
    fromVersion: detectedVersion,
    toVersion: "1",
    notes: detectedVersion === "0"
      ? ["Upgraded config to version 1 by adding version metadata."]
      : ["Config already matches the current schema version."],
  };
}

function normalizeVersion(value: unknown): string {
  if (typeof value !== "string") return "0";
  const trimmed = value.trim();
  return trimmed || "0";
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeForStableJson(value[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIssuePrefix(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "LOCAL";
}

async function inferBaseBranch(projectRoot: string): Promise<string> {
  const originHead = await gitOutput(projectRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead?.startsWith("origin/")) return originHead.slice("origin/".length);
  const currentBranch = await gitOutput(projectRoot, ["branch", "--show-current"]);
  return currentBranch || "main";
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    const output = stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

async function ensureLocalGitExclude(projectRoot: string, pattern: string): Promise<boolean> {
  const excludePath = await gitOutput(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!excludePath) return false;
  const absoluteExcludePath = resolve(projectRoot, excludePath);
  let current = "";
  try {
    current = await readFile(absoluteExcludePath, "utf8");
  } catch {
    // Missing exclude files are created below.
  }
  if (current.split(/\r?\n/).includes(pattern)) return false;
  await mkdir(dirname(absoluteExcludePath), { recursive: true });
  await appendFile(absoluteExcludePath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${pattern}\n`, "utf8");
  return true;
}

function parseGithubRemote(remote: string | undefined): { owner: string; repo: string } | undefined {
  if (!remote) return undefined;
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remote);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remote);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
