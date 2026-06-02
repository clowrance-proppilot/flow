import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { isExceptionalWorkStatusLabel } from "../../dashboard-labels.js";
import type { DashboardIssue } from "../types.js";
import { copyText, cx, recordStatusClass, recordStatusLabel, workStatusLabel } from "../utils.js";
import { DetailSection } from "./DetailSection.js";
import { WorkflowTrack } from "./WorkflowTrack.js";

export function IssueList(props: {
  issues: DashboardIssue[];
  activeRef: string;
  expandedRef: string;
  onActivate: (ref: string) => void;
}) {
  return (
    <div className="mirror-scroll min-h-0 overflow-auto p-3 sm:p-4 lg:p-5">
      <div className="grid gap-2 sm:gap-2.5">
        {props.issues.length ? props.issues.map((issue) => {
          const isExpanded = issue.ref === props.expandedRef;
          const statusLabel = workStatusLabel(issue);
          const detailsId = `detail-panel-${issue.ref}`;
          return (
            <div key={issue.ref} className="grid min-w-0">
              <button
                type="button"
                data-mirror-control="issue-focus"
                aria-controls={detailsId}
                aria-expanded={isExpanded}
                onClick={() => props.onActivate(issue.ref)}
                className={cx(
                  "grid w-full min-w-0 gap-2 rounded-md border border-l-4 border-[var(--th-border)] bg-[var(--th-card)] p-3 text-left shadow-sm transition-colors hover:bg-[var(--th-card-hover)] sm:p-3.5",
                  "border-l-[var(--th-primary)]",
                  issue.ref === props.activeRef && "accent-active",
                  isExpanded && "rounded-b-none",
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="whitespace-nowrap font-mono text-[0.8rem] font-extrabold accent-text">
                      {issue.ref}
                    </span>
                  </div>
                </div>
                <div className="line-clamp-2 break-words text-[0.85rem] font-semibold leading-snug text-[var(--th-fg)] sm:text-[0.86rem]">
                  {issue.title || "Untitled issue"}
                </div>
                <div className="flex items-center gap-2.5 sm:gap-3">
                  <WorkflowTrack status={statusLabel} />
                  {!isExceptionalWorkStatusLabel(statusLabel) && (
                    <span className="min-w-0 truncate text-[0.74rem] text-[var(--th-fg-muted)] sm:text-[0.75rem]">
                      {statusLabel}
                    </span>
                  )}
                </div>
              </button>
              {isExpanded ? <IssueDetails id={detailsId} issue={issue} /> : null}
            </div>
          );
        }) : (
          <div className="rounded-md border border-dashed border-[var(--th-border)] p-6 text-center text-xs text-[var(--th-fg-faint)]">
            No matching issues
          </div>
        )}
      </div>
    </div>
  );
}

function IssueDetails({
  id,
  issue,
}: {
  id: string;
  issue: DashboardIssue;
}) {
  const [copied, setCopied] = useState(false);
  const blockerLabels = Array.isArray(issue.blockerLabels) ? issue.blockerLabels : [];
  const repositories = Array.isArray(issue.repositories) ? issue.repositories : [];
  const statusLabel = workStatusLabel(issue);
  const handoffPrompt = (issue.handoffPrompt || issue.nextPickup || "").trim();
  const attentionTitle = statusLabel === "Blocked" ? "Blockers" : "Readiness Notes";
  const copyHandoffPrompt = () => {
    if (!handoffPrompt) return;
    void copyText(handoffPrompt).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <section id={id} className="min-w-0 rounded-b-md border border-t-0 border-l-4 border-[var(--th-border)] border-l-[var(--th-primary)] bg-[var(--th-surface)] shadow-sm">
      <DetailSection title="Issue Details">
        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[0.8rem] sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-y-2.5">
          <dt className="text-[var(--th-fg-muted)]">Status</dt>
          <dd className="m-0 break-words text-[var(--th-fg)]">{statusLabel}</dd>
          {issue.workStatusDetail && <>
            <dt className="text-[var(--th-fg-muted)]">Source</dt>
            <dd className="m-0 break-words text-[var(--th-fg-soft)]">{issue.workStatusDetail}</dd>
          </>}
          {repositories.length > 0 && <>
            <dt className="text-[var(--th-fg-muted)]">Repos</dt>
            <dd className="m-0 break-words font-mono text-[var(--th-fg)] [overflow-wrap:anywhere]">{repositories.join(", ")}</dd>
          </>}
          {issue.prStatus && <>
            <dt className="text-[var(--th-fg-muted)]">PR</dt>
            <dd className="m-0 break-words text-[var(--th-fg)]">
              {issue.prStatus}
            </dd>
            <dt className="text-[var(--th-fg-muted)]">Review</dt>
            <dd className="m-0 break-words text-[var(--th-fg)]">{issue.reviewStatus || "Pending"}</dd>
          </>}
          <dt className="text-[var(--th-fg-muted)]">Evidence</dt>
          <dd className={cx("m-0", recordStatusClass(issue.evidenceStatus))}>
            {recordStatusLabel(issue.evidenceStatus)}
          </dd>
          <dt className="text-[var(--th-fg-muted)]">Docs</dt>
          <dd className={cx("m-0", recordStatusClass(issue.documentationStatus))}>
            {recordStatusLabel(issue.documentationStatus)}
          </dd>
          {issue.updatedLabel && <>
            <dt className="text-[var(--th-fg-muted)]">Updated</dt>
            <dd className="m-0 font-mono text-[var(--th-fg)]">{issue.updatedLabel}</dd>
          </>}
        </dl>
      </DetailSection>

      {blockerLabels.length ? (
        <DetailSection title={attentionTitle}>
          <div className="grid gap-1.5 sm:gap-2">
            {blockerLabels.map((label, index) => (
              <div key={`${index}-${label}`} className={cx(
                "rounded-md border p-2.5 text-xs leading-relaxed [overflow-wrap:anywhere] sm:p-3",
                statusLabel === "Blocked"
                  ? "border-flow-red/40 bg-flow-red/10 text-red-300"
                  : "border-[var(--th-border)] bg-[var(--th-card)] text-[var(--th-fg-soft)]",
              )}>
                {label}
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}

      {handoffPrompt ? (
        <DetailSection title="Handoff Prompt">
          <div className="grid gap-3">
            <details className="group">
              <summary className="cursor-pointer text-[0.76rem] font-semibold text-[var(--th-fg-muted)] hover:text-[var(--th-fg)]">
                Show prompt ({handoffPrompt.length} chars)
              </summary>
              <pre className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--th-border)] bg-[var(--th-input)] p-3 text-[0.74rem] leading-relaxed text-[var(--th-fg-soft)] [overflow-wrap:anywhere] sm:p-3.5">{handoffPrompt}</pre>
            </details>
            <button
              type="button"
              data-mirror-control="copy-handoff-prompt"
              onClick={copyHandoffPrompt}
              className="status-filter status-theme-active inline-flex min-h-8 w-fit items-center gap-2 rounded-md border px-2.5 text-[0.76rem] font-semibold"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </DetailSection>
      ) : null}
    </section>
  );
}
