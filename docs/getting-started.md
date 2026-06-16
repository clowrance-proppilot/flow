# Getting Started

Flow is workflow state for coding agents. It keeps issue routing, prepared
workspaces, handoff prompts, evidence, documentation disposition, pull request
state, and closeout readiness in one durable project model.

## Prerequisites

- Node.js 22 or 24
- npm 10 or newer
- Git
- `gh` when using GitHub issues or pull requests

## Install

```bash
npm install @camden-lowrance/flow
```

The package provides two surfaces:

- `flow`: stdio MCP server for agents, adapters, and automation.
- `flow-dashboard`: desktop/dashboard server for the human project view.

`flow` is not a command protocol. Do not pass JSON bodies on argv or stdin.
Register it as an MCP server in the host and use tool discovery.

Use one MCP server across projects by registering roots with `flow_project_add`
and passing `projectId` or `projectRoot` on project-specific tool calls.

Start the dashboard:

```bash
npx flow-dashboard
```

Open `http://127.0.0.1:8767/dashboard`.

## Bootstrap

Flow durable behavior belongs in Flow-managed config. Agents initialize and
change it through MCP; they do not edit a project config file.

Use the MCP tools `flow_bootstrap`, `flow_config_get`, `flow_config_update`,
`flow_config_validate`, and `flow_config_explain`.

The bootstrap tool creates a starter config from repository metadata. Use
`flow_config_update` for topology, providers, runtime store, experimental
app-layer Autoflow, and dashboard settings. Do not use environment variables as
the primary topology or provider selection surface.

## First Workflow

Flow exposes agent actions as MCP tools. Use tool discovery from the host, then
call `flow_queue`, `flow_issue_view`, and `flow_workflow_audit`.

When multiple projects are registered, call `flow_projects` to find project ids.
Pass `projectId` or `projectRoot` for project-specific work, or call
`flow_queue` / `flow_backlog` with `allProjects: true` for aggregate reads.

Capture or select work:

- Use `flow_issue_create` for simple issue capture.
- Use `flow_issue_intake` when you want dedupe, routing, or review before
  creation.
- Use `flow_issue_select` for existing work.

Prepare and hand off work:

Call `flow_issue_select`, then `flow_workflow_advance`.

When `advance` asks for confirmation, approve it with the returned
`approveConfirmationId`.

Record completion evidence:

Call `flow_record_result`, `flow_record_evidence`, and
`flow_record_documentation`.

Useful read-only checks:

- `flow_state` for current session state.
- `flow_observe` for suggested next MCP tools.
- `flow_review_local` for local readiness.
- `flow_review_code_review` for pull request and check state.

For migration from the removed JSON command surface, see
[Migrating to MCP](migration-to-mcp.md).

## Autoflow

Autoflow is experimental app-layer behavior built above the same Flow runtime
model. Core agent work should use the MCP issue and workflow tools above,
including `flow_workflow_adopt_handoff` for live local agent threads.

Select the agent session provider with `flow_config_update`:

```json
{
  "patch": {
    "runtime": {
      "agentSession": {
        "provider": "claude"
      }
    }
  }
}
```

## More

- [Configuration Reference](config-reference.md)
- [MCP Reference](mcp-reference.md)
- [Migrating To MCP](migration-to-mcp.md)
- [Adapter Authoring](adapter-authoring.md)
- [Desktop Notes](desktop.md)
- [Troubleshooting](troubleshooting.md)
