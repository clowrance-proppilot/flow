import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { SqlFlowStore } from "../src/sql-store.js";
import { FlowStore, createFlowStore } from "../src/store.js";

test("SqlFlowStore creates and reads sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-store-test-"));
  try {
    const store = new SqlFlowStore({ root });
    await store.ensure();

    const session = await store.createSession("test-session-1");
    assert.equal(session.id, "test-session-1");
    assert.ok(session.createdAt);
    assert.ok(session.updatedAt);

    const read = await store.readSession("test-session-1");
    assert.ok(read);
    assert.equal(read.id, "test-session-1");

    const missing = await store.readSession("non-existent");
    assert.equal(missing, undefined);

    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SqlFlowStore writes and updates sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-store-update-"));
  try {
    const store = new SqlFlowStore({ root });
    await store.ensure();

    const session = await store.createSession("test-session-2");
    assert.equal(session.selectedIssueRef, undefined);

    const updated = await store.writeSession({
      ...session,
      selectedIssueRef: "ISSUE-1",
      selectedRepoKey: "main",
    });
    assert.equal(updated.selectedIssueRef, "ISSUE-1");
    assert.equal(updated.selectedRepoKey, "main");

    const read = await store.readSession("test-session-2");
    assert.ok(read);
    assert.equal(read.selectedIssueRef, "ISSUE-1");

    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SqlFlowStore appends events", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-store-events-"));
  try {
    const store = new SqlFlowStore({ root });
    await store.ensure();

    await store.createSession("test-session-3");

    const event = await store.appendEvent({
      sessionId: "test-session-3",
      type: "test.event",
      message: "Test event message",
      payload: {},
    });
    assert.ok(event.id);
    assert.equal(event.sessionId, "test-session-3");
    assert.equal(event.type, "test.event");

    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createFlowStore factory creates SQLite store by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-store-factory-"));
  try {
    const store = createFlowStore({ root });
    assert.ok(store instanceof SqlFlowStore);

    await store.ensure();
    const session = await store.createSession("factory-test");
    assert.ok(session.id);

    if (store instanceof SqlFlowStore) {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createFlowStore factory creates file store when specified", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-store-factory-"));
  try {
    const store = createFlowStore({ root, backend: "file" });
    assert.ok(store instanceof FlowStore);

    await store.ensure();
    const session = await store.createSession("file-factory-test");
    assert.ok(session.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SqlFlowStore handles concurrent writes from multiple store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-store-concurrent-"));
  const stores = [
    new SqlFlowStore({ root }),
    new SqlFlowStore({ root }),
    new SqlFlowStore({ root }),
  ];
  try {
    await Promise.all(stores.map((store) => store.ensure()));

    const sessions = await Promise.all([
      stores[0].createSession("concurrent-1"),
      stores[1].createSession("concurrent-2"),
      stores[2].createSession("concurrent-3"),
    ]);

    assert.equal(sessions.length, 3);

    for (const session of sessions) {
      const read = await stores[0].readSession(session.id);
      assert.ok(read);
      assert.equal(read.id, session.id);
    }
  } finally {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  }
});
