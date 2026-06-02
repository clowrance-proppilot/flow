import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlowStore } from "../../src/store.js";
import { SqlFlowStore } from "../../src/sql-store.js";

export async function withTempFlowRoot<T>(
  prefix: string,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function withSqlFlowStore<T>(
  prefix: string,
  run: (store: SqlFlowStore, root: string) => Promise<T>,
): Promise<T> {
  return withTempFlowRoot(prefix, async (root) => {
    const store = new SqlFlowStore({ root });
    try {
      await store.ensure();
      return await run(store, root);
    } finally {
      store.close();
    }
  });
}

export async function withFileFlowStore<T>(
  prefix: string,
  run: (store: FlowStore, root: string) => Promise<T>,
): Promise<T> {
  return withTempFlowRoot(prefix, async (root) => {
    const store = new FlowStore({ root });
    await store.ensure();
    return await run(store, root);
  });
}
