import type { IssueState } from "../contracts.js";

export interface ClaimProjection {
  eventId: string;
  actorId: string;
  claimedAt: string;
  input?: unknown;
}

export interface BlockerProjection {
  eventId: string;
  actorId: string;
  askedAt: string;
  input?: unknown;
  resolvedByEventId?: string;
  resolvedAt?: string;
}

export interface LinkProjection {
  eventId: string;
  type: string;
  target: {
    type: string;
    ref: string;
  };
  linkedAt: string;
}

export interface RecordProjection {
  eventId: string;
  recordedAt: string;
  input?: unknown;
  result?: unknown;
}

export interface HandoffProjection {
  eventId: string;
  actorId: string;
  handedOffAt: string;
  input?: unknown;
  result?: unknown;
}

export interface ProjectedWorkSubject {
  subject: {
    type: string;
    ref: string;
  };
  state: IssueState;
  claims: ClaimProjection[];
  blockers: BlockerProjection[];
  links: LinkProjection[];
  records: RecordProjection[];
  handoffs: HandoffProjection[];
  completedAt?: string;
  completedByEventId?: string;
}
