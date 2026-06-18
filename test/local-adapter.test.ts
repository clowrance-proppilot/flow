import assert from "node:assert/strict";
import test from "node:test";
import { LocalIssueTrackerAdapter } from "../src/adapters/local.js";
import { MemoryWorkflowLedger } from "../src/ledger.js";

function makeAdapter() {
  const ledger = new MemoryWorkflowLedger();
  const adapter = new LocalIssueTrackerAdapter({ ledger, prefix: "PP" });
  return { ledger, adapter };
}

test("createIssue keys the ledger item by an explicit external ref", async () => {
  const { ledger, adapter } = makeAdapter();
  // Pre-existing minted item proves the external ref is honored, not the PP-N sequence.
  await ledger.writeIssue({ ref: "PP-1", title: "Existing", repoKeys: [], state: "queued", metadata: {} });

  const created = await adapter.createIssue({
    issueType: "Task",
    summary: "Wire external-ref intake",
    description: "Key the local tracker item by PRO-3373.",
    ref: "PRO-3373",
  });

  assert.equal(created.ref, "PRO-3373");

  // The runtime persists the created issue into the ledger; mirror that here.
  await ledger.ensureIssue({
    ref: created.ref,
    title: created.title,
    repoKeys: [],
    state: "queued",
    summary: created.description,
    metadata: {},
  });

  const fromLedger = await ledger.readIssue("PRO-3373");
  assert.ok(fromLedger, "ledger item should be keyed by the exact external ref");
  assert.equal(fromLedger.ref, "PRO-3373");

  const fetched = await adapter.getIssue("PRO-3373");
  assert.equal(fetched.ref, "PRO-3373");
});

test("createIssue mints PP-N when no ref is provided", async () => {
  const { ledger, adapter } = makeAdapter();
  await ledger.writeIssue({ ref: "PP-1", title: "Existing", repoKeys: [], state: "queued", metadata: {} });

  const created = await adapter.createIssue({
    issueType: "Bug",
    summary: "Fall back to minted ref",
  });

  assert.equal(created.ref, "PP-2");
});
