import type { DashboardIssue } from "../types";
import { workStatusLabel } from "../status";
import { recordStatusClass, recordStatusLabel } from "../status";

export function IssueDetails({
  issue,
}: {
  issue: DashboardIssue;
}) {
  const blockers = issue.blockerLabels ?? [];
  const repos = issue.repositories ?? [];
  return (
    <section className="issue-detail">
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
          <div className="blocker-list">
            {blockers.map((label) => (
              <div key={label} className={workStatusLabel(issue) === "Blocked" ? "blocker-note blocked" : "blocker-note"}>
                {label}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
