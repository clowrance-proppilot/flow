# Configuration Reference

Flow stores durable project configuration in `.flow/config.yaml`. The config is
the source of truth for topology, adapter selection, execution policy, dashboard
settings, runtime store, and ledger selection.

Environment variables are acceptable for process context and secret injection
when a concrete adapter needs them. They should not be the durable configuration
surface for workflow topology, provider selection, ports, ledgers, or executor
policy.

## Minimal Config

```yaml
version: "1"
project:
  name: "Flow"

topology:
  repos:
    flow:
      name: "flow"
      baseBranch: "main"
  branchPattern: "{kind}/{issueRef}-{slug}"
  pullRequestUrlPattern: "https://github.com/camden-lowrance/{repoName}/pull/{number}"

issueTracker:
  type: "github"
  owner: "camden-lowrance"
  repo: "flow"

collaboration:
  type: "github"
  owner: "camden-lowrance"
  repo: "flow"

sourceControl:
  type: "git"

runtime:
  agentSession:
    provider: "claude"

ledger:
  type: "sql"
  dialect: "sqlite"
```

Validate it:

```bash
flow '{"op":"config","mode":"validate"}'
flow '{"op":"config","mode":"explain"}'
```

## Project

```yaml
project:
  name: "Flow"
  icon: "F"
```

- `name`: required display/project name.
- `icon`: optional display icon.

## Topology

```yaml
topology:
  repos:
    flow:
      name: "flow"
      baseBranch: "main"
      pathFromRoot: "."
  branchPattern: "{kind}/{issueRef}-{slug}"
  pullRequestUrlPattern: "https://github.com/org/{repoName}/pull/{number}"
  issueInference:
    - repo: flow
      keywords: ["flow", "runtime", "dashboard"]
```

- `repos`: required map of repo keys to repository configs.
- `repos.<key>.name`: repository name used by adapters.
- `repos.<key>.baseBranch`: default base branch.
- `repos.<key>.pathFromRoot`: relative path for monorepo layouts.
- `branchPattern`: optional branch template. Must include `{issueRef}`.
- `pullRequestUrlPattern`: optional PR URL template. Must include `{repoName}`
  and `{number}`.
- `issueInference`: optional keyword rules that help infer routing.

## Adapters

Adapters are selected by `type` and keep provider-specific behavior behind
adapter boundaries.

### GitHub Issues

```yaml
issueTracker:
  type: "github"
  owner: "camden-lowrance"
  repo: "flow"
  assignee: "*"
  activeLabels: ["in-progress"]
  backlogLabels: ["backlog"]
```

Requires authenticated `gh`.

### Jira

```yaml
issueTracker:
  type: "jira"
  siteUrl: "https://example.atlassian.net"
  projectKey: "FLOW"
  activeQueueJql: "project = FLOW AND statusCategory != Done"
  backlogQueueJql: "project = FLOW AND status = Backlog"
  email: "user@example.com"
```

Jira token values may be injected as environment variables or adapter-specific
secrets.

### Local

```yaml
issueTracker:
  type: "local"
  prefix: "FLOW"
```

Local issues are stored in the Flow ledger.

### Collaboration

```yaml
collaboration:
  type: "github"
  owner: "camden-lowrance"
  repo: "flow"
```

Use `type: "none"` when pull request integration is disabled.

## Runtime

```yaml
runtime:
  stateDir: ".flow/runtime"
  storeDir: ".flow/store"
  store:
    type: "sqlite"
  agentSession:
    provider: "claude"
  executionPlane:
    type: "flow-standalone"
    workerName: "flow-worker"
    slots: 4
    dashboardUrl: "http://127.0.0.1:8080"
  defaultSessionId: "cli"
  autoflowBlockedThreshold: 5
  staleWorkerRunTimeoutMs: 600000
  debug: false
  dashboard:
    host: "127.0.0.1"
    port: 8767
    url: "http://127.0.0.1:8767"
```

- `store.type`: `file` or `sqlite`. Defaults to SQLite in configured runtime.
- `agentSession.provider`: `pi` or `claude`.
- `executionPlane.type`: `flow-standalone` or `hatchet`.
- `autoflowBlockedThreshold`: number of blocked Autoflow attempts before
  stopping.
- `staleWorkerRunTimeoutMs`: timeout before stale worker runs are expired.
- `dashboard`: host, port, and public URL for dashboard serving.

## Ledger

```yaml
ledger:
  type: "sql"
  dialect: "sqlite"
```

SQLite is the default SQL ledger. Keep runtime state local unless your project
intentionally commits workflow ledger history.

## Work Types And Executors

```yaml
workTypes:
  - name: "flow.implement"
    category: "implement"
    requiredCapabilities: []
    allowedExecutors: ["live_agent_thread"]
    outputType: "worker_result"

executors:
  - name: "live_agent_thread"
    executionMode: "local_thread"
    capabilities: []
    outputs: ["worker_result"]
```

Use these sections to make execution policy explicit while keeping SDKs, CLIs,
review tools, issue trackers, and model providers behind adapters.
