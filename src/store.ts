import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type WorkRuntimeEvent,
  type WorkRuntimeSession,
  workRuntimeEventSchema,
  workRuntimeSessionSchema,
  createId,
  nowIso,
} from "./contracts.js";

export interface StorePaths {
  root: string;
}

/**
 * Session-local runtime scratch store.
 *
 * This store is intentionally separate from Flow's durable workflow ledger.
 * Use the workflow ledger for authoritative issue, worker, job, and evidence
 * state; use FlowStore for CLI/session selection state and transient runtime
 * traces that can be rebuilt from the ledger and provider state.
 */
export class FlowStore {
  readonly root: string;

  constructor(paths: StorePaths) {
    this.root = paths.root;
  }

  async ensure(): Promise<void> {
    await mkdir(join(this.root, "sessions"), { recursive: true });
    await mkdir(join(this.root, "events"), { recursive: true });
  }

  async createSession(id = createId("session")): Promise<WorkRuntimeSession> {
    const now = nowIso();
    const session = workRuntimeSessionSchema.parse({
      id,
      findings: [],
      workerResults: [],
      createdAt: now,
      updatedAt: now,
    });
    await this.writeSession(session);
    return session;
  }

  async readSession(id: string): Promise<WorkRuntimeSession | undefined> {
    return this.readJson(join(this.root, "sessions", `${id}.json`), workRuntimeSessionSchema);
  }

  async writeSession(session: WorkRuntimeSession): Promise<WorkRuntimeSession> {
    const parsed = workRuntimeSessionSchema.parse({ ...session, updatedAt: nowIso() });
    await this.writeJson(join(this.root, "sessions", `${parsed.id}.json`), parsed);
    return parsed;
  }

  async appendEvent(event: Omit<WorkRuntimeEvent, "id" | "createdAt">): Promise<WorkRuntimeEvent> {
    const parsed = workRuntimeEventSchema.parse({
      ...event,
      id: createId("event"),
      createdAt: nowIso(),
    });
    await this.appendJsonLine(join(this.root, "events", `${safeName(parsed.sessionId)}.jsonl`), parsed);
    return parsed;
  }

  private async readJson<T>(
    path: string,
    schema: { parse(value: unknown): T },
  ): Promise<T | undefined> {
    try {
      const raw = await readFile(path, "utf8");
      return schema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const existing = await readFile(path, "utf8").catch((error: unknown) => {
      if (isMissingFile(error)) return "";
      throw error;
    });
    await writeFile(path, `${existing}${JSON.stringify(value)}\n`, "utf8");
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
