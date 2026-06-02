import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type WorkRuntimeEvent,
  type WorkRuntimeSession,
  workRuntimeSessionSchema,
  nowIso,
} from "./contracts.js";
import { buildRuntimeEvent, buildRuntimeSession } from "./store-codecs.js";
import { SqlFlowStore } from "./sql-store.js";

export interface StorePaths {
  root: string;
}

/**
 * Common interface for Flow session stores.
 * Both file-based and SQL-backed stores implement this interface.
 */
export interface FlowStoreInterface {
  readonly root: string;
  ensure(): Promise<void>;
  createSession(id?: string): Promise<WorkRuntimeSession>;
  readSession(id: string): Promise<WorkRuntimeSession | undefined>;
  writeSession(session: WorkRuntimeSession): Promise<WorkRuntimeSession>;
  appendEvent(event: Omit<WorkRuntimeEvent, "id" | "createdAt">): Promise<WorkRuntimeEvent>;
}

/**
 * Session-local runtime scratch store using file-based storage.
 *
 * This store is intentionally separate from Flow's durable workflow ledger.
 * Use the workflow ledger for authoritative issue, worker, job, and evidence
 * state; use FlowStore for CLI/session selection state and transient runtime
 * traces that can be rebuilt from the ledger and provider state.
 */
export class FlowStore implements FlowStoreInterface {
  readonly root: string;

  constructor(paths: StorePaths) {
    this.root = paths.root;
  }

  async ensure(): Promise<void> {
    await mkdir(join(this.root, "sessions"), { recursive: true });
    await mkdir(join(this.root, "events"), { recursive: true });
  }

  async createSession(id?: string): Promise<WorkRuntimeSession> {
    const session = buildRuntimeSession(id);
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
    const parsed = buildRuntimeEvent(event);
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

export type FlowStoreBackend = "file" | "sqlite";

export interface FlowStoreFactoryOptions {
  root: string;
  backend?: FlowStoreBackend;
}

/**
 * Factory function to create a FlowStore instance.
 * Defaults to the SQLite-backed store for better concurrent access.
 */
export function createFlowStore(options: FlowStoreFactoryOptions): FlowStoreInterface {
  const backend = options.backend ?? "sqlite";
  if (backend === "sqlite") {
    return new SqlFlowStore({ root: options.root });
  }
  return new FlowStore({ root: options.root });
}
