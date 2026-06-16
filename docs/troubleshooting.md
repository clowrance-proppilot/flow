# Troubleshooting

## MCP Server Does Not Start

`flow` starts a stdio MCP server. Do not add command-style JSON bodies,
human-output modes, or `--json` toggles.

Check the MCP contract:

```bash
npm run check:mcp-contract
```

## Config Does Not Apply

Validate config first:

Use `flow_config_validate` and `flow_config_explain`.

Make durable changes in Flow-managed config. Environment variables should only
inject secrets or process context.

## GitHub Auth Fails

Flow's GitHub adapters use the authenticated `gh` CLI. Check:

```bash
gh auth status
gh repo view
```

If Autoflow uses Claude, the Claude SDK must also be authenticated through its
own configuration. The Claude Code CLI and Claude SDK are separate binaries, but
the SDK can use user settings when Flow does not force project-only settings.

## Autoflow Is Idle Or Blocked

Inspect status through the desktop app-layer status view and use
`flow_workflow_audit` for core issue readiness.

Common causes:

- Missing repo routing.
- Missing prepared worktree.
- Pull request conflicts.
- Failing or pending checks.
- Missing evidence or documentation disposition.
- Stale worker run beyond `runtime.staleWorkerRunTimeoutMs`.

## Worktree Problems

Check recorded workspace state with `flow_issue_view`, then inspect local git
state with `git worktree list`.

Adopt an existing workspace when Flow should track it:

Use `flow_adopt_workspace` with `id`, `repoKey`, and `worktreePath`.

## SQL State Problems

Verify ledger state:

Use `flow_ledger_verify`.

SQLite runtime and workflow state are stored under Flow's configured runtime
paths. If a project uses a custom `runtime.storeDir`, `runtime.stateDir`, or
`ledger.path`, inspect those paths before deleting anything.

## Pull Request Closeout Stalls

Run `flow_review_code_review` and `flow_workflow_audit`.

Flow will block closeout for draft PRs, conflicts, failed checks, missing
template headings, must-fix auto-review feedback, missing evidence, or missing
documentation disposition.
