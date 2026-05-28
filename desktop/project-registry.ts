import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { flowConfigPath, nowIso, validateFlowConfig } from "../src/index.js";

export const desktopProjectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
  configPath: z.string().min(1),
  valid: z.boolean(),
  error: z.string().optional(),
  addedAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime(),
});
export type DesktopProjectRecord = z.infer<typeof desktopProjectRecordSchema>;

const desktopProjectRegistryStateSchema = z.object({
  activeProjectId: z.string().min(1).optional(),
  projects: z.array(desktopProjectRecordSchema).default([]),
});
type DesktopProjectRegistryState = z.infer<typeof desktopProjectRegistryStateSchema>;

export interface DesktopProjectRegistryOptions {
  statePath: string;
}

export class DesktopProjectRegistry {
  private readonly statePath: string;

  constructor(options: DesktopProjectRegistryOptions) {
    this.statePath = options.statePath;
  }

  async listProjects(): Promise<DesktopProjectRecord[]> {
    const state = await this.readState();
    return [...state.projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async activeProject(preferredRoot?: string): Promise<DesktopProjectRecord | undefined> {
    const state = await this.readState();
    if (preferredRoot) {
      const resolvedPreferredRoot = resolve(preferredRoot);
      const preferred = state.projects.find((project) => resolve(project.root) === resolvedPreferredRoot);
      if (preferred) return preferred;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? state.projects[0];
  }

  async addProject(root: string): Promise<DesktopProjectRecord> {
    const resolvedRoot = resolve(root);
    const state = await this.readState();
    const existing = state.projects.find((project) => project.root === resolvedRoot);
    const validated = await this.projectRecord(resolvedRoot, existing);
    const projects = upsertProject(state.projects, validated);
    await this.writeState({
      activeProjectId: validated.id,
      projects,
    });
    return validated;
  }

  async setActiveProject(projectId: string): Promise<DesktopProjectRecord> {
    const state = await this.readState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown Flow project ${projectId}.`);
    const updated = { ...project, lastOpenedAt: nowIso() };
    await this.writeState({
      activeProjectId: updated.id,
      projects: upsertProject(state.projects, updated),
    });
    return updated;
  }

  async refreshProject(projectId: string): Promise<DesktopProjectRecord> {
    const state = await this.readState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown Flow project ${projectId}.`);
    const refreshed = await this.projectRecord(project.root, project);
    await this.writeState({
      activeProjectId: state.activeProjectId,
      projects: upsertProject(state.projects, refreshed),
    });
    return refreshed;
  }

  private async projectRecord(root: string, existing?: DesktopProjectRecord): Promise<DesktopProjectRecord> {
    const now = nowIso();
    const validation = await validateFlowConfig({ projectRoot: root });
    return desktopProjectRecordSchema.parse({
      id: existing?.id ?? projectIdForRoot(root),
      name: validation.config?.project.name || basename(root) || "Flow Project",
      root,
      configPath: flowConfigPath(root),
      valid: validation.ok,
      error: validation.ok ? undefined : validation.errors.join("; "),
      addedAt: existing?.addedAt ?? now,
      lastOpenedAt: now,
    });
  }

  private async readState(): Promise<DesktopProjectRegistryState> {
    if (!existsSync(this.statePath)) return { projects: [] };
    try {
      const raw = await readFile(this.statePath, "utf8");
      return desktopProjectRegistryStateSchema.parse(JSON.parse(raw));
    } catch {
      return { projects: [] };
    }
  }

  private async writeState(state: DesktopProjectRegistryState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const parsed = desktopProjectRegistryStateSchema.parse(state);
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

function upsertProject(projects: DesktopProjectRecord[], project: DesktopProjectRecord): DesktopProjectRecord[] {
  const index = projects.findIndex((candidate) => candidate.id === project.id);
  if (index === -1) return [...projects, project];
  return projects.map((candidate, candidateIndex) => candidateIndex === index ? project : candidate);
}
