import type { AutoflowActivityState, AutoflowRunnerStatus } from "../types";

export function activityFromAutoflowStatus(status: AutoflowRunnerStatus): AutoflowActivityState {
  if (!status.enabled) {
    return { phase: "idle", label: "Autoflow paused", detail: "Project automation is off.", updatedAt: status.updatedAt };
  }

  const issues = status.issues ?? {};
  const entries = Object.entries(issues);
  const running = entries.filter(([, s]) => s.phase === "running");
  const recovering = entries.filter(([, s]) => s.phase === "recovering");
  const starting = entries.filter(([, s]) => s.phase === "starting");
  const needsInput = entries.filter(([, s]) => s.phase === "needs_input");
  const failed = entries.filter(([, s]) => s.phase === "failed");

  if (running.length > 0 || recovering.length > 0) {
    const active = [...running, ...recovering];
    const refs = active.map(([ref]) => ref).slice(0, 3).join(", ");
    return {
      phase: "thinking",
      label: `Working ${active.length} issue${active.length === 1 ? "" : "s"}`,
      detail: active.length <= 3 ? refs : `${refs} +${active.length - 3} more`,
      updatedAt: status.updatedAt,
    };
  }
  if (starting.length > 0) {
    return {
      phase: "starting",
      label: `Starting ${starting.length} issue${starting.length === 1 ? "" : "s"}`,
      updatedAt: status.updatedAt,
    };
  }
  if (needsInput.length > 0) {
    const refs = needsInput.map(([ref]) => ref).slice(0, 2).join(", ");
    return {
      phase: "failed",
      label: `${needsInput.length} need${needsInput.length === 1 ? "s" : ""} input`,
      detail: needsInput.length <= 2 ? refs : `${refs} +${needsInput.length - 2} more`,
      updatedAt: status.updatedAt,
    };
  }
  if (failed.length > 0) {
    return {
      phase: "failed",
      label: `${failed.length} failed`,
      detail: failed.map(([ref]) => ref).slice(0, 2).join(", "),
      updatedAt: status.updatedAt,
    };
  }
  return {
    phase: "idle",
    label: "Autoflow watching",
    detail: status.activeCount > 0 ? `${status.activeCount} active` : "No active runs",
    updatedAt: status.updatedAt,
  };
}

export function AutoflowHealth({
  enabled,
  activity,
  autoflowStatus,
}: {
  enabled: boolean;
  activity: AutoflowActivityState | null;
  autoflowStatus?: AutoflowRunnerStatus | null;
}) {
  const stateClass = enabled ? activity?.phase ?? "idle" : "paused";
  const label = activity?.label ?? (enabled ? "Autoflow watching" : "Autoflow paused");
  const detail = activity?.detail ?? (enabled ? "No active runs" : "Project automation is off");
  const concurrency = autoflowStatus?.maxConcurrency;
  return (
    <div className={`autoflow-health ${stateClass}`} aria-label="Autoflow health">
      <span className="autoflow-health-dot" aria-hidden="true" />
      <span className="autoflow-health-label">{label}</span>
      {concurrency ? <span className="autoflow-health-concurrency">/{concurrency}</span> : null}
      <span className="autoflow-health-detail">{detail}</span>
    </div>
  );
}
