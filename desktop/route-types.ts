import type { DashboardState } from "../src/dashboard-state.js";
import type { createConfiguredWorkRuntime } from "../src/runtime-factory.js";
import type { StandaloneAutoflowRunner } from "../src/experimental/autoflow-runner.js";
import type { ClaudeSessionDriver } from "../src/experimental/claude-session-driver.js";
import type { DesktopProjectRecord, DesktopProjectRegistry } from "./project-registry.js";

export interface DesktopProjectSurface {
  project: DesktopProjectRecord;
  configured: ReturnType<typeof createConfiguredWorkRuntime>;
  dashboardState: DashboardState;
  agentSessionDriver: ClaudeSessionDriver;
  autoflowRunner: StandaloneAutoflowRunner;
}

export type ProjectSurfaceLoader = (project: DesktopProjectRecord) => Promise<DesktopProjectSurface>;

export interface RouteContext {
  projectRegistry: DesktopProjectRegistry;
  projectSurface: ProjectSurfaceLoader;
  invalidateProjectSurface?: (projectId: string) => void;
}
