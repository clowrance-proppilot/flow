import type { PendingConfirmationState } from "../types";

export function PendingActionNotice({
  text,
  pendingConfirmation,
  approving,
  onApprove,
}: {
  text: string;
  pendingConfirmation?: PendingConfirmationState | null;
  approving?: boolean;
  onApprove?: () => void;
}) {
  const isConfirmation = text.toLowerCase().startsWith("needs confirmation:");
  const body = pendingConfirmation?.summary || (isConfirmation ? text.replace(/^needs confirmation:\s*/i, "").trim() : text);
  return (
    <div className={isConfirmation ? "pending-action-notice needs-confirmation" : "pending-action-notice"} aria-label="Workflow notice">
      <span className="pending-action-label">{isConfirmation ? "Needs confirmation" : "Workflow"}</span>
      <span className="pending-action-text">{body}</span>
      {pendingConfirmation && onApprove ? (
        <button type="button" className="pending-action-button" onClick={onApprove} disabled={approving}>
          {approving ? "Approving..." : "Approve"}
        </button>
      ) : null}
    </div>
  );
}
