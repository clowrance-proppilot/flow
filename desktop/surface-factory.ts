import { DashboardState } from "../src/dashboard-state.js";
import { validateFlowConfig } from "../src/config/config-loader.js";
import { createConfiguredWorkRuntime } from "../src/runtime-factory.js";
import { GitAdapter } from "../src/adapters/git.js";
import { createDefaultAutoflowRunnerState, StandaloneAutoflowRunner } from "../src/experimental/autoflow-runner.js";
import { PiSessionDriver } from "../src/pi-session-driver.js";
import type { DesktopProjectRecord } from "./project-registry.js";
import type { DesktopProjectSurface } from "./route-types.js";
import { LruMap } from "./lru-map.js";

export interface DesktopSurfaceFactoryOptions {
  desktopAgentDisabled?: boolean;
}

export class DesktopSurfaceFactory {
  private readonly cache: LruMap<string, DesktopProjectSurface>;
  private readonly desktopAgentDisabled: boolean;

  constructor(options: DesktopSurfaceFactoryOptions) {
    this.desktopAgentDisabled = options.desktopAgentDisabled ?? false;
    this.cache = new LruMap<string, DesktopProjectSurface>(5);
  }

  async getSurface(project: DesktopProjectRecord): Promise<DesktopProjectSurface> {
    const cached = this.cache.get(project.id);
    if (cached && cached.project.root === project.root) return cached;

    const configValidation = await validateFlowConfig({ projectRoot: project.root });
    const configured = createConfiguredWorkRuntime({
      projectRoot: project.root,
      flowConfig: configValidation.config,
    });
    const dashboardState = new DashboardState({ runtime: configured.runtime });
    const piSessionDriver = new PiSessionDriver({
      runtime: configured.runtime,
      repoRoot: project.root,
      flowSessionId: `desktop-${project.id}`,
      agent: this.desktopAgentDisabled ? false : undefined,
    });
    const git = new GitAdapter();

    const surface: DesktopProjectSurface = {
      project,
      configured,
      dashboardState,
      piSessionDriver,
      autoflowRunner: new StandaloneAutoflowRunner({
        projectId: project.id,
        runtime: configured.runtime,
        state: createDefaultAutoflowRunnerState(project.root),
        agentSessionDriver: piSessionDriver,
        gitInspect: async (path: string) => {
          const status = await git.inspect(path);
          return { dirty: status.dirty, entries: status.entries };
        },
      }),
    };

    this.cache.set(project.id, surface);
    return surface;
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }
}
