import assert from "node:assert/strict";
import test from "node:test";

import type { FlowStoreInterface } from "../src/store.js";
import { withFileFlowStore, withSqlFlowStore } from "./helpers/fixtures.js";

/**
 * Shared store acceptance tests.
 *
 * Both the file-backed FlowStore and the SQL-backed SqlFlowStore must
 * produce equivalent runtime record shapes so schema changes land in
 * one place (the shared codecs).
 */

function registerStoreTests(
  label: string,
  withStore: <T>(prefix: string, run: (store: FlowStoreInterface, root: string) => Promise<T>) => Promise<T>,
) {
  test(`${label}: createSession returns a valid WorkRuntimeSession`, async () => {
    await withStore(`store-codecs-session-${label}-`, async (store) => {
      const session = await store.createSession("test-session");
      assert.equal(session.id, "test-session");
      assert.deepEqual(session.findings, []);
      assert.deepEqual(session.workerResults, []);
      assert.ok(session.createdAt);
      assert.ok(session.updatedAt);
      assert.equal(session.createdAt, session.updatedAt);
    });
  });

  test(`${label}: writeSession updates the updatedAt timestamp`, async () => {
    await withStore(`store-codecs-write-${label}-`, async (store) => {
      const session = await store.createSession("ts-session");
      const original = session.updatedAt;
      const updated = await store.writeSession({ ...session, selectedIssueRef: "GH-999" });
      assert.equal(updated.selectedIssueRef, "GH-999");
      assert.ok(updated.updatedAt >= original, "updatedAt should advance");
    });
  });

  test(`${label}: appendEvent returns a valid WorkRuntimeEvent`, async () => {
    await withStore(`store-codecs-event-${label}-`, async (store) => {
      await store.createSession("evt-session");
      const event = await store.appendEvent({
        sessionId: "evt-session",
        type: "test.hello",
        message: "Codec round-trip",
        payload: { key: "value" },
      });
      assert.ok(event.id.startsWith("event-"));
      assert.equal(event.sessionId, "evt-session");
      assert.equal(event.type, "test.hello");
      assert.equal(event.message, "Codec round-trip");
      assert.deepEqual(event.payload, { key: "value" });
      assert.ok(event.createdAt);
    });
  });

  test(`${label}: readSession round-trips the written record`, async () => {
    await withStore(`store-codecs-roundtrip-${label}-`, async (store) => {
      const created = await store.createSession("rt-session");
      const read = await store.readSession("rt-session");
      assert.deepEqual(read, created);
    });
  });
}

registerStoreTests("file", (prefix, run) =>
  withFileFlowStore(prefix, (store, root) => run(store, root)),
);

registerStoreTests("sqlite", (prefix, run) =>
  withSqlFlowStore(prefix, (store, root) => run(store, root)),
);
