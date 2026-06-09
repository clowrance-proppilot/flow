import assert from "node:assert/strict";
import test from "node:test";
import { LinearIssueTrackerAdapter, inferIssueType, escapeGraphQLString } from "../src/adapters/linear.js";
import { ProviderAdapterError } from "../src/adapters/provider-errors.js";

// --- Mock helpers ---

function mockJsonResponse(body: unknown, status = 200): Response {
  const bodyStr = JSON.stringify(body);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyStr));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "application/json" } });
}

function createMockFetch(responses: unknown[]) {
  let callIndex = 0;
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    void url;
    void init;
    const body = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return mockJsonResponse(body);
  };
}

function makeIssue(overrides: Partial<{
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateType: string;
  stateName: string;
  url: string;
  updatedAt: string;
  labels: string[];
  assigneeName: string;
}> = {}) {
  return {
    id: overrides.id ?? "issue-uuid-1",
    identifier: overrides.identifier ?? "ENG-123",
    title: overrides.title ?? "Fix login bug",
    description: overrides.description ?? "Users cannot log in",
    state: {
      name: overrides.stateName ?? "In Progress",
      type: overrides.stateType ?? "started",
    },
    url: overrides.url ?? "https://linear.app/team/issue/ENG-123/fix-login-bug",
    updatedAt: overrides.updatedAt ?? "2026-06-01T12:00:00Z",
    labels: {
      nodes: (overrides.labels ?? ["bug"]).map((name) => ({ name })),
    },
    assignee: overrides.assigneeName ? { name: overrides.assigneeName } : undefined,
  };
}

function graphqlData(data: unknown) {
  return { data };
}

function graphqlError(message: string) {
  return { errors: [{ message }] };
}

// --- Unit tests ---

test("Linear adapter capabilities are correct", () => {
  const adapter = new LinearIssueTrackerAdapter({
    apiKey: "test-key",
    teamId: "team-1",
  });
  assert.equal(adapter.capabilities.canCreateIssues, true);
  assert.equal(adapter.capabilities.canTransitionIssues, true);
  assert.equal(adapter.capabilities.canPostComments, true);
  assert.equal(adapter.capabilities.canManageActivePlanningLane, false);
  assert.equal(adapter.capabilities.canFetchOpenIssues, true);
  assert.equal(adapter.capabilities.canSearchIssues, true);
  assert.equal(adapter.capabilities.canTagIssues, true);
});

test("Linear adapter getIssue fetches and normalizes issue by identifier", async () => {
  const issue = makeIssue({
    identifier: "ENG-42",
    title: "Deploy new API",
    stateType: "started",
    stateName: "In Progress",
    labels: ["feature"],
    assigneeName: "Alice",
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: [issue] } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.getIssue("ENG-42");
    assert.equal(result.ref, "ENG-42");
    assert.equal(result.title, "Deploy new API");
    assert.equal(result.status, "In Progress");
    assert.equal(result.statusCategory, "In Progress");
    assert.equal(result.type, "story");
    assert.equal(result.assignee, "Alice");
    assert.equal(result.labels.includes("feature"), true);
    assert.equal(result.resolution, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter getIssue throws on not found", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: [] } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    await assert.rejects(
      () => adapter.getIssue("ENG-999"),
      (error: unknown) => {
        assert.ok(error instanceof ProviderAdapterError);
        assert.equal(error.provider, "linear");
        assert.equal(error.operation, "getIssue");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter fetchActiveQueue returns non-completed issues", async () => {
  const issues = [
    makeIssue({ identifier: "ENG-1", stateType: "started", stateName: "In Progress" }),
    makeIssue({ identifier: "ENG-2", stateType: "unstarted", stateName: "Todo" }),
    makeIssue({ identifier: "ENG-3", stateType: "backlog", stateName: "Backlog" }),
  ];

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: issues } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.fetchActiveQueue(10);
    assert.equal(result.length, 3);
    assert.equal(result[0].ref, "ENG-1");
    assert.equal(result[0].statusCategory, "In Progress");
    assert.equal(result[1].ref, "ENG-2");
    assert.equal(result[1].statusCategory, "To Do");
    assert.equal(result[2].ref, "ENG-3");
    assert.equal(result[2].statusCategory, "To Do");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter fetchBacklogQueue returns backlog issues", async () => {
  const issues = [
    makeIssue({ identifier: "ENG-10", stateType: "backlog", stateName: "Backlog" }),
  ];

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: issues } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.fetchBacklogQueue(5);
    assert.equal(result.length, 1);
    assert.equal(result[0].ref, "ENG-10");
    assert.equal(result[0].status, "Backlog");
    assert.equal(result[0].statusCategory, "To Do");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter searchIssues filters by title and state", async () => {
  const issues = [
    makeIssue({ identifier: "ENG-50", title: "Fix auth bug" }),
  ];

  const originalFetch = globalThis.fetch;
  try {
    let capturedBody: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      void url;
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return mockJsonResponse(graphqlData({ issues: { nodes: issues } }));
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.searchIssues({ title: "auth bug", state: "open", limit: 5 });
    assert.equal(result.length, 1);
    assert.equal(result[0].ref, "ENG-50");
    assert.ok(capturedBody);
    assert.ok(capturedBody!.includes("auth bug"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter createIssue sends mutation and returns normalized issue", async () => {
  const createdIssue = makeIssue({
    identifier: "ENG-99",
    title: "New feature",
    stateType: "unstarted",
    stateName: "Todo",
    labels: [],
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issueCreate: { issue: createdIssue } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.createIssue({
      issueType: "story",
      title: "New feature",
      summary: "A new feature",
      description: "Detailed description",
    });
    assert.equal(result.ref, "ENG-99");
    assert.equal(result.title, "New feature");
    assert.equal(result.status, "To Do");
    assert.equal(result.statusCategory, "To Do");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter transitionIssue moves issue to new state", async () => {
  const issueBefore = makeIssue({
    identifier: "ENG-77",
    stateType: "started",
    stateName: "In Progress",
  });
  const issueAfter = makeIssue({
    identifier: "ENG-77",
    stateType: "completed",
    stateName: "Done",
  });

  const originalFetch = globalThis.fetch;
  try {
    let callCount = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      void _url;
      void _init;
      callCount++;
      if (callCount === 1) {
        return mockJsonResponse(graphqlData({ issues: { nodes: [issueBefore] } }));
      }
      if (callCount === 2) {
        return mockJsonResponse(graphqlData({
          workflowStates: { nodes: [
            { id: "state-done", name: "Done", type: "completed" },
            { id: "state-progress", name: "In Progress", type: "started" },
          ] },
        }));
      }
      if (callCount === 3) {
        return mockJsonResponse(graphqlData({ issueUpdate: { success: true } }));
      }
      return mockJsonResponse(graphqlData({ issues: { nodes: [issueAfter] } }));
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.transitionIssue("ENG-77", "Done");
    assert.ok(result);
    assert.equal(result!.ref, "ENG-77");
    assert.equal(result!.status, "Done");
    assert.equal(result!.statusCategory, "Complete");
    assert.equal(result!.resolution, "Done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter postComment returns comment URL", async () => {
  const issue = makeIssue({ identifier: "ENG-20" });

  const originalFetch = globalThis.fetch;
  try {
    let callCount = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      void _url;
      void _init;
      callCount++;
      if (callCount === 1) {
        return mockJsonResponse(graphqlData({ issues: { nodes: [issue] } }));
      }
      return mockJsonResponse(graphqlData({
        commentCreate: { comment: { url: "https://linear.app/team/issue/ENG-20#comment-1" } },
      }));
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.postComment("ENG-20", "Great work!");
    assert.equal(result.body, "Great work!");
    assert.equal(result.url, "https://linear.app/team/issue/ENG-20#comment-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter addIssueTags merges labels", async () => {
  const issue = makeIssue({
    identifier: "ENG-30",
    labels: ["existing-label"],
  });

  const originalFetch = globalThis.fetch;
  try {
    let callCount = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      void _url;
      void _init;
      callCount++;

      if (callCount === 1) {
        return mockJsonResponse(graphqlData({ issues: { nodes: [issue] } }));
      }
      if (callCount === 2) {
        return mockJsonResponse(graphqlData({
          issueLabels: { nodes: [
            { id: "label-1", name: "existing-label" },
            { id: "label-2", name: "urgent" },
          ] },
        }));
      }
      if (callCount === 3) {
        return mockJsonResponse(graphqlData({
          issue: { labels: { nodes: [{ id: "label-1" }] } },
        }));
      }
      if (callCount === 4) {
        return mockJsonResponse(graphqlData({ issueUpdate: { success: true } }));
      }
      return mockJsonResponse(graphqlData({ issues: { nodes: [issue] } }));
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.addIssueTags("ENG-30", ["urgent"]);
    assert.ok(result);
    assert.equal(result!.ref, "ENG-30");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter removeIssueTags filters out matching labels", async () => {
  const issue = makeIssue({
    identifier: "ENG-31",
    labels: ["bug", "urgent"],
  });

  const originalFetch = globalThis.fetch;
  try {
    let callCount = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      void _url;
      void _init;
      callCount++;

      if (callCount === 1) {
        return mockJsonResponse(graphqlData({ issues: { nodes: [issue] } }));
      }
      if (callCount === 2) {
        return mockJsonResponse(graphqlData({
          issue: { labels: { nodes: [{ id: "l1" }, { id: "l2" }] } },
        }));
      }
      if (callCount === 3) {
        return mockJsonResponse(graphqlData({
          issueLabels: { nodes: [
            { id: "l1", name: "bug" },
            { id: "l2", name: "urgent" },
          ] },
        }));
      }
      if (callCount === 4) {
        return mockJsonResponse(graphqlData({ issueUpdate: { success: true } }));
      }
      return mockJsonResponse(graphqlData({ issues: { nodes: [issue] } }));
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.removeIssueTags("ENG-31", ["urgent"]);
    assert.ok(result);
    assert.equal(result!.ref, "ENG-31");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter maps completed state to Complete category", async () => {
  const issue = makeIssue({
    stateType: "completed",
    stateName: "Done",
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: [issue] } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.getIssue("ENG-123");
    assert.equal(result.status, "Done");
    assert.equal(result.statusCategory, "Complete");
    assert.equal(result.resolution, "Done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter maps canceled state to Complete category", async () => {
  const issue = makeIssue({
    stateType: "canceled",
    stateName: "Canceled",
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: [issue] } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.getIssue("ENG-123");
    assert.equal(result.status, "Canceled");
    assert.equal(result.statusCategory, "Complete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter maps backlog state to To Do category", async () => {
  const issue = makeIssue({
    stateType: "backlog",
    stateName: "Backlog",
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: [issue] } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.getIssue("ENG-123");
    assert.equal(result.status, "Backlog");
    assert.equal(result.statusCategory, "To Do");
    assert.equal(result.resolution, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter maps unstarted state to To Do category", async () => {
  const issue = makeIssue({
    stateType: "unstarted",
    stateName: "Todo",
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlData({ issues: { nodes: [issue] } }),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    const result = await adapter.getIssue("ENG-123");
    assert.equal(result.status, "To Do");
    assert.equal(result.statusCategory, "To Do");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter handles GraphQL errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createMockFetch([
      graphqlError("Unauthorized: invalid API key"),
    ]) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "bad-key",
      teamId: "team-1",
    });

    await assert.rejects(
      () => adapter.getIssue("ENG-1"),
      (error: unknown) => {
        assert.ok(error instanceof ProviderAdapterError);
        assert.equal(error.provider, "linear");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter handles HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (): Promise<Response> => {
      return mockJsonResponse("Internal Server Error", 500);
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
    });

    await assert.rejects(
      () => adapter.getIssue("ENG-1"),
      (error: unknown) => {
        assert.ok(error instanceof ProviderAdapterError);
        assert.equal(error.code, "provider_failed");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter classifies auth errors correctly", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (): Promise<Response> => {
      return mockJsonResponse("Unauthorized", 401);
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "bad-key",
      teamId: "team-1",
    });

    await assert.rejects(
      () => adapter.getIssue("ENG-1"),
      (error: unknown) => {
        assert.ok(error instanceof ProviderAdapterError);
        assert.equal(error.code, "auth_missing");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter uses workspaceUrl when provided", async () => {
  const issue = makeIssue();

  const originalFetch = globalThis.fetch;
  try {
    let capturedUrl: string | URL | Request | undefined;
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      void _init;
      capturedUrl = url;
      return mockJsonResponse(graphqlData({ issues: { nodes: [issue] } }));
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
      workspaceUrl: "https://custom.linear.app",
    });

    await adapter.getIssue("ENG-123");
    assert.ok(capturedUrl);
    const urlStr = typeof capturedUrl === "string" ? capturedUrl : capturedUrl.toString();
    assert.ok(urlStr.startsWith("https://custom.linear.app"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Linear adapter strips trailing slash from workspaceUrl", async () => {
  const issue = makeIssue();

  const originalFetch = globalThis.fetch;
  try {
    let capturedUrl: string | URL | Request | undefined;
    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      void _init;
      capturedUrl = url;
      return mockJsonResponse(graphqlData({ issues: { nodes: [issue] } }));
    }) as typeof fetch;

    const adapter = new LinearIssueTrackerAdapter({
      apiKey: "test-key",
      teamId: "team-1",
      workspaceUrl: "https://custom.linear.app/",
    });

    await adapter.getIssue("ENG-123");
    const urlStr = typeof capturedUrl === "string" ? capturedUrl : capturedUrl!.toString();
    assert.ok(!urlStr.includes("custom.linear.app//"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inferIssueType detects bug from labels", () => {
  assert.equal(inferIssueType(["bug", "urgent"]), "bug");
  assert.equal(inferIssueType(["Bug"]), "bug");
  assert.equal(inferIssueType(["something-bug-related"]), "bug");
});

test("inferIssueType detects story from labels", () => {
  assert.equal(inferIssueType(["feature"]), "story");
  assert.equal(inferIssueType(["story"]), "story");
  assert.equal(inferIssueType(["enhancement"]), "story");
});

test("inferIssueType defaults to task for unknown labels", () => {
  assert.equal(inferIssueType(["chore"]), "task");
  assert.equal(inferIssueType([]), "task");
  assert.equal(inferIssueType(["docs", "refactor"]), "task");
});

test("escapeGraphQLString escapes special characters", () => {
  assert.equal(escapeGraphQLString('hello "world"'), 'hello \\"world\\"');
  assert.equal(escapeGraphQLString("line1\nline2"), "line1\\nline2");
  assert.equal(escapeGraphQLString("back\\slash"), "back\\\\slash");
  assert.equal(escapeGraphQLString("no\r carriage"), "no\\r carriage");
});
