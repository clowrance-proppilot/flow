import type { PiActivityState } from "../types";

export function StatusSummary({
  activity,
}: {
  activity: PiActivityState | null;
}) {
  const showDetail = activity?.phase === "tool" || activity?.phase === "responding" || activity?.phase === "failed";
  return (
    <div className={`status-summary ${activity?.phase ?? "idle"}`} aria-label="Flow status">
      <span className="pi-activity-pulse" aria-hidden="true" />
      <span className="pi-activity-label">{activity?.label ?? "Agent not started"}</span>
      {activity?.toolName ? <span className="pi-activity-tool">{activity.toolName}</span> : null}
      {showDetail && activity?.detail ? <span className="pi-activity-detail">{activity.detail}</span> : null}
    </div>
  );
}
