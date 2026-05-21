import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
}

export interface BootstrapFlowConfigResult {
  ok: boolean;
  created: boolean;
  path: string;
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

export function findFlowConfigPath(options: LoadFlowConfigOptions = {}): string | undefined {
  if (options.configPath) {
    const explicit = resolve(options.configPath);
    if (!existsSync(explicit)) throw new Error(`Flow config not found at ${explicit}.`);
    return explicit;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const candidates = [
    join(projectRoot, ".flow", "config.yaml"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function bootstrapFlowConfig(options: BootstrapFlowConfigOptions = {}): Promise<BootstrapFlowConfigResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const configDir = join(projectRoot, ".flow");
  const configPath = join(configDir, "config.yaml");
  if (existsSync(configPath) && !options.force) {
    throw new Error(`Flow config already exists at ${configPath}. Pass --force to overwrite it.`);
  }

  const remote = await gitOutput(projectRoot, ["config", "--get", "remote.origin.url"]);
  const github = parseGithubRemote(remote);
  const folderName = basename(projectRoot);
  const repoName = github?.repo ?? folderName;
  const projectName = repoName;
  const baseBranch = await inferBaseBranch(projectRoot);

  const config: FlowConfig = flowConfigSchema.parse({
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
      ...(github
        ? { pullRequestUrlPattern: `https://github.com/${github.owner}/{repoName}/pull/{number}` }
        : {}),
      issueInference: [],
    },
    ...(github
      ? {
        collaboration: {
          type: "github",
          owner: github.owner,
        },
      }
      : {}),
    sourceControl: {
      type: "git",
    },
    ledger: {
      type: "flow",
    },
    runtime: {
      dashboard: {
        host: "127.0.0.1",
        port: 8867,
        url: "http://127.0.0.1:8867",
      },
    },
  });

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, stringifyYaml(config), "utf8");
  return {
    ok: true,
    created: true,
    path: configPath,
    projectName,
    repoName,
    baseBranch,
    owner: github?.owner,
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

function parseGithubRemote(remote: string | undefined): { owner: string; repo: string } | undefined {
  if (!remote) return undefined;
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remote);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remote);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return undefined;
}
