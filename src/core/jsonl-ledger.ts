import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { FlowEventLedger } from "./event-ledger.js";
import { type FlowEvent, type FlowEventInput, type FlowEventQuery, type FlowSubject, flowEventSchema, normalizeFlowEvent } from "./events.js";
import { matchesQuery } from "./memory-ledger.js";

export class JsonlFlowEventLedger implements FlowEventLedger {
  constructor(private readonly path: string) {}

  async append(event: FlowEvent | FlowEventInput): Promise<FlowEvent> {
    const normalized = normalizeFlowEvent(event);
    const existing = normalized.idempotencyKey
      ? (await this.readAll()).find((candidate) => candidate.idempotencyKey === normalized.idempotencyKey)
      : undefined;
    if (existing) return existing;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(normalized)}\n`, { flag: "a" });
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
    return (await this.readAll()).filter((event) => matchesQuery(event, query));
  }

  private async readAll(): Promise<FlowEvent[]> {
    if (!existsSync(this.path)) return [];
    const raw = await readFile(this.path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => flowEventSchema.parse(JSON.parse(line)));
  }
}
