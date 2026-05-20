import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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

export interface LoadFlowConfigOptions {
  projectRoot?: string;
  configPath?: string;
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
    join(projectRoot, "flow.config.yaml"),
    join(projectRoot, "flow.config.yml"),
    join(projectRoot, "flow.config.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
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
