# Agent Handoff

Flow is the MCP work record for agents. Use Flow MCP tools to select work,
prepare or adopt the workspace, request handoff, and record evidence, results,
documentation, pull requests, and next pickup notes. Use a local agent process
only for the implementation step.

This path does not require Autoflow. Autoflow, Desktop, and background
orchestration are experimental app-layer behavior built above the same Flow
bookkeeping contract.

## Contract

- Use registered Flow MCP tools as the only agent command surface.
- Use MCP tool discovery as the authoritative command shape.
- Treat Flow-managed config as the durable source of truth.
- Do not edit code before Flow has prepared or adopted the workspace.
- Verify any subprocess output before recording success.
- Record blockers and next pickup through Flow when work cannot finish.

If Flow MCP tools are unavailable, stop and report that Flow MCP is not
connected.

## Orchestrator Thread

An orchestrator thread is an ordinary live agent session that coordinates work
through Flow and calls local worker CLIs when useful. It is not part of Flow
core.

Typical loop:

1. Discover Flow MCP tools and inspect Flow state.
2. Select or view the issue.
3. Prepare or adopt the workspace through Flow.
4. Request or read the handoff prompt.
5. Run a bounded local worker process in the prepared workspace.
6. Inspect the diff and run relevant tests in the prepared workspace.
7. Record evidence, result, documentation, PR state, or blocker notes through
   Flow.

## Flow MCP Tools

Use tool discovery from the host. The core workflow tools are:

- `flow_state`, `flow_issue_view`, `flow_issue_select`
- `flow_workflow_advance`, `flow_prepare_workspace`,
  `flow_adopt_workspace`
- `flow_workflow_handoff`, `flow_workflow_adopt_handoff`, `flow_observe`
- `flow_record_evidence`, `flow_record_result`,
  `flow_record_documentation`, `flow_record_pull_request`

If Flow returns a handoff prompt or handoff request, the orchestrator can save
the returned `prompt` for a local worker:

```powershell
$handoffPrompt = "Use Flow to work GH-123 in the prepared workspace."
Set-Content -Path .\flow-handoff-prompt.txt -Value $handoffPrompt -Encoding utf8NoBOM
```

The default worker record for this path is `live_agent_thread`: Flow tracks the
handoff and result while the live local agent process does the implementation.

Inspect changes and run tests before recording success:

```powershell
git diff --stat
npm test
```

Record closeout through `flow_record_evidence`, `flow_record_result`, and
`flow_record_documentation`.

## Worker CLI Recipes

Before invoking a worker, discover the installed command shape:

```powershell
Get-Command claude -ErrorAction SilentlyContinue
claude --help
```

Claude Code:

```powershell
Set-Location "C:\path\to\prepared\workspace"
$prompt = Get-Content .\flow-handoff-prompt.txt -Raw
claude -p --output-format json --permission-mode dontAsk $prompt
```

Codex CLI:

```powershell
Set-Location "C:\path\to\prepared\workspace"
$prompt = Get-Content .\flow-handoff-prompt.txt -Raw
codex exec $prompt
```

Quad or another local agent:

```powershell
Set-Location "C:\path\to\prepared\workspace"
$prompt = Get-Content .\flow-handoff-prompt.txt -Raw
quad $prompt
```

Adjust flags to the installed CLI. Keep the Flow side of the workflow unchanged.

Set a timeout outside the worker when the host supports one. If the worker exits
nonzero, times out, or returns an unusable result, record the blocker and next
pickup through Flow instead of retrying silently.

If a Flow MCP tool returns an error, read the tool error text before deciding
the next action. If Flow reports a blocker state, stop the worker path and
record or surface the blocker rather than continuing in an unmanaged workspace.

Example handoff response shape:

```json
{
  "id": "worker-gh-123",
  "issueRef": "GH-123",
  "repoKey": "flow",
  "workJobId": "job-gh-123",
  "workspacePath": "C:/repo/.worktrees/feature-gh-123",
  "prompt": "Use Flow to work this prompt."
}
```

## Subagent Prompt

Pass a short Flow contract into every worker:

```text
You are working in a Flow-prepared workspace for GH-123.
Use Flow MCP tools for workflow state and records. Start with tool discovery,
then use `flow_workflow_audit`, `flow_observe`, and
`flow_workflow_adopt_handoff` as needed.
Do not use Autoflow.
Make the requested code changes, run focused tests, and report changed files,
tests, blockers, and next pickup.
If blocked, record the blocker and stop.
```

The orchestrator should still inspect the worker's changes before recording
success.
