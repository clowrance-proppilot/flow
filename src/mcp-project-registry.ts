import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import * as z from "zod/v4";

import { validateFlowConfig } from "./config/config-loader.js";
import { nowIso } from "./contracts.js";
import { flowConfigPath, flowMcpProjectRegistryPath } from "./flow-layout.js";

export const flowMcpProjectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
  configPath: z.string().min(1),
  valid: z.boolean(),
  icon: z.string().min(1).optional(),
  error: z.string().optional(),
  addedAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime(),
});
export type FlowMcpProjectRecord = z.infer<typeof flowMcpProjectRecordSchema>;

const flowMcpProjectRegistryStateSchema = z.object({
  defaultProjectId: z.string().min(1).optional(),
  projects: z.array(flowMcpProjectRecordSchema).default([]),
});
type FlowMcpProjectRegistryState = z.infer<typeof flowMcpProjectRegistryStateSchema>;

export interface FlowMcpProjectRegistryOptions {
  statePath?: string;
}

export class FlowMcpProjectRegistry {
  private readonly statePath: string;

  constructor(options: FlowMcpProjectRegistryOptions = {}) {
    this.statePath = options.statePath ?? process.env.FLOW_MCP_PROJECTS_PATH ?? flowMcpProjectRegistryPath();
  }

  async listProjects(): Promise<FlowMcpProjectRecord[]> {
    const state = await this.readState();
    return [...state.projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async defaultProject(): Promise<FlowMcpProjectRecord | undefined> {
    const state = await this.readState();
    return state.projects.find((project) => project.id === state.defaultProjectId)
      ?? state.projects[0];
  }

  async getProject(input: { projectId?: string; root?: string }): Promise<FlowMcpProjectRecord | undefined> {
    const state = await this.readState();
    const resolvedRoot = input.root ? resolve(input.root) : undefined;
    return state.projects.find((candidate) =>
      input.projectId ? candidate.id === input.projectId : resolvedRoot ? resolve(candidate.root) === resolvedRoot : false
    );
  }

  async addProject(root: string, options: { makeDefault?: boolean } = {}): Promise<FlowMcpProjectRecord> {
    const resolvedRoot = resolve(root);
    const state = await this.readState();
    const existing = state.projects.find((project) => resolve(project.root) === resolvedRoot);
    const project = await this.projectRecord(resolvedRoot, existing);
    const projects = upsertProject(state.projects, project);
    const existingDefaultId = state.defaultProjectId;
    await this.writeState({
      defaultProjectId: options.makeDefault === true || !existingDefaultId ? project.id : existingDefaultId,
      projects,
    });
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const state = await this.readState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown Flow project ${projectId}.`);
    const remaining = state.projects.filter((candidate) => candidate.id !== projectId);
    const existingDefaultId = state.defaultProjectId;
    const nextDefaultId = existingDefaultId === projectId ? remaining[0]?.id : existingDefaultId;
    await this.writeState({
      defaultProjectId: remaining.some((candidate) => candidate.id === nextDefaultId) ? nextDefaultId : remaining[0]?.id,
      projects: remaining,
    });
  }

  async refreshProject(projectId: string): Promise<FlowMcpProjectRecord> {
    const state = await this.readState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown Flow project ${projectId}.`);
    const refreshed = await this.projectRecord(project.root, project);
    await this.writeState({
      defaultProjectId: state.defaultProjectId,
      projects: upsertProject(state.projects, refreshed),
    });
    return refreshed;
  }

  private async projectRecord(root: string, existing?: FlowMcpProjectRecord): Promise<FlowMcpProjectRecord> {
    const now = nowIso();
    const validation = await validateFlowConfig({ projectRoot: root });
    return flowMcpProjectRecordSchema.parse({
      id: existing?.id ?? projectIdForRoot(root),
      name: validation.config?.project.name || basename(root) || "Flow Project",
      root,
      configPath: flowConfigPath(root),
      valid: validation.ok,
      icon: validation.config?.project.icon,
      error: validation.ok ? undefined : validation.errors.join("; "),
      addedAt: existing?.addedAt ?? now,
      lastOpenedAt: now,
    });
  }

  private async readState(): Promise<FlowMcpProjectRegistryState> {
    if (!existsSync(this.statePath)) return { projects: [] };
    try {
      const raw = await readFile(this.statePath, "utf8");
      return flowMcpProjectRegistryStateSchema.parse(JSON.parse(raw));
    } catch {
      return { projects: [] };
    }
  }

  private async writeState(state: FlowMcpProjectRegistryState): Promise<void> {
    const parsed = flowMcpProjectRegistryStateSchema.parse(state);
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }
}

export function projectIdForRoot(root: string): string {
  const resolved = resolve(root);
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${basename(resolved) || "project"}-${digest}`;
}

function upsertProject(projects: FlowMcpProjectRecord[], project: FlowMcpProjectRecord): FlowMcpProjectRecord[] {
  const index = projects.findIndex((candidate) => candidate.id === project.id || resolve(candidate.root) === resolve(project.root));
  if (index === -1) return [...projects, project];
  return projects.map((candidate, candidateIndex) => candidateIndex === index ? project : candidate);
}
