import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  NotionAdapter,
  normalizeNotionPage,
  mapStatusCategory,
  flattenBlocksToMarkdown,
  normalizeNotionId,
  readMultiSelectNames,
} from "../src/adapters/notion.js";
import type { NotionPage, NotionBlock, NotionPropertyMapping } from "../src/adapters/notion.js";
import { ProviderAdapterError } from "../src/adapters/provider-errors.js";

// --- Mock helpers ---

const DEFAULT_PROPS = {
  title: "Name",
  status: "Status",
  labels: "Tags",
  assignee: "Assignee",
  type: "Type",
};

function makePage(overrides: Partial<NotionPage> = {}): NotionPage {
  return {
    id: "abc12345-6789-0abc-def0-1234567890ab",
    url: "https://notion.so/abc1234567890abcdef01234567890ab",
    properties: {
      Name: { title: [{ plain_text: "Test Issue" }] },
      Status: { status: { name: "In Progress" } },
      Tags: { multi_select: [{ name: "bug" }, { name: "urgent" }] },
      Assignee: { people: [{ name: "Alice" }] },
      Type: { select: { name: "Bug" } },
    },
    last_edited_time: "2026-06-09T12:00:00.000Z",
    ...overrides,
  };
}

function mockFetch(response: unknown, status = 200, headers?: Record<string, string>) {
  const fetchMock = mock.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers ?? {})),
    text: async () => JSON.stringify(response),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function restoreFetch() {
  // @ts-expect-error - restoring original fetch
  global.fetch = undefined;
}

// --- normalizeNotionId ---

test("normalizeNotionId passes through hyphenated UUID", () => {
  assert.equal(
    normalizeNotionId("abc12345-6789-0abc-def0-1234567890ab"),
    "abc12345-6789-0abc-def0-1234567890ab",
  );
});

test("normalizeNotionId adds hyphens to 32-char hex", () => {
  assert.equal(
    normalizeNotionId("abc1234567890abcdef01234567890ab"),
    "abc12345-6789-0abc-def0-1234567890ab",
  );
});

test("normalizeNotionId extracts ID from Notion URL", () => {
  assert.equal(
    normalizeNotionId("https://notion.so/abc1234567890abcdef01234567890ab?v=xyz"),
    "abc12345-6789-0abc-def0-1234567890ab",
  );
});

// --- mapStatusCategory ---

test("mapStatusCategory maps known statuses", () => {
  assert.equal(mapStatusCategory("To Do"), "To Do");
  assert.equal(mapStatusCategory("Backlog"), "To Do");
  assert.equal(mapStatusCategory("Not Started"), "To Do");
  assert.equal(mapStatusCategory("In Progress"), "In Progress");
  assert.equal(mapStatusCategory("In Review"), "In Progress");
  assert.equal(mapStatusCategory("Blocked"), "In Progress");
  assert.equal(mapStatusCategory("Done"), "Complete");
  assert.equal(mapStatusCategory("Complete"), "Complete");
  assert.equal(mapStatusCategory("Cancelled"), "Complete");
});

test("mapStatusCategory defaults to To Do for unknown statuses", () => {
  assert.equal(mapStatusCategory("Custom Status"), "To Do");
  assert.equal(mapStatusCategory(""), "To Do");
});

test("mapStatusCategory is case insensitive", () => {
  assert.equal(mapStatusCategory("in progress"), "In Progress");
  assert.equal(mapStatusCategory("IN PROGRESS"), "In Progress");
  assert.equal(mapStatusCategory("done"), "Complete");
});

// --- readMultiSelectNames ---

test("readMultiSelectNames reads names from multi_select property", () => {
  assert.deepEqual(
    readMultiSelectNames({ multi_select: [{ name: "bug" }, { name: "feature" }] }),
    ["bug", "feature"],
  );
});

test("readMultiSelectNames returns empty array for missing data", () => {
  assert.deepEqual(readMultiSelectNames(null), []);
  assert.deepEqual(readMultiSelectNames(undefined), []);
  assert.deepEqual(readMultiSelectNames({}), []);
  assert.deepEqual(readMultiSelectNames({ multi_select: [] }), []);
});

// --- flattenBlocksToMarkdown ---

test("flattenBlocksToMarkdown converts paragraph blocks", () => {
  const blocks: NotionBlock[] = [
    { id: "1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hello world" }] } },
  ];
  assert.equal(flattenBlocksToMarkdown(blocks), "Hello world");
});

test("flattenBlocksToMarkdown converts heading blocks", () => {
  const blocks: NotionBlock[] = [
    { id: "1", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
    { id: "2", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Subtitle" }] } },
    { id: "3", type: "heading_3", heading_3: { rich_text: [{ plain_text: "Section" }] } },
  ];
  assert.equal(flattenBlocksToMarkdown(blocks), "# Title\n\n## Subtitle\n\n### Section");
});

test("flattenBlocksToMarkdown converts list blocks", () => {
  const blocks: NotionBlock[] = [
    { id: "1", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Item 1" }] } },
    { id: "2", type: "numbered_list_item", numbered_list_item: { rich_text: [{ plain_text: "Step 1" }] } },
  ];
  assert.equal(flattenBlocksToMarkdown(blocks), "- Item 1\n\n1. Step 1");
});

test("flattenBlocksToMarkdown converts to_do blocks", () => {
  const blocks: NotionBlock[] = [
    { id: "1", type: "to_do", to_do: { rich_text: [{ plain_text: "Done task" }], checked: true } },
    { id: "2", type: "to_do", to_do: { rich_text: [{ plain_text: "Open task" }], checked: false } },
  ];
  assert.equal(flattenBlocksToMarkdown(blocks), "- [x] Done task\n\n- [ ] Open task");
});

test("flattenBlocksToMarkdown converts code blocks", () => {
  const blocks: NotionBlock[] = [
    { id: "1", type: "code", code: { rich_text: [{ plain_text: "const x = 1;" }], language: "javascript" } },
  ];
  assert.equal(flattenBlocksToMarkdown(blocks), "```javascript\nconst x = 1;\n```");
});

test("flattenBlocksToMarkdown converts quote and divider blocks", () => {
  const blocks: NotionBlock[] = [
    { id: "1", type: "quote", quote: { rich_text: [{ plain_text: "A quote" }] } },
    { id: "2", type: "divider", divider: {} },
  ];
  assert.equal(flattenBlocksToMarkdown(blocks), "> A quote\n\n---");
});

test("flattenBlocksToMarkdown skips blocks with no text", () => {
  const blocks: NotionBlock[] = [
    { id: "1", type: "paragraph", paragraph: { rich_text: [] } },
    { id: "2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Has text" }] } },
  ];
  assert.equal(flattenBlocksToMarkdown(blocks), "Has text");
});

test("flattenBlocksToMarkdown returns empty string for empty input", () => {
  assert.equal(flattenBlocksToMarkdown([]), "");
});

// --- normalizeNotionPage ---

test("normalizeNotionPage maps page to UnifiedIssue", () => {
  const page = makePage();
  const issue = normalizeNotionPage(page, DEFAULT_PROPS);

  assert.equal(issue.ref, page.id);
  assert.equal(issue.title, "Test Issue");
  assert.equal(issue.status, "In Progress");
  assert.equal(issue.statusCategory, "In Progress");
  assert.equal(issue.type, "bug");
  assert.equal(issue.url, page.url);
  assert.equal(issue.updatedAt, "2026-06-09T12:00:00.000Z");
  assert.deepEqual(issue.labels, ["bug", "urgent"]);
  assert.equal(issue.assignee, "Alice");
});

test("normalizeNotionPage uses custom property mapping", () => {
  const page: NotionPage = {
    id: "test-id",
    url: "https://notion.so/test",
    properties: {
      Title: { title: [{ plain_text: "Custom Title" }] },
      State: { status: { name: "Done" } },
      Labels: { multi_select: [{ name: "feature" }] },
    },
  };
  const customProps = { title: "Title", status: "State", labels: "Labels", assignee: "Assignee", type: "Type" };
  const issue = normalizeNotionPage(page, customProps);

  assert.equal(issue.title, "Custom Title");
  assert.equal(issue.status, "Done");
  assert.equal(issue.statusCategory, "Complete");
  assert.deepEqual(issue.labels, ["feature"]);
});

test("normalizeNotionPage handles missing optional properties", () => {
  const page: NotionPage = {
    id: "test-id",
    url: "https://notion.so/test",
    properties: {
      Name: { title: [{ plain_text: "Minimal Issue" }] },
      Status: { status: { name: "To Do" } },
    },
  };
  const issue = normalizeNotionPage(page, DEFAULT_PROPS);

  assert.equal(issue.title, "Minimal Issue");
  assert.equal(issue.status, "To Do");
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.assignee, undefined);
  assert.equal(issue.type, "task"); // default when no type property
});

test("normalizeNotionPage includes description when provided", () => {
  const page = makePage();
  const issue = normalizeNotionPage(page, DEFAULT_PROPS, "A description");

  assert.equal(issue.description, "A description");
});

// --- NotionAdapter ---

test("NotionAdapter has correct capabilities", () => {
  const adapter = new NotionAdapter({ apiKey: "test", databaseId: "db-id" });
  assert.equal(adapter.capabilities.canCreateIssues, true);
  assert.equal(adapter.capabilities.canTransitionIssues, true);
  assert.equal(adapter.capabilities.canPostComments, true);
  assert.equal(adapter.capabilities.canManageActivePlanningLane, false);
  assert.equal(adapter.capabilities.canFetchOpenIssues, true);
  assert.equal(adapter.capabilities.canSearchIssues, true);
  assert.equal(adapter.capabilities.canTagIssues, true);
});

test("NotionAdapter.getIssue fetches page and blocks", async () => {
  const page = makePage();
  const fetchMock = mockFetch(page);
  // First call: page fetch. Second call: blocks fetch.
  fetchMock.mock.mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.includes("/blocks/")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          results: [
            { id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Description text" }] } },
          ],
          has_more: false,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify(page),
    };
  });

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const issue = await adapter.getIssue("abc12345-6789-0abc-def0-1234567890ab");

  assert.equal(issue.title, "Test Issue");
  assert.equal(issue.description, "Description text");
  assert.equal(issue.status, "In Progress");

  mock.restoreAll();
});

test("NotionAdapter.fetchActiveQueue queries with active statuses", async () => {
  const page = makePage();
  const fetchMock = mockFetch({ results: [page], has_more: false });

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const issues = await adapter.fetchActiveQueue(5);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, "Test Issue");

  // Verify the request body had active status filter
  const call = fetchMock.mock.calls[0];
  const body = JSON.parse(call.arguments[1].body as string);
  assert.ok(body.filter.or.length > 0);

  mock.restoreAll();
});

test("NotionAdapter.fetchBacklogQueue queries with backlog statuses", async () => {
  const page = makePage({ properties: { ...makePage().properties, Status: { status: { name: "To Do" } } } });
  const fetchMock = mockFetch({ results: [page], has_more: false });

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const issues = await adapter.fetchBacklogQueue(5);

  assert.equal(issues.length, 1);

  const call = fetchMock.mock.calls[0];
  const body = JSON.parse(call.arguments[1].body as string);
  assert.ok(body.filter.or.some((f: { status: { equals: string } }) => f.status.equals === "To Do"));

  mock.restoreAll();
});

test("NotionAdapter.searchIssues filters by title client-side", async () => {
  const page1 = makePage({ id: "p1", properties: { ...makePage().properties, Name: { title: [{ plain_text: "Fix login bug" }] } } });
  const page2 = makePage({ id: "p2", properties: { ...makePage().properties, Name: { title: [{ plain_text: "Add feature" }] } } });
  mockFetch({ results: [page1, page2], has_more: false });

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const issues = await adapter.searchIssues({ title: "login" });

  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, "Fix login bug");

  mock.restoreAll();
});

test("NotionAdapter.createIssue creates page with properties", async () => {
  const createdPage = makePage({
    id: "new-page-id",
    properties: {
      Name: { title: [{ plain_text: "New Issue" }] },
      Status: { status: { name: "To Do" } },
      Type: { select: { name: "Bug" } },
    },
  });
  const fetchMock = mockFetch(createdPage);

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const issue = await adapter.createIssue({
    issueType: "bug",
    title: "New Issue",
    summary: "A new bug",
    description: "Bug details here",
  });

  assert.equal(issue.title, "New Issue");
  assert.equal(issue.status, "To Do");
  assert.equal(issue.statusCategory, "To Do");

  // Verify the request body
  const call = fetchMock.mock.calls[0];
  const body = JSON.parse(call.arguments[1].body as string);
  assert.equal(body.parent.database_id, "db-id");
  assert.ok(body.children?.length > 0);

  mock.restoreAll();
});

test("NotionAdapter.transitionIssue updates status property", async () => {
  const updatedPage = makePage({
    properties: { ...makePage().properties, Status: { status: { name: "Done" } } },
  });
  const fetchMock = mock.fn(async (url: string) => {
    if (url.includes("/pages/") && !url.includes("/query")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify(updatedPage),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify({ results: [], has_more: false }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const result = await adapter.transitionIssue("abc12345-6789-0abc-def0-1234567890ab", "Done");

  assert.ok(result);
  assert.equal((result as { status: string }).status, "Done");

  // Verify PATCH request was made
  const patchCall = fetchMock.mock.calls.find((c: { arguments: { 1?: { method?: string } } }) => c.arguments[1]?.method === "PATCH");
  assert.ok(patchCall);

  mock.restoreAll();
});

test("NotionAdapter.postComment appends paragraph block", async () => {
  const fetchMock = mockFetch({ results: [] });

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const result = await adapter.postComment("abc12345-6789-0abc-def0-1234567890ab", "A comment");

  assert.equal(result.body, "A comment");
  assert.ok(result.url);

  const call = fetchMock.mock.calls[0];
  const body = JSON.parse(call.arguments[1].body as string);
  assert.equal(body.children[0].type, "paragraph");
  assert.equal(body.children[0].paragraph.rich_text[0].text.content, "A comment");

  mock.restoreAll();
});

test("NotionAdapter.addIssueTags merges with existing tags", async () => {
  const page = makePage();
  let patched = false;
  const fetchMock = mock.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PATCH") {
      patched = true;
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({}) };
    }
    // GET: return updated page after PATCH, original before
    const responsePage = patched
      ? { ...page, properties: { ...page.properties, Tags: { multi_select: [{ name: "bug" }, { name: "urgent" }, { name: "new-tag" }] } } }
      : page;
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(responsePage) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const result = await adapter.addIssueTags("abc12345-6789-0abc-def0-1234567890ab", ["new-tag"]);

  assert.ok(result);
  assert.deepEqual((result as { labels: string[] }).labels, ["bug", "urgent", "new-tag"]);

  mock.restoreAll();
});

test("NotionAdapter.removeIssueTags removes specified tags", async () => {
  const page = makePage();
  let patched = false;
  const fetchMock = mock.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PATCH") {
      patched = true;
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({}) };
    }
    const responsePage = patched
      ? { ...page, properties: { ...page.properties, Tags: { multi_select: [{ name: "bug" }] } } }
      : page;
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(responsePage) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  const result = await adapter.removeIssueTags("abc12345-6789-0abc-def0-1234567890ab", ["urgent"]);

  assert.ok(result);
  assert.deepEqual((result as { labels: string[] }).labels, ["bug"]);

  mock.restoreAll();
});

// --- Error handling ---

test("NotionAdapter throws ProviderAdapterError on auth failure", async () => {
  mockFetch({ message: "Unauthorized" }, 401);

  const adapter = new NotionAdapter({ apiKey: "bad-key", databaseId: "db-id" });
  await assert.rejects(
    () => adapter.getIssue("abc12345-6789-0abc-def0-1234567890ab"),
    (error: unknown) => {
      assert.ok(error instanceof ProviderAdapterError);
      assert.equal(error.provider, "notion");
      assert.equal(error.code, "auth_missing");
      return true;
    },
  );

  mock.restoreAll();
});

test("NotionAdapter throws ProviderAdapterError on server error", async () => {
  mockFetch({ message: "Internal Server Error" }, 500);

  const adapter = new NotionAdapter({ apiKey: "test-key", databaseId: "db-id" });
  await assert.rejects(
    () => adapter.getIssue("abc12345-6789-0abc-def0-1234567890ab"),
    (error: unknown) => {
      assert.ok(error instanceof ProviderAdapterError);
      assert.equal(error.provider, "notion");
      assert.equal(error.code, "provider_failed");
      return true;
    },
  );

  mock.restoreAll();
});

test("NotionAdapter sends correct headers", async () => {
  const page = makePage();
  const fetchMock = mockFetch(page);

  const adapter = new NotionAdapter({ apiKey: "secret-key", databaseId: "db-id" });
  await adapter.getIssue("abc12345-6789-0abc-def0-1234567890ab");

  const call = fetchMock.mock.calls[0];
  const headers = call.arguments[1]?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer secret-key");
  assert.equal(headers["Notion-Version"], "2022-06-28");

  mock.restoreAll();
});

test("NotionAdapter uses custom property mapping from constructor", async () => {
  const page: NotionPage = {
    id: "custom-id",
    url: "https://notion.so/custom",
    properties: {
      Title: { title: [{ plain_text: "Custom Mapped" }] },
      State: { status: { name: "Done" } },
      Labels: { multi_select: [{ name: "enhancement" }] },
      Owner: { people: [{ name: "Bob" }] },
      Kind: { select: { name: "Story" } },
    },
  };
  mockFetch(page);

  const mapping: NotionPropertyMapping = {
    title: "Title",
    status: "State",
    labels: "Labels",
    assignee: "Owner",
    type: "Kind",
  };
  const adapter = new NotionAdapter({ apiKey: "key", databaseId: "db", propertyMapping: mapping });
  const issue = await adapter.getIssue("custom-id");

  assert.equal(issue.title, "Custom Mapped");
  assert.equal(issue.status, "Done");
  assert.equal(issue.statusCategory, "Complete");
  assert.deepEqual(issue.labels, ["enhancement"]);
  assert.equal(issue.assignee, "Bob");
  assert.equal(issue.type, "story");

  mock.restoreAll();
});
