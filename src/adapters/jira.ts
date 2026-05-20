import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  IssueTrackerCapabilities,
  IssueTrackerProvider,
  UnifiedIssue,
} from "./provider-contracts.js";

const execFileAsync = promisify(execFile);
const defaultJiraSiteUrl = "https://beckshybrids.atlassian.net";

export interface JiraIssue {
  key: string;
  summary: string;
  issueType?: string;
  status?: string;
  statusCategory?: string;
  resolution?: string;
  assignee?: string;
  updated?: string;
  labels: string[];
}

export interface JiraComment {
  url?: string;
  body: string;
}

export interface JiraAdapterOptions {
  cwd: string;
  siteUrl?: string;
  email?: string;
  apiToken?: string;
}

export interface JiraIssueCreateInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: string;
}

export interface JiraSprintMoveInput {
  issueKeys: string[];
  projectKey?: string;
  boardId?: number;
  sprintId?: number;
}

export interface JiraSprintMoveResult {
  issueKeys: string[];
  sprintId: number;
  sprintName?: string;
  boardId?: number;
}

export interface JiraTransitionResult {
  key: string;
  status: string;
}

export class AcliJiraAdapter implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    canCreateIssues: true,
    canTransitionIssues: true,
    canPostComments: true,
    canManageActivePlanningLane: true,
  };

  private readonly cwd: string;
  private readonly siteUrl: string;
  private readonly email?: string;
  private readonly apiToken?: string;

  constructor(options: JiraAdapterOptions) {
    this.cwd = options.cwd;
    this.siteUrl = (options.siteUrl ?? process.env.ATLASSIAN_SITE_URL ?? defaultJiraSiteUrl).replace(/\/+$/, "");
    this.email = options.email ?? process.env.ATLASSIAN_EMAIL;
    this.apiToken = options.apiToken ?? process.env.ATLASSIAN_API_TOKEN;
  }

  async getIssue(ref: string): Promise<UnifiedIssue> {
    return normalizeJiraIssue(await this.viewIssue(ref), this.siteUrl);
  }

  async fetchActiveQueue(limit?: number): Promise<UnifiedIssue[]> {
    const issues = await this.searchCurrentUserOpenSprintIssues(limit);
    return issues.map((issue) => normalizeJiraIssue(issue, this.siteUrl));
  }

  async fetchBacklogQueue(limit?: number): Promise<UnifiedIssue[]> {
    const issues = await this.searchCurrentUserBacklogIssues(limit);
    return issues.map((issue) => normalizeJiraIssue(issue, this.siteUrl));
  }

  async transitionIssue(ref: string, targetStatus: string): Promise<UnifiedIssue | void> {
    await this.transitionIssueToStatus(ref, targetStatus);
    return this.getIssue(ref).catch(() => undefined);
  }

  async postComment(ref: string, body: string): Promise<JiraComment> {
    return this.postIssueComment(ref, body);
  }

  async moveIssuesToActivePlanningLane(input: {
    issueRefs: string[];
    laneId?: string;
    projectKey?: string;
  }): Promise<{ laneId: string; laneName?: string }> {
    const sprintId = input.laneId && Number.isFinite(Number(input.laneId)) ? Number(input.laneId) : undefined;
    const moved = await this.moveIssuesToActiveSprint({
      issueKeys: input.issueRefs,
      projectKey: input.projectKey,
      sprintId,
    });
    return {
      laneId: String(moved.sprintId),
      laneName: moved.sprintName,
    };
  }

  async viewIssue(key: string): Promise<JiraIssue> {
    const { stdout } = await withPerfLog(`acli jira workitem view ${key}`, () =>
      execFileAsync(
        "acli",
        ["jira", "workitem", "view", key, "--fields", "summary,issuetype,status,resolution,assignee,labels", "--json"],
        {
          cwd: this.cwd,
          maxBuffer: 10 * 1024 * 1024,
        },
      )
    );
    return parseJiraIssue(JSON.parse(stdout) as unknown, key);
  }

  async searchCurrentUserOpenSprintIssues(limit = 10): Promise<JiraIssue[]> {
    const { stdout } = await withPerfLog(`acli jira workitem search open-sprint limit=${limit}`, () =>
      execFileAsync(
        "acli",
        [
          "jira",
          "workitem",
          "search",
          "--jql",
          currentUserOpenSprintJql(),
          "--fields",
          "key,summary,issuetype,status,assignee,labels",
          "--limit",
          String(limit),
          "--json",
        ],
        {
          cwd: this.cwd,
          maxBuffer: 10 * 1024 * 1024,
        },
      )
    );
    return parseJiraSearch(JSON.parse(stdout) as unknown);
  }

  async searchCurrentUserBacklogIssues(limit = 10): Promise<JiraIssue[]> {
    const { stdout } = await withPerfLog(`acli jira workitem search backlog limit=${limit}`, () =>
      execFileAsync(
        "acli",
        [
          "jira",
          "workitem",
          "search",
          "--jql",
          currentUserBacklogJql(),
          "--fields",
          "key,summary,issuetype,status,assignee,labels",
          "--limit",
          String(limit),
          "--json",
        ],
        {
          cwd: this.cwd,
          maxBuffer: 10 * 1024 * 1024,
        },
      )
    );
    return parseJiraSearch(JSON.parse(stdout) as unknown);
  }

  async postIssueComment(key: string, body: string): Promise<JiraComment> {
    const { stdout } = await withPerfLog(`acli jira workitem comment create ${key}`, () =>
      execFileAsync(
        "acli",
        ["jira", "workitem", "comment", "create", "--key", key, "--body", body, "--json"],
        {
          cwd: this.cwd,
          maxBuffer: 10 * 1024 * 1024,
        },
      )
    );
    return {
      url: stdout.trim() ? parseJiraCommentUrl(JSON.parse(stdout) as unknown) : undefined,
      body,
    };
  }

  async createIssue(input: JiraIssueCreateInput): Promise<JiraIssue & UnifiedIssue> {
    const args = [
      "jira",
      "workitem",
      "create",
      "--project",
      input.projectKey,
      "--type",
      input.issueType,
      "--summary",
      input.summary,
      "--json",
    ];
    if (input.description) args.push("--description", input.description);
    const { stdout } = await withPerfLog("acli jira workitem create", () =>
      execFileAsync("acli", args, {
        cwd: this.cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
    );
    const created = parseJiraIssue(JSON.parse(stdout) as unknown);
    const hydrated = await this.viewIssue(created.key).catch(() => created);
    return withUnifiedJiraIssue(hydrated, this.siteUrl);
  }

  async transitionIssueToStatus(key: string, status: string): Promise<JiraTransitionResult> {
    await withPerfLog(`acli jira workitem transition ${key} ${status}`, () =>
      execFileAsync(
        "acli",
        ["jira", "workitem", "transition", "--key", key, "--status", status, "--yes", "--json"],
        {
          cwd: this.cwd,
          maxBuffer: 10 * 1024 * 1024,
        },
      )
    );
    return { key, status };
  }

  async moveIssuesToActiveSprint(input: JiraSprintMoveInput): Promise<JiraSprintMoveResult> {
    const issueKeys = input.issueKeys.map((key) => key.trim()).filter(Boolean);
    if (issueKeys.length === 0) throw new Error("At least one Jira issue key is required.");
    const sprint = input.sprintId
      ? { id: input.sprintId, name: undefined, originBoardId: input.boardId }
      : await this.findActiveSprint(input.projectKey ?? "FSB", input.boardId);
    await this.jiraSoftwareRequest(`/rest/agile/1.0/sprint/${sprint.id}/issue`, {
      method: "POST",
      body: JSON.stringify({ issues: issueKeys }),
    });
    return {
      issueKeys,
      sprintId: sprint.id,
      sprintName: sprint.name,
      boardId: sprint.originBoardId ?? input.boardId,
    };
  }

  private async findActiveSprint(projectKey: string, boardId?: number): Promise<{ id: number; name?: string; originBoardId?: number }> {
    const boardIds = boardId ? [boardId] : await this.findScrumBoardIds(projectKey);
    for (const id of boardIds) {
      const payload = await this.jiraSoftwareRequest(`/rest/agile/1.0/board/${id}/sprint?state=active&maxResults=50`);
      const sprint = readArray(payload, "values").find((candidate) => stringOrUndefined(candidate.state) === "active");
      const sprintId = numberOrUndefined(sprint?.id);
      if (sprintId !== undefined) {
        return {
          id: sprintId,
          name: stringOrUndefined(sprint?.name),
          originBoardId: numberOrUndefined(sprint?.originBoardId) ?? id,
        };
      }
    }
    throw new Error(`No active Jira sprint found for project ${projectKey}.`);
  }

  private async findScrumBoardIds(projectKey: string): Promise<number[]> {
    const payload = await this.jiraSoftwareRequest(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&type=scrum&maxResults=50`);
    const ids = readArray(payload, "values").map((board) => numberOrUndefined(board.id)).filter((id): id is number => id !== undefined);
    if (ids.length === 0) throw new Error(`No Jira scrum board found for project ${projectKey}.`);
    return ids;
  }

  private async jiraSoftwareRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.email || !this.apiToken) {
      throw new Error("Jira REST auth is not configured. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN.");
    }
    const response = await withPerfLog(`jira rest ${init.method ?? "GET"} ${path}`, () =>
      fetch(`${this.siteUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`,
          ...init.headers,
        },
      })
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Jira REST ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) as unknown : {};
  }
}

export function currentUserOpenSprintJql(): string {
  return "project = FSB AND assignee = currentUser() AND sprint in openSprints() AND status in ('Ready for Dev', 'In Progress', 'In Review')";
}

async function withPerfLog<T>(label: string, operation: () => Promise<T>, defaultThresholdMs = 1000): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    const durationMs = Date.now() - startedAt;
    const thresholdMs = Number(process.env.FLOW_PERF_CLI_THRESHOLD_MS ?? defaultThresholdMs);
    if (process.env.FLOW_PERF_LOG === "1" || durationMs >= thresholdMs) {
      console.error(`[flow perf] ${label} duration_ms=${durationMs}`);
    }
  }
}

export function currentUserBacklogJql(): string {
  return "project = FSB AND assignee = currentUser() AND sprint is EMPTY AND status in ('Ready for Dev', 'To Do', 'Selected for Development') ORDER BY updated DESC";
}

export function parseJiraIssue(value: unknown, fallbackKey = ""): JiraIssue {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Jira issue JSON.");
  }
  const record = value as Record<string, unknown>;
  const fields = isRecord(record.fields) ? record.fields : record;
  return {
    key: String(record.key ?? fallbackKey),
    summary: String(fields.summary ?? record.summary ?? ""),
    issueType: isRecord(fields.issuetype)
      ? stringOrUndefined(fields.issuetype.name)
      : isRecord(fields.issueType)
        ? stringOrUndefined(fields.issueType.name)
        : stringOrUndefined(fields.issuetype) ?? stringOrUndefined(fields.issueType),
    status: isRecord(fields.status) ? String(fields.status.name ?? "") : stringOrUndefined(fields.status),
    statusCategory: statusCategory(fields.status),
    resolution: isRecord(fields.resolution)
      ? stringOrUndefined(fields.resolution.name)
      : stringOrUndefined(fields.resolution),
    assignee: isRecord(fields.assignee)
      ? stringOrUndefined(fields.assignee.displayName)
      : stringOrUndefined(fields.assignee),
    updated: stringOrUndefined(fields.updated),
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
  };
}

export function parseJiraSearch(value: unknown): JiraIssue[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.issues)
      ? value.issues
      : isRecord(value) && Array.isArray(value.values)
        ? value.values
        : [];
  return items.map((item) => parseJiraIssue(item));
}

export function normalizeJiraIssue(issue: JiraIssue, siteUrl = defaultJiraSiteUrl): UnifiedIssue {
  return withUnifiedJiraIssue(issue, siteUrl);
}

function withUnifiedJiraIssue(issue: JiraIssue, siteUrl = defaultJiraSiteUrl): JiraIssue & UnifiedIssue {
  return {
    ...issue,
    ref: issue.key,
    title: issue.summary,
    status: issue.status ?? "",
    statusCategory: issue.statusCategory,
    resolution: issue.resolution,
    type: normalizeIssueType(issue.issueType),
    url: `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(issue.key)}`,
    updatedAt: issue.updated,
    labels: issue.labels,
    assignee: issue.assignee,
    raw: issue,
  };
}

export function parseJiraCommentUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidates = [
    record.url,
    record.self,
    record.webUrl,
    isRecord(record.comment) ? record.comment.url : undefined,
    isRecord(record.comment) ? record.comment.self : undefined,
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function normalizeIssueType(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "task";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const items = value[key];
  return Array.isArray(items) ? items.filter(isRecord) : [];
}

function statusCategory(status: unknown): string | undefined {
  if (!isRecord(status)) return undefined;
  const category = status.statusCategory;
  if (!isRecord(category)) return undefined;
  return stringOrUndefined(category.key) ?? stringOrUndefined(category.name);
}
