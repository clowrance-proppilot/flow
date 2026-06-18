# Flow

Flow is workflow state for coding agents.

Agents and adapters use its MCP-only agent surface for issue state, handoff,
evidence, readiness, and closeout. Humans use the read-only dashboard mirror.

Flow does not replace the IDE, issue tracker, Git, PRs, CI, or agent runtime.
It records handoff and results; it does not run agents.

## 0.3.0 Breaking Change

`flow` is now MCP-only. It starts a stdio MCP server and does not accept JSON
command bodies through argv or stdin. Use MCP tool discovery from the host and
call explicit `flow_*` tools.

For migration details, see [Migrating to MCP](docs/migration-to-mcp.md).

One installed `flow` MCP server can work across projects. Register projects
with `flow_project_add`, then pass `projectId` or `projectRoot` on
project-specific tools. Read tools such as `flow_queue` can also use
`allProjects: true` to inspect every registered project at once.

## Install

```bash
npm install @camden-lowrance/flow
npx flow-dashboard
```

Package: [@camden-lowrance/flow](https://www.npmjs.com/package/@camden-lowrance/flow)

## Surfaces

- `flow`: stdio MCP server for agents and adapters.
- `flow-dashboard`: read-only human view of the same state.

![Flow dashboard overview](docs/images/dashboard-overview.png)

## Agent Contract

- `flow` starts a stdio MCP server.
- MCP tool discovery is the authoritative external command shape.
- Flow-managed config owns durable topology, adapters, dashboard, and ledger
  settings. Agents read and update it through MCP tools, not file edits.
- Flow writes runtime state and the workflow ledger.

Core tools:

- `flow_bootstrap`
- `flow_config_get`
- `flow_config_update`
- `flow_projects`
- `flow_project_add`
- `flow_queue`
- `flow_issue_view`
- `flow_issue_create`
- `flow_issue_triage`
- `flow_prepare_workspace`
- `flow_workflow_audit`
- `flow_workflow_advance`
- `flow_record_evidence`
- `flow_record_result`
- `flow_record_documentation`
- `flow_okf_list`
- `flow_okf_validate`
- `flow_okf_status`
- `flow_okf_record_disposition`

## Files

```text
<user-state>/config.json
<user-state>/runtime/
<user-state>/ledger/workflow.db
```

Environment variables are only for process context, local launch mechanics, and
secret injection. Durable behavior belongs in Flow-managed config updated
through MCP.

## Release Checks

```bash
npm run check
npm test
npm run build
npm run smoke:flow
npm run smoke:dashboard
npm run readiness:public
```

Releases are published to npm from GitHub Releases. See
[Releasing Flow](docs/releasing.md).

More:

- [Getting started](docs/getting-started.md)
- [Configuration reference](docs/config-reference.md)
- [MCP reference](docs/mcp-reference.md)
- [Migrating to MCP](docs/migration-to-mcp.md)
- [Agent handoff](docs/agent-handoff.md)
- [Adapter authoring](docs/adapter-authoring.md)
- [Desktop notes](docs/desktop.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Runtime and dashboard](docs/runtime-and-dashboard.md)
- [Host integration](docs/host-integration.md)
- [Why Flow](docs/why-flow.md)
