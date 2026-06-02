export type WorkStatusFilter = "all" | string;
export type StatusKind = "loading" | "ok" | "error";

export type DashboardIssue = {
  ref: string;
  title?: string;
  workStatus?: string;
  workStatusDetail?: string;
  statusLabel?: string;
  repositories?: string[];
  blockerLabels?: string[];
  prStatus?: string;
  reviewStatus?: string;
  evidenceStatus?: string;
  documentationStatus?: string;
  updatedLabel?: string;
  nextPickup?: string;
  handoffPrompt?: string;
};

export type DashboardIssueStringField =
  | "title"
  | "workStatus"
  | "workStatusDetail"
  | "statusLabel"
  | "prStatus"
  | "reviewStatus"
  | "evidenceStatus"
  | "documentationStatus"
  | "updatedLabel"
  | "nextPickup"
  | "handoffPrompt";

export type DashboardPayload = {
  ok: boolean;
  snapshot?: {
    freshnessLabel?: string;
  };
  issues?: DashboardIssue[];
};
