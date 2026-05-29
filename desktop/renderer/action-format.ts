import type { DashboardIssue, DesktopAction, PendingConfirmationState } from "./types";

export function pendingConfirmationFromActionResult(result: unknown): PendingConfirmationState | null {
  if (!result || typeof result !== "object") return null;
  const record = result as {
    session?: { pendingConfirmation?: { id?: unknown; summary?: unknown } };
  };
  const pending = record.session?.pendingConfirmation;
  if (!pending || typeof pending.id !== "string" || typeof pending.summary !== "string") return null;
  return { id: pending.id, summary: pending.summary };
}

export function formatActionSummary(action: DesktopAction, summary: string): string {
  if (action === "autoflow") return formatAutoflowNotice(summary);
  if (action === "approve_confirmation") return compactChatText(summary);
  if (action === "run_doctor") {
    const match = summary.match(/^Doctor (\w+) for ([^.]+)\.\s*(\{.*\})$/s);
    if (match) {
      const [, status, issueRef, raw] = match;
      try {
        const payload = JSON.parse(raw) as {
          blockers?: string[];
          readiness?: { nextActions?: Array<{ summary?: string }> };
          codeReview?: { prUrl?: string; state?: string; mergeStateStatus?: string };
        };
        const blockers = (payload.blockers ?? []).slice(0, 3);
        const nextActions = (payload.readiness?.nextActions ?? [])
          .map((item) => item.summary)
          .filter(Boolean)
          .slice(0, 2);
        return [
          `Doctor ${status} for ${issueRef}.`,
          payload.codeReview?.prUrl ? `PR: ${payload.codeReview.prUrl} (${payload.codeReview.state ?? "unknown"} / ${payload.codeReview.mergeStateStatus ?? "unknown"})` : "",
          blockers.length ? `Blockers: ${blockers.join("; ")}` : "",
          nextActions.length ? `Next: ${nextActions.join("; ")}` : "",
        ].filter(Boolean).join("\n");
      } catch {
        return `Doctor ${status} for ${issueRef}.`;
      }
    }
  }
  return compactChatText(summary);
}

export function actionPayload(
  action: DesktopAction,
  prompt: string,
  issue: DashboardIssue | undefined,
  pendingConfirmation?: PendingConfirmationState | null,
): Record<string, unknown> {
  const summary = prompt.trim() || issue?.title || issue?.ref || "Flow Desktop action";
  if (action === "approve_confirmation") return { confirmationId: pendingConfirmation?.id };
  if (action === "record_evidence") return { summary, source: "Flow Desktop conversation" };
  if (action === "record_documentation") return { summary, disposition: "not_needed" };
  if (action === "record_result") return { summary, status: "succeeded" };
  return {};
}

function formatAutoflowNotice(summary: string): string {
  const match = summary.match(/^Autoflow ([^ ]+) for ([^.]+)\.\s*(.*)$/s);
  if (!match) return compactChatText(summary);
  const [, status, issueRef, message] = match;
  const label = status === "needs_confirmation" ? "Needs confirmation" : titleCase(status.replace(/_/g, " "));
  return compactChatText(`${label}: ${message || issueRef}`);
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactChatText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 700) return trimmed;
  return `${trimmed.slice(0, 680).trimEnd()}...`;
}
