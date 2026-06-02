/**
 * Shared codecs for runtime session and event records.
 *
 * Both the file-backed FlowStore and the SQL-backed KyselyFlowState
 * use these helpers so schema changes land in one place.
 */

import {
  type WorkRuntimeEvent,
  type WorkRuntimeSession,
  workRuntimeEventSchema,
  workRuntimeSessionSchema,
  createId,
  nowIso,
} from "./contracts.js";

/**
 * Build a new WorkRuntimeSession record with defaults for empty arrays
 * and auto-generated timestamps.
 */
export function buildRuntimeSession(id = createId("session")): WorkRuntimeSession {
  const now = nowIso();
  return workRuntimeSessionSchema.parse({
    id,
    findings: [],
    workerResults: [],
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Build a new WorkRuntimeEvent record from an event input, adding
 * an auto-generated id and createdAt timestamp.
 */
export function buildRuntimeEvent(
  event: Omit<WorkRuntimeEvent, "id" | "createdAt">,
): WorkRuntimeEvent {
  return workRuntimeEventSchema.parse({
    ...event,
    id: createId("event"),
    createdAt: nowIso(),
  });
}
