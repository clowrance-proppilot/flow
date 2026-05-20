import type { FlowEvent } from "./events.js";

export function sortFlowEvents(events: FlowEvent[]): FlowEvent[] {
  return [...events].sort((left, right) => {
    const byTime = left.timestamp.localeCompare(right.timestamp);
    return byTime || left.id.localeCompare(right.id);
  });
}
