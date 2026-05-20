import type { IssueState } from "../contracts.js";
import type { FlowEvent, FlowSubject } from "./events.js";
import { sortFlowEvents } from "./projection.js";

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
  target: FlowSubject;
  linkedAt: string;
}

export interface RecordProjection {
  eventId: string;
  primitive: "record";
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
  subject: FlowSubject;
  state: IssueState;
  claims: ClaimProjection[];
  blockers: BlockerProjection[];
  links: LinkProjection[];
  records: RecordProjection[];
  handoffs: HandoffProjection[];
  completedAt?: string;
  completedByEventId?: string;
}

export function projectWorkSubject(events: FlowEvent[], fallbackSubject: FlowSubject = { type: "issue", ref: "unknown" }): ProjectedWorkSubject {
  const ordered = sortFlowEvents(events);
  const subject = ordered[0]?.subject ?? fallbackSubject;
  const claims: ClaimProjection[] = [];
  const blockers: BlockerProjection[] = [];
  const links: LinkProjection[] = [];
  const records: RecordProjection[] = [];
  const handoffs: HandoffProjection[] = [];
  let completedAt: string | undefined;
  let completedByEventId: string | undefined;

  for (const event of ordered) {
    if (event.primitive === "claim") {
      claims.push({
        eventId: event.id,
        actorId: event.actor.id,
        claimedAt: event.timestamp,
        input: event.input,
      });
    }
    if (event.primitive === "ask") {
      blockers.push({
        eventId: event.id,
        actorId: event.actor.id,
        askedAt: event.timestamp,
        input: event.input,
      });
    }
    if (event.primitive === "decide") {
      const resolvedEventId = resolvedAskEventId(event);
      const blocker = resolvedEventId
        ? blockers.find((candidate) => candidate.eventId === resolvedEventId)
        : blockers.find((candidate) => !candidate.resolvedByEventId);
      if (blocker) {
        blocker.resolvedByEventId = event.id;
        blocker.resolvedAt = event.timestamp;
      }
    }
    if (event.primitive === "link") {
      for (const link of event.links) {
        links.push({
          eventId: event.id,
          type: link.type,
          target: link.target,
          linkedAt: event.timestamp,
        });
      }
    }
    if (event.primitive === "record") {
      records.push({
        eventId: event.id,
        primitive: "record",
        recordedAt: event.timestamp,
        input: event.input,
        result: event.result,
      });
    }
    if (event.primitive === "handoff") {
      handoffs.push({
        eventId: event.id,
        actorId: event.actor.id,
        handedOffAt: event.timestamp,
        input: event.input,
        result: event.result,
      });
    }
    if (event.primitive === "complete") {
      completedAt = event.timestamp;
      completedByEventId = event.id;
    }
  }

  const unresolvedBlockers = blockers.filter((blocker) => !blocker.resolvedByEventId);
  return {
    subject,
    state: deriveWorkState({ claims, blockers: unresolvedBlockers, links, records, handoffs, completedAt }),
    claims,
    blockers,
    links,
    records,
    handoffs,
    completedAt,
    completedByEventId,
  };
}

function deriveWorkState(input: {
  claims: ClaimProjection[];
  blockers: BlockerProjection[];
  links: LinkProjection[];
  records: RecordProjection[];
  handoffs: HandoffProjection[];
  completedAt?: string;
}): IssueState {
  if (input.completedAt) return "done";
  if (input.blockers.length) return "blocked";
  if (input.links.some((link) => link.target.type === "pull_request")) return "review_ready";
  if (input.handoffs.length || input.records.length) return "running";
  if (input.claims.length) return "selected";
  return "queued";
}

function resolvedAskEventId(event: FlowEvent): string | undefined {
  if (event.input && typeof event.input === "object" && "askEventId" in event.input) {
    const value = (event.input as { askEventId?: unknown }).askEventId;
    return typeof value === "string" ? value : undefined;
  }
  return event.links.find((link) => link.type === "resolves" && link.target.type === "flow_event")?.target.ref;
}
