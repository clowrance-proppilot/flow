---
name: flow-fanout
description: Use when the user asks Flow to fan out issue work across subagents, launch scoped workers, coordinate multiple Flow issues, or aggregate agent results through Flow MCP tools.
---

# Flow Fan-Out

Use this skill to orchestrate issue work from the current thread while Flow
remains the state machine. The skill owns policy. Flow owns issue state,
handoffs, evidence, PR records, and closeout.

## Rules

- Use Flow MCP tools for all workflow state changes.
- Keep worker tasks thin: each worker gets one issue, one repo/workspace, and
  the Flow handoff prompt or next MCP tool suggestion.
- Do not edit `.flow` ledger/runtime files directly.
- Do not add a daemon, desktop runner, or external workflow engine for this
  path.
- Do not make environment variables the durable orchestration surface.
- Stop and report the exact Flow error if a Flow mutation fails.

## Tool Surface

Use registered Flow MCP tools. If they are unavailable, stop and report that
Flow MCP is not connected.

Start with:

- `flow_queue`
- `flow_observe`
- `flow_workflow_audit`

Use `nextMcpTools` from Flow responses whenever present. They are the
authoritative next machine-readable actions for the current issue.

## Fan-Out Loop

1. Inspect queue and choose a small batch of independent issues.
2. For each issue, run `flow_observe`; if needed run `flow_workflow_advance`.
3. If Flow returns an execution handoff, launch one scoped subagent for that
   issue. Give it only the issue ref, repo key, workspace path, handoff prompt,
   and the expected `flow_record_result` arguments.
4. While workers run, keep observing other issues or preparing non-overlapping
   Flow commands in the current thread.
5. When a worker finishes, inspect its changed files and tests. Record the
   result through `flow_record_result`.
6. Record acceptance evidence through `flow_record_evidence` or
   `flow_record_acceptance`.
7. Record PR metadata through `flow_record_pull_request`.
8. Run `flow_observe`, then `flow_workflow_advance` until Flow reports review,
   closeout, done, or a real blocker.

## Worker Prompt Shape

Use a narrow prompt:

```text
Work only issue <ISSUE_REF> in repo <REPO_KEY>.
Workspace: <WORKSPACE_PATH>

Use Flow's handoff prompt below as the task source. Do not work unrelated files.
Do not modify Flow ledger/runtime files directly.

When done, report:
- status: succeeded | blocked | failed
- summary
- changedFiles
- testsRun
- blockers

Flow `flow_record_result` arguments:
<ARGUMENTS_FROM_nextMcpTools>

Handoff:
<HANDOFF_PROMPT>
```

## Aggregation

For each worker result:

Call `flow_record_result`, then `flow_observe`.

Then follow returned `nextMcpTools` for evidence, PR record, and advance.

## Blockers

If a worker cannot finish, still record the result:

Call `flow_record_result` with `status: "blocked"`, `summary`, `blockers`,
and `nextPickup`.

Then run `flow_observe` and report the blocker with the Flow output.
