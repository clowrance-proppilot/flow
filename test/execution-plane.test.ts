import assert from "node:assert/strict";
import test from "node:test";

import {
  HATCHET_AUTOFLOW_TASK_NAME,
  HATCHET_AUTOFLOW_VERSION,
  autoflowSemanticSteps,
  hatchetRepoConcurrencyKey,
  toHatchetAutoflowPayload,
} from "../src/index.js";

test("Hatchet Autoflow payload keeps Flow semantics explicit", () => {
  const payload = toHatchetAutoflowPayload({
    projectId: "flow",
    issueRef: "gh-412",
    repoKeys: ["flow"],
    requestedBy: "cli",
    reason: "spike",
  });

  assert.equal(payload.version, HATCHET_AUTOFLOW_VERSION);
  assert.equal(payload.taskName, HATCHET_AUTOFLOW_TASK_NAME);
  assert.equal(payload.issueRef, "GH-412");
  assert.equal(payload.runId, "flow:GH-412");
  assert.deepEqual(payload.semanticSteps, [
    "select_issue",
    "doctor",
    "prepare_workspace",
    "create_worker_handoff",
    "run_executor",
    "record_result",
    "closeout",
  ]);
});

test("Hatchet repo concurrency key is stable across repo ordering", () => {
  const first = hatchetRepoConcurrencyKey({ projectId: "flow", repoKeys: ["desktop", "flow"] });
  const second = hatchetRepoConcurrencyKey({ projectId: "flow", repoKeys: ["flow", "desktop", "flow"] });

  assert.equal(first, "flow:flow:repos:desktop+flow");
  assert.equal(second, first);
});

test("Autoflow semantic steps do not assign domain policy to Hatchet", () => {
  assert.ok(autoflowSemanticSteps.includes("doctor"));
  assert.ok(autoflowSemanticSteps.includes("closeout"));
  assert.equal(autoflowSemanticSteps.some((step) => step.includes("github")), false);
  assert.equal(autoflowSemanticSteps.some((step) => step.includes("hatchet")), false);
});

test("Hatchet payload carries only a durable Pi session handle", () => {
  const payload = toHatchetAutoflowPayload({
    projectId: "flow",
    issueRef: "gh-412",
    repoKeys: ["flow"],
    requestedBy: "daemon",
    durableSession: {
      provider: "pi",
      issueRef: "gh-412",
      flowSessionId: "desktop-flow-gh-412",
      piSessionId: "pi-gh-412",
      sessionFile: " C:/tmp/pi-session.jsonl ",
      workspacePath: " C:/repo/.worktrees/gh-412 ",
    },
  });

  assert.deepEqual(payload.durableSession, {
    provider: "pi",
    issueRef: "GH-412",
    flowSessionId: "desktop-flow-gh-412",
    piSessionId: "pi-gh-412",
    sessionFile: "C:/tmp/pi-session.jsonl",
    workspacePath: "C:/repo/.worktrees/gh-412",
  });
});
