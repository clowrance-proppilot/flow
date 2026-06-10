# Adapter Authoring

Flow keeps provider details behind adapter boundaries. Issue trackers, code
review tools, source control, agent SDKs, and execution planes should not leak
provider-specific state into durable workflow topology.

## Adapter Types

- Issue tracker: issue view, queue, backlog, create, transition, comments,
  search, tagging, and planning lane operations.
- Code collaboration: pull request discovery, creation, review comments,
  ready-for-review, and merge operations.
- Source control: inspect repository state and prepare worktrees.
- Agent session: open issue sessions, post prompts, persist timelines, and
  summarize results.
- Execution plane: background worker orchestration.

## Durable Config

Select adapters in `.flow/config.yaml`:

```yaml
issueTracker:
  type: "github"
  owner: "camden-lowrance"
  repo: "flow"

collaboration:
  type: "github"
  owner: "camden-lowrance"
  repo: "flow"

runtime:
  agentSession:
    provider: "claude"
```

Do not make environment variables the primary selector for topology or provider
choice. Use them for secrets only.

## Built-in Issue Tracker Adapters

Flow ships with first-class support for several issue trackers:

### GitHub Issues

```yaml
issueTracker:
  type: "github"
  owner: "my-org"
  repo: "my-repo"
  activeLabels: ["in-progress"]
  backlogLabels: ["backlog"]
```

### Jira

```yaml
issueTracker:
  type: "jira"
  siteUrl: "https://myteam.atlassian.net"
  projectKey: "PROJ"
```

### Linear

```yaml
issueTracker:
  type: "linear"
  apiKey: "${LINEAR_API_KEY}"
  teamId: "team-uuid"
  workspaceUrl: "https://api.linear.app"  # optional, defaults to api.linear.app
```

The Linear adapter maps Linear issue states to Flow's normalized status
categories:

| Linear state type | Flow status      | Flow statusCategory |
|-------------------|------------------|---------------------|
| `completed`       | Done             | Complete            |
| `canceled`        | Canceled         | Complete            |
| `started`         | In Progress      | In Progress         |
| `backlog`         | Backlog          | To Do               |
| `unstarted`       | To Do            | To Do               |

### Notion

The Notion adapter uses Notion's REST API to manage issues as database items.
Issues live in a Notion database, and properties are mapped to Flow's unified
issue fields.

```yaml
issueTracker:
  type: "notion"
  apiKey: "${NOTION_API_KEY}"
  databaseId: "abc1234567890abcdef01234567890ab"
  propertyMapping:
    title: "Name"
    status: "Status"
    labels: "Tags"
    assignee: "Assignee"
    type: "Type"
```

The `propertyMapping` field is optional. Defaults are shown above. Each key maps
a Flow field to the corresponding Notion database property name.

- `title` maps to a Notion `title` property (required in every Notion database).
- `status` maps to a Notion `status` property. Status values are normalized to
  Flow's `statusCategory`: `To Do`, `In Progress`, or `Complete`.
- `labels` maps to a Notion `multi_select` property.
- `assignee` maps to a Notion `people`, `rich_text`, or `select` property.
- `type` maps to a Notion `select` property.

The adapter handles rate limiting (Notion allows ~3 requests/second) with
automatic backoff. If `apiKey` is not set in config, the adapter falls back to
the `NOTION_API_KEY` environment variable.

### Local

```yaml
issueTracker:
  type: "local"
```

## Custom Adapter Pattern

A custom issue tracker should implement the provider interface used by
`FlowWorkRuntime` and return provider-neutral work items.

```ts
import type { IssueTrackerProvider } from "../src/providers.js";

export function createExampleIssueTracker(): IssueTrackerProvider {
  return {
    capabilities: {
      canCreateIssues: true,
      canTransitionIssues: true,
      canPostComments: true,
      canSearchIssues: true,
      canTagIssues: true,
      canManageActivePlanningLane: false,
    },
    async getIssue(ref) {
      return {
        ref,
        title: "Example issue",
        repoKeys: ["flow"],
        state: "queued",
        metadata: {
          issueStatus: "Open",
          issueStatusCategory: "To Do",
          "workflow.external.issue.status": "published",
        },
      };
    },
    async fetchActiveQueue() {
      return [];
    },
    async fetchBacklogQueue() {
      return [];
    },
  };
}
```

Keep raw provider IDs, URLs, and statuses in metadata fields. Keep Flow routing
and workflow decisions in Flow's neutral fields.

## Plugin Boundary

When packaging provider support, keep SDK imports, CLIs, auth, and provider
request/response parsing inside the adapter or plugin. The rest of Flow should
depend on provider-neutral capabilities, not on a concrete SDK.

## Verification

Use the manifests and focused tests for the adapter surface you touch:

```bash
flow '{"op":"manifest","target":"issue"}'
flow '{"op":"manifest","target":"workflow"}'
npm run check
```
