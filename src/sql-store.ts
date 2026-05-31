import { join } from "node:path";

import type { WorkRuntimeEvent, WorkRuntimeSession } from "./contracts.js";
import { KyselyFlowState, createSqliteSqlStateConfig } from "./sql-state.js";
import type { FlowStoreInterface } from "./store.js";

export interface SqlStorePaths {
  root: string;
}

export class SqlFlowStore implements FlowStoreInterface {
  readonly root: string;
  private readonly state: KyselyFlowState;

  constructor(paths: SqlStorePaths) {
    this.root = paths.root;
    const config = createSqliteSqlStateConfig({ path: join(this.root, "flow-store.db") });
    if (!config.dialect) throw new Error("SQLite SQL state config did not create a dialect.");
    this.state = new KyselyFlowState({
      root: this.root,
      dialect: config.dialect,
    });
  }

  ensure(): Promise<void> {
    return this.state.ensure();
  }

  createSession(id?: string): Promise<WorkRuntimeSession> {
    return this.state.createSession(id);
  }

  readSession(id: string): Promise<WorkRuntimeSession | undefined> {
    return this.state.readSession(id);
  }

  writeSession(session: WorkRuntimeSession): Promise<WorkRuntimeSession> {
    return this.state.writeSession(session);
  }

  appendEvent(event: Omit<WorkRuntimeEvent, "id" | "createdAt">): Promise<WorkRuntimeEvent> {
    return this.state.appendEvent(event);
  }

  close(): void {
    void this.state.close();
  }
}
