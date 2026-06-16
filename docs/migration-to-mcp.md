# Migrating To MCP

Flow 0.3.0 removes the JSON command surface. `flow` now starts a stdio MCP
server, and MCP tool discovery is the only external command shape.

## What Changed

- Removed JSON requests through argv and stdin.
- Removed raw runtime-method dispatch.
- Removed CLI manifests and CLI examples.
- Removed `.flow/config.yaml` as the project config authoring surface.
- Added explicit `flow_*` MCP tools for supported bookkeeping operations.

This is a breaking change for hosts that launched `flow` as a command and sent
JSON bodies such as `{"op":"state"}` or `{"op":"workflow",...}`.

## Host Migration

1. Register `flow` as a stdio MCP server in the host.
2. Register project roots with `flow_project_add`.
3. Pass `projectId` or `projectRoot` when a tool should operate on a specific
   registered project.
4. Use MCP tool discovery to read the current tool list and input schemas.
5. Replace command bodies with explicit tools.

There is no MCP-global active project. The server owns multiple project
contexts at once; project-specific tools resolve scope from each call.
`flow_queue` and `flow_backlog` can read every registered project with
`allProjects: true`.

| Previous intent | MCP tool |
| --- | --- |
| List projects | `flow_projects` |
| Register project | `flow_project_add` |
| Read state | `flow_state` |
| Read queue | `flow_queue` |
| Bootstrap config | `flow_bootstrap` |
| Read config | `flow_config_get` |
| Update config | `flow_config_update` |
| Validate config | `flow_config_validate` |
| View issue | `flow_issue_view` |
| Create issue | `flow_issue_create` |
| Triage issues | `flow_issue_triage` |
| Prepare workspace | `flow_prepare_workspace` |
| Advance workflow | `flow_workflow_advance` |
| Audit readiness | `flow_workflow_audit` |
| Record result | `flow_record_result` |
| Record evidence | `flow_record_evidence` |
| Record documentation | `flow_record_documentation` |
| Observe next action | `flow_observe` |

There is no replacement for raw runtime-method calls. Add or use a typed MCP
tool for durable bookkeeping behavior instead.

## Agent Contract

Agents should:

- Start with MCP tool discovery.
- Pass `projectId` or `projectRoot` on project-specific tool calls when more
  than one project is registered.
- Treat Flow-managed config as the durable behavior source and mutate it only
  through MCP tools.
- Prepare or adopt a Flow workspace before editing code.
- Record evidence, result, documentation, pull request state, and blockers
  through MCP tools.
- Stop and report that Flow MCP is not connected if `flow_*` tools are missing.

Agents should not:

- Send JSON command bodies to `flow`.
- Depend on a raw `flow_runtime` tool.
- Use Autoflow unless the requester explicitly asks for the experimental
  app-layer path.

## Verification

Run:

```bash
npm run check
npm test
npm run build
npm run smoke:flow
npm run smoke:dashboard
```

Run `npm run smoke:desktop` when the local Electron binary is installed.
