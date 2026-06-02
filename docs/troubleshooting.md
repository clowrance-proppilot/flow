# Troubleshooting

## CLI Writes Non-JSON Output

`flow` stdout must be one JSON document. Diagnostics and performance output
should go to stderr. Do not add human-output modes or `--json` toggles.

Check the command contract:

```bash
npm run check:cli-contract
flow '{"op":"manifest"}'
```

## Config Does Not Apply

Validate config first:

```bash
flow '{"op":"config","mode":"validate"}'
flow '{"op":"config","mode":"explain"}'
```

Make durable changes in `.flow/config.yaml`. Environment variables should only
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

Inspect status:

```bash
flow '{"op":"autoflow","mode":"status"}'
flow '{"op":"workflow","mode":"doctor","id":"GH-123"}'
```

Common causes:

- Missing repo routing.
- Missing prepared worktree.
- Pull request conflicts.
- Failing or pending checks.
- Missing evidence or documentation disposition.
- Stale worker run beyond `runtime.staleWorkerRunTimeoutMs`.

## Worktree Problems

Check recorded workspace state:

```bash
flow '{"op":"issue","mode":"view","id":"GH-123"}'
git worktree list
```

Adopt an existing workspace when Flow should track it:

```bash
flow '{"op":"issue","mode":"adoptWorkspace","id":"GH-123","repoKey":"flow","worktreePath":"/path/to/worktree"}'
```

## SQL State Problems

Verify ledger state:

```bash
flow '{"op":"ledger","mode":"verify"}'
```

SQLite runtime and workflow state are stored under Flow's configured runtime
paths. If a project uses a custom `runtime.storeDir`, `runtime.stateDir`, or
`ledger.path`, inspect those paths before deleting anything.

## Pull Request Closeout Stalls

Run:

```bash
flow '{"op":"review","mode":"codeReview","id":"GH-123"}'
flow '{"op":"workflow","mode":"doctor","id":"GH-123"}'
```

Flow will block closeout for draft PRs, conflicts, failed checks, missing
template headings, must-fix auto-review feedback, missing evidence, or missing
documentation disposition.
