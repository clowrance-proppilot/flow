---
name: flow-fanout
description: Use when the user asks Flow to fan out issue work across subagents, launch scoped workers, coordinate multiple Flow issues, or aggregate agent results through the Flow JSON CLI.
---

# Flow Fan-Out

Use this skill to orchestrate issue work from the current thread while Flow
remains the state machine. The skill owns policy. Flow owns issue state,
handoffs, evidence, PR records, and closeout.

## Rules

- Use Flow JSON commands for all workflow state changes.
- Keep worker tasks thin: each worker gets one issue, one repo/workspace, and
  the Flow handoff prompt or next JSON command.
- Do not edit `.flow` ledger/runtime files directly.
- Do not add a daemon, desktop runner, or external workflow engine for this
  path.
- Do not make environment variables the durable orchestration surface.
- Stop and report the exact Flow error if a Flow mutation fails.

## Command Surface

Prefer `node bin/flow '<json>'` inside the Flow repo, or `flow '<json>'` when
the installed CLI is known fresh. Stdout is one JSON document.

Start with:

```bash
node bin/flow '{"op":"manifest","target":"workflow"}'
node bin/flow '{"op":"queue"}'
node bin/flow '{"op":"workflow","mode":"observe","id":"GH-123"}'
```

Use `nextJsonCommands` from Flow responses whenever present. They are the
authoritative next machine-readable actions for the current issue.

## Fan-Out Loop

1. Inspect queue and choose a small batch of independent issues.
2. For each issue, run `workflow observe`; if needed run `workflow advance`.
3. If Flow returns an execution handoff, launch one scoped subagent for that
   issue. Give it only the issue ref, repo key, workspace path, handoff prompt,
   and the expected `recordResult` JSON shape.
4. While workers run, keep observing other issues or preparing non-overlapping
   Flow commands in the current thread.
5. When a worker finishes, inspect its changed files and tests. Record the
   result through `workflow recordResult`.
6. Record acceptance evidence through `workflow recordEvidence` or
   `workflow recordAcceptance`.
7. Record PR metadata through `workflow recordPullRequest`.
8. Run `workflow observe`, then `workflow advance` until Flow reports review,
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

Flow recordResult request:
<JSON_FROM_nextJsonCommands>

Handoff:
<HANDOFF_PROMPT>
```

## Aggregation

For each worker result:

```bash
node bin/flow '{"op":"workflow","mode":"recordResult","id":"GH-123","repoKey":"flow","taskId":"worker-...","workJobId":"job-...","status":"succeeded","summary":"...","changedFiles":["..."],"testsRun":["..."]}'
node bin/flow '{"op":"workflow","mode":"observe","id":"GH-123"}'
```

Then follow returned `nextJsonCommands` for evidence, PR record, and advance.

## Blockers

If a worker cannot finish, still record the result:

```bash
node bin/flow '{"op":"workflow","mode":"recordResult","id":"GH-123","repoKey":"flow","status":"blocked","summary":"Blocked on ...","blockers":["..."],"nextPickup":"..."}'
```

Then run `workflow observe` and report the blocker with the Flow output.
