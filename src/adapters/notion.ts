import type {
  CreateIssueInput,
  IssueTrackerCapabilities,
  IssueTrackerProvider,
  IssueSearchParams,
  UnifiedIssue,
} from "./provider-contracts.js";
import { ProviderAdapterError } from "./provider-errors.js";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const RATE_LIMIT_DELAY_MS = 350; // ~3 requests/sec with margin

export interface NotionAdapterOptions {
  apiKey: string;
  databaseId: string;
  propertyMapping?: NotionPropertyMapping;
}

export interface NotionPropertyMapping {
  title?: string;       // default: "Name" (Notion's default title property)
  status?: string;      // default: "Status"
  labels?: string;      // default: "Tags"
  assignee?: string;    // default: "Assignee"
  type?: string;        // default: "Type"
}

interface NotionPropertyDef {
  title: string;
  status: string;
  labels: string;
  assignee: string;
  type: string;
}

export interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, unknown>;
  last_edited_time?: string;
}

export interface NotionBlock {
  id: string;
  type: string;
  [key: string]: unknown;
}

// Status category mapping from Notion status names to Flow categories
const STATUS_CATEGORY_MAP: Record<string, string> = {
  // To Do
  "to do": "To Do",
  "todo": "To Do",
  "backlog": "To Do",
  "not started": "To Do",
  "new": "To Do",
  "icebox": "To Do",
  "planned": "To Do",
  // In Progress
  "in progress": "In Progress",
  "working": "In Progress",
  "in review": "In Progress",
  "review": "In Progress",
  "in development": "In Progress",
  "blocked": "In Progress",
  "on hold": "In Progress",
  // Complete
  "done": "Complete",
  "complete": "Complete",
  "completed": "Complete",
  "closed": "Complete",
  "resolved": "Complete",
  "shipped": "Complete",
  "cancelled": "Complete",
  "canceled": "Complete",
};

export class NotionAdapter implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    canCreateIssues: true,
    canTransitionIssues: true,
    canPostComments: true,
    canManageActivePlanningLane: false,
    canFetchOpenIssues: true,
    canSearchIssues: true,
    canTagIssues: true,
  };

  private readonly apiKey: string;
  private readonly databaseId: string;
  private readonly props: NotionPropertyDef;
  private lastRequestTime = 0;

  constructor(options: NotionAdapterOptions) {
    this.apiKey = options.apiKey;
    this.databaseId = options.databaseId;
    this.props = {
      title: options.propertyMapping?.title ?? "Name",
      status: options.propertyMapping?.status ?? "Status",
      labels: options.propertyMapping?.labels ?? "Tags",
      assignee: options.propertyMapping?.assignee ?? "Assignee",
      type: options.propertyMapping?.type ?? "Type",
    };
  }

  async getIssue(ref: string): Promise<UnifiedIssue> {
    const pageId = normalizeNotionId(ref);
    const page = await this.notionRequest<NotionPage>(`/pages/${pageId}`, { method: "GET" });
    const description = await this.fetchPageMarkdown(pageId);
    return normalizeNotionPage(page, this.props, description);
  }

  async fetchActiveQueue(limit = 10): Promise<UnifiedIssue[]> {
    const activeStatuses = [
      "In Progress", "In Review", "Working", "In Development", "Blocked",
    ];
    return this.queryDatabaseByStatus(activeStatuses, limit);
  }

  async fetchBacklogQueue(limit = 10): Promise<UnifiedIssue[]> {
    const backlogStatuses = ["To Do", "Backlog", "Not Started", "New", "Planned"];
    return this.queryDatabaseByStatus(backlogStatuses, limit);
  }

  async fetchOpenIssues(limit = 100): Promise<UnifiedIssue[]> {
    const results: UnifiedIssue[] = [];
    let startCursor: string | undefined;
    let remaining = limit;

    while (remaining > 0) {
      const pageSize = Math.min(remaining, 100);
      const body: Record<string, unknown> = {
        page_size: pageSize,
        filter: {
          property: this.props.status,
          status: { does_not_equal: "Done" },
        },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      };
      if (startCursor) body.start_cursor = startCursor;

      const response = await this.notionRequest<NotionQueryResponse>(
        `/databases/${this.databaseId}/query`,
        { method: "POST", body: JSON.stringify(body) },
      );

      for (const page of response.results) {
        results.push(normalizeNotionPage(page, this.props));
      }

      if (!response.has_more || !response.next_cursor) break;
      startCursor = response.next_cursor;
      remaining -= response.results.length;
    }

    return results.slice(0, limit);
  }

  async searchIssues(params: IssueSearchParams): Promise<UnifiedIssue[]> {
    const limit = params.limit ?? 10;
    const filters: unknown[] = [];

    if (params.state) {
      const normalized = params.state.toLowerCase();
      if (["open", "todo", "to do", "active"].includes(normalized)) {
        filters.push({
          property: this.props.status,
          status: { does_not_equal: "Done" },
        });
      } else if (["closed", "done", "complete"].includes(normalized)) {
        filters.push({
          property: this.props.status,
          status: { equals: "Done" },
        });
      }
    }

    if (params.issueType && this.props.type) {
      filters.push({
        property: this.props.type,
        select: { equals: params.issueType },
      });
    }

    const body: Record<string, unknown> = {
      page_size: Math.min(limit, 100),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    };

    if (filters.length === 1) {
      body.filter = filters[0];
    } else if (filters.length > 1) {
      body.filter = { and: filters };
    }

    const response = await this.notionRequest<NotionQueryResponse>(
      `/databases/${this.databaseId}/query`,
      { method: "POST", body: JSON.stringify(body) },
    );

    let issues = response.results.map((page) => normalizeNotionPage(page, this.props));

    const query = (params.title || params.summary || "").toLowerCase();
    if (query) {
      issues = issues.filter((issue) => issue.title.toLowerCase().includes(query));
    }

    return issues.slice(0, limit);
  }

  async createIssue(input: CreateIssueInput): Promise<UnifiedIssue> {
    const issueTitle = input.title?.trim() || input.summary;
    const issueType = input.issueType || "Task";

    const properties: Record<string, unknown> = {
      [this.props.title]: {
        title: [{ text: { content: issueTitle } }],
      },
    };

    if (this.props.type) {
      properties[this.props.type] = {
        select: { name: issueType },
      };
    }

    if (this.props.status) {
      properties[this.props.status] = {
        status: { name: "To Do" },
      };
    }

    const requestBody: Record<string, unknown> = {
      parent: { database_id: this.databaseId },
      properties,
    };

    if (input.description) {
      requestBody.children = [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: input.description } }],
          },
        },
      ];
    }

    const page = await this.notionRequest<NotionPage>("/pages", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    return normalizeNotionPage(page, this.props, input.description);
  }

  async transitionIssue(ref: string, targetStatus: string): Promise<UnifiedIssue | void> {
    const pageId = normalizeNotionId(ref);
    await this.notionRequest(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [this.props.status]: {
            status: { name: targetStatus },
          },
        },
      }),
    });
    return this.getIssue(ref).catch(() => undefined);
  }

  async postComment(ref: string, commentBody: string): Promise<{ url?: string; body: string }> {
    const pageId = normalizeNotionId(ref);
    await this.notionRequest(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: commentBody } }],
            },
          },
        ],
      }),
    });
    return { url: `https://notion.so/${pageId.replace(/-/g, "")}`, body: commentBody };
  }

  async addIssueTags(ref: string, tags: string[]): Promise<UnifiedIssue | void> {
    if (!this.props.labels) return this.getIssue(ref);
    const pageId = normalizeNotionId(ref);
    const page = await this.notionRequest<NotionPage>(`/pages/${pageId}`, { method: "GET" });
    const existing = readMultiSelectNames(page.properties[this.props.labels]);
    const merged = [...new Set([...existing, ...tags.map((t) => t.trim()).filter(Boolean)])];

    await this.notionRequest(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [this.props.labels]: {
            multi_select: merged.map((name) => ({ name })),
          },
        },
      }),
    });
    return this.getIssue(ref);
  }

  async removeIssueTags(ref: string, tags: string[]): Promise<UnifiedIssue | void> {
    if (!this.props.labels) return this.getIssue(ref);
    const pageId = normalizeNotionId(ref);
    const page = await this.notionRequest<NotionPage>(`/pages/${pageId}`, { method: "GET" });
    const existing = readMultiSelectNames(page.properties[this.props.labels]);
    const removals = new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean));
    const remaining = existing.filter((name) => !removals.has(name.toLowerCase()));

    await this.notionRequest(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          [this.props.labels]: {
            multi_select: remaining.map((name) => ({ name })),
          },
        },
      }),
    });
    return this.getIssue(ref);
  }

  // --- Internal helpers ---

  private async queryDatabaseByStatus(statuses: string[], limit: number): Promise<UnifiedIssue[]> {
    const body: Record<string, unknown> = {
      page_size: Math.min(limit, 100),
      filter: {
        or: statuses.map((status) => ({
          property: this.props.status,
          status: { equals: status },
        })),
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    };

    const response = await this.notionRequest<NotionQueryResponse>(
      `/databases/${this.databaseId}/query`,
      { method: "POST", body: JSON.stringify(body) },
    );

    return response.results.map((page) => normalizeNotionPage(page, this.props)).slice(0, limit);
  }

  private async fetchPageMarkdown(pageId: string): Promise<string | undefined> {
    try {
      const response = await this.notionRequest<NotionBlockChildrenResponse>(
        `/blocks/${pageId}/children?page_size=100`,
        { method: "GET" },
      );
      return flattenBlocksToMarkdown(response.results);
    } catch {
      return undefined;
    }
  }

  private async notionRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.respectRateLimit();

    const url = `${NOTION_API_BASE}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
      await sleep(retryAfter * 1000);
      return this.notionRequest<T>(path, init);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new ProviderAdapterError({
        provider: "notion",
        operation: `${init.method ?? "GET"} ${path}`,
        code: response.status === 401 || response.status === 403 ? "auth_missing" : "provider_failed",
        message: `Notion API ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
      });
    }

    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private async respectRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < RATE_LIMIT_DELAY_MS) {
      await sleep(RATE_LIMIT_DELAY_MS - elapsed);
    }
    this.lastRequestTime = Date.now();
  }
}

// --- Notion response types ---

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor?: string;
}

interface NotionBlockChildrenResponse {
  results: NotionBlock[];
  has_more: boolean;
}

// --- Normalization ---

export function normalizeNotionPage(
  page: NotionPage,
  props: NotionPropertyDef,
  description?: string,
): UnifiedIssue {
  const title = readTitle(page.properties[props.title]);
  const status = readStatus(page.properties[props.status]);
  const statusCategory = mapStatusCategory(status);
  const labels = props.labels ? readMultiSelectNames(page.properties[props.labels]) : [];
  const assignee = props.assignee ? readRichTextOrSelect(page.properties[props.assignee]) : undefined;
  const type = props.type ? readSelectName(page.properties[props.type]) : undefined;

  return {
    ref: page.id,
    title,
    description,
    status,
    statusCategory,
    type: normalizeIssueType(type),
    url: page.url,
    updatedAt: page.last_edited_time,
    labels,
    assignee,
    raw: page,
  };
}

export function mapStatusCategory(status: string): string {
  const normalized = status.toLowerCase().trim();
  return STATUS_CATEGORY_MAP[normalized] ?? "To Do";
}

export function flattenBlocksToMarkdown(blocks: NotionBlock[]): string {
  const segments: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading_1": {
        const text = extractBlockText(block);
        if (text) segments.push(`# ${text}`);
        break;
      }
      case "heading_2": {
        const text = extractBlockText(block);
        if (text) segments.push(`## ${text}`);
        break;
      }
      case "heading_3": {
        const text = extractBlockText(block);
        if (text) segments.push(`### ${text}`);
        break;
      }
      case "bulleted_list_item": {
        const text = extractBlockText(block);
        if (text) segments.push(`- ${text}`);
        break;
      }
      case "numbered_list_item": {
        const text = extractBlockText(block);
        if (text) segments.push(`1. ${text}`);
        break;
      }
      case "to_do": {
        const text = extractBlockText(block);
        if (!text) break;
        const blockData = block.to_do as Record<string, unknown> | undefined;
        const checked = blockData?.checked === true;
        segments.push(`- [${checked ? "x" : " "}] ${text}`);
        break;
      }
      case "code": {
        const text = extractBlockText(block);
        if (!text) break;
        const blockData = block.code as Record<string, unknown> | undefined;
        const lang = String(blockData?.language ?? "");
        segments.push(`\`\`\`${lang}\n${text}\n\`\`\``);
        break;
      }
      case "quote": {
        const text = extractBlockText(block);
        if (text) segments.push(`> ${text}`);
        break;
      }
      case "divider":
        segments.push("---");
        break;
      default: {
        const text = extractBlockText(block);
        if (text) segments.push(text);
      }
    }
  }
  return segments.join("\n\n").trim() || "";
}

function extractBlockText(block: NotionBlock): string {
  const blockData = block[block.type] as Record<string, unknown> | undefined;
  if (!blockData) return "";
  const richText = blockData.rich_text;
  if (!Array.isArray(richText)) return "";
  return richText.map((rt: Record<string, unknown>) => String(rt.plain_text ?? "")).join("");
}

function readTitle(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.title)) return "";
  return record.title.map((t: Record<string, unknown>) => String(t.plain_text ?? "")).join("");
}

function readStatus(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.status && typeof record.status === "object") {
    return String((record.status as Record<string, unknown>).name ?? "");
  }
  if (typeof record.name === "string") return record.name;
  return "";
}

export function readMultiSelectNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.multi_select)) return [];
  return record.multi_select
    .map((item: Record<string, unknown>) => String(item.name ?? ""))
    .filter((name: string) => name.length > 0);
}

function readSelectName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.select && typeof record.select === "object") {
    const name = (record.select as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function readRichTextOrSelect(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.people) && record.people.length > 0) {
    const person = record.people[0] as Record<string, unknown>;
    return typeof person.name === "string" ? person.name : undefined;
  }
  if (Array.isArray(record.rich_text) && record.rich_text.length > 0) {
    return record.rich_text.map((rt: Record<string, unknown>) => String(rt.plain_text ?? "")).join("") || undefined;
  }
  if (record.select && typeof record.select === "object") {
    const name = (record.select as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function normalizeIssueType(value: string | undefined): string {
  if (!value || !value.trim()) return "task";
  return value.trim().toLowerCase();
}

export function normalizeNotionId(ref: string): string {
  const trimmed = ref.trim();
  const urlMatch = /([a-f0-9]{32})(?:\?|$)/i.exec(trimmed);
  if (urlMatch) return addHyphens(urlMatch[1]);
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed)) return trimmed;
  if (/^[a-f0-9]{32}$/i.test(trimmed)) return addHyphens(trimmed);
  return trimmed;
}

function addHyphens(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
