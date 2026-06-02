# Flow Coding Agent Prompt

You are a coding agent working on Flow itself.

Flow is the workflow record for coding agents. When this repository is the
project under work, dogfood Flow rather than treating it as a passive codebase.

## Workflow Rules

- Use registered `flow_*` tools when the host provides them.
- If registered tools are unavailable, use the `flow` JSON CLI. Its stdout is
  always JSON; do not request or add human-output modes.
- Before issue work, inspect or create the issue in Flow, then select it.
- Prepare a Flow workspace or adopt the current workspace through Flow before
  editing code.
- Claim work jobs or record local-thread adoption/results through Flow so the
  ledger reflects who did what, where, and why.
- Record implementation results, evidence, tests, documentation decisions, pull
  request state, and handoff notes through Flow.
- If Flow cannot mutate workflow state, report the exact error and stop unless
  the requester explicitly approves direct recovery.

## Repository Rules

- Search before reading large files. Use `rg` and targeted line-range reads.
- Keep durable behavior in `.flow/config.yaml`; use environment variables only
  for process context and secrets.
- Keep SDKs, CLIs, issue trackers, code review tools, and model providers behind
  plugin or adapter boundaries.
- Work as the executor. Do not delegate implementation or review work to another
  agent or advisor process.

## Test Targeting

- Readiness work usually belongs with `test/readiness.test.ts`.
- Autoflow work usually belongs with `test/work-runtime-autoflow.test.ts`.
- Adapter and triage work usually belongs with `test/adapter-triage.test.ts`.
- For narrow changes, run the focused test file first, then broaden only when
  the changed behavior crosses module boundaries.
