# Configuration Reference

Flow-managed config is the durable source of truth for topology, adapter
selection, execution policy, dashboard settings, runtime store, and ledger
selection. Agents initialize and change it through MCP tools:

- `flow_bootstrap`
- `flow_config_get`
- `flow_config_update`
- `flow_config_validate`
- `flow_config_explain`

Do not edit a project config file. Flow owns persistence.

Environment variables are acceptable for process context and secret injection
when a concrete adapter needs them. They should not be the durable
configuration surface for workflow topology, provider selection, ports,
ledgers, or executor policy.

## Bootstrap

Call `flow_bootstrap` once for a project. Flow infers a local starter config
from repository metadata and persists it under Flow user state.

## Update Shape

Use `flow_config_update` with a schema-validated patch:

```json
{
  "patch": {
    "project": {
      "name": "Flow"
    },
    "topology": {
      "repos": {
        "flow": {
          "name": "flow",
          "baseBranch": "main",
          "pathFromRoot": "."
        }
      },
      "branchPattern": "{kind}/{issueRef}-{slug}",
      "pullRequestUrlPattern": "https://github.com/camden-lowrance/{repoName}/pull/{number}",
      "issueInference": [
        {
          "repo": "flow",
          "keywords": ["flow", "runtime", "dashboard"]
        }
      ]
    },
    "issueTracker": {
      "type": "github",
      "owner": "camden-lowrance",
      "repo": "flow"
    },
    "collaboration": {
      "type": "github",
      "owner": "camden-lowrance",
      "repo": "flow"
    },
    "sourceControl": {
      "type": "git"
    },
    "ledger": {
      "type": "sql",
      "dialect": "sqlite"
    },
    "runtime": {
      "agentSession": {
        "provider": "claude"
      }
    }
  }
}
```

## Common Sections

- `project.name`: display/project name.
- `project.icon`: optional display icon.
- `topology.repos`: required map of repo keys to repository configs.
- `topology.repos.<key>.name`: repository name used by adapters.
- `topology.repos.<key>.baseBranch`: default base branch.
- `topology.repos.<key>.pathFromRoot`: relative path for monorepo layouts.
- `topology.branchPattern`: optional branch template. Must include
  `{issueRef}`.
- `topology.pullRequestUrlPattern`: optional PR URL template. Must include
  `{repoName}` and `{number}`.
- `topology.issueInference`: optional keyword rules that help infer routing.
- `issueTracker.type`: `local`, `github`, `jira`, `linear`, or `notion`.
- `collaboration.type`: `none`, `local`, or `github`.
- `sourceControl.type`: currently `git`.
- `ledger.type`: `sql` for SQLite/Postgres state or `flow` for the unified
  SQLite state backend.
- `knowledge.okfBundles`: optional list of OKF bundles whose lifecycle Flow
  should track.
- `knowledge.okfBundles[].id`: stable bundle id used by `flow_okf_*` tools.
- `knowledge.okfBundles[].path`: bundle path, relative to the project root unless
  absolute.
- `knowledge.okfBundles[].description`: optional human description.
- `knowledge.okfBundles[].owner`: optional owning team, repo, or source.
- `runtime.store.type`: `sqlite` or `file`.
- `runtime.agentSession.provider`: `claude`.
- `runtime.dashboard.host`, `runtime.dashboard.port`, `runtime.dashboard.url`:
  dashboard bind/public settings.

## Examples

Configure local-only work:

```json
{
  "patch": {
    "issueTracker": { "type": "local", "prefix": "FLOW" },
    "collaboration": { "type": "none" },
    "sourceControl": { "type": "git" }
  }
}
```

Configure GitHub issues and pull requests:

```json
{
  "patch": {
    "issueTracker": {
      "type": "github",
      "owner": "camden-lowrance",
      "repo": "flow",
      "assignee": "*",
      "activeLabels": ["in-progress"],
      "backlogLabels": ["backlog"]
    },
    "collaboration": {
      "type": "github",
      "owner": "camden-lowrance",
      "repo": "flow"
    }
  }
}
```

Configure dashboard port:

```json
{
  "patch": {
    "runtime": {
      "dashboard": {
        "host": "127.0.0.1",
        "port": 8767,
        "url": "http://127.0.0.1:8767"
      }
    }
  }
}
```

Configure OKF bundle lifecycle tracking:

```json
{
  "patch": {
    "knowledge": {
      "okfBundles": [
        {
          "id": "repo",
          "path": ".okf",
          "description": "Repo-local OKF projection"
        }
      ]
    }
  }
}
```

After updates, call `flow_config_validate` and `flow_config_explain`.
