import type { DashboardState } from "../src/dashboard-state.js";
import type { createConfiguredWorkRuntime } from "../src/runtime-factory.js";
import type { PiSessionDriver } from "./pi-session-driver.js";
import type { DesktopProjectRecord, DesktopProjectRegistry } from "./project-registry.js";

export interface DesktopProjectSurface {
  project: DesktopProjectRecord;
  configured: ReturnType<typeof createConfiguredWorkRuntime>;
  dashboardState: DashboardState;
  piSessionDriver: PiSessionDriver;
}

export type ProjectSurfaceLoader = (project: DesktopProjectRecord) => Promise<DesktopProjectSurface>;

export interface RouteContext {
  projectRegistry: DesktopProjectRegistry;
  projectSurface: ProjectSurfaceLoader;
  invalidateProjectSurface?: (projectId: string) => void;
}
