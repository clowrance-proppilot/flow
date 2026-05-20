import type { FlowEvent, FlowEventInput, FlowEventQuery, FlowSubject } from "./events.js";

export interface FlowEventLedger {
  append(event: FlowEvent | FlowEventInput): Promise<FlowEvent>;
  appendMany(events: Array<FlowEvent | FlowEventInput>): Promise<FlowEvent[]>;
  readSubject(subject: FlowSubject): Promise<FlowEvent[]>;
  query(query: FlowEventQuery): Promise<FlowEvent[]>;
}
