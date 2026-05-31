import assert from "node:assert/strict";
import test from "node:test";

import { DashboardState } from "../src/dashboard-state.js";
import type { DashboardQueueIssue } from "../src/work-runtime.js";

function makeIssue(overrides: Partial<DashboardQueueIssue> = {}): DashboardQueueIssue {
  return {
    ref: "ISSUE-1",
    title: "Test Issue",
    workStatus: "Active",
    workStatusDetail: "In progress",
    statusLabel: "In Progress",
    repositories: ["main"],
    prStatus: "Open",
    reviewStatus: "Pending",
    evidenceStatus: "Present",
    documentationStatus: "Needed",
    updatedLabel: "2h ago",
    blockerLabels: [],
    nextPickup: "Continue work",
    handoffPrompt: "Pick up where left off",
    ...overrides,
  };
}

function mockRuntime(issues: DashboardQueueIssue[]) {
  return {
    inspectDashboardQueue: async (_limit: number) => issues,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("DashboardState.payload returns ok with snapshot freshness label", async () => {
  const issues = [makeIssue()];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();

  assert.equal(payload.ok, true);
  assert.ok(payload.snapshot);
  assert.ok(typeof (payload.snapshot as Record<string, unknown>).freshnessLabel === "string");
});

test("DashboardState.payload returns issues with expected fields", async () => {
  const issues = [
    makeIssue({
      ref: "ISSUE-42",
      title: "Fix the bug",
      workStatus: "Active",
      repositories: ["web_app", "app_api"],
      blockerLabels: ["blocked-by:ISSUE-10"],
      evidenceStatus: "Present",
      documentationStatus: "Needed",
    }),
  ];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const payloadIssues = payload.issues as Record<string, unknown>[];

  assert.equal(payloadIssues.length, 1);
  assert.equal(payloadIssues[0].ref, "ISSUE-42");
  assert.equal(payloadIssues[0].title, "Fix the bug");
  assert.equal(payloadIssues[0].workStatus, "Active");
  assert.deepEqual(payloadIssues[0].repositories, ["web_app", "app_api"]);
  assert.deepEqual(payloadIssues[0].blockerLabels, ["blocked-by:ISSUE-10"]);
  assert.equal(payloadIssues[0].evidenceStatus, "Present");
  assert.equal(payloadIssues[0].documentationStatus, "Needed");
});

test("DashboardState.payload normalizes unknown workStatus to Unknown", async () => {
  const issues = [makeIssue({ workStatus: "invalid-status" })];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const payloadIssues = payload.issues as Record<string, unknown>[];

  assert.equal(payloadIssues[0].workStatus, "Unknown");
});

test("DashboardState.payload normalizes unknown evidenceStatus to Needed", async () => {
  const issues = [makeIssue({ evidenceStatus: "missing" })];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const payloadIssues = payload.issues as Record<string, unknown>[];

  assert.equal(payloadIssues[0].evidenceStatus, "Needed");
});

test("DashboardState.payload omits empty optional fields", async () => {
  const issues = [
    makeIssue({
      workStatusDetail: undefined,
      statusLabel: undefined,
      prStatus: undefined,
      reviewStatus: undefined,
      updatedLabel: undefined,
      nextPickup: undefined,
      handoffPrompt: undefined,
    }),
  ];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const payloadIssues = payload.issues as Record<string, unknown>[];

  assert.equal(payloadIssues[0].workStatusDetail, undefined);
  assert.equal(payloadIssues[0].statusLabel, undefined);
  assert.equal(payloadIssues[0].prStatus, undefined);
  assert.equal(payloadIssues[0].reviewStatus, undefined);
  assert.equal(payloadIssues[0].updatedLabel, undefined);
  assert.equal(payloadIssues[0].nextPickup, undefined);
  assert.equal(payloadIssues[0].handoffPrompt, undefined);
});

test("DashboardState.payload omits empty string optional fields", async () => {
  const issues = [
    makeIssue({
      workStatusDetail: "",
      statusLabel: "",
      prStatus: "",
      reviewStatus: "",
      updatedLabel: "",
      nextPickup: "",
      handoffPrompt: "",
    }),
  ];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const payloadIssues = payload.issues as Record<string, unknown>[];

  assert.equal(payloadIssues[0].workStatusDetail, undefined);
  assert.equal(payloadIssues[0].statusLabel, undefined);
  assert.equal(payloadIssues[0].prStatus, undefined);
  assert.equal(payloadIssues[0].reviewStatus, undefined);
  assert.equal(payloadIssues[0].updatedLabel, undefined);
  assert.equal(payloadIssues[0].nextPickup, undefined);
  assert.equal(payloadIssues[0].handoffPrompt, undefined);
});

test("DashboardState.payload respects custom limit option", async () => {
  let capturedLimit: number | undefined;
  const runtime = {
    inspectDashboardQueue: async (limit: number) => {
      capturedLimit = limit;
      return [makeIssue()];
    },
  };
  const state = new DashboardState({ runtime });

  await state.payload({ limit: 10 });

  assert.equal(capturedLimit, 10);
});

test("DashboardState.payload uses default limit of 25", async () => {
  let capturedLimit: number | undefined;
  const runtime = {
    inspectDashboardQueue: async (limit: number) => {
      capturedLimit = limit;
      return [];
    },
  };
  const state = new DashboardState({ runtime });

  await state.payload();

  assert.equal(capturedLimit, 25);
});

test("DashboardState.payload caches snapshot within TTL", async () => {
  let callCount = 0;
  const runtime = {
    inspectDashboardQueue: async (_limit: number) => {
      callCount++;
      return [makeIssue()];
    },
  };
  const state = new DashboardState({ runtime });

  await state.payload();
  await state.payload();
  await state.payload();

  assert.equal(callCount, 1);
});

test("DashboardState.payload deduplicates concurrent refreshes", async () => {
  let callCount = 0;
  const refresh = deferred<DashboardQueueIssue[]>();
  const runtime = {
    inspectDashboardQueue: async (_limit: number) => {
      callCount++;
      return await refresh.promise;
    },
  };
  const state = new DashboardState({ runtime });

  const requests = [state.payload(), state.payload(), state.payload()];
  refresh.resolve([makeIssue({ ref: "SHARED-SNAPSHOT" })]);
  const [result1, result2, result3] = await Promise.all(requests);

  assert.equal(callCount, 1);
  assert.deepEqual(result1.issues, result2.issues);
  assert.deepEqual(result2.issues, result3.issues);
  assert.equal((result1.issues as Record<string, unknown>[])[0].ref, "SHARED-SNAPSHOT");
});

test("DashboardState.payload keeps concurrent refreshes separate for different limits", async () => {
  const refreshes = new Map<number, ReturnType<typeof deferred<DashboardQueueIssue[]>>>();
  const runtime = {
    inspectDashboardQueue: async (limit: number) => {
      const refresh = deferred<DashboardQueueIssue[]>();
      refreshes.set(limit, refresh);
      return await refresh.promise;
    },
  };
  const state = new DashboardState({ runtime });

  const limit10 = state.payload({ limit: 10 });
  const limit50 = state.payload({ limit: 50 });
  refreshes.get(10)?.resolve([makeIssue({ ref: "LIMIT-10" })]);
  refreshes.get(50)?.resolve([makeIssue({ ref: "LIMIT-50" })]);
  const [result10, result50] = await Promise.all([limit10, limit50]);

  assert.equal(refreshes.size, 2);
  assert.equal((result10.issues as Record<string, unknown>[])[0].ref, "LIMIT-10");
  assert.equal((result50.issues as Record<string, unknown>[])[0].ref, "LIMIT-50");
});

test("DashboardState.payload propagates a failed concurrent refresh to every waiter", async () => {
  let callCount = 0;
  const refresh = deferred<DashboardQueueIssue[]>();
  const runtime = {
    inspectDashboardQueue: async (_limit: number) => {
      callCount++;
      return await refresh.promise;
    },
  };
  const state = new DashboardState({ runtime });

  const requests = Promise.allSettled([state.payload(), state.payload(), state.payload()]);
  refresh.reject(new Error("refresh failed"));
  const results = await requests;

  assert.equal(callCount, 1);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected", "rejected"]);
  for (const result of results) {
    assert.equal((result as PromiseRejectedResult).reason.message, "refresh failed");
  }
});

test("DashboardState.payload calls debugLog on refresh", async () => {
  const debugEvents: Array<{ event: string; details: Record<string, unknown> }> = [];
  const runtime = mockRuntime([makeIssue()]);
  const state = new DashboardState({
    runtime,
    debugLog: (event, details) => debugEvents.push({ event, details }),
  });

  await state.payload();

  assert.equal(debugEvents.length, 1);
  assert.equal(debugEvents[0].event, "dashboard.runtime_snapshot");
  assert.equal(debugEvents[0].details.limit, 25);
  assert.equal(debugEvents[0].details.issueCount, 1);
  assert.ok(typeof debugEvents[0].details.durationMs === "number");
});

test("DashboardState handles empty issue list", async () => {
  const runtime = mockRuntime([]);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.issues, []);
});

test("DashboardState.payload handles multiple issues", async () => {
  const issues = [
    makeIssue({ ref: "ISSUE-1", title: "First" }),
    makeIssue({ ref: "ISSUE-2", title: "Second" }),
    makeIssue({ ref: "ISSUE-3", title: "Third" }),
  ];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const payloadIssues = payload.issues as Record<string, unknown>[];

  assert.equal(payloadIssues.length, 3);
  assert.equal(payloadIssues[0].ref, "ISSUE-1");
  assert.equal(payloadIssues[1].ref, "ISSUE-2");
  assert.equal(payloadIssues[2].ref, "ISSUE-3");
});

test("DashboardState.payload includes all dashboard issue fields", async () => {
  const issues = [makeIssue()];
  const runtime = mockRuntime(issues);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const payloadIssues = payload.issues as Record<string, unknown>[];
  const issue = payloadIssues[0];

  const expectedFields = [
    "blockerLabels",
    "documentationStatus",
    "evidenceStatus",
    "handoffPrompt",
    "nextPickup",
    "prStatus",
    "ref",
    "repositories",
    "reviewStatus",
    "statusLabel",
    "title",
    "updatedLabel",
    "workStatus",
    "workStatusDetail",
  ];

  for (const field of expectedFields) {
    assert.ok(Object.hasOwn(issue, field), `Expected field "${field}" to be present`);
  }
});

test("DashboardState.snapshot freshness label shows relative time", async () => {
  const runtime = mockRuntime([makeIssue()]);
  const state = new DashboardState({ runtime });

  const payload = await state.payload();
  const freshnessLabel = (payload.snapshot as Record<string, unknown>).freshnessLabel as string;

  assert.ok(
    freshnessLabel.startsWith("Snapshot"),
    `Expected freshness label to start with "Snapshot", got "${freshnessLabel}"`,
  );
});
