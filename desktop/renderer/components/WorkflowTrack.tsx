import React from "react";
import { isExceptionalStatus, statusThemeClass, workflowSteps } from "../status";

export function WorkflowTrack({ status }: { status?: string }) {
  if (!status || isExceptionalStatus(status)) {
    return <span className={statusThemeClass(status || "Unknown")}>{status || "Unknown"}</span>;
  }
  const currentIndex = workflowSteps.indexOf(status as typeof workflowSteps[number]);
  return (
    <div className="workflow-track" title={status}>
      {workflowSteps.map((step, index) => (
        <React.Fragment key={step}>
          {index > 0 ? <span className={index <= currentIndex ? "track-line active" : "track-line"} /> : null}
          <span className={index <= currentIndex ? "track-dot active" : "track-dot"} />
        </React.Fragment>
      ))}
    </div>
  );
}
