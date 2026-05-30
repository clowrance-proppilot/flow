---
name: hermes
description: Use for Hermes agent workflow execution through Flow.
---

# Hermes Agent Flow Integration

Use this skill when the user asks to run work through Hermes, pick up Flow
issues via Hermes, or execute terminal/file-based tasks with evidence recording.

Hermes picks up Flow issues, executes work via terminal and file tools, and
records evidence back through the Flow JSON CLI protocol.

## Workflow

1. **Issue Selection**: Select or identify the Flow issue to work on.
2. **Workspace Preparation**: Prepare the workspace via Flow's worktree system.
3. **Execution**: Hermes executes work using terminal commands and file operations.
4. **Evidence Recording**: Record results, changed files, tests run, and blockers.
5. **Handoff**: Report results back to Flow for state progression.

## Hermes Capabilities

- `repo.worktree.prepare` - Prepare repository worktrees
- `code.edit` - Edit source code files
- `test.run` - Run tests and capture results
- `review.remediate` - Address review feedback
- `evidence.record` - Record execution evidence
- `terminal.execute` - Execute terminal commands
- `file.read` - Read file contents
- `file.write` - Write file contents

## Recording Results

Use the Flow JSON CLI to record Hermes execution results:

```bash
flow worker result --issue-ref <ref> --repo-key <key> \
  --executor hermes_agent --status succeeded \
  --summary "Completed implementation" \
  --changed-files src/file.ts --tests-run test/file.test.ts
```

Prefer registered Flow tools. Use the CLI only when this skill is installed
without tool bindings. Stdout is JSON.

Do not write provider, ledger, sprint, or git workflow state directly unless the
requester approves recovery after a Flow failure.

If a Flow mutation fails, stop and report the exact tool or CLI error.
