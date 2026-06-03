# Agent Handoff

Flow is the command-line work record for agents. Use Flow to select work,
prepare or adopt the workspace, request handoff, and record evidence, results,
documentation, pull requests, and next pickup notes. Use a local agent process
only for the implementation step.

This path does not require Autoflow. Autoflow, Desktop, and background
orchestration are experimental app-layer behavior built above the same Flow
bookkeeping contract.

## Contract

- Send one JSON object to `flow` through argv or stdin.
- Read one JSON object from stdout.
- Treat `.flow/config.yaml` as the durable source of truth.
- Do not edit code before Flow has prepared or adopted the workspace.
- Verify any subprocess output before recording success.
- Record blockers and next pickup through Flow when work cannot finish.

PowerShell stdin is the safest cross-agent shape on Windows:

```powershell
@'
{"op":"state"}
'@ | flow
```

For larger requests, write UTF-8 without BOM and pipe the file body:

```powershell
Get-Content .\flow-request.json -Raw | flow
```

## Orchestrator Thread

An orchestrator thread is an ordinary live agent session that coordinates work
through Flow and calls local worker CLIs when useful. It is not part of Flow
core.

Typical loop:

1. Inspect Flow state and manifests.
2. Select or view the issue.
3. Prepare or adopt the workspace through Flow.
4. Request or read the handoff prompt.
5. Run a bounded local worker process in the prepared workspace.
6. Inspect the diff and run relevant tests in the prepared workspace.
7. Record evidence, result, documentation, PR state, or blocker notes through
   Flow.

## Flow Commands

Discover the current command shape:

```powershell
@'
{"op":"manifest","target":"issue"}
'@ | flow

@'
{"op":"manifest","target":"workflow"}
'@ | flow
```

Inspect work:

```powershell
@'
{"op":"state"}
'@ | flow

@'
{"op":"issue","mode":"view","id":"GH-123"}
'@ | flow
```

Prepare or adopt a workspace:

```powershell
@'
{"op":"workflow","mode":"advance","id":"GH-123"}
'@ | flow

@'
{"op":"issue","mode":"adoptWorkspace","id":"GH-123","repoKey":"flow","worktreePath":"C:/path/to/worktree"}
'@ | flow
```

Request handoff details:

```powershell
@'
{"op":"workflow","mode":"handoff","id":"GH-123"}
'@ | flow

@'
{"op":"workflow","mode":"adoptHandoff","id":"GH-123","adopter":"claude"}
'@ | flow

@'
{"op":"workflow","mode":"observe","id":"GH-123"}
'@ | flow
```

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

Record closeout:

```powershell
@'
{"op":"workflow","mode":"recordEvidence","id":"GH-123","summary":"npm test passed","criteria":["tests"],"source":"npm test"}
'@ | flow

@'
{"op":"workflow","mode":"recordResult","id":"GH-123","repoKey":"flow","executor":"live_agent_thread","summary":"Implemented agent handoff docs","changedFiles":["docs/agent-handoff.md"],"testsRun":["npm test"]}
'@ | flow

@'
{"op":"workflow","mode":"recordDocumentation","id":"GH-123","disposition":"updated","summary":"Added agent handoff documentation."}
'@ | flow
```

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

Pi Agent:

```powershell
Set-Location "C:\path\to\prepared\workspace"
$prompt = Get-Content .\flow-handoff-prompt.txt -Raw
pi-coding-agent $prompt
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

Flow errors are JSON too. If `ok` is false, read `error.code`, `error.message`,
and any manifest hint before deciding the next command. If Flow reports a
blocker state, stop the worker path and record or surface the blocker rather
than continuing in an unmanaged workspace.

Example handoff response shape:

```json
{
  "ok": true,
  "op": "workflow",
  "result": {
    "id": "worker-gh-123",
    "issueRef": "GH-123",
    "repoKey": "flow",
    "workJobId": "job-gh-123",
    "workspacePath": "C:/repo/.worktrees/feature-gh-123",
    "prompt": "Use Flow to work this prompt."
  }
}
```

## Subagent Prompt

Pass a short Flow contract into every worker:

```text
You are working in a Flow-prepared workspace for GH-123.
Use Flow's JSON CLI for workflow state and records. Start by discovering the
available command shape with:
@'
{"op":"manifest","target":"workflow"}
'@ | flow
Do not use Autoflow.
Make the requested code changes, run focused tests, and report changed files,
tests, blockers, and next pickup.
If blocked, record the blocker and stop.
```

The orchestrator should still inspect the worker's changes before recording
success.
