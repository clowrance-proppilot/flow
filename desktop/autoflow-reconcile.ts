import type { WorkItem } from "../src/index.js";
import type { DesktopProjectRecord, DesktopProjectRegistry } from "./project-registry.js";
import type { DesktopProjectSurface, ProjectSurfaceLoader } from "./route-types.js";

export const desktopAutoflowReconcileIntervals = {
  activeMs: 30_000,
  idleMs: 120_000,
} as const;

export interface AutoflowReconcileSummary {
  enabledProjects: number;
  pendingProjects: number;
  reconciledProjects: number;
}

const autoflowQueueStates = new Set(["queued", "selected"]);

export function hasAutoflowQueueWork(queue: Pick<WorkItem, "state">[]): boolean {
  return queue.some((issue) => autoflowQueueStates.has(issue.state));
}

export async function runEnabledProjectAutoflowReconcile(
  projectRegistry: DesktopProjectRegistry,
  projectSurface: ProjectSurfaceLoader,
): Promise<AutoflowReconcileSummary> {
  const projects = await projectRegistry.listProjects();
  const validProjects = projects.filter((project) => project.valid);
  const summaries = await Promise.all(validProjects.map((project) => reconcileProjectIfQueued(project, projectSurface)));
  return {
    enabledProjects: summaries.filter((summary) => summary.enabled).length,
    pendingProjects: summaries.filter((summary) => summary.pending).length,
    reconciledProjects: summaries.filter((summary) => summary.reconciled).length,
  };
}

export function nextAutoflowReconcileDelay(summary: AutoflowReconcileSummary): number {
  return summary.pendingProjects > 0 || summary.reconciledProjects > 0
    ? desktopAutoflowReconcileIntervals.activeMs
    : desktopAutoflowReconcileIntervals.idleMs;
}

async function reconcileProjectIfQueued(
  project: DesktopProjectRecord,
  projectSurface: ProjectSurfaceLoader,
): Promise<{ enabled: boolean; pending: boolean; reconciled: boolean }> {
  const surface = await projectSurface(project);
  const status = await surface.autoflowRunner.status();
  if (!status.enabled) return { enabled: false, pending: false, reconciled: false };
  const pending = await projectHasQueuedAutoflowWork(surface);
  if (!pending) return { enabled: true, pending, reconciled: false };
  await surface.autoflowRunner.tick();
  return { enabled: true, pending, reconciled: true };
}

async function projectHasQueuedAutoflowWork(surface: DesktopProjectSurface): Promise<boolean> {
  return hasAutoflowQueueWork(await surface.configured.runtime.inspectQueue(50));
}
