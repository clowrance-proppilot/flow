import type { FlowEventLedger } from "./event-ledger.js";
import { type FlowEvent, type FlowEventInput, type FlowEventQuery, type FlowSubject, normalizeFlowEvent, sameSubject } from "./events.js";

export class MemoryFlowEventLedger implements FlowEventLedger {
  private readonly events: FlowEvent[] = [];

  async append(event: FlowEvent | FlowEventInput): Promise<FlowEvent> {
    const normalized = normalizeFlowEvent(event);
    if (normalized.idempotencyKey) {
      const existing = this.events.find((candidate) => candidate.idempotencyKey === normalized.idempotencyKey);
      if (existing) return existing;
    }
    this.events.push(normalized);
    return normalized;
  }

  async appendMany(events: Array<FlowEvent | FlowEventInput>): Promise<FlowEvent[]> {
    const appended: FlowEvent[] = [];
    for (const event of events) {
      appended.push(await this.append(event));
    }
    return appended;
  }

  async readSubject(subject: FlowSubject): Promise<FlowEvent[]> {
    return this.query({ subject });
  }

  async query(query: FlowEventQuery): Promise<FlowEvent[]> {
    return this.events.filter((event) => matchesQuery(event, query));
  }
}

export function matchesQuery(event: FlowEvent, query: FlowEventQuery): boolean {
  if (query.subject && !sameSubject(event.subject, query.subject)) return false;
  if (query.primitive && event.primitive !== query.primitive) return false;
  if (query.actorId && event.actor.id !== query.actorId) return false;
  if (query.correlationId && event.correlationId !== query.correlationId) return false;
  return true;
}
