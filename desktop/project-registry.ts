import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { flowConfigPath, nowIso, validateFlowConfig } from "../src/index.js";

export const desktopProjectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
  configPath: z.string().min(1),
  valid: z.boolean(),
  icon: z.string().min(1).optional(),
  error: z.string().optional(),
  autoflowEnabled: z.boolean().default(true),
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
  statePath?: string;
  dbPath?: string;
}

export class DesktopProjectRegistry {
  private readonly statePath?: string;
  private readonly dbPath?: string;
  private db: DatabaseSync | null = null;

  constructor(options: DesktopProjectRegistryOptions) {
    this.statePath = options.statePath;
    this.dbPath = options.dbPath;
    if (!this.statePath && !this.dbPath) throw new Error("DesktopProjectRegistry requires statePath or dbPath.");
  }

  async listProjects(): Promise<DesktopProjectRecord[]> {
    const state = await this.readState();
    const projects = activeProjects(state.projects);
    if (projects.length !== state.projects.length) {
      await this.writeState({
        activeProjectId: projects.some((project) => project.id === state.activeProjectId) ? state.activeProjectId : projects[0]?.id,
        projects,
      });
    }
    return [...projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async activeProject(preferredRoot?: string): Promise<DesktopProjectRecord | undefined> {
    const state = await this.readState();
    const projects = activeProjects(state.projects);
    if (preferredRoot) {
      const resolvedPreferredRoot = resolve(preferredRoot);
      const preferred = projects.find((project) => resolve(project.root) === resolvedPreferredRoot);
      if (preferred) return preferred;
    }
    return projects.find((project) => project.id === state.activeProjectId) ?? projects[0];
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

  async setProjectAutoflow(projectId: string, enabled: boolean): Promise<DesktopProjectRecord> {
    const state = await this.readState();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Unknown Flow project ${projectId}.`);
    const updated = desktopProjectRecordSchema.parse({
      ...project,
      autoflowEnabled: enabled,
      lastOpenedAt: nowIso(),
    });
    await this.writeState({
      activeProjectId: state.activeProjectId,
      projects: upsertProject(state.projects, updated),
    });
    return updated;
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
      icon: validation.config?.project.icon,
      error: validation.ok ? undefined : validation.errors.join("; "),
      autoflowEnabled: existing?.autoflowEnabled ?? true,
      addedAt: existing?.addedAt ?? now,
      lastOpenedAt: now,
    });
  }

  private async readState(): Promise<DesktopProjectRegistryState> {
    if (this.dbPath) return this.readDbState();
    const statePath = this.requireStatePath();
    if (!existsSync(statePath)) return { projects: [] };
    try {
      const raw = await readFile(statePath, "utf8");
      return desktopProjectRegistryStateSchema.parse(JSON.parse(raw));
    } catch {
      return { projects: [] };
    }
  }

  private async writeState(state: DesktopProjectRegistryState): Promise<void> {
    const parsed = desktopProjectRegistryStateSchema.parse(state);
    if (this.dbPath) {
      this.writeDbState(parsed);
      return;
    }
    const statePath = this.requireStatePath();
    await mkdir(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await rename(tempPath, statePath);
  }

  private requireStatePath(): string {
    if (!this.statePath) throw new Error("DesktopProjectRegistry statePath is not configured.");
    return this.statePath;
  }

  private getDb(): DatabaseSync {
    if (this.db) return this.db;
    if (!this.dbPath) throw new Error("DesktopProjectRegistry dbPath is not configured.");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_project_state (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    return this.db;
  }

  private readDbState(): DesktopProjectRegistryState {
    try {
      const row = this.getDb().prepare("SELECT data FROM desktop_project_state WHERE id = ?").get("projects") as { data: string } | undefined;
      if (!row) return { projects: [] };
      return desktopProjectRegistryStateSchema.parse(JSON.parse(row.data));
    } catch {
      return { projects: [] };
    }
  }

  private writeDbState(state: DesktopProjectRegistryState): void {
    const parsed = desktopProjectRegistryStateSchema.parse(state);
    this.getDb().prepare(`
      INSERT INTO desktop_project_state (id, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `).run("projects", JSON.stringify(parsed), nowIso());
  }
}

export function projectIdForRoot(root: string): string {
  const resolved = resolve(root);
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${basename(resolved) || "project"}-${digest}`;
}

function upsertProject(projects: DesktopProjectRecord[], project: DesktopProjectRecord): DesktopProjectRecord[] {
  const index = projects.findIndex((candidate) => candidate.id === project.id || resolve(candidate.root) === resolve(project.root));
  if (index === -1) return [...projects, project];
  return projects.map((candidate, candidateIndex) => candidateIndex === index ? project : candidate);
}

function activeProjects(projects: DesktopProjectRecord[]): DesktopProjectRecord[] {
  const seen = new Set<string>();
  const active: DesktopProjectRecord[] = [];
  for (const project of projects) {
    const root = resolve(project.root);
    if (seen.has(root) || !existsSync(project.configPath)) continue;
    seen.add(root);
    active.push(project);
  }
  return active;
}
