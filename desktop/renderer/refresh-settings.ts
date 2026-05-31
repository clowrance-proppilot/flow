export const defaultDesktopRefreshIntervals = {
  dashboardMs: 5_000,
  autoflowStatusMs: 5_000,
} as const;

export interface DesktopRefreshSettings {
  refreshIntervalMs?: number;
  dashboardRefreshIntervalMs?: number;
  autoflowStatusRefreshIntervalMs?: number;
}

export interface DesktopRefreshIntervals {
  dashboardMs: number;
  autoflowStatusMs: number;
}

export function desktopRefreshIntervalsFromSettings(settings?: DesktopRefreshSettings): DesktopRefreshIntervals {
  const shared = positiveIntervalMs(settings?.refreshIntervalMs, defaultDesktopRefreshIntervals.dashboardMs);
  return {
    dashboardMs: positiveIntervalMs(settings?.dashboardRefreshIntervalMs, shared),
    autoflowStatusMs: positiveIntervalMs(settings?.autoflowStatusRefreshIntervalMs, shared),
  };
}

function positiveIntervalMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
