import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import {
  type WorkRuntimeEvent,
  type WorkRuntimeSession,
  workRuntimeEventSchema,
  workRuntimeSessionSchema,
  createId,
  nowIso,
} from "./contracts.js";
import type { FlowStoreInterface } from "./store.js";

export interface SqlStorePaths {
  root: string;
}

/**
 * SQL-backed session store using SQLite.
 *
 * Replaces the file-based FlowStore with a SQLite-backed implementation
 * for better concurrent access and atomic operations.
 */
export class SqlFlowStore implements FlowStoreInterface {
  readonly root: string;
  private db: Database.Database | null = null;

  constructor(paths: SqlStorePaths) {
    this.root = paths.root;
  }

  private getDb(): Database.Database {
    if (!this.db) {
      this.ensureSync();
    }
    return this.db!;
  }

  private ensureSync(): void {
    if (this.db) return;
    mkdirSync(dirname(this.dbPath()), { recursive: true });
    this.db = new Database(this.dbPath());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
  }

  async ensure(): Promise<void> {
    this.ensureSync();
  }

  private dbPath(): string {
    return join(this.root, "flow-store.db");
  }

  private createTables(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
    `);
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
    const row = this.getDb().prepare("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) return undefined;
    return workRuntimeSessionSchema.parse(JSON.parse(row.data));
  }

  async writeSession(session: WorkRuntimeSession): Promise<WorkRuntimeSession> {
    const parsed = workRuntimeSessionSchema.parse({ ...session, updatedAt: nowIso() });
    const stmt = this.getDb().prepare(`
      INSERT INTO sessions (id, data, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `);
    stmt.run(parsed.id, JSON.stringify(parsed), parsed.createdAt, parsed.updatedAt);
    return parsed;
  }

  async appendEvent(event: Omit<WorkRuntimeEvent, "id" | "createdAt">): Promise<WorkRuntimeEvent> {
    const parsed = workRuntimeEventSchema.parse({
      ...event,
      id: createId("event"),
      createdAt: nowIso(),
    });
    const stmt = this.getDb().prepare(`
      INSERT INTO events (id, session_id, type, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(parsed.id, parsed.sessionId, parsed.type, JSON.stringify(parsed), parsed.createdAt);
    return parsed;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
