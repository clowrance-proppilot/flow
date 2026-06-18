# MCP Reference

`flow` starts a stdio MCP server. It does not accept JSON command bodies and it
does not expose a raw runtime-method bridge.

Use MCP tool discovery from the host as the authoritative command shape.

Tools return structured content. The text content mirrors that structured
payload for hosts that display tool output directly.

The server manages all registered projects simultaneously. Project-specific
tools accept optional `projectId` or `projectRoot` inputs; omitted scope uses
the default project registered at server startup. `flow_queue` and
`flow_backlog` also accept `allProjects: true` for aggregate reads.

## Project Tools

| Tool | Purpose |
| --- | --- |
| `flow_projects` | List projects registered with this MCP server. |
| `flow_project_add` | Add a project root and optionally make it the default. |
| `flow_project_refresh` | Refresh project metadata from config. |
| `flow_project_remove` | Remove a project from the registry. |

## Core Tools

| Tool | Purpose |
| --- | --- |
| `flow_state` | Read handoff/session state. |
| `flow_queue` | Inspect active configured-tracker work. |
| `flow_backlog` | Inspect backlog work. |
| `flow_bootstrap` | Create starter Flow config from repository metadata. |
| `flow_config_get` | Read Flow-managed project config. |
| `flow_config_update` | Apply a schema-validated patch to Flow-managed config. |
| `flow_config_validate` | Validate Flow-managed project config. |
| `flow_config_explain` | Explain topology, adapters, and runtime settings. |
| `flow_config_migrate` | Report or apply config migration. |
| `flow_ledger_verify` | Verify the configured workflow ledger. |
| `flow_layout` | Read Flow file and directory layout. |
| `flow_doctor` | Aggregate project health (session hygiene, worktree, config, ledger) as findings with severities and suggested fixes. |

## Issue And Workspace

| Tool | Purpose |
| --- | --- |
| `flow_issue_view` | Inspect an issue or work item by ref. |
| `flow_issue_select` | Select an issue in a Flow session. |
| `flow_issue_intake` | Analyze issue creation input and optionally review/apply. |
| `flow_issue_create` | Create tracked work through the configured issue tracker. |
| `flow_issue_route` | Record the repos an issue should touch. |
| `flow_issue_triage` | Analyze open issues and propose cleanup actions. |
| `flow_prepare_workspace` | Prepare a git worktree for an issue. |
| `flow_adopt_workspace` | Record an existing worktree as the issue workspace. |
| `flow_adopt_branch` | Adopt the current branch/worktree as Flow-tracked work. |

## Workflow

| Tool | Purpose |
| --- | --- |
| `flow_workflow_audit` | Diagnose workflow readiness for an issue. |
| `flow_workflow_advance` | Advance selected issue workflow state. |
| `flow_workflow_handoff` | Summarize current Flow handoff state. |
| `flow_workflow_adopt_handoff` | Adopt a pending local-thread handoff request. |
| `flow_publish_workspace` | Push the prepared worktree branch. |
| `flow_open_pull_request` | Create and record a pull request. |
| `flow_sync_branch` | Rebase the prepared branch and refresh review state. |
| `flow_cleanup_workspaces` | Prune merged issue worktrees. |
| `flow_record_result` | Record local thread or executor result. |
| `flow_record_pull_request` | Record pull request metadata. |
| `flow_record_evidence` | Record verification evidence. |
| `flow_record_documentation` | Record documentation disposition. |
| `flow_record_acceptance` | Record evidence and docs disposition together. |
| `flow_observe` | Observe workflow state and suggested next MCP tools. |

Record completion evidence:

- Call `flow_record_result` with issue id, repo key, summary, changed files, and tests.
- Call `flow_record_evidence` with verification summary and criteria.
- Call `flow_record_documentation` with documentation disposition.

## Knowledge And OKF

| Tool | Purpose |
| --- | --- |
| `flow_okf_list` | List configured or detected OKF bundles. |
| `flow_okf_status` | Validate all configured or detected OKF bundles and summarize knowledge health. |
| `flow_okf_validate` | Validate one OKF bundle against hard conformance rules. |
| `flow_okf_record_disposition` | Record OKF/knowledge lifecycle disposition for an issue. |

Flow treats OKF as source-controlled knowledge, not as Flow-owned document
storage. The OKF MCP tools manage lifecycle state around bundles: discovery,
validation status, drift disposition, and closeout evidence. Authoring judgment
still belongs in agent skills and repo instructions.

## Review And Work Jobs

| Tool | Purpose |
| --- | --- |
| `flow_review_local` | Review local readiness state. |
| `flow_review_code_review` | Review pull request, checks, and provider state. |
| `flow_work_jobs` | List typed work jobs for a session or issue. |
| `flow_claim_work_job` | Claim a typed work job for an executor. |
| `flow_record_work_job_result` | Record a typed work job result. |

## Removed Surface

There is no `flow_runtime` escape hatch and no JSON command fallback. If a
bookkeeping operation needs to be external, add or use a typed `flow_*` MCP
tool.

## Autoflow

Autoflow is experimental app-layer behavior. Core agent work should use the MCP tools above; see
[Agent handoff](agent-handoff.md) for the local-worker path.
