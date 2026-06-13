# CLI Reference

`flow` is a JSON-only command. It accepts one JSON object through argv or stdin
and writes one JSON object to stdout. There is no human-output mode and no
`--json` toggle.

## Manifest

```bash
flow '{"op":"manifest"}'
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"manifest","target":"issue"}'
flow '{"op":"manifest","target":"review"}'
flow '{"op":"manifest","target":"config"}'
```

Use manifests as the authoritative command shape for agents.

## Top-Level Ops

- `manifest`: capability metadata.
- `state`: current selected session summary.
- `queue`: active configured issue queue.
- `backlog`: backlog queue.
- `bootstrap`: create starter Flow config.
- `config`: validate, explain, or migrate config.
- `ledger`: verify the active SQL workflow ledger.
- `issue`: issue view, create, route, and workspace adoption.
- `workflow`: readiness, handoff, evidence, docs, result, and closeout.
- `review`: local or code review status.
- `runtime`: raw Work Runtime method bridge.

## Issue

```bash
flow '{"op":"issue","mode":"view","id":"GH-123"}'
flow '{"op":"issue","mode":"select","id":"GH-123"}'
flow '{"op":"issue","mode":"route","id":"GH-123","repoKeys":["flow"]}'
flow '{"op":"issue","mode":"adoptWorkspace","id":"GH-123","repoKey":"flow","worktreePath":"/path/to/worktree"}'
flow '{"op":"issue","mode":"triage","dryRun":true,"limit":50}'
```

Issue creation supports structured intake fields:

```bash
flow '{"op":"issue","mode":"intake","dryRun":true,"review":true,"summary":"Add SQL ledger docs","issueType":"Task"}'
flow '{"op":"issue","mode":"create","summary":"Add SQL ledger docs","issueType":"Task","repoKeys":["flow"]}'
```

## Workflow

```bash
flow '{"op":"workflow","mode":"doctor","id":"GH-123"}'
flow '{"op":"workflow","mode":"advance","id":"GH-123"}'
flow '{"op":"workflow","mode":"handoff","id":"GH-123"}'
flow '{"op":"workflow","mode":"adoptHandoff","id":"GH-123","adopter":"claude"}'
flow '{"op":"workflow","mode":"observe","id":"GH-123"}'
```

Record outputs:

```bash
flow '{"op":"workflow","mode":"recordResult","id":"GH-123","repoKey":"flow","summary":"Done","changedFiles":["README.md"],"testsRun":["npm test"]}'
flow '{"op":"workflow","mode":"recordPullRequest","id":"GH-123","repo":"flow","number":123,"url":"https://github.com/camden-lowrance/flow/pull/123","headRefName":"feature/gh-123","isDraft":false}'
flow '{"op":"workflow","mode":"recordEvidence","id":"GH-123","summary":"npm test passed","criteria":["tests"]}'
flow '{"op":"workflow","mode":"recordDocumentation","id":"GH-123","disposition":"updated","summary":"Updated docs."}'
flow '{"op":"workflow","mode":"recordAcceptance","id":"GH-123","summary":"Verified acceptance criteria.","criteria":["tests"],"disposition":"not_needed"}'
```

`adoptHandoff` claims the current pending execution handoff for a live local
agent thread and returns the handoff request, including `workspacePath`,
`prompt`, `workJobId`, and task id. Use `recordResult` afterward to record the
thread result.

Remediate what `doctor` reports without leaving Flow:

```bash
flow '{"op":"workflow","mode":"publish","id":"GH-123"}'
flow '{"op":"workflow","mode":"openPullRequest","id":"GH-123"}'
flow '{"op":"workflow","mode":"syncBranch","id":"GH-123"}'
flow '{"op":"workflow","mode":"cleanup","id":"GH-123"}'
```

`publish` pushes the committed worktree branch (`force:true` for
force-with-lease). `openPullRequest` creates the pull request through the
configured collaboration provider and records it in one step; it accepts
optional `title`, `body`, `draft`, and `baseBranch`. `syncBranch` rebases the
worktree branch onto its base branch, force-pushes (disable with
`push:false`), and refreshes review state. `cleanup` prunes merged-issue
worktrees and deletes confirmed-merged local/remote branches when closeout
reports `cleanup_needed`.

## Autoflow

Autoflow is experimental app-layer behavior. Core CLI agent work should use the
issue and workflow commands above; see [Agent handoff](agent-handoff.md) for the
CLI-first local-worker pattern.

Autoflow is not a `flow` op. It runs through its own app-layer entry point:

```bash
npm run autoflow -- GH-123
```

Autoflow uses configured issue, source-control, collaboration, runtime store,
and `runtime.agentSession.provider` settings.

## Config And Ledger

```bash
flow '{"op":"config","mode":"validate"}'
flow '{"op":"config","mode":"explain"}'
flow '{"op":"config","mode":"migrate","write":true}'
flow '{"op":"ledger","mode":"verify"}'
```

`ledger verify` checks the configured SQL workflow ledger and returns a JSON
health response.

## Review

```bash
flow '{"op":"review","mode":"local","id":"GH-123"}'
flow '{"op":"review","mode":"codeReview","id":"GH-123"}'
flow '{"op":"review","mode":"codeReview","id":"GH-123","repo":"owner/repo","post":false}'
```

## Errors

Errors are JSON too. Unsupported modes return a manifest hint so agents can
recover without guessing command shapes.
