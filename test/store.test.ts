import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { FlowStore, createId, nowIso } from "../src/index.js";

test("FlowStore creates session and event directories on ensure", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-ensure-"));
  const store = new FlowStore({ root });

  await store.ensure();

  const entries = await readdir(root);
  assert.ok(entries.includes("sessions"), "sessions directory should exist");
  assert.ok(entries.includes("events"), "events directory should exist");
});

test("FlowStore creates a session with generated ID and timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-create-session-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const session = await store.createSession();

  assert.ok(session.id.startsWith("session-"), "session ID should start with 'session-'");
  assert.deepEqual(session.findings, []);
  assert.deepEqual(session.workerResults, []);
  assert.equal(session.createdAt, session.updatedAt);
  assert.ok(new Date(session.createdAt).getTime() > 0, "createdAt should be a valid date");
});

test("FlowStore creates a session with a caller-provided ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-custom-id-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const session = await store.createSession("custom-session-42");

  assert.equal(session.id, "custom-session-42");
  assert.deepEqual(session.findings, []);
  assert.deepEqual(session.workerResults, []);
});

test("FlowStore persists session to disk as JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-persist-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const created = await store.createSession("persist-test");
  const raw = await readFile(join(root, "sessions", "persist-test.json"), "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.id, created.id);
  assert.equal(parsed.createdAt, created.createdAt);
  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(parsed.workerResults, []);
});

test("FlowStore reads back a written session", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-read-write-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const created = await store.createSession("read-back");
  const readBack = await store.readSession("read-back");

  assert.ok(readBack, "readSession should return the session");
  assert.equal(readBack.id, created.id);
  assert.equal(readBack.createdAt, created.createdAt);
  assert.deepEqual(readBack.findings, created.findings);
  assert.deepEqual(readBack.workerResults, created.workerResults);
});

test("FlowStore readSession returns undefined for missing session", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-missing-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const result = await store.readSession("nonexistent");

  assert.equal(result, undefined);
});

test("FlowStore writeSession updates the session and bumps updatedAt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-update-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const session = await store.createSession("update-test");
  const originalUpdatedAt = session.updatedAt;

  // Small delay so updatedAt differs
  await new Promise((resolve) => setTimeout(resolve, 10));

  session.selectedIssueRef = "ISSUE-100";
  const updated = await store.writeSession(session);

  assert.equal(updated.selectedIssueRef, "ISSUE-100");
  assert.ok(updated.updatedAt >= originalUpdatedAt, "updatedAt should be >= original");

  const readBack = await store.readSession("update-test");
  assert.equal(readBack?.selectedIssueRef, "ISSUE-100");
});

test("FlowStore appendEvent creates an event with generated ID and timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-event-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const event = await store.appendEvent({
    sessionId: "session-abc",
    type: "test_event",
    message: "Something happened",
    payload: {},
  });

  assert.ok(event.id.startsWith("event-"), "event ID should start with 'event-'");
  assert.equal(event.sessionId, "session-abc");
  assert.equal(event.type, "test_event");
  assert.equal(event.message, "Something happened");
  assert.ok(new Date(event.createdAt).getTime() > 0, "createdAt should be a valid date");
});

test("FlowStore appendEvent writes JSONL with one entry per line", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-jsonl-"));
  const store = new FlowStore({ root });
  await store.ensure();

  await store.appendEvent({ sessionId: "session-jsonl", type: "first", message: "First event", payload: {} });
  await store.appendEvent({ sessionId: "session-jsonl", type: "second", message: "Second event", payload: {} });

  const raw = await readFile(join(root, "events", "session-jsonl.jsonl"), "utf8");
  const lines = raw.trim().split("\n");

  assert.equal(lines.length, 2, "should have 2 JSONL lines");

  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);

  assert.equal(first.type, "first");
  assert.equal(first.message, "First event");
  assert.equal(second.type, "second");
  assert.equal(second.message, "Second event");
  assert.notEqual(first.id, second.id, "event IDs should be unique");
});

test("FlowStore appendEvent sanitizes session IDs in filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-safe-name-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const event = await store.appendEvent({
    sessionId: "session/with:special*chars",
    type: "test",
    message: "Special chars test",
    payload: {},
  });

  // safeName replaces non-alphanumeric chars (except ._-) with underscores
  const raw = await readFile(join(root, "events", "session_with_special_chars.jsonl"), "utf8");
  const parsed = JSON.parse(raw.trim());

  assert.equal(parsed.sessionId, "session/with:special*chars");
  assert.equal(parsed.id, event.id);
});

test("FlowStore appendEvent with optional issueRef and payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-event-payload-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const event = await store.appendEvent({
    sessionId: "session-payload",
    type: "issue_selected",
    issueRef: "ISSUE-42",
    message: "Issue selected",
    payload: { repoKey: "app_api", branchKind: "feature" },
  });

  assert.equal(event.issueRef, "ISSUE-42");
  assert.equal(event.payload.repoKey, "app_api");
  assert.equal(event.payload.branchKind, "feature");

  const raw = await readFile(join(root, "events", "session-payload.jsonl"), "utf8");
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.issueRef, "ISSUE-42");
  assert.deepEqual(parsed.payload, { repoKey: "app_api", branchKind: "feature" });
});

test("FlowStore creates parent directories automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-nested-"));
  const nestedRoot = join(root, "deep", "nested", "path");
  const store = new FlowStore({ root: nestedRoot });

  // Should not throw even though directories don't exist yet
  const session = await store.createSession("auto-mkdir");

  const readBack = await store.readSession("auto-mkdir");
  assert.ok(readBack, "session should be readable after auto-creating directories");
  assert.equal(readBack.id, session.id);
});

test("FlowStore roundtrips session with findings and worker results", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-roundtrip-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const session = await store.createSession("roundtrip-test");

  // Update session with findings and worker results
  session.findings = [
    {
      id: "finding-1",
      severity: "blocker",
      summary: "Tests are failing",
      source: "readiness",
      createdAt: nowIso(),
    },
    {
      id: "finding-2",
      severity: "warning",
      summary: "PR is still draft",
      detail: "Convert to ready for review",
      source: "readiness",
      createdAt: nowIso(),
    },
  ];
  session.workerResults = [
    {
      taskId: "worker-1",
      issueRef: "ISSUE-1",
      repoKey: "app_api",
      status: "succeeded",
      summary: "Implementation done",
      changedFiles: ["src/example.ts"],
      testsRun: ["npm test"],
      blockers: [],
      completedAt: nowIso(),
    },
  ];
  session.selectedIssueRef = "ISSUE-1";

  await store.writeSession(session);

  const readBack = await store.readSession("roundtrip-test");

  assert.ok(readBack, "session should roundtrip");
  assert.equal(readBack.selectedIssueRef, "ISSUE-1");
  assert.equal(readBack.findings.length, 2);
  assert.equal(readBack.findings[0].severity, "blocker");
  assert.equal(readBack.findings[0].summary, "Tests are failing");
  assert.equal(readBack.findings[1].severity, "warning");
  assert.equal(readBack.findings[1].detail, "Convert to ready for review");
  assert.equal(readBack.workerResults.length, 1);
  assert.equal(readBack.workerResults[0].taskId, "worker-1");
  assert.equal(readBack.workerResults[0].status, "succeeded");
  assert.deepEqual(readBack.workerResults[0].changedFiles, ["src/example.ts"]);
});

test("FlowStore appendEvent handles sequential appends with unique IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-concurrent-"));
  const store = new FlowStore({ root });
  await store.ensure();

  // Sequential appends to avoid read-modify-write race in appendJsonLine
  await store.appendEvent({ sessionId: "session-concurrent", type: "a", message: "Event A", payload: {} });
  await store.appendEvent({ sessionId: "session-concurrent", type: "b", message: "Event B", payload: {} });
  await store.appendEvent({ sessionId: "session-concurrent", type: "c", message: "Event C", payload: {} });

  const raw = await readFile(join(root, "events", "session-concurrent.jsonl"), "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);

  assert.equal(lines.length, 3, "should have 3 JSONL lines");
  const parsed = lines.map((line) => JSON.parse(line));
  const types = parsed.map((e: { type: string }) => e.type);
  assert.deepEqual(types, ["a", "b", "c"], "all three events should be in order");

  // Each event should have a unique ID
  const ids = new Set(parsed.map((e: { id: string }) => e.id));
  assert.equal(ids.size, 3, "all event IDs should be unique");
});

test("FlowStore createSession generates unique IDs for concurrent calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-unique-ids-"));
  const store = new FlowStore({ root });
  await store.ensure();

  const sessions = await Promise.all([
    store.createSession(),
    store.createSession(),
    store.createSession(),
  ]);

  const ids = new Set(sessions.map((s) => s.id));
  assert.equal(ids.size, 3, "all session IDs should be unique");

  // All should be readable
  for (const session of sessions) {
    const readBack = await store.readSession(session.id);
    assert.ok(readBack, `session ${session.id} should be readable`);
  }
});

test("FlowStore ensures idempotent directory creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-idempotent-"));
  const store = new FlowStore({ root });

  // Calling ensure multiple times should not throw
  await store.ensure();
  await store.ensure();
  await store.ensure();

  // Store should still work normally
  const session = await store.createSession("idempotent-test");
  assert.equal(session.id, "idempotent-test");
});

test("FlowStore writeSession validates against the schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-validate-"));
  const store = new FlowStore({ root });
  await store.ensure();

  // Attempting to write invalid data should throw
  await assert.rejects(
    store.writeSession({
      id: "", // Empty ID should fail schema validation
      findings: [],
      workerResults: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as any),
    /too_small/,
  );
});

test("FlowStore appendEvent validates against the schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-store-event-validate-"));
  const store = new FlowStore({ root });
  await store.ensure();

  // Empty sessionId should fail
  await assert.rejects(
    store.appendEvent({
      sessionId: "",
      type: "test",
      message: "Should fail",
      payload: {},
    }),
    /too_small/,
  );

  // Empty type should fail
  await assert.rejects(
    store.appendEvent({
      sessionId: "valid-session",
      type: "",
      message: "Should fail",
      payload: {},
    }),
    /too_small/,
  );

  // Empty message should fail
  await assert.rejects(
    store.appendEvent({
      sessionId: "valid-session",
      type: "test",
      message: "",
      payload: {},
    }),
    /too_small/,
  );
});
