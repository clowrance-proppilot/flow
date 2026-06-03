# CLI Reference

`flow` is a JSON-only command. It accepts one JSON object through argv or stdin
and writes one JSON object to stdout. There is no human-output mode and no
`--json` toggle.

## Manifest

```bash
flow '{"op":"manifest"}'
flow '{"op":"manifest","target":"workflow"}'
flow '{"op":"manifest","target":"issue"}'
flow '{"op":"manifest","target":"autoflow"}'
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
- `ledger`: verify workflow ledger.
- `issue`: issue view, create, route, and workspace adoption.
- `workflow`: readiness, handoff, evidence, docs, result, and closeout.
- `autoflow`: experimental app-layer Autoflow control.
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

## Autoflow

Autoflow is experimental app-layer behavior. Core CLI agent work should use the
issue and workflow commands above; see [Agent handoff](agent-handoff.md) for the
CLI-first local-worker pattern.

```bash
flow '{"op":"autoflow","mode":"status"}'
flow '{"op":"autoflow","mode":"enable"}'
flow '{"op":"autoflow","mode":"disable"}'
flow '{"op":"autoflow","mode":"tick"}'
flow '{"op":"autoflow","mode":"run","id":"GH-123"}'
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

## Review

```bash
flow '{"op":"review","mode":"local","id":"GH-123"}'
flow '{"op":"review","mode":"codeReview","id":"GH-123"}'
flow '{"op":"review","mode":"codeReview","id":"GH-123","repo":"owner/repo","post":false}'
```

## Errors

Errors are JSON too. Unsupported modes return a manifest hint so agents can
recover without guessing command shapes.
