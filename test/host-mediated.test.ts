import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_MEDIATED_TRACKER_TYPE,
  resolveTrackerDirective,
  resolveHostMediatedDirective,
  validateHostMediatedTracker,
  type HostMediatedTrackerConfig,
} from "../src/config/host-mediated.js";

const tracker: HostMediatedTrackerConfig = {
  type: HOST_MEDIATED_TRACKER_TYPE,
  binding: "linear",
  teamId: "team-123",
  statusMap: { "In Progress": "state-ip", Done: "state-done" },
  map: {
    view: { tool: "Linear.get_issue", args: { id: "$ref" } },
    fetchQueue: { tool: "Linear.list_issues", args: { teamId: "$teamId", state: "active", first: "$limit" } },
    transition: { tool: "Linear.save_issue", args: { id: "$ref", stateId: "$statusId" } },
    comment: { tool: "Linear.save_comment", args: { issueId: "$ref", body: "$body" } },
  },
};

test("resolves a view directive with $ref substitution", () => {
  const directive = resolveTrackerDirective(tracker, "view", { ref: "PRO-3378" });
  assert.equal(directive.tool, "Linear.get_issue");
  assert.equal(directive.binding, "linear");
  assert.deepEqual(directive.args, { id: "PRO-3378" });
});

test("transition resolves status via statusMap; teamId comes from config", () => {
  const directive = resolveTrackerDirective(tracker, "transition", { ref: "PRO-1", status: "In Progress" });
  assert.deepEqual(directive.args, { id: "PRO-1", stateId: "state-ip" });
  const queue = resolveTrackerDirective(tracker, "fetchQueue", { limit: 10 });
  assert.equal(queue.args.teamId, "team-123");
  assert.equal(queue.args.state, "active");
});

test("exact $var preserves type; interpolation coerces to string", () => {
  const partial: HostMediatedTrackerConfig = {
    type: HOST_MEDIATED_TRACKER_TYPE,
    binding: "x",
    map: { fetchQueue: { tool: "T", args: { first: "$limit", label: "top-$limit" } } },
  };
  const directive = resolveTrackerDirective(partial, "fetchQueue", { limit: 5 });
  assert.equal(directive.args.first, 5);
  assert.equal(directive.args.label, "top-5");
});

test("throws on a missing required variable", () => {
  assert.throws(() => resolveTrackerDirective(tracker, "transition", { ref: "PRO-1" }), /statusId/);
});

test("throws on an unmapped operation", () => {
  assert.throws(() => resolveTrackerDirective(tracker, "create", {}), /no mapping for operation "create"/);
});

test("resolveHostMediatedDirective rejects a non-host-mediated config", () => {
  assert.throws(
    () => resolveHostMediatedDirective({ issueTracker: { type: "linear" } }, "view", { ref: "X" }),
    /host-mediated/,
  );
});

test("validation flags missing binding, bad tool, unknown op and unknown variable", () => {
  const issues = validateHostMediatedTracker({
    type: HOST_MEDIATED_TRACKER_TYPE,
    map: {
      view: { tool: "", args: { id: "$ref" } },
      bogus: { tool: "T" },
      transition: { tool: "T2", args: { id: "$nope" } },
    },
  });
  const joined = issues.map((issue) => issue.message).join(" | ");
  assert.match(joined, /binding is required/);
  assert.match(joined, /tool must be a non-empty/);
  assert.match(joined, /Unknown host-mediated operation "bogus"/);
  assert.match(joined, /Unknown variable "\$nope"/);
});

test("a valid tracker produces no validation issues", () => {
  assert.deepEqual(validateHostMediatedTracker(tracker), []);
});
