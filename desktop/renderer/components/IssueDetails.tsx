import type { DashboardIssue } from "../types";
import { workStatusLabel, autoflowPhaseLabel, autoflowPhaseThemeClass } from "../status";
import { recordStatusClass, recordStatusLabel } from "../status";

export function IssueDetails({
  issue,
  autoflowStatus,
}: {
  issue: DashboardIssue;
  autoflowStatus?: { phase: string; summary?: string } | null;
}) {
  const blockers = issue.blockerLabels ?? [];
  const repos = issue.repositories ?? [];
  const isIntervention = autoflowStatus?.phase === "needs_input";
  return (
    <section className="issue-detail">
      {autoflowStatus && autoflowStatus.phase !== "idle" ? (
        <div className={`detail-section autoflow-detail-section ${autoflowPhaseThemeClass(autoflowStatus.phase)}`}>
          <div className="eyebrow">Autoflow</div>
          <div className="autoflow-detail-row">
            <span className={`autoflow-detail-phase ${autoflowPhaseThemeClass(autoflowStatus.phase)}`}>
              <span className="autoflow-detail-dot" aria-hidden="true" />
              {autoflowPhaseLabel(autoflowStatus.phase)}
            </span>
          </div>
          {autoflowStatus.summary ? (
            <div className="autoflow-detail-summary">{autoflowStatus.summary}</div>
          ) : null}
          {isIntervention ? (
            <div className="autoflow-intervention-panel">
              <p className="autoflow-intervention-text">
                Autoflow is blocked and needs your input. Open the issue to review blockers and take action.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="detail-section">
        <div className="eyebrow">Details</div>
        <div className="detail-grid">
          <span className="detail-label">Ref</span>
          <span className="detail-value mono">{issue.ref}</span>

          <span className="detail-label">Status</span>
          <span className="detail-value">{workStatusLabel(issue)}</span>

          {issue.workStatusDetail ? (
            <>
              <span className="detail-label">Source</span>
              <span className="detail-value">{issue.workStatusDetail}</span>
            </>
          ) : null}

          {repos.length ? (
            <>
              <span className="detail-label">Repos</span>
              <span className="detail-value mono">{repos.join(", ")}</span>
            </>
          ) : null}

          {issue.prStatus ? (
            <>
              <span className="detail-label">PR</span>
              <span className="detail-value">{issue.prStatus}</span>
              <span className="detail-label">Review</span>
              <span className="detail-value">{issue.reviewStatus || "Pending"}</span>
            </>
          ) : null}

          <span className="detail-label">Evidence</span>
          <span className={recordStatusClass(issue.evidenceStatus)}>{recordStatusLabel(issue.evidenceStatus)}</span>

          <span className="detail-label">Docs</span>
          <span className={recordStatusClass(issue.documentationStatus)}>{recordStatusLabel(issue.documentationStatus)}</span>
        </div>
      </div>

      {blockers.length ? (
        <div className="detail-section">
          <div className="eyebrow">{workStatusLabel(issue) === "Blocked" ? "Blockers" : "Readiness Notes"}</div>
          {blockers.length > 3 ? (
            <details className="blocker-collapse">
              <summary className="blocker-collapse-summary">{blockers.length} items</summary>
              <div className="blocker-list">
                {blockers.map((label) => (
                  <div key={label} className={workStatusLabel(issue) === "Blocked" ? "blocker-note blocked" : "blocker-note"}>
                    {label}
                  </div>
                ))}
              </div>
            </details>
          ) : (
            <div className="blocker-list">
              {blockers.map((label) => (
                <div key={label} className={workStatusLabel(issue) === "Blocked" ? "blocker-note blocked" : "blocker-note"}>
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
