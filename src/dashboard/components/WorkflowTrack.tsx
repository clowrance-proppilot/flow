import React from "react";
import { isExceptionalWorkStatusLabel, workStatusSteps } from "../../dashboard-labels.js";
import { cx, workStatusThemeClass } from "../utils.js";

export function WorkflowTrack({ status, size = "sm" }: { status?: string; size?: "sm" | "md" }) {
  const themeClass = workStatusThemeClass(status || "Unknown");
  if (status && isExceptionalWorkStatusLabel(status)) {
    return (
      <span
        className={cx(
          "status-pill inline-flex items-center rounded-full border px-2 py-0.5 text-[0.66rem] font-semibold",
          themeClass,
        )}
        title={status}
      >
        {status}
      </span>
    );
  }

  const currentIndex = workStatusSteps.indexOf(status as typeof workStatusSteps[number]);
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2";
  const gap = size === "sm" ? "gap-1" : "gap-1.5";
  const barH = size === "sm" ? "h-px" : "h-[1.5px]";

  return (
    <div className={cx("workflow-track flex items-center", gap, themeClass)} title={status ? `Work status: ${status}` : "Work status unknown"}>
      {workStatusSteps.map((step, i) => {
        const isPast = currentIndex >= 0 && i < currentIndex;
        const isCurrent = i === currentIndex;
        const isFuture = currentIndex < 0 || i > currentIndex;
        return (
          <React.Fragment key={step}>
            {i > 0 && (
              <span className={cx(barH, "w-2 rounded-full", isPast || isCurrent ? "status-track-fill opacity-50" : "bg-[var(--th-fg-faint)] opacity-30")} />
            )}
            <span
              className={cx(
                "rounded-full transition-colors",
                dotSize,
                isCurrent && "status-dot",
                isPast && "status-dot opacity-50",
                isFuture && "bg-[var(--th-fg-faint)] opacity-30",
              )}
            />
          </React.Fragment>
        );
      })}
      {size === "md" && status && (
        <span className="ml-1.5 text-[0.68rem] font-semibold text-[var(--th-fg-muted)]">
          {status}
        </span>
      )}
    </div>
  );
}
